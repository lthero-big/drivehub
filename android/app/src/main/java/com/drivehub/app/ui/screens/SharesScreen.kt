package com.drivehub.app.ui.screens

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.*
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.drivehub.app.data.Share
import com.drivehub.app.ui.AppViewModel
import com.drivehub.app.ui.components.*
import com.drivehub.app.ui.theme.Dh
import com.drivehub.app.ui.theme.Radius
import com.drivehub.app.ui.theme.Space

@Composable
fun SharesScreen(vm: AppViewModel, onPickup: () -> Unit) {
    val list by vm.shares.collectAsStateWithLifecycle()
    val err by vm.sharesError.collectAsStateWithLifecycle()
    val c = Dh.c
    LaunchedEffect(Unit) { vm.loadShares() }
    Column(Modifier.fillMaxSize()) {
        ScreenHeader("分享", if (list.isEmpty()) null else "${list.count { it.status == "active" && !it.revoked }} 个生效中 · 共 ${list.size} 个") {
            TextButton(onPickup) { Text("取件", color = c.accent) }
            HeaderAction(Icons.Default.Refresh, "刷新") { vm.loadShares() }
        }
        err?.let { StatusPill(it, c.danger, Modifier.padding(horizontal = 20.dp, vertical = 4.dp)) }
        if (list.isEmpty() && err == null) {
            EmptyState(EmptyKind.Shares, "还没有分享", "在文件上点「更多 → 分享」即可生成取件码", Modifier.padding(bottom = dockInset())) {
                MorphStatusButton(MorphState.Idle("用取件码领取", Icons.Default.Key), height = 44.dp, onClick = onPickup)
            }
        } else {
            LazyColumn(contentPadding = PaddingValues(start = 16.dp, end = 16.dp, top = 8.dp, bottom = dockInset()), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                items(list, key = { it.id }) { s -> ShareCard(s, vm) }
            }
        }
    }
}

@Composable
private fun ShareCard(s: Share, vm: AppViewModel) {
    val c = Dh.c
    val ctx = LocalContext.current
    val active = s.status == "active" && !s.revoked
    val (permIcon, permLabel, permTint) = when (s.perm) {
        "preview" -> Triple(Icons.Default.Visibility, "仅预览", c.image)
        "upload" -> Triple(Icons.Default.Upload, "收集上传", c.video)
        else -> Triple(Icons.Default.Download, "可下载", c.accent)
    }
    DhCard(Modifier.fillMaxWidth()) {
        Column(Modifier.padding(16.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                IconTile(permIcon, permTint, 44.dp)
                Spacer(Modifier.width(12.dp))
                Column(Modifier.weight(1f)) {
                    Text(s.name?.ifBlank { null } ?: s.items.firstOrNull()?.substringAfterLast('/') ?: s.code, style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.SemiBold, color = c.fg, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.padding(top = 4.dp)) {
                        StatusPill(if (active) "生效中" else if (s.revoked) "已撤销" else s.status, if (active) c.success else c.fg3)
                        Spacer(Modifier.width(6.dp))
                        StatusPill(permLabel, permTint, dot = false)
                        if (s.hasPin) { Spacer(Modifier.width(6.dp)); StatusPill("PIN", c.warning, dot = false) }
                    }
                }
            }
            Spacer(Modifier.height(12.dp))
            Row(
                Modifier.fillMaxWidth().clip(Radius.md).background(c.surfaceSunken).padding(start = 14.dp, end = 4.dp, top = 4.dp, bottom = 4.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Column(Modifier.weight(1f)) {
                    Text("取件码", color = c.fg3, style = MaterialTheme.typography.labelSmall)
                    Text(s.pickupCode, color = if (active) c.accent else c.fg3, fontFamily = FontFamily.Monospace, fontSize = 20.sp, fontWeight = FontWeight.Bold, letterSpacing = 2.sp)
                }
                HeaderAction(Icons.Default.ContentCopy, "复制取件码") { copyText(ctx, s.pickupCode); vm.message.value = "已复制取件码" }
                HeaderAction(Icons.Default.Link, "复制链接") { copyText(ctx, s.urlWithPin ?: s.url); vm.message.value = "已复制分享链接" }
            }
            Spacer(Modifier.height(10.dp))
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text("访问 ${s.visits}  ·  下载 ${s.downloads}", color = c.fg3, style = MaterialTheme.typography.labelSmall, modifier = Modifier.weight(1f))
                if (!s.revoked) HeaderAction(Icons.Default.Block, "撤销", c.fg2) { vm.revoke(s) }
                HeaderAction(Icons.Default.DeleteOutline, "删除", c.danger) { vm.deleteShare(s) }
            }
        }
    }
}
