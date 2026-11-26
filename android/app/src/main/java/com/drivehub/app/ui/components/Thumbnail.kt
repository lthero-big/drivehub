package com.drivehub.app.ui.components

import android.content.Context
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Folder
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material3.Icon
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
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
 * File visual for grid/list: the bare thumbnail (flat secondary fill while loading, kind glyph on
 * failure). No gradient scrim, no extension / size badges; [videoMark] adds one tiny dark play tag.
 */
@Composable
fun FileThumb(item: FsItem, modifier: Modifier = Modifier, shape: Shape = Radius.sm, glyph: Dp = 22.dp, videoMark: Boolean = false) {
    val c = Dh.c
    val kind = kindOf(item.name)
    val tint = c.kindTint(kind, item.isDir)
    val fake = LocalThumbPainter.current?.invoke(item)
    val src = LocalThumbs.current
    val ctx = LocalContext.current
    val req = remember(item, src) { if (fake == null) src?.request?.invoke(ctx, item) else null }
    var state by remember(req) { mutableStateOf<AsyncImagePainter.State>(AsyncImagePainter.State.Empty) }
    val loading = req != null && (state is AsyncImagePainter.State.Loading || state is AsyncImagePainter.State.Empty)
    Box(modifier.clip(shape).background(if (fake != null || loading) c.surface2 else tint.copy(alpha = 0.13f)), Alignment.Center) {
        when {
            fake != null -> Image(fake, item.name, Modifier.fillMaxSize(), contentScale = ContentScale.Crop)
            req != null && src != null -> {
                if (state is AsyncImagePainter.State.Error) Glyph(item, tint, glyph)
                AsyncImage(req, item.name, src.loader, Modifier.fillMaxSize(), contentScale = ContentScale.Crop, onState = { state = it })
            }
            else -> Glyph(item, tint, glyph)
        }
        if (videoMark && kind == "video") {
            Box(
                Modifier.align(Alignment.BottomEnd).padding(4.dp).clip(Radius.xs).background(Color.Black.copy(alpha = 0.5f))
                    .padding(horizontal = 4.dp, vertical = 1.dp),
            ) { Icon(Icons.Default.PlayArrow, "视频", Modifier.size(12.dp), Color.White) }
        }
    }
}

@Composable
private fun Glyph(item: FsItem, tint: Color, size: Dp) {
    Icon(if (item.isDir) Icons.Default.Folder else iconFor(item.name), null, Modifier.size(size), tint)
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
