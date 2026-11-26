package com.drivehub.app.ui.screens

import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.*
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.work.WorkInfo
import androidx.work.WorkManager
import com.drivehub.app.data.FsItem
import com.drivehub.app.data.OfflineCache
import com.drivehub.app.ui.components.*
import com.drivehub.app.ui.fmtSize
import com.drivehub.app.ui.kindOf
import com.drivehub.app.ui.theme.Dh
import com.drivehub.app.ui.theme.Motion
import com.drivehub.app.ui.theme.Radius
import com.drivehub.app.ui.theme.Space
import com.drivehub.app.ui.theme.kindTint
import com.drivehub.app.work.TAG_TRANSFER

@Composable
fun TransfersScreen() {
    val ctx = LocalContext.current
    val c = Dh.c
    val infos by WorkManager.getInstance(ctx).getWorkInfosByTagFlow(TAG_TRANSFER).collectAsStateWithLifecycle(emptyList())
    val downloadDir = OfflineCache.downloads(ctx).absolutePath
    val running = infos.count { it.state == WorkInfo.State.RUNNING }
    Column(Modifier.fillMaxSize()) {
        ScreenHeader("传输", if (infos.isEmpty()) null else "$running 个进行中 · 共 ${infos.size} 个") {
            HeaderAction(Icons.Default.CleaningServices, "清理已完成") { WorkManager.getInstance(ctx).pruneWork() }
        }
        if (infos.isEmpty()) {
            EmptyState(EmptyKind.Transfers, "没有传输任务", "上传与下载会在这里显示进度，断网后自动续传\n下载目录：$downloadDir", Modifier.padding(bottom = dockInset()))
        } else {
            LazyColumn(contentPadding = PaddingValues(start = 16.dp, end = 16.dp, top = 8.dp, bottom = dockInset()), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                items(infos.sortedByDescending { it.state == WorkInfo.State.RUNNING }, key = { it.id }) { w -> TransferCard(w) }
            }
        }
    }
}

@Composable
private fun TransferCard(w: WorkInfo) {
    val ctx = LocalContext.current
    val c = Dh.c
    val name = w.progress.getString("name") ?: w.outputData.getString("name") ?: w.id.toString().take(8)
    val done = w.progress.getLong("done", 0); val total = w.progress.getLong("total", 0)
    val upload = w.tags.any { it.contains("upload", ignoreCase = true) }
    val stateColor = when (w.state) {
        WorkInfo.State.SUCCEEDED -> c.success
        WorkInfo.State.FAILED -> c.danger
        WorkInfo.State.RUNNING -> c.accent
        else -> c.fg3
    }
    val frac by animateFloatAsState(if (total > 0) (done.toFloat() / total).coerceIn(0f, 1f) else 0f, Motion.medium(), label = "transfer")
    DhCard(Modifier.fillMaxWidth()) {
        Column(Modifier.padding(14.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Box(contentAlignment = Alignment.Center) {
                    FileGlyph(FsItem(name, name, false), 46.dp)
                    if (w.state == WorkInfo.State.RUNNING) {
                        if (total > 0) CircularProgressIndicator(progress = { frac }, Modifier.size(54.dp), color = c.accent, strokeWidth = 2.5.dp, trackColor = c.line, strokeCap = StrokeCap.Round)
                        else CircularProgressIndicator(Modifier.size(54.dp), color = c.accent, strokeWidth = 2.5.dp)
                    }
                }
                Spacer(Modifier.width(12.dp))
                Column(Modifier.weight(1f)) {
                    Text(name, style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.SemiBold, color = c.fg, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.padding(top = 4.dp)) {
                        StatusPill(
                            when (w.state) {
                                WorkInfo.State.SUCCEEDED -> "完成"
                                WorkInfo.State.FAILED -> "失败"
                                WorkInfo.State.RUNNING -> if (upload) "上传中" else "下载中"
                                WorkInfo.State.ENQUEUED -> "等待网络"
                                WorkInfo.State.CANCELLED -> "已取消"
                                else -> w.state.name
                            }, stateColor,
                        )
                        Spacer(Modifier.width(8.dp))
                        Text(
                            when (w.state) {
                                WorkInfo.State.RUNNING -> "${fmtSize(done)} / ${if (total > 0) fmtSize(total) else "?"}"
                                WorkInfo.State.ENQUEUED -> "已重试 ${w.runAttemptCount} 次"
                                else -> ""
                            }, color = c.fg3, style = MaterialTheme.typography.labelSmall,
                        )
                    }
                }
                if (!w.state.isFinished) HeaderAction(Icons.Default.Close, "取消") { WorkManager.getInstance(ctx).cancelWorkById(w.id) }
                else Icon(if (w.state == WorkInfo.State.SUCCEEDED) Icons.Default.CheckCircle else Icons.Default.ErrorOutline, null, Modifier.padding(12.dp), stateColor)
            }
            when (w.state) {
                WorkInfo.State.SUCCEEDED -> w.outputData.getString("file")?.let {
                    Text(it, color = c.fg3, style = MaterialTheme.typography.labelSmall, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(top = 8.dp))
                }
                WorkInfo.State.FAILED -> Text(w.outputData.getString("error") ?: "", color = c.danger, style = MaterialTheme.typography.labelSmall, modifier = Modifier.padding(top = 8.dp))
                WorkInfo.State.RUNNING -> if (total > 0) LinearProgressIndicator(
                    progress = { frac }, modifier = Modifier.fillMaxWidth().padding(top = 10.dp).height(4.dp).clip(Radius.pill),
                    color = c.kindTint(kindOf(name), false), trackColor = c.line, strokeCap = StrokeCap.Round, gapSize = 0.dp, drawStopIndicator = {},
                )
                else -> {}
            }
        }
    }
}
