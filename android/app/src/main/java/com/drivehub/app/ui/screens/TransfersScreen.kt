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
fun TransfersScreen() {
    val ctx = LocalContext.current
    val infos by WorkManager.getInstance(ctx).getWorkInfosByTagFlow(TAG_TRANSFER).collectAsStateWithLifecycle(emptyList())
    val downloadDir = OfflineCache.downloads(ctx).absolutePath
    Column(Modifier.fillMaxSize()) {
        Row(Modifier.fillMaxWidth().padding(start = 20.dp, end = 4.dp, top = 12.dp, bottom = 4.dp), verticalAlignment = Alignment.CenterVertically) {
            Text("传输", style = MaterialTheme.typography.headlineMedium, modifier = Modifier.weight(1f))
            IconButton({ WorkManager.getInstance(ctx).pruneWork() }) { Icon(Icons.Default.CleaningServices, "清理") }
        }
        if (infos.isEmpty()) {
            EmptyHint("没有传输任务", "下载的文件保存在\n$downloadDir")
        } else {
            LazyColumn(contentPadding = PaddingValues(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                items(infos.sortedByDescending { it.state == WorkInfo.State.RUNNING }, key = { it.id }) { w ->
                    val name = w.progress.getString("name") ?: w.outputData.getString("name") ?: w.id.toString().take(8)
                    val done = w.progress.getLong("done", 0); val total = w.progress.getLong("total", 0)
                    Surface(shape = CardShape, color = MaterialTheme.colorScheme.surfaceVariant, modifier = Modifier.fillMaxWidth()) {
                        Column(Modifier.padding(16.dp)) {
                            Row(verticalAlignment = Alignment.CenterVertically) {
                                Icon(
                                    when (w.state) {
                                        WorkInfo.State.SUCCEEDED -> Icons.Default.CheckCircle
                                        WorkInfo.State.FAILED -> Icons.Default.Error
                                        WorkInfo.State.RUNNING -> Icons.Default.Downloading
                                        else -> Icons.Default.Schedule
                                    },
                                    null,
                                    tint = when (w.state) {
                                        WorkInfo.State.SUCCEEDED -> Neon
                                        WorkInfo.State.FAILED -> Danger
                                        WorkInfo.State.RUNNING -> Neon
                                        else -> TextSecondary
                                    },
                                )
                                Spacer(Modifier.width(10.dp))
                                Text(name, style = MaterialTheme.typography.titleSmall, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
                                if (!w.state.isFinished) IconButton({ WorkManager.getInstance(ctx).cancelWorkById(w.id) }) { Icon(Icons.Default.Close, "取消") }
                            }
                            Spacer(Modifier.height(6.dp))
                            Text(
                                when (w.state) {
                                    WorkInfo.State.SUCCEEDED -> "完成" + (w.outputData.getString("file")?.let { "  →  $it" } ?: "")
                                    WorkInfo.State.FAILED -> "失败：${w.outputData.getString("error") ?: ""}"
                                    WorkInfo.State.ENQUEUED -> "等待网络 / 重试中（已重试 ${w.runAttemptCount} 次）"
                                    WorkInfo.State.RUNNING -> "${fmtSize(done)} / ${if (total > 0) fmtSize(total) else "?"}"
                                    else -> w.state.name
                                },
                                color = TextSecondary,
                                style = MaterialTheme.typography.bodySmall,
                            )
                            if (w.state == WorkInfo.State.RUNNING && total > 0) {
                                Spacer(Modifier.height(8.dp))
                                LinearProgressIndicator(progress = { done.toFloat() / total }, modifier = Modifier.fillMaxWidth(), color = Neon, trackColor = InkChip)
                            }
                        }
                    }
                }
            }
        }
    }
}
