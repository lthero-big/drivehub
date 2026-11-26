package com.drivehub.app.ui.screens

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.Logout
import androidx.compose.material.icons.filled.*
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.drivehub.app.BuildConfig
import com.drivehub.app.ui.AppViewModel
import com.drivehub.app.ui.components.*
import com.drivehub.app.ui.theme.Dh
import com.drivehub.app.ui.theme.ThemeMode

private fun themeIcon(m: ThemeMode): ImageVector = when (m) {
    ThemeMode.System -> Icons.Default.BrightnessAuto
    ThemeMode.Light -> Icons.Default.LightMode
    ThemeMode.Dark -> Icons.Default.DarkMode
}

/** 「我的」: profile card, update card and Grouped Inset settings (appearance, tools, account). */
@Composable
fun MeScreen(vm: AppViewModel, onPickup: () -> Unit) {
    val info by vm.serverInfo.collectAsStateWithLifecycle()
    val mode by vm.themeMode.collectAsStateWithLifecycle()
    val thumbs by vm.thumbnails.collectAsStateWithLifecycle()
    val upd by vm.appUpdate.collectAsStateWithLifecycle()
    val c = Dh.c
    val user = vm.prefs.username.orEmpty()
    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState())) {
        ScreenHeader("我的")
        Column(Modifier.padding(horizontal = 16.dp)) {
            DhCard(Modifier.fillMaxWidth()) {
                Row(Modifier.padding(14.dp), verticalAlignment = Alignment.CenterVertically) {
                    Avatar(user.firstOrNull()?.uppercaseChar()?.toString() ?: "D", 52.dp, upd.pkg != null)
                    Spacer(Modifier.width(14.dp))
                    Column(Modifier.weight(1f)) {
                        Text(user.ifBlank { "已登录" }, style = MaterialTheme.typography.titleMedium, color = c.fg, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        Text(vm.prefs.serverUrl ?: "", color = c.fg2, style = MaterialTheme.typography.bodySmall, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        info?.let { Text("服务器 ${it.serverVersion} · API v${it.apiVersion}", color = c.fg3, style = MaterialTheme.typography.labelSmall, modifier = Modifier.padding(top = 2.dp)) }
                    }
                }
            }
            if (upd.pkg != null || upd.checking || upd.error != null) {
                Spacer(Modifier.height(12.dp))
                AppUpdateCard(vm)
            }
            SectionLabel("外观")
            GroupCard {
                ThemeMode.entries.forEachIndexed { i, m ->
                    GroupRow(
                        themeIcon(m), m.label, m.caption, first = i == 0,
                        trailing = { if (m == mode) Icon(Icons.Default.Check, "当前", Modifier.size(20.dp), c.accent) },
                        onClick = { vm.setTheme(m) },
                    )
                }
            }
            Spacer(Modifier.height(12.dp))
            GroupCard {
                GroupRow(Icons.Default.PhotoLibrary, "显示图片 / 视频缩略图", "15 MB 以内的媒体会下载原文件并缓存", first = true,
                    trailing = { DhSwitch(thumbs) { vm.setThumbnails(it) } },
                    onClick = { vm.setThumbnails(!thumbs) })
            }
            SectionLabel("工具")
            GroupCard {
                GroupRow(Icons.Default.Key, "取件码领取", "用取件码或链接领取文件", first = true, onClick = onPickup)
                GroupRow(Icons.Default.SystemUpdate, "检查更新", "App ${BuildConfig.VERSION_NAME}") { vm.refreshAppUpdate() }
            }
            SectionLabel("账户")
            GroupCard {
                GroupRow(Icons.Default.Dns, "更换服务器", vm.prefs.serverUrl ?: "", first = true) { vm.changeServer() }
                GroupRow(Icons.AutoMirrored.Filled.Logout, "退出登录", null, tint = c.danger, iconTint = c.danger, trailing = null) { vm.logout() }
            }
            Text(
                "DriveHub App ${BuildConfig.VERSION_NAME} · API v${BuildConfig.API_VERSION}",
                color = c.fg3, style = MaterialTheme.typography.labelSmall,
                modifier = Modifier.padding(top = 20.dp, bottom = 24.dp).align(Alignment.CenterHorizontally),
            )
        }
    }
}
