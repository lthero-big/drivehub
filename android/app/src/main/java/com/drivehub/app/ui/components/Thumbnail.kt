package com.drivehub.app.ui.components

import android.content.Context
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Folder
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Shape
import androidx.compose.ui.graphics.painter.Painter
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import coil.ImageLoader
import coil.compose.AsyncImage
import coil.compose.AsyncImagePainter
import coil.decode.VideoFrameDecoder
import coil.disk.DiskCache
import coil.memory.MemoryCache
import coil.request.ImageRequest
import coil.request.videoFrameMillis
import com.drivehub.app.data.FsItem
import com.drivehub.app.ui.ThumbPolicy
import com.drivehub.app.ui.extBadge
import com.drivehub.app.ui.fmtSize
import com.drivehub.app.ui.kindOf
import com.drivehub.app.ui.theme.Dh
import com.drivehub.app.ui.theme.Radius
import com.drivehub.app.ui.theme.kindTint
import okhttp3.OkHttpClient
import java.util.concurrent.TimeUnit

/**
 * Where thumbnails come from. Built once by the ViewModel; [request] returns null when the
 * [ThumbPolicy] says the item should show its icon instead.
 */
class ThumbSource(val loader: ImageLoader, val request: (Context, FsItem) -> ImageRequest?) {
    companion object {
        /**
         * Coil loader on its own OkHttp client that stamps the DriveHub client headers + bearer token
         * (read per request, so token refreshes apply). Memory LRU + 256 MB disk LRU; video frames
         * via [VideoFrameDecoder]; Coil samples every bitmap down to the requested size (no OOM).
         */
        fun build(ctx: Context, headers: () -> Map<String, String>): ImageLoader {
            val http = OkHttpClient.Builder()
                .connectTimeout(15, TimeUnit.SECONDS).readTimeout(60, TimeUnit.SECONDS)
                .dispatcher(okhttp3.Dispatcher().apply { maxRequestsPerHost = 3 })
                .addInterceptor { chain ->
                    val b = chain.request().newBuilder()
                    headers().forEach { (k, v) -> b.header(k, v) }
                    chain.proceed(b.build())
                }.build()
            return ImageLoader.Builder(ctx)
                .okHttpClient(http)
                .respectCacheHeaders(false)
                .memoryCache { MemoryCache.Builder(ctx).maxSizePercent(0.15).build() }
                .diskCache { DiskCache.Builder().directory(ctx.cacheDir.resolve("thumbs")).maxSizeBytes(256L * 1024 * 1024).build() }
                .components { add(VideoFrameDecoder.Factory()) }
                .build()
        }

        fun requestFor(ctx: Context, url: String, key: String, item: FsItem): ImageRequest =
            ImageRequest.Builder(ctx)
                .data(url)
                .memoryCacheKey(key)
                .diskCacheKey(key)
                .size(ThumbPolicy.SIZE_PX)
                .crossfade(220)
                .apply { if (kindOf(item.name) == "video") videoFrameMillis(1000) }
                .build()
    }
}

val LocalThumbs = staticCompositionLocalOf<ThumbSource?> { null }

/** Screenshot/preview hook: supplies a painter instead of hitting the network. */
val LocalThumbPainter = staticCompositionLocalOf<((FsItem) -> Painter?)?> { null }

/**
 * File visual for grid/list: real thumbnail (skeleton while loading, coloured icon on failure),
 * with extension / size badges and a play mark for videos.
 */
@Composable
fun FileThumb(item: FsItem, modifier: Modifier = Modifier, shape: Shape = Radius.md, glyph: Dp = 40.dp, badges: Boolean = true) {
    val c = Dh.c
    val kind = kindOf(item.name)
    val tint = c.kindTint(kind, item.isDir)
    val fake = LocalThumbPainter.current?.invoke(item)
    val src = LocalThumbs.current
    val ctx = LocalContext.current
    val req = remember(item, src) { if (fake == null) src?.request?.invoke(ctx, item) else null }
    var state by remember(req) { mutableStateOf<AsyncImagePainter.State>(AsyncImagePainter.State.Empty) }
    val hasImage = fake != null || (req != null && state is AsyncImagePainter.State.Success)
    Box(modifier.clip(shape).background(tint.copy(alpha = if (c.isDark) 0.12f else 0.10f)), Alignment.Center) {
        when {
            fake != null -> Image(fake, item.name, Modifier.fillMaxSize(), contentScale = ContentScale.Crop)
            req != null && src != null -> {
                if (state is AsyncImagePainter.State.Loading || state is AsyncImagePainter.State.Empty)
                    Box(Modifier.fillMaxSize().shimmer(c.surfaceHigh, c.fg.copy(alpha = 0.06f)))
                if (state is AsyncImagePainter.State.Error) Glyph(item, tint, glyph)
                AsyncImage(req, item.name, src.loader, Modifier.fillMaxSize(), contentScale = ContentScale.Crop, onState = { state = it })
            }
            else -> Glyph(item, tint, glyph)
        }
        if (hasImage) {
            Box(Modifier.matchParentSize().background(Brush.verticalGradient(listOf(Color.Transparent, Color.Transparent, Color.Black.copy(alpha = 0.45f)))))
            if (kind == "video") {
                Box(Modifier.size(glyph * 0.85f).clip(CircleShape).background(Color.Black.copy(alpha = 0.45f)), Alignment.Center) {
                    Icon(Icons.Default.PlayArrow, null, Modifier.size(glyph * 0.55f), Color.White)
                }
            }
        }
        if (badges && !item.isDir) {
            val ext = extBadge(item.name)
            Row(Modifier.align(Alignment.BottomStart).fillMaxWidth().padding(6.dp), verticalAlignment = Alignment.CenterVertically) {
                if (ext.isNotEmpty()) Badge(ext, if (hasImage) Color.Black.copy(alpha = 0.5f) else tint.copy(alpha = 0.2f), if (hasImage) Color.White else tint)
                Spacer(Modifier.weight(1f))
                if (hasImage) Badge(fmtSize(item.size), Color.Black.copy(alpha = 0.5f), Color.White)
            }
        }
    }
}

@Composable
private fun Glyph(item: FsItem, tint: Color, size: Dp) {
    Icon(if (item.isDir) Icons.Default.Folder else iconFor(item.name), null, Modifier.size(size), tint)
}

@Composable
private fun Badge(text: String, bg: Color, fg: Color) {
    Text(
        text, color = fg, style = MaterialTheme.typography.labelSmall, maxLines = 1,
        modifier = Modifier.clip(Radius.xs).background(bg).padding(horizontal = 5.dp, vertical = 1.dp),
    )
}

/** Convenience used by the ViewModel to build the [ThumbSource]. */
fun thumbSource(ctx: Context, enabled: () -> Boolean, server: () -> String?, url: (String) -> String?, headers: () -> Map<String, String>): ThumbSource {
    val loader = ThumbSource.build(ctx.applicationContext, headers)
    return ThumbSource(loader) { c, item ->
        val base = server()
        val u = url(item.path)
        if (base == null || u == null || !ThumbPolicy.shouldLoad(item, enabled())) null
        else ThumbSource.requestFor(c, u, ThumbPolicy.cacheKey(base, item), item)
    }
}
