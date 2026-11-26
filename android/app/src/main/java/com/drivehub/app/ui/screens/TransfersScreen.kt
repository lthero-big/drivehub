package com.drivehub.app.ui.screens

import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.*
import androidx.compose.material3.TextButton
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
import com.drivehub.app.ui.theme.Dh
import com.drivehub.app.ui.theme.Motion
import com.drivehub.app.ui.theme.Radius
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
            if (infos.any { it.state.isFinished }) TextButton({ WorkManager.getInstance(ctx).pruneWork() }) { Text("清理已完成", color = c.fg2) }
        }
        if (infos.isEmpty()) {
            EmptyState(EmptyKind.Transfers, "没有传输任务", "上传与下载会在这里显示进度，断网后自动续传\n下载目录：$downloadDir")
        } else {
            val list = infos.sortedByDescending { it.state == WorkInfo.State.RUNNING }
            LazyColumn(contentPadding = PaddingValues(top = 8.dp, bottom = 24.dp)) {
                itemsIndexed(list, key = { _, w -> w.id }) { i, w ->
                    TransferRow(w, Modifier.padding(horizontal = 16.dp).groupItem(i == 0, i == list.lastIndex, c, 64.dp))
                }
            }
        }
    }
}

/** One transfer in the grouped list: glyph, name, status line, 4 dp brand-red progress bar. */
@Composable
private fun TransferRow(w: WorkInfo, modifier: Modifier) {
    val ctx = LocalContext.current
    val c = Dh.c
    val name = w.progress.getString("name") ?: w.outputData.getString("name") ?: w.id.toString().take(8)
    val done = w.progress.getLong("done", 0); val total = w.progress.getLong("total", 0)
    val upload = w.tags.any { it.contains("upload", ignoreCase = true) }
    val frac by animateFloatAsState(if (total > 0) (done.toFloat() / total).coerceIn(0f, 1f) else 0f, Motion.medium(), label = "transfer")
    val status = when (w.state) {
        WorkInfo.State.SUCCEEDED -> "完成"
        WorkInfo.State.FAILED -> "失败" + (w.outputData.getString("error")?.let { " · $it" } ?: "")
        WorkInfo.State.RUNNING -> (if (upload) "上传中" else "下载中") + " · ${fmtSize(done)} / ${if (total > 0) fmtSize(total) else "?"}"
        WorkInfo.State.ENQUEUED -> "等待网络 · 已重试 ${w.runAttemptCount} 次"
        WorkInfo.State.CANCELLED -> "已取消"
        else -> w.state.name
    }
    Column(modifier.fillMaxWidth().padding(start = 14.dp, end = 4.dp, top = 10.dp, bottom = 10.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            FileGlyph(FsItem(name, name, false), 36.dp)
            Spacer(Modifier.width(14.dp))
            Column(Modifier.weight(1f)) {
                Text(name, style = MaterialTheme.typography.bodyLarge, color = c.fg, maxLines = 1, overflow = TextOverflow.Ellipsis)
                Text(status, color = if (w.state == WorkInfo.State.FAILED) c.danger else c.fg3, style = MaterialTheme.typography.bodySmall, maxLines = 2, overflow = TextOverflow.Ellipsis)
            }
            if (!w.state.isFinished) HeaderAction(Icons.Default.Close, "取消", c.fg3) { WorkManager.getInstance(ctx).cancelWorkById(w.id) }
            else Icon(
                if (w.state == WorkInfo.State.SUCCEEDED) Icons.Default.CheckCircle else Icons.Default.ErrorOutline, null,
                Modifier.padding(12.dp).size(20.dp), if (w.state == WorkInfo.State.SUCCEEDED) c.success else c.fg3,
            )
        }
        if (w.state == WorkInfo.State.SUCCEEDED) w.outputData.getString("file")?.let {
            Text(it, color = c.fg3, style = MaterialTheme.typography.labelSmall, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(start = 50.dp, end = 10.dp, top = 4.dp))
        }
        if (w.state == WorkInfo.State.RUNNING) {
            val barMod = Modifier.padding(start = 50.dp, end = 10.dp, top = 8.dp).fillMaxWidth().height(4.dp).clip(Radius.pill)
            if (total > 0) LinearProgressIndicator(progress = { frac }, modifier = barMod, color = c.accent, trackColor = c.surface2, strokeCap = StrokeCap.Round, gapSize = 0.dp, drawStopIndicator = {})
            else LinearProgressIndicator(modifier = barMod, color = c.accent, trackColor = c.surface2, strokeCap = StrokeCap.Round, gapSize = 0.dp)
        }
    }
}
