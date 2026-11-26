package com.drivehub.app.ui.screens

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import androidx.activity.compose.BackHandler
import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.gestures.detectTransformGestures
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.rotate
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.media3.common.MediaMetadata
import androidx.media3.common.Player
import com.drivehub.app.data.ApiClient
import com.drivehub.app.data.FsItem
import com.drivehub.app.ui.AppViewModel
import com.drivehub.app.ui.components.*
import com.drivehub.app.ui.fmtSize
import com.drivehub.app.ui.kindOf
import com.drivehub.app.ui.theme.*
import kotlinx.coroutines.delay

/** Preview stage: dark "暗场" for images/video, theme surface for documents; glow follows media colour. */
@Composable
fun PreviewScreen(vm: AppViewModel, item: FsItem, onClose: () -> Unit) {
    BackHandler { onClose() }
    val kind = kindOf(item.name)
    val base = Dh.c
    val stage = if (kind in setOf("image", "video", "audio") && !base.isDark)
        MidnightColors.copy(accent = base.accent, accentSoft = base.accentSoft, onAccent = base.onAccent) else base
    var tint by remember { mutableStateOf<Color?>(null) }
    CompositionLocalProvider(LocalDh provides stage) {
        val c = Dh.c
        AmbientBackground(Modifier.fillMaxSize(), tint = tint, base = if (kind == "image" || kind == "video") Color(0xFF060708) else c.bg) {
            Box(Modifier.fillMaxSize(), Alignment.Center) {
                when (kind) {
                    "image" -> ImagePreview(vm, item) { tint = it }
                    "video", "audio" -> MediaPreview(vm, item) { tint = it }
                    "pdf" -> PdfPreview(vm, item)
                    "text" -> TextPreview(vm, item)
                    else -> EmptyState(EmptyKind.Folder, "此类型暂不支持预览", "${item.name}\n${fmtSize(item.size)}")
                }
            }
            PreviewTopBar(vm, item, onClose)
        }
    }
}

@Composable
private fun PreviewTopBar(vm: AppViewModel, item: FsItem, onClose: () -> Unit) {
    val c = Dh.c
    var dl by remember { mutableStateOf<MorphState>(MorphState.Idle("下载", Icons.Default.Download)) }
    LaunchedEffect(dl) { if (dl is MorphState.Done) { delay(2200); dl = MorphState.Idle("下载", Icons.Default.Download) } }
    Row(
        Modifier.fillMaxWidth().background(Brush.verticalGradient(listOf(c.bg.copy(alpha = 0.85f), Color.Transparent)))
            .statusBarsPadding().padding(horizontal = 12.dp, vertical = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        GlassIconButton(Icons.AutoMirrored.Filled.ArrowBack, "返回", onClick = onClose)
        Spacer(Modifier.width(12.dp))
        Column(Modifier.weight(1f)) {
            Text(item.name, color = c.fg, style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
            Text(fmtSize(item.size), color = c.fg2, style = MaterialTheme.typography.labelSmall)
        }
        MorphStatusButton(dl, height = 40.dp) { vm.download(item); dl = MorphState.Done("已加入队列") }
    }
}

@Composable
fun ImagePreview(vm: AppViewModel, item: FsItem, onTint: (Color?) -> Unit) {
    val c = Dh.c
    val r by produceLoad(item.path) { vm.previewBitmap(item.path) }
    val bmp = r?.getOrNull()
    LaunchedEffect(bmp) { bmp?.let { onTint(dominantColor(it)) } }
    when {
        r == null -> CircularProgressIndicator(color = c.accent)
        r!!.isFailure -> EmptyState(EmptyKind.Error, "图片加载失败", vm.errText(r!!.exceptionOrNull()!!))
        bmp == null -> EmptyState(EmptyKind.Error, "无法解码图片", item.name)
        else -> ZoomableImage(bmp, item.name)
    }
}

/** Pinch to zoom (1–5×), drag to pan when zoomed, double-tap toggles 1× / 2.5×. */
@Composable
private fun ZoomableImage(bmp: Bitmap, desc: String) {
    var scale by remember { mutableFloatStateOf(1f) }
    var offset by remember { mutableStateOf(Offset.Zero) }
    val s by animateFloatAsState(scale, Motion.medium(), label = "zoom")
    val img = remember(bmp) { bmp.asImageBitmap() }
    Image(
        img, desc,
        Modifier.fillMaxSize()
            .pointerInput(Unit) {
                detectTapGestures(onDoubleTap = { if (scale > 1.1f) { scale = 1f; offset = Offset.Zero } else scale = 2.5f })
            }
            .pointerInput(Unit) {
                detectTransformGestures { _, pan, zoom, _ ->
                    scale = (scale * zoom).coerceIn(1f, 5f)
                    offset = if (scale > 1f) offset + pan else Offset.Zero
                }
            }
            .graphicsLayer { scaleX = s; scaleY = s; translationX = offset.x; translationY = offset.y },
        contentScale = ContentScale.Fit,
    )
}

@Composable
fun TextPreview(vm: AppViewModel, item: FsItem) {
    val c = Dh.c
    val r by produceLoad(item.path) { vm.previewFile(item.path).readText().take(200_000) }
    when {
        r == null -> CircularProgressIndicator(color = c.accent)
        r!!.isFailure -> EmptyState(EmptyKind.Error, "加载失败", vm.errText(r!!.exceptionOrNull()!!))
        else -> DhCard(Modifier.fillMaxSize().statusBarsPadding().padding(start = 12.dp, end = 12.dp, top = 64.dp, bottom = 12.dp).navigationBarsPadding()) {
            Text(
                r!!.getOrNull()!!, Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(16.dp),
                style = MaterialTheme.typography.bodySmall, fontFamily = FontFamily.Monospace, color = c.fg,
            )
        }
    }
}

@Composable
fun PdfPreview(vm: AppViewModel, item: FsItem) {
    val c = Dh.c
    val r by produceLoad(item.path) {
        val f = vm.previewFile(item.path)
        kotlinx.coroutines.withContext(kotlinx.coroutines.Dispatchers.IO) {
            val pfd = android.os.ParcelFileDescriptor.open(f, android.os.ParcelFileDescriptor.MODE_READ_ONLY)
            val rd = android.graphics.pdf.PdfRenderer(pfd)
            val pages = (0 until rd.pageCount).map { i ->
                rd.openPage(i).use { p ->
                    val w = 1080; val h = (w.toFloat() * p.height / p.width).toInt()
                    val bmp = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888)
                    bmp.eraseColor(android.graphics.Color.WHITE)
                    p.render(bmp, null, null, android.graphics.pdf.PdfRenderer.Page.RENDER_MODE_FOR_DISPLAY); bmp
                }
            }
            rd.close(); pfd.close(); pages
        }
    }
    when {
        r == null -> CircularProgressIndicator(color = c.accent)
        r!!.isFailure -> EmptyState(EmptyKind.Error, "加载失败", vm.errText(r!!.exceptionOrNull()!!))
        else -> LazyColumn(
            Modifier.fillMaxSize(), verticalArrangement = Arrangement.spacedBy(12.dp),
            contentPadding = PaddingValues(start = 14.dp, end = 14.dp, top = 96.dp, bottom = 32.dp),
        ) {
            items(r!!.getOrNull()!!) { b ->
                Image(b.asImageBitmap(), null, Modifier.fillMaxWidth().shadow(8.dp, Radius.md).clip(Radius.md), contentScale = ContentScale.FillWidth)
            }
        }
    }
}

private fun fmtTime(ms: Long): String {
    val s = (ms / 1000).coerceAtLeast(0)
    return if (s >= 3600) "%d:%02d:%02d".format(s / 3600, s / 60 % 60, s % 60) else "%d:%02d".format(s / 60, s % 60)
}

/**
 * Video/audio player: ExoPlayer surface (video) or a slowly spinning artwork disc (audio), with a
 * custom Compose control bar; the ambient glow takes the artwork's colour when available.
 */
@Composable
fun MediaPreview(vm: AppViewModel, item: FsItem, onTint: (Color?) -> Unit) {
    val ctx = LocalContext.current
    val c = Dh.c
    val api = vm.client() ?: return
    val audio = kindOf(item.name) == "audio"
    val player = remember(item.path) {
        val ds = androidx.media3.datasource.okhttp.OkHttpDataSource.Factory(ApiClient.defaultHttp()).setDefaultRequestProperties(api.clientHeaders())
        androidx.media3.exoplayer.ExoPlayer.Builder(ctx)
            .setMediaSourceFactory(androidx.media3.exoplayer.source.DefaultMediaSourceFactory(ctx).setDataSourceFactory(ds)).build().apply {
                setMediaItem(androidx.media3.common.MediaItem.fromUri(api.fileUrl(item.path, preview = true))); prepare(); playWhenReady = true
            }
    }
    var artwork by remember { mutableStateOf<Bitmap?>(null) }
    var pos by remember { mutableLongStateOf(0L) }
    var dur by remember { mutableLongStateOf(0L) }
    var playing by remember { mutableStateOf(false) }
    var drag by remember { mutableStateOf<Float?>(null) }
    DisposableEffect(player) {
        val l = object : Player.Listener {
            override fun onMediaMetadataChanged(m: MediaMetadata) {
                m.artworkData?.let { d -> artwork = runCatching { BitmapFactory.decodeByteArray(d, 0, d.size) }.getOrNull() }
            }
        }
        player.addListener(l)
        onDispose { player.removeListener(l); player.release() }
    }
    LaunchedEffect(artwork) { artwork?.let { onTint(dominantColor(it)) } }
    LaunchedEffect(player) {
        while (true) {
            pos = player.currentPosition; dur = player.duration.coerceAtLeast(0); playing = player.isPlaying
            delay(250)
        }
    }
    Column(Modifier.fillMaxSize().statusBarsPadding().navigationBarsPadding().padding(top = 64.dp)) {
        Box(Modifier.weight(1f).fillMaxWidth().padding(16.dp), Alignment.Center) {
            if (!audio) {
                AndroidView(
                    { v -> androidx.media3.ui.PlayerView(v).apply { useController = false; this.player = player; setShutterBackgroundColor(android.graphics.Color.TRANSPARENT) } },
                    Modifier.fillMaxSize().clip(Radius.lg).clickable { if (player.isPlaying) player.pause() else player.play() },
                )
            } else {
                val spin by rememberInfiniteTransition(label = "disc").animateFloat(0f, 360f, infiniteRepeatable(tween(18_000, easing = LinearEasing)), label = "spin")
                val art = artwork
                Box(
                    Modifier.size(260.dp).shadow(40.dp, CircleShape, ambientColor = c.accent, spotColor = c.accent).rotate(if (playing) spin else 0f)
                        .clip(CircleShape).background(Brush.linearGradient(listOf(c.audio, c.glowB.copy(alpha = 1f))))
                        .border(1.dp, Color.White.copy(alpha = 0.18f), CircleShape),
                    Alignment.Center,
                ) {
                    if (art != null) Image(art.asImageBitmap(), null, Modifier.fillMaxSize(), contentScale = ContentScale.Crop)
                    else Icon(Icons.Default.MusicNote, null, Modifier.size(96.dp), Color.White.copy(alpha = 0.9f))
                    Box(Modifier.size(38.dp).clip(CircleShape).background(c.bg).border(1.dp, c.line, CircleShape))
                }
            }
        }
        Column(
            Modifier.fillMaxWidth().padding(16.dp).clip(Radius.xl).background(c.dock).border(1.dp, c.dockHighlight, Radius.xl).padding(horizontal = 18.dp, vertical = 14.dp),
        ) {
            if (audio) Text(item.name.substringBeforeLast('.'), color = c.fg, style = MaterialTheme.typography.titleMedium, maxLines = 1, overflow = TextOverflow.Ellipsis)
            val frac = drag ?: if (dur > 0) pos.toFloat() / dur else 0f
            Slider(
                frac, { drag = it },
                onValueChangeFinished = { drag?.let { player.seekTo((it * dur).toLong()) }; drag = null },
                colors = SliderDefaults.colors(thumbColor = c.accent, activeTrackColor = c.accent, inactiveTrackColor = c.fg.copy(alpha = 0.15f)),
            )
            Row {
                Text(fmtTime(if (drag != null) (frac * dur).toLong() else pos), color = c.fg2, style = MaterialTheme.typography.labelSmall)
                Spacer(Modifier.weight(1f))
                Text(fmtTime(dur), color = c.fg2, style = MaterialTheme.typography.labelSmall)
            }
            Row(Modifier.fillMaxWidth().padding(top = 4.dp), horizontalArrangement = Arrangement.SpaceEvenly, verticalAlignment = Alignment.CenterVertically) {
                HeaderAction(Icons.Default.Replay10, "后退 10 秒", c.fg) { player.seekTo((player.currentPosition - 10_000).coerceAtLeast(0)) }
                Box(
                    Modifier.size(64.dp).shadow(18.dp, CircleShape, ambientColor = c.accent, spotColor = c.accent).clip(CircleShape).background(c.accent)
                        .clickable { if (player.isPlaying) player.pause() else player.play() },
                    Alignment.Center,
                ) { Icon(if (playing) Icons.Default.Pause else Icons.Default.PlayArrow, if (playing) "暂停" else "播放", Modifier.size(34.dp), c.onAccent) }
                HeaderAction(Icons.Default.Forward10, "前进 10 秒", c.fg) { player.seekTo(player.currentPosition + 10_000) }
            }
        }
    }
}
