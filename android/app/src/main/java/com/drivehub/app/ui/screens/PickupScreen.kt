package com.drivehub.app.ui.screens

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.background
import androidx.compose.material.icons.Icons
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

@Composable
fun PickupScreen(vm: AppViewModel, onClose: (() -> Unit)? = null) {
    val st by vm.pickup.collectAsStateWithLifecycle()
    val c = Dh.c
    var code by remember { mutableStateOf("") }
    var pin by remember { mutableStateOf("") }
    val open = st.open
    if (onClose != null) BackHandler { if (open != null) vm.pickupClose() else onClose() }
    Column(Modifier.fillMaxSize().background(c.bg).navigationBarsPadding().imePadding()) {
        ScreenHeader(
            if (open == null) "取件码领取" else (open.name ?: open.code), open?.owner?.let { "来自 $it" },
            leading = {
                BackLink(if (open != null) "关闭" else "返回") {
                    when {
                        open != null -> vm.pickupClose()
                        onClose != null -> onClose()
                    }
                }
            },
        )
        if (open == null) {
            Column(Modifier.padding(horizontal = 16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                Text("输入好友给你的取件码或分享链接", color = c.fg2, style = MaterialTheme.typography.bodyMedium, modifier = Modifier.padding(start = 4.dp))
                DhCard(Modifier.fillMaxWidth()) {
                    Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(14.dp)) {
                        DhTextField(code, { code = it }, "取件码或分享链接", Modifier.fillMaxWidth(), leading = Icons.Default.Key)
                        if (st.needPin) DhTextField(pin, { pin = it }, "提取码 PIN", Modifier.fillMaxWidth(), leading = Icons.Default.Password)
                        st.error?.let { Text(it, color = c.danger, style = MaterialTheme.typography.bodySmall) }
                        MorphStatusButton(if (st.busy) MorphState.Busy("领取中…") else MorphState.Idle("领取"), Modifier.fillMaxWidth(), enabled = code.isNotBlank()) { vm.claim(code, pin) }
                    }
                }
            }
        } else {
            BackHandler(enabled = st.path != "/") { vm.pickupBrowse(null) }
            val rows = buildList {
                if (st.path != "/") add(null)
                addAll(st.items)
            }
            LazyColumn(contentPadding = PaddingValues(top = 8.dp, bottom = 24.dp)) {
                itemsIndexed(rows) { idx, i ->
                    val m = Modifier.padding(horizontal = 16.dp).groupItem(idx == 0, idx == rows.lastIndex, c, 64.dp)
                    if (i == null) PickupRow(FsItem("返回上一级", "..", true), "", null, m) { vm.pickupBrowse(null) }
                    else {
                        val canDl = !i.isDir && open.allowDownload && !i.missing
                        PickupRow(
                            FsItem(i.name, i.path, i.isDir, i.size, null),
                            when { i.isDir -> "文件夹"; i.missing -> "文件已不存在"; else -> fmtSize(i.size) },
                            if (canDl) ({ vm.pickupDownload(i) }) else null, m,
                        ) { if (i.isDir) vm.pickupBrowse(i) }
                    }
                }
            }
        }
    }
}

@Composable
private fun PickupRow(item: FsItem, meta: String, onDownload: (() -> Unit)?, modifier: Modifier, onClick: () -> Unit) {
    val c = Dh.c
    Row(
        modifier.fillMaxWidth().clickable(onClick = onClick).padding(start = 14.dp, end = 4.dp, top = 10.dp, bottom = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        FileGlyph(item, 36.dp)
        Spacer(Modifier.width(14.dp))
        Column(Modifier.weight(1f)) {
            Text(item.name, color = c.fg, style = MaterialTheme.typography.bodyLarge, maxLines = 1, overflow = TextOverflow.Ellipsis)
            if (meta.isNotEmpty()) Text(meta, color = c.fg3, style = MaterialTheme.typography.bodySmall)
        }
        onDownload?.let { HeaderAction(Icons.Default.Download, "下载", c.accent, it) }
    }
}
