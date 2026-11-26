package com.drivehub.app.ui.screens

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.*
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.drivehub.app.data.FsItem
import com.drivehub.app.ui.AppViewModel
import com.drivehub.app.ui.components.*
import com.drivehub.app.ui.fmtSize
import com.drivehub.app.ui.theme.Dh
import com.drivehub.app.ui.theme.Radius

@Composable
fun PickupScreen(vm: AppViewModel, onClose: (() -> Unit)? = null) {
    val st by vm.pickup.collectAsStateWithLifecycle()
    val c = Dh.c
    var code by remember { mutableStateOf("") }
    var pin by remember { mutableStateOf("") }
    val open = st.open
    if (onClose != null) BackHandler { if (open != null) vm.pickupClose() else onClose() }
    Column(Modifier.fillMaxSize().statusBarsPadding().navigationBarsPadding().imePadding()) {
        Row(Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 8.dp), verticalAlignment = Alignment.CenterVertically) {
            GlassIconButton(if (open != null) Icons.Default.Close else Icons.AutoMirrored.Filled.ArrowBack, "关闭") {
                when {
                    open != null -> vm.pickupClose()
                    onClose != null -> onClose()
                }
            }
            Spacer(Modifier.width(12.dp))
            Column(Modifier.weight(1f)) {
                Text(if (open == null) "取件码领取" else (open.name ?: open.code), style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.Bold, color = c.fg, maxLines = 1, overflow = TextOverflow.Ellipsis)
                open?.owner?.let { Text("来自 $it", color = c.fg3, style = MaterialTheme.typography.bodySmall) }
            }
        }
        if (open == null) {
            Column(Modifier.padding(20.dp), verticalArrangement = Arrangement.spacedBy(14.dp), horizontalAlignment = Alignment.CenterHorizontally) {
                EmptyIllustration(EmptyKind.Shares)
                Text("输入好友给你的取件码或分享链接", color = c.fg2, style = MaterialTheme.typography.bodyMedium)
                DhCard(Modifier.fillMaxWidth()) {
                    Column(Modifier.padding(18.dp), verticalArrangement = Arrangement.spacedBy(14.dp)) {
                        DhTextField(code, { code = it }, "取件码或分享链接", Modifier.fillMaxWidth(), leading = Icons.Default.Key)
                        if (st.needPin) DhTextField(pin, { pin = it }, "提取码 PIN", Modifier.fillMaxWidth(), leading = Icons.Default.Password)
                        st.error?.let { Text(it, color = c.danger, style = MaterialTheme.typography.bodySmall) }
                        MorphStatusButton(if (st.busy) MorphState.Busy("领取中…") else MorphState.Idle("领取", Icons.Default.Inbox), Modifier.fillMaxWidth(), enabled = code.isNotBlank()) { vm.claim(code, pin) }
                    }
                }
            }
        } else {
            BackHandler(enabled = st.path != "/") { vm.pickupBrowse(null) }
            LazyColumn(contentPadding = PaddingValues(horizontal = 8.dp, vertical = 8.dp)) {
                if (st.path != "/") item {
                    PickupRow(FsItem("返回上一级", "..", true), "", null) { vm.pickupBrowse(null) }
                }
                items(st.items) { i ->
                    val fake = FsItem(i.name, i.path, i.isDir, i.size, null)
                    val canDl = !i.isDir && open.allowDownload && !i.missing
                    PickupRow(
                        fake,
                        when { i.isDir -> "文件夹"; i.missing -> "文件已不存在"; else -> fmtSize(i.size) },
                        if (canDl) ({ vm.pickupDownload(i) }) else null,
                    ) { if (i.isDir) vm.pickupBrowse(i) }
                }
            }
        }
    }
}

@Composable
private fun PickupRow(item: FsItem, meta: String, onDownload: (() -> Unit)?, onClick: () -> Unit) {
    val c = Dh.c
    Row(
        Modifier.fillMaxWidth().clip(Radius.md).clickable(onClick = onClick).padding(horizontal = 12.dp, vertical = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        FileGlyph(item, 48.dp)
        Spacer(Modifier.width(14.dp))
        Column(Modifier.weight(1f)) {
            Text(item.name, color = c.fg, style = MaterialTheme.typography.titleSmall, maxLines = 1, overflow = TextOverflow.Ellipsis)
            if (meta.isNotEmpty()) Text(meta, color = c.fg3, style = MaterialTheme.typography.bodySmall)
        }
        onDownload?.let { HeaderAction(Icons.Default.Download, "下载", c.accent, it) }
    }
}
