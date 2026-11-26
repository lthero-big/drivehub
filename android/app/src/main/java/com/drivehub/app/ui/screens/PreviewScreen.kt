package com.drivehub.app.ui.screens

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import androidx.activity.compose.BackHandler
import androidx.compose.animation.core.animateFloatAsState
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
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
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

/** Preview: pure black stage with a quiet top bar for images / video / audio, paper canvas for documents. */
@Composable
fun PreviewScreen(vm: AppViewModel, item: FsItem, onClose: () -> Unit) {
    BackHandler { onClose() }
    val kind = kindOf(item.name)
    val media = kind == "image" || kind == "video" || kind == "audio"
    CompositionLocalProvider(LocalDh provides if (media) MediaStage else Dh.c) {
        val c = Dh.c
        Column(Modifier.fillMaxSize().background(c.bg)) {
            PreviewTopBar(vm, item, onClose)
            Box(Modifier.weight(1f).fillMaxWidth(), Alignment.Center) {
                when (kind) {
                    "image" -> ImagePreview(vm, item)
                    "video", "audio" -> MediaPreview(vm, item)
                    "pdf" -> PdfPreview(vm, item)
                    "text" -> TextPreview(vm, item)
                    else -> EmptyState(EmptyKind.Folder, "此类型暂不支持预览", "${item.name}\n${fmtSize(item.size)}")
                }
            }
        }
    }
}

@Composable
private fun PreviewTopBar(vm: AppViewModel, item: FsItem, onClose: () -> Unit) {
    val c = Dh.c
    var queued by remember { mutableStateOf(false) }
    LaunchedEffect(queued) { if (queued) { delay(2200); queued = false } }
    Row(
        Modifier.fillMaxWidth().statusBarsPadding().height(52.dp).padding(horizontal = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        IconButton(onClose) { Icon(Icons.Default.ChevronLeft, "返回", Modifier.size(28.dp), c.fg) }
        Column(Modifier.weight(1f)) {
            Text(item.name, color = c.fg, style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
            Text(if (queued) "已加入下载队列" else fmtSize(item.size), color = c.fg2, style = MaterialTheme.typography.labelSmall)
        }
        IconButton({ if (!queued) { vm.download(item); queued = true } }) {
            Icon(if (queued) Icons.Default.Check else Icons.Default.Download, "下载", Modifier.size(22.dp), if (queued) c.accent else c.fg)
        }
    }
}

@Composable
fun ImagePreview(vm: AppViewModel, item: FsItem) {
    val c = Dh.c
    val r by produceLoad(item.path) { vm.previewBitmap(item.path) }
    val bmp = r?.getOrNull()
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
        else -> DhCard(Modifier.fillMaxSize().navigationBarsPadding().padding(start = 12.dp, end = 12.dp, top = 4.dp, bottom = 12.dp)) {
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
            contentPadding = PaddingValues(start = 14.dp, end = 14.dp, top = 8.dp, bottom = 32.dp),
        ) {
            items(r!!.getOrNull()!!) { b ->
                Image(b.asImageBitmap(), null, Modifier.fillMaxWidth().clip(Radius.sm).border(Hair, c.line, Radius.sm), contentScale = ContentScale.FillWidth)
            }
        }
    }
}

private fun fmtTime(ms: Long): String {
    val s = (ms / 1000).coerceAtLeast(0)
    return if (s >= 3600) "%d:%02d:%02d".format(s / 3600, s / 60 % 60, s % 60) else "%d:%02d".format(s / 60, s % 60)
}

/**
 * Video/audio player: ExoPlayer surface (video) or a flat artwork square (audio) on black, with a
 * plain control strip — brand red only on the progress track.
 */
@Composable
fun MediaPreview(vm: AppViewModel, item: FsItem) {
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
    LaunchedEffect(player) {
        while (true) {
            pos = player.currentPosition; dur = player.duration.coerceAtLeast(0); playing = player.isPlaying
            delay(250)
        }
    }
    Column(Modifier.fillMaxSize().navigationBarsPadding()) {
        Box(Modifier.weight(1f).fillMaxWidth(), Alignment.Center) {
            if (!audio) {
                AndroidView(
                    { v -> androidx.media3.ui.PlayerView(v).apply { useController = false; this.player = player; setShutterBackgroundColor(android.graphics.Color.BLACK) } },
                    Modifier.fillMaxSize().clickable { if (player.isPlaying) player.pause() else player.play() },
                )
            } else {
                val art = artwork
                Box(Modifier.size(240.dp).clip(Radius.lg).background(c.surface2), Alignment.Center) {
                    if (art != null) Image(art.asImageBitmap(), null, Modifier.fillMaxSize(), contentScale = ContentScale.Crop)
                    else Icon(Icons.Default.MusicNote, null, Modifier.size(72.dp), c.fg3)
                }
            }
        }
        Column(Modifier.fillMaxWidth().padding(horizontal = 20.dp, vertical = 12.dp)) {
            if (audio) Text(item.name.substringBeforeLast('.'), color = c.fg, style = MaterialTheme.typography.titleMedium, maxLines = 1, overflow = TextOverflow.Ellipsis)
            val frac = drag ?: if (dur > 0) pos.toFloat() / dur else 0f
            Slider(
                frac, { drag = it },
                onValueChangeFinished = { drag?.let { player.seekTo((it * dur).toLong()) }; drag = null },
                colors = SliderDefaults.colors(thumbColor = c.fg, activeTrackColor = c.accent, inactiveTrackColor = c.fg.copy(alpha = 0.18f)),
            )
            Row {
                Text(fmtTime(if (drag != null) (frac * dur).toLong() else pos), color = c.fg2, style = MaterialTheme.typography.labelSmall)
                Spacer(Modifier.weight(1f))
                Text(fmtTime(dur), color = c.fg2, style = MaterialTheme.typography.labelSmall)
            }
            Row(Modifier.fillMaxWidth().padding(top = 4.dp), horizontalArrangement = Arrangement.SpaceEvenly, verticalAlignment = Alignment.CenterVertically) {
                HeaderAction(Icons.Default.Replay10, "后退 10 秒", c.fg) { player.seekTo((player.currentPosition - 10_000).coerceAtLeast(0)) }
                IconButton({ if (player.isPlaying) player.pause() else player.play() }, Modifier.size(56.dp)) {
                    Icon(if (playing) Icons.Default.Pause else Icons.Default.PlayArrow, if (playing) "暂停" else "播放", Modifier.size(40.dp), c.fg)
                }
                HeaderAction(Icons.Default.Forward10, "前进 10 秒", c.fg) { player.seekTo(player.currentPosition + 10_000) }
            }
        }
    }
}
