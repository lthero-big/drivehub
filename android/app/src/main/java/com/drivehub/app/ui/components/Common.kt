@file:OptIn(androidx.compose.material3.ExperimentalMaterial3Api::class)

package com.drivehub.app.ui.components

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
import com.drivehub.app.ui.screens.*
import com.drivehub.app.ui.theme.*
import com.drivehub.app.work.TAG_TRANSFER
import java.text.DateFormat
import java.util.Date

fun fmtSize(n: Long): String = when {
    n < 1024 -> "$n B"; n < 1 shl 20 -> "%.1f KB".format(n / 1024.0)
    n < 1 shl 30 -> "%.1f MB".format(n / 1048576.0); else -> "%.2f GB".format(n / 1073741824.0)
}

fun copyText(ctx: Context, text: String) {
    (ctx.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager)
        .setPrimaryClip(ClipData.newPlainText("DriveHub", text))
}

internal val CardShape = RoundedCornerShape(18.dp)
internal val IconShape = RoundedCornerShape(14.dp)
internal val PillShape = RoundedCornerShape(50)


@Composable
internal fun BrandMark(modifier: Modifier = Modifier) {
    Box(
        modifier.size(72.dp).clip(RoundedCornerShape(22.dp)).background(Neon),
        contentAlignment = Alignment.Center,
    ) {
        Icon(Icons.Default.CloudQueue, null, Modifier.size(38.dp), Color(0xFF052315))
    }
}

@Composable
fun SheetItem(icon: ImageVector, label: String, tint: Color = TextPrimary, onClick: () -> Unit) {
    ListItem(
        headlineContent = { Text(label, color = tint) },
        modifier = Modifier.clickable { onClick() },
        leadingContent = { Icon(icon, null, tint = tint) },
        colors = ListItemDefaults.colors(containerColor = Color.Transparent),
    )
}

@Composable
fun FileGlyph(item: FsItem, size: Dp) {
    val kind = kindOf(item.name)
    val tint = kindTint(kind, item.isDir)
    Box(Modifier.size(size).clip(IconShape).background(tint.copy(alpha = 0.16f)), Alignment.Center) {
        Icon(if (item.isDir) Icons.Default.Folder else iconFor(item.name), null, Modifier.size(size * 0.5f), tint)
    }
}

internal fun fileSubtitle(it: FsItem): String = buildString {
    if (it.isDir) append("文件夹") else append(fmtSize(it.size))
    it.modifiedUnix?.let { t ->
        if (isNotEmpty()) append("  ·  ")
        append(DateFormat.getDateTimeInstance(DateFormat.SHORT, DateFormat.SHORT).format(Date(t * 1000)))
    }
}

@Composable
fun FileRow(it: FsItem, onClick: () -> Unit, onMore: () -> Unit) {
    ListItem(
        headlineContent = { Text(it.name, maxLines = 1, overflow = TextOverflow.Ellipsis, style = MaterialTheme.typography.titleMedium) },
        supportingContent = { Text(fileSubtitle(it), color = TextSecondary) },
        leadingContent = { FileGlyph(it, 48.dp) },
        trailingContent = { IconButton(onMore) { Icon(Icons.Default.MoreVert, "更多", tint = TextTertiary) } },
        modifier = Modifier.clickable { onClick() },
        colors = ListItemDefaults.colors(containerColor = Color.Transparent),
    )
}

@Composable
fun FileGridCell(it: FsItem, onClick: () -> Unit, onMore: () -> Unit) {
    Column(
        Modifier.clip(CardShape).clickable { onClick() }.padding(8.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Box(Modifier.fillMaxWidth(), contentAlignment = Alignment.TopCenter) {
            FileGlyph(it, 56.dp)
            IconButton(onMore, Modifier.align(Alignment.TopEnd).size(28.dp)) {
                Icon(Icons.Default.MoreVert, "更多", Modifier.size(16.dp), TextTertiary)
            }
        }
        Spacer(Modifier.height(8.dp))
        Text(it.name, maxLines = 2, overflow = TextOverflow.Ellipsis, style = MaterialTheme.typography.bodySmall, modifier = Modifier.fillMaxWidth())
    }
}

fun kindOf(name: String): String = when (name.substringAfterLast('.', "").lowercase()) {
    "jpg", "jpeg", "png", "gif", "webp", "bmp", "heic" -> "image"
    "mp4", "mkv", "webm", "mov", "m4v", "3gp" -> "video"
    "mp3", "m4a", "wav", "flac", "ogg", "aac" -> "audio"
    "pdf" -> "pdf"
    "txt", "md", "log", "json", "csv", "xml", "yml", "yaml", "toml", "rs", "kt", "py", "js", "ts" -> "text"
    else -> "other"
}

fun iconFor(name: String) = when (kindOf(name)) {
    "image" -> Icons.Default.Image
    "video" -> Icons.Default.Movie
    "audio" -> Icons.Default.MusicNote
    "pdf" -> Icons.Default.PictureAsPdf
    else -> Icons.AutoMirrored.Filled.InsertDriveFile
}

@Composable
internal fun EmptyHint(title: String, subtitle: String) {
    Column(Modifier.fillMaxSize().padding(32.dp), Arrangement.Center, Alignment.CenterHorizontally) {
        Text(title, style = MaterialTheme.typography.titleMedium, color = TextSecondary)
        Spacer(Modifier.height(6.dp))
        Text(subtitle, color = TextTertiary, style = MaterialTheme.typography.bodySmall)
    }
}

@Composable
internal fun <T> produceLoad(key: Any, block: suspend () -> T): State<Result<T>?> =
    produceState<Result<T>?>(null, key) { value = runCatching { block() } }
