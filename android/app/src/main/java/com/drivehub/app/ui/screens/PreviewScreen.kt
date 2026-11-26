@file:OptIn(androidx.compose.material3.ExperimentalMaterial3Api::class)

package com.drivehub.app.ui.screens

import android.annotation.SuppressLint
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.net.Uri
import android.provider.OpenableColumns
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.activity.compose.BackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.InsertDriveFile
import androidx.compose.material.icons.automirrored.filled.Logout
import androidx.compose.material.icons.filled.*
import androidx.compose.material.icons.outlined.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.work.WorkInfo
import androidx.work.WorkManager
import com.drivehub.app.BuildConfig
import com.drivehub.app.core.Compat
import com.drivehub.app.core.VersionNegotiator
import com.drivehub.app.data.*
import com.drivehub.app.ui.*
import com.drivehub.app.ui.components.*
import com.drivehub.app.ui.theme.*
import com.drivehub.app.work.TAG_TRANSFER
import java.text.DateFormat
import java.util.Date

@Composable
fun PreviewScreen(vm: AppViewModel, item: FsItem, onClose: () -> Unit) {
    BackHandler { onClose() }
    Column(Modifier.fillMaxSize().background(Ink)) {
        TopAppBar(
            title = { Text(item.name, maxLines = 1, overflow = TextOverflow.Ellipsis) },
            navigationIcon = { IconButton(onClose) { Icon(Icons.AutoMirrored.Filled.ArrowBack, "back") } },
            actions = { IconButton({ vm.download(item) }) { Icon(Icons.Default.Download, "download") } },
            colors = TopAppBarDefaults.topAppBarColors(containerColor = Ink),
        )
        Box(Modifier.fillMaxSize(), Alignment.Center) {
            when (kindOf(item.name)) {
                "image" -> ImagePreview(vm, item)
                "video", "audio" -> MediaPreview(vm, item)
                "pdf" -> PdfPreview(vm, item)
                "text" -> TextPreview(vm, item)
                else -> Column(horizontalAlignment = Alignment.CenterHorizontally) {
                    FileGlyph(item, 72.dp)
                    Spacer(Modifier.height(12.dp))
                    Text("此类型暂不支持预览", color = TextSecondary)
                    Text(fmtSize(item.size), color = TextTertiary, style = MaterialTheme.typography.bodySmall)
                    Button({ vm.download(item) }, Modifier.padding(top = 16.dp), shape = PillShape) { Text("下载") }
                }
            }
        }
    }
}


@Composable
fun ImagePreview(vm: AppViewModel, item: FsItem) {
    val r by produceLoad(item.path) { vm.previewBitmap(item.path) }
    when {
        r == null -> CircularProgressIndicator(color = Neon)
        r!!.isFailure -> Text(vm.errText(r!!.exceptionOrNull()!!), Modifier.padding(16.dp))
        r!!.getOrNull() == null -> Text("无法解码图片", color = TextSecondary)
        else -> Image(r!!.getOrNull()!!.asImageBitmap(), item.name, Modifier.fillMaxSize(), contentScale = ContentScale.Fit)
    }
}

@Composable
fun TextPreview(vm: AppViewModel, item: FsItem) {
    val r by produceLoad(item.path) { vm.previewFile(item.path).readText().take(200_000) }
    when {
        r == null -> CircularProgressIndicator(color = Neon)
        r!!.isFailure -> Text(vm.errText(r!!.exceptionOrNull()!!), Modifier.padding(16.dp))
        else -> Text(r!!.getOrNull()!!, Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(16.dp), style = MaterialTheme.typography.bodySmall, color = TextPrimary)
    }
}

@Composable
fun PdfPreview(vm: AppViewModel, item: FsItem) {
    val r by produceLoad(item.path) {
        val f = vm.previewFile(item.path)
        kotlinx.coroutines.withContext(kotlinx.coroutines.Dispatchers.IO) {
            val pfd = android.os.ParcelFileDescriptor.open(f, android.os.ParcelFileDescriptor.MODE_READ_ONLY)
            val rd = android.graphics.pdf.PdfRenderer(pfd)
            val pages = (0 until rd.pageCount).map { i ->
                rd.openPage(i).use { p ->
                    val w = 1080; val h = (w.toFloat() * p.height / p.width).toInt()
                    val bmp = android.graphics.Bitmap.createBitmap(w, h, android.graphics.Bitmap.Config.ARGB_8888)
                    bmp.eraseColor(android.graphics.Color.WHITE)
                    p.render(bmp, null, null, android.graphics.pdf.PdfRenderer.Page.RENDER_MODE_FOR_DISPLAY); bmp
                }
            }
            rd.close(); pfd.close(); pages
        }
    }
    when {
        r == null -> CircularProgressIndicator(color = Neon)
        r!!.isFailure -> Text(vm.errText(r!!.exceptionOrNull()!!), Modifier.padding(16.dp))
        else -> LazyColumn(Modifier.fillMaxSize(), verticalArrangement = Arrangement.spacedBy(8.dp), contentPadding = PaddingValues(12.dp)) {
            items(r!!.getOrNull()!!) { b -> Image(b.asImageBitmap(), null, Modifier.fillMaxWidth().clip(RoundedCornerShape(8.dp)), contentScale = ContentScale.FillWidth) }
        }
    }
}

@Composable
fun MediaPreview(vm: AppViewModel, item: FsItem) {
    val ctx = LocalContext.current
    val api = vm.client() ?: return
    val player = remember(item.path) {
        val ds = androidx.media3.datasource.okhttp.OkHttpDataSource.Factory(ApiClient.defaultHttp()).setDefaultRequestProperties(api.clientHeaders())
        androidx.media3.exoplayer.ExoPlayer.Builder(ctx)
            .setMediaSourceFactory(androidx.media3.exoplayer.source.DefaultMediaSourceFactory(ctx).setDataSourceFactory(ds)).build().apply {
                setMediaItem(androidx.media3.common.MediaItem.fromUri(api.fileUrl(item.path, preview = true))); prepare(); playWhenReady = true
            }
    }
    DisposableEffect(player) { onDispose { player.release() } }
    AndroidView({ c -> androidx.media3.ui.PlayerView(c).apply { this.player = player } }, Modifier.fillMaxSize())
}
