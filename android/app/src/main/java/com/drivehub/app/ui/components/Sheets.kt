package com.drivehub.app.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.Logout
import androidx.compose.material.icons.filled.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.drivehub.app.data.FsItem
import com.drivehub.app.data.Share
import com.drivehub.app.ui.theme.Dh
import com.drivehub.app.ui.theme.Radius

/** Modal sheet on the paper canvas: grouped cards sit on it, slim neutral handle. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun DhSheet(onDismiss: () -> Unit, content: @Composable ColumnScope.() -> Unit) {
    val c = Dh.c
    ModalBottomSheet(
        onDismissRequest = onDismiss,
        sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true),
        shape = Radius.sheet,
        containerColor = c.bg,
        scrimColor = c.scrim,
        dragHandle = { Box(Modifier.padding(top = 8.dp, bottom = 8.dp).size(36.dp, 5.dp).clip(Radius.pill).background(c.fg3.copy(alpha = 0.35f))) },
    ) {
        Column(Modifier.fillMaxWidth().padding(horizontal = 16.dp).padding(bottom = 24.dp), content = content)
    }
}

/** Header used by file sheets: thumbnail + name + meta. */
@Composable
fun SheetFileHeader(item: FsItem) {
    val c = Dh.c
    Row(Modifier.fillMaxWidth().padding(horizontal = 4.dp, vertical = 6.dp), verticalAlignment = Alignment.CenterVertically) {
        FileThumb(item, Modifier.size(44.dp), Radius.sm, glyph = 24.dp)
        Spacer(Modifier.width(12.dp))
        Column(Modifier.weight(1f)) {
            Text(item.name, style = MaterialTheme.typography.titleMedium, color = c.fg, maxLines = 2, overflow = TextOverflow.Ellipsis)
            Text(fileSubtitle(item), color = c.fg3, style = MaterialTheme.typography.bodySmall)
        }
    }
}

/** File action sheet: one grouped card of actions, the destructive action in its own card. */
@Composable
fun FileActionSheet(
    item: FsItem,
    onDismiss: () -> Unit,
    onPreview: () -> Unit,
    onDownload: () -> Unit,
    onShare: () -> Unit,
    onRename: () -> Unit,
    onDelete: () -> Unit,
) {
    val c = Dh.c
    DhSheet(onDismiss) {
        SheetFileHeader(item)
        Spacer(Modifier.height(12.dp))
        GroupCard {
            if (!item.isDir) {
                GroupRow(Icons.Default.Visibility, "预览", first = true, trailing = null, onClick = onPreview)
                GroupRow(Icons.Default.Download, "下载", trailing = null, onClick = onDownload)
            }
            GroupRow(Icons.Default.IosShare, "分享", first = item.isDir, trailing = null, onClick = onShare)
            GroupRow(Icons.Default.Edit, "重命名", trailing = null, onClick = onRename)
        }
        Spacer(Modifier.height(12.dp))
        GroupCard {
            GroupRow(Icons.Default.DeleteOutline, "删除", tint = c.danger, iconTint = c.danger, first = true, trailing = null, onClick = onDelete)
        }
    }
}

/** "+" sheet: upload / new folder as two plain rows. */
@Composable
fun AddSheet(onDismiss: () -> Unit, onUpload: () -> Unit, onMkdir: () -> Unit) {
    val c = Dh.c
    DhSheet(onDismiss) {
        Text("添加到此文件夹", style = MaterialTheme.typography.titleMedium, color = c.fg, modifier = Modifier.padding(start = 4.dp, top = 4.dp, bottom = 12.dp))
        GroupCard {
            GroupRow(Icons.Default.CloudUpload, "上传文件", "支持多选 · 断点续传", first = true, trailing = null, onClick = onUpload)
            GroupRow(Icons.Default.CreateNewFolder, "新建文件夹", trailing = null, onClick = onMkdir)
        }
    }
}

@Composable
private fun GroupScope.RadioRow(icon: androidx.compose.ui.graphics.vector.ImageVector, title: String, desc: String, selected: Boolean, first: Boolean = false, onClick: () -> Unit) {
    val c = Dh.c
    GroupRow(icon, title, desc, first = first, trailing = { if (selected) Icon(Icons.Default.Check, "已选", Modifier.size(20.dp), c.accent) }, onClick = onClick)
}

/** Apple-style segmented control on the secondary fill. */
@Composable
fun <T> Segmented(options: List<Pair<T, String>>, selected: T, onPick: (T) -> Unit, modifier: Modifier = Modifier) {
    val c = Dh.c
    Row(modifier.fillMaxWidth().clip(Radius.md).background(c.surface2).padding(3.dp)) {
        options.forEach { (v, l) ->
            val on = v == selected
            Text(
                l, color = if (on) c.fg else c.fg2, style = MaterialTheme.typography.labelLarge,
                fontWeight = if (on) FontWeight.SemiBold else FontWeight.Medium, textAlign = TextAlign.Center,
                modifier = Modifier.weight(1f).clip(Radius.sm).background(if (on) c.surface else c.surface2)
                    .clickable { onPick(v) }.padding(vertical = 7.dp),
            )
        }
    }
}

/** Create-share sheet: permission rows, validity segments, PIN switch. */
@Composable
fun ShareSheet(item: FsItem, onDismiss: () -> Unit, onOk: (String, Long?, Boolean) -> Unit) {
    val c = Dh.c
    var perm by remember { mutableStateOf("download") }
    var days by remember { mutableStateOf<Long?>(7) }
    var pin by remember { mutableStateOf(true) }
    DhSheet(onDismiss) {
        Column(Modifier.verticalScroll(rememberScrollState())) {
            Text("创建分享", style = MaterialTheme.typography.titleLarge, color = c.fg, modifier = Modifier.padding(start = 4.dp, top = 4.dp))
            Text(item.name, color = c.fg3, style = MaterialTheme.typography.bodySmall, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(start = 4.dp))
            SectionLabel("访问权限")
            GroupCard {
                RadioRow(Icons.Default.Visibility, "仅预览", "对方只能在线查看", perm == "preview", first = true) { perm = "preview" }
                RadioRow(Icons.Default.Download, "可下载", "允许保存到本地", perm == "download") { perm = "download" }
                if (item.isDir) RadioRow(Icons.Default.Upload, "收集上传", "对方可向此文件夹上传", perm == "upload") { perm = "upload" }
            }
            SectionLabel("有效期")
            Segmented(listOf<Pair<Long?, String>>(1L to "1 天", 7L to "7 天", 30L to "30 天", null to "永久"), days, { days = it })
            Spacer(Modifier.height(16.dp))
            GroupCard {
                GroupRow(Icons.Default.Password, "随机提取码 PIN", "对方领取时需要输入提取码", first = true,
                    trailing = { DhSwitch(pin) { pin = it } }, onClick = { pin = !pin })
            }
            Spacer(Modifier.height(20.dp))
            MorphStatusButton(MorphState.Idle("创建分享"), Modifier.fillMaxWidth()) { onOk(perm, days, pin) }
        }
    }
}

/** Result dialog: the pickup code large and monospaced on the secondary fill, with copy actions. */
@Composable
fun ShareCreatedDialog(s: Share, onDismiss: () -> Unit) {
    val c = Dh.c
    val ctx = LocalContext.current
    AlertDialog(
        onDismiss,
        icon = { Icon(Icons.Default.CheckCircle, null, Modifier.size(32.dp), c.success) },
        title = { Text("分享已创建", color = c.fg) },
        text = {
            Column(horizontalAlignment = Alignment.CenterHorizontally, modifier = Modifier.fillMaxWidth()) {
                Text("取件码", color = c.fg3, style = MaterialTheme.typography.labelMedium)
                Text(
                    s.pickupCode, color = c.fg, fontFamily = FontFamily.Monospace, fontSize = 28.sp, fontWeight = FontWeight.SemiBold, letterSpacing = 4.sp,
                    modifier = Modifier.padding(vertical = 8.dp).clip(Radius.md).background(c.surface2).padding(horizontal = 18.dp, vertical = 8.dp),
                )
                Text(s.urlWithPin ?: s.url, color = c.fg3, style = MaterialTheme.typography.bodySmall, maxLines = 2, overflow = TextOverflow.Ellipsis, textAlign = TextAlign.Center)
            }
        },
        confirmButton = { TextButton({ copyText(ctx, s.pickupCode); onDismiss() }) { Text("复制取件码", color = c.accent) } },
        dismissButton = { TextButton({ copyText(ctx, s.urlWithPin ?: s.url); onDismiss() }) { Text("复制链接", color = c.fg2) } },
        containerColor = c.surface,
        shape = Radius.xl,
    )
}

@Composable
fun TextDialog(title: String, initial: String, onDismiss: () -> Unit, onOk: (String) -> Unit) {
    val c = Dh.c
    var v by remember { mutableStateOf(initial) }
    AlertDialog(
        onDismiss,
        title = { Text(title, color = c.fg) },
        text = { DhTextField(v, { v = it }, "名称", Modifier.fillMaxWidth()) },
        confirmButton = { TextButton({ if (v.isNotBlank()) onOk(v.trim()) }) { Text("确定", color = c.accent) } },
        dismissButton = { TextButton(onDismiss) { Text("取消", color = c.fg2) } },
        containerColor = c.surface,
        shape = Radius.xl,
    )
}

@Composable
fun ConfirmDeleteDialog(name: String, onDismiss: () -> Unit, onConfirm: () -> Unit) {
    val c = Dh.c
    AlertDialog(
        onDismiss,
        title = { Text("删除“$name”？", color = c.fg) },
        text = { Text("此操作无法撤销。", color = c.fg2) },
        confirmButton = { TextButton(onConfirm) { Text("删除", color = c.danger) } },
        dismissButton = { TextButton(onDismiss) { Text("取消", color = c.fg2) } },
        containerColor = c.surface,
        shape = Radius.xl,
    )
}

/** Avatar sheet: account summary plus the in-app update card (opened from the 「浏览」 avatar). */
@Composable
fun AccountSheet(
    user: String,
    server: String,
    serverVersion: String?,
    onDismiss: () -> Unit,
    onLogout: () -> Unit,
    update: @Composable () -> Unit,
) {
    val c = Dh.c
    DhSheet(onDismiss) {
        Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.padding(horizontal = 4.dp, vertical = 6.dp)) {
            Avatar(user.firstOrNull()?.uppercaseChar()?.toString() ?: "D", 48.dp, false)
            Spacer(Modifier.width(12.dp))
            Column(Modifier.weight(1f)) {
                Text(user.ifBlank { "已登录" }, style = MaterialTheme.typography.titleMedium, color = c.fg)
                Text(server, color = c.fg2, style = MaterialTheme.typography.bodySmall, maxLines = 1, overflow = TextOverflow.Ellipsis)
                serverVersion?.let { Text("服务器 $it", color = c.fg3, style = MaterialTheme.typography.labelSmall) }
            }
        }
        Spacer(Modifier.height(12.dp))
        update()
        Spacer(Modifier.height(12.dp))
        GroupCard { GroupRow(Icons.AutoMirrored.Filled.Logout, "退出登录", null, tint = c.danger, iconTint = c.danger, first = true, trailing = null, onClick = onLogout) }
    }
}
