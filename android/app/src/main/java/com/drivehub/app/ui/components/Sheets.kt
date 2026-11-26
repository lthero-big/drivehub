package com.drivehub.app.ui.components

import androidx.compose.animation.animateColorAsState
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.Logout
import androidx.compose.material.icons.filled.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.geometry.RoundRect
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Outline
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.PathOperation
import androidx.compose.ui.graphics.Shape
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Density
import androidx.compose.ui.unit.LayoutDirection
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.drivehub.app.data.FsItem
import com.drivehub.app.data.Share
import com.drivehub.app.ui.theme.Dh
import com.drivehub.app.ui.theme.Motion
import com.drivehub.app.ui.theme.Radius

/** Theme-styled modal sheet with a slim handle. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun DhSheet(onDismiss: () -> Unit, content: @Composable ColumnScope.() -> Unit) {
    val c = Dh.c
    ModalBottomSheet(
        onDismissRequest = onDismiss,
        sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true),
        shape = Radius.sheet,
        containerColor = c.surface,
        scrimColor = c.scrim,
        dragHandle = { Box(Modifier.padding(top = 10.dp, bottom = 6.dp).size(40.dp, 4.dp).clip(Radius.pill).background(c.lineStrong)) },
    ) {
        Column(Modifier.fillMaxWidth().padding(horizontal = 20.dp).padding(bottom = 28.dp), content = content)
    }
}

/** Header used by file sheets: thumbnail + name + meta. */
@Composable
fun SheetFileHeader(item: FsItem) {
    val c = Dh.c
    Row(Modifier.fillMaxWidth().padding(vertical = 8.dp), verticalAlignment = Alignment.CenterVertically) {
        FileThumb(item, Modifier.size(56.dp), Radius.md, glyph = 28.dp, badges = false)
        Spacer(Modifier.width(14.dp))
        Column(Modifier.weight(1f)) {
            Text(item.name, style = MaterialTheme.typography.titleMedium, color = c.fg, maxLines = 2, overflow = TextOverflow.Ellipsis)
            Text(fileSubtitle(item), color = c.fg2, style = MaterialTheme.typography.bodySmall)
        }
    }
}

@Composable
private fun QuickAction(icon: ImageVector, label: String, tint: Color, modifier: Modifier, onClick: () -> Unit) {
    val c = Dh.c
    Column(
        modifier.clip(Radius.md).background(c.surfaceHigh).border(1.dp, c.line, Radius.md).clickable(onClick = onClick).padding(vertical = 14.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Icon(icon, null, Modifier.size(24.dp), tint)
        Spacer(Modifier.height(6.dp))
        Text(label, color = c.fg, style = MaterialTheme.typography.labelMedium)
    }
}

/** "More" sheet for a file: quick-action tiles on top, destructive action set apart below. */
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
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            if (!item.isDir) QuickAction(Icons.Default.Visibility, "预览", c.accent, Modifier.weight(1f), onPreview)
            if (!item.isDir) QuickAction(Icons.Default.Download, "下载", c.image, Modifier.weight(1f), onDownload)
            QuickAction(Icons.Default.Share, "分享", c.video, Modifier.weight(1f), onShare)
            QuickAction(Icons.Default.Edit, "重命名", c.folder, Modifier.weight(1f), onRename)
        }
        Spacer(Modifier.height(12.dp))
        GroupCard {
            GroupRow(Icons.Default.DeleteOutline, "删除", "移除后无法恢复", tint = c.danger, iconTint = c.danger, first = true, onClick = onDelete)
        }
    }
}

/** "+" sheet: two large tiles. */
@Composable
fun AddSheet(onDismiss: () -> Unit, onUpload: () -> Unit, onMkdir: () -> Unit) {
    val c = Dh.c
    DhSheet(onDismiss) {
        Text("添加到当前文件夹", style = MaterialTheme.typography.titleMedium, color = c.fg, modifier = Modifier.padding(vertical = 8.dp))
        Row(Modifier.fillMaxWidth().padding(top = 8.dp), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            BigTile(Icons.Default.CloudUpload, "上传文件", "支持多选 · 断点续传", c.accent, Modifier.weight(1f), onUpload)
            BigTile(Icons.Default.CreateNewFolder, "新建文件夹", "整理你的文件", c.folder, Modifier.weight(1f), onMkdir)
        }
    }
}

@Composable
private fun BigTile(icon: ImageVector, title: String, sub: String, tint: Color, modifier: Modifier, onClick: () -> Unit) {
    val c = Dh.c
    Column(modifier.clip(Radius.lg).background(tint.copy(alpha = 0.10f)).border(1.dp, tint.copy(alpha = 0.25f), Radius.lg).clickable(onClick = onClick).padding(16.dp)) {
        IconTile(icon, tint, 46.dp, filled = true)
        Spacer(Modifier.height(18.dp))
        Text(title, color = c.fg, style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.SemiBold)
        Text(sub, color = c.fg2, style = MaterialTheme.typography.bodySmall)
    }
}

/** Ticket outline: rounded rectangle with semicircle notches on both sides (Luma ticket select). */
class TicketShape(private val corner: Float, private val notch: Float) : Shape {
    override fun createOutline(size: Size, layoutDirection: LayoutDirection, density: Density): Outline {
        val r = with(density) { corner.dp.toPx() }; val n = with(density) { notch.dp.toPx() }
        val base = Path().apply { addRoundRect(RoundRect(Rect(Offset.Zero, size), CornerRadius(r))) }
        val holes = Path().apply {
            addOval(Rect(Offset(-n, size.height / 2 - n), Size(n * 2, n * 2)))
            addOval(Rect(Offset(size.width - n, size.height / 2 - n), Size(n * 2, n * 2)))
        }
        return Outline.Generic(Path().apply { op(base, holes, PathOperation.Difference) })
    }
}

@Composable
private fun TicketOption(icon: ImageVector, title: String, desc: String, selected: Boolean, onClick: () -> Unit) {
    val c = Dh.c
    val shape = remember { TicketShape(18f, 9f) }
    val border by animateColorAsState(if (selected) c.accent else c.line, Motion.short(), label = "ticketBorder")
    val bg by animateColorAsState(if (selected) c.accentSoft else c.surfaceHigh, Motion.short(), label = "ticketBg")
    Row(
        Modifier.fillMaxWidth().clip(shape).background(bg).border(if (selected) 1.5.dp else 1.dp, border, shape)
            .clickable(onClick = onClick).padding(horizontal = 18.dp, vertical = 14.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        IconTile(icon, if (selected) c.accent else c.fg2, 40.dp, shape = Radius.sm)
        Spacer(Modifier.width(14.dp))
        Column(Modifier.weight(1f)) {
            Text(title, color = c.fg, style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.SemiBold)
            Text(desc, color = c.fg2, style = MaterialTheme.typography.bodySmall)
        }
        Box(
            Modifier.size(22.dp).clip(CircleShape).background(if (selected) c.accent else Color.Transparent)
                .border(1.5.dp, if (selected) c.accent else c.lineStrong, CircleShape),
            Alignment.Center,
        ) { if (selected) Icon(Icons.Default.Check, null, Modifier.size(14.dp), c.onAccent) }
    }
}

/** Create-share sheet: permission tickets, validity chips, PIN switch. */
@Composable
fun ShareSheet(item: FsItem, onDismiss: () -> Unit, onOk: (String, Long?, Boolean) -> Unit) {
    val c = Dh.c
    var perm by remember { mutableStateOf("download") }
    var days by remember { mutableStateOf<Long?>(7) }
    var pin by remember { mutableStateOf(true) }
    DhSheet(onDismiss) {
        Column(Modifier.verticalScroll(rememberScrollState())) {
            Text("创建分享", style = MaterialTheme.typography.titleLarge, color = c.fg, modifier = Modifier.padding(top = 4.dp))
            Text(item.name, color = c.fg2, style = MaterialTheme.typography.bodySmall, maxLines = 1, overflow = TextOverflow.Ellipsis)
            SectionLabel("访问权限", Modifier.padding(top = 10.dp))
            Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                TicketOption(Icons.Default.Visibility, "仅预览", "对方只能在线查看", perm == "preview") { perm = "preview" }
                TicketOption(Icons.Default.Download, "可下载", "允许保存到本地", perm == "download") { perm = "download" }
                if (item.isDir) TicketOption(Icons.Default.Upload, "收集上传", "对方可向此文件夹上传", perm == "upload") { perm = "upload" }
            }
            SectionLabel("有效期", Modifier.padding(top = 10.dp))
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                listOf<Pair<Long?, String>>(1L to "1 天", 7L to "7 天", 30L to "30 天", null to "永久").forEach { (d, l) ->
                    val on = days == d
                    Text(
                        l, color = if (on) c.bg else c.fg2, style = MaterialTheme.typography.labelLarge,
                        modifier = Modifier.clip(Radius.pill).background(if (on) c.fg else c.surfaceHigh)
                            .border(1.dp, if (on) Color.Transparent else c.line, Radius.pill)
                            .clickable { days = d }.padding(horizontal = 16.dp, vertical = 9.dp),
                    )
                }
            }
            Spacer(Modifier.height(14.dp))
            GroupCard {
                GroupRow(Icons.Default.Password, "随机提取码 PIN", "对方领取时需要输入提取码", first = true,
                    trailing = { Switch(pin, { pin = it }, colors = SwitchDefaults.colors(checkedThumbColor = c.onAccent, checkedTrackColor = c.accent)) },
                    onClick = { pin = !pin })
            }
            Spacer(Modifier.height(18.dp))
            MorphStatusButton(MorphState.Idle("创建分享", Icons.Default.Link), Modifier.fillMaxWidth()) { onOk(perm, days, pin) }
        }
    }
}

/** Result dialog: the pickup code rendered large and monospaced, with copy actions. */
@Composable
fun ShareCreatedDialog(s: Share, onDismiss: () -> Unit) {
    val c = Dh.c
    val ctx = LocalContext.current
    AlertDialog(
        onDismiss,
        icon = { IconTile(Icons.Default.CheckCircle, c.success, 48.dp) },
        title = { Text("分享已创建", color = c.fg) },
        text = {
            Column(horizontalAlignment = Alignment.CenterHorizontally, modifier = Modifier.fillMaxWidth()) {
                Text("取件码", color = c.fg2, style = MaterialTheme.typography.labelMedium)
                Text(
                    s.pickupCode, color = c.accent, fontFamily = FontFamily.Monospace, fontSize = 30.sp, fontWeight = FontWeight.Bold, letterSpacing = 4.sp,
                    modifier = Modifier.padding(vertical = 8.dp).clip(Radius.md).background(c.accentSoft).padding(horizontal = 18.dp, vertical = 8.dp),
                )
                Text(s.urlWithPin ?: s.url, color = c.fg2, style = MaterialTheme.typography.bodySmall, maxLines = 2, overflow = TextOverflow.Ellipsis)
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
        text = { DhTextField(v, { v = it }, "名称", Modifier.fillMaxWidth(), leading = Icons.Default.Edit) },
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
        icon = { IconTile(Icons.Default.DeleteOutline, c.danger, 48.dp) },
        title = { Text("删除 $name？", color = c.fg) },
        text = { Text("此操作无法撤销。", color = c.fg2) },
        confirmButton = { TextButton(onConfirm) { Text("删除", color = c.danger) } },
        dismissButton = { TextButton(onDismiss) { Text("取消", color = c.fg2) } },
        containerColor = c.surface,
        shape = Radius.xl,
    )
}

/** Avatar sheet: account summary plus the in-app update card (opened from the search bar badge). */
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
        Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.padding(vertical = 8.dp)) {
            Avatar(user.firstOrNull()?.uppercaseChar()?.toString() ?: "D", 52, false)
            Spacer(Modifier.width(14.dp))
            Column(Modifier.weight(1f)) {
                Text(user.ifBlank { "已登录" }, style = MaterialTheme.typography.titleMedium, color = c.fg)
                Text(server, color = c.fg2, style = MaterialTheme.typography.bodySmall, maxLines = 1, overflow = TextOverflow.Ellipsis)
                serverVersion?.let { Text("服务器 $it", color = c.fg3, style = MaterialTheme.typography.labelSmall) }
            }
        }
        Spacer(Modifier.height(12.dp))
        update()
        Spacer(Modifier.height(12.dp))
        GroupCard { GroupRow(Icons.AutoMirrored.Filled.Logout, "退出登录", null, tint = c.danger, iconTint = c.danger, first = true, onClick = onLogout) }
    }
}
