package com.drivehub.app.ui.screens

import androidx.compose.animation.animateColorAsState
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.Logout
import androidx.compose.material.icons.filled.*
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Switch
import androidx.compose.material3.SwitchDefaults
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.drivehub.app.BuildConfig
import com.drivehub.app.ui.AppViewModel
import com.drivehub.app.ui.components.*
import com.drivehub.app.ui.theme.*

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
                Row(Modifier.padding(16.dp), verticalAlignment = Alignment.CenterVertically) {
                    Avatar(user.firstOrNull()?.uppercaseChar()?.toString() ?: "D", 58, upd.pkg != null)
                    Spacer(Modifier.width(14.dp))
                    Column(Modifier.weight(1f)) {
                        Text(user.ifBlank { "已登录" }, style = MaterialTheme.typography.titleLarge, color = c.fg, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        Text(vm.prefs.serverUrl ?: "", color = c.fg2, style = MaterialTheme.typography.bodySmall, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        info?.let {
                            Row(Modifier.padding(top = 6.dp)) {
                                StatusPill("服务器 ${it.serverVersion}", c.success)
                                Spacer(Modifier.width(6.dp))
                                StatusPill("API v${it.apiVersion}", c.fg2, dot = false)
                            }
                        }
                    }
                }
            }
            Spacer(Modifier.height(12.dp))
            AppUpdateCard(vm)
            SectionLabel("外观", Modifier.padding(top = 8.dp))
            ThemePicker(mode) { vm.setTheme(it) }
            Spacer(Modifier.height(10.dp))
            GroupCard {
                GroupRow(Icons.Default.PhotoLibrary, "显示图片 / 视频缩略图", "15 MB 以内的媒体会下载原文件并缓存", first = true,
                    trailing = { Switch(thumbs, { vm.setThumbnails(it) }, colors = SwitchDefaults.colors(checkedThumbColor = c.onAccent, checkedTrackColor = c.accent)) },
                    onClick = { vm.setThumbnails(!thumbs) })
            }
            SectionLabel("工具", Modifier.padding(top = 8.dp))
            GroupCard {
                GroupRow(Icons.Default.Key, "取件码领取", "用取件码或链接领取文件", first = true, onClick = onPickup)
                GroupRow(Icons.Default.SystemUpdate, "检查更新", "App ${BuildConfig.VERSION_NAME}") { vm.refreshAppUpdate() }
            }
            SectionLabel("账户", Modifier.padding(top = 8.dp))
            GroupCard {
                GroupRow(Icons.Default.Dns, "更换服务器", vm.prefs.serverUrl ?: "", iconTint = c.image, first = true) { vm.changeServer() }
                GroupRow(Icons.AutoMirrored.Filled.Logout, "退出登录", null, tint = c.danger, iconTint = c.danger, trailing = null) { vm.logout() }
            }
            Text(
                "DriveHub App ${BuildConfig.VERSION_NAME}  ·  API v${BuildConfig.API_VERSION}",
                color = c.fg3, style = MaterialTheme.typography.labelSmall,
                modifier = Modifier.padding(top = 16.dp).align(Alignment.CenterHorizontally),
            )
            Spacer(Modifier.height(dockInset()))
        }
    }
}

/** Theme cards with a mini preview of each palette; switching is instant and persisted. */
@Composable
fun ThemePicker(current: ThemeMode, onPick: (ThemeMode) -> Unit) {
    Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
        ThemeMode.entries.chunked(2).forEach { row ->
            Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                row.forEach { m -> ThemeCard(m, m == current, Modifier.weight(1f)) { onPick(m) } }
            }
        }
    }
}

@Composable
private fun ThemeCard(m: ThemeMode, selected: Boolean, modifier: Modifier, onClick: () -> Unit) {
    val c = Dh.c
    val border by animateColorAsState(if (selected) c.accent else c.line, Motion.short(), label = "themeBorder")
    Column(
        modifier.clip(Radius.lg).background(c.surface).border(if (selected) 2.dp else 1.dp, border, Radius.lg).clickable(onClick = onClick).padding(10.dp),
    ) {
        Box(Modifier.fillMaxWidth().height(64.dp).clip(Radius.md)) {
            if (m == ThemeMode.System) {
                Row(Modifier.fillMaxSize()) {
                    MiniPreview(PaperColors, Modifier.weight(1f).fillMaxHeight())
                    MiniPreview(MidnightColors, Modifier.weight(1f).fillMaxHeight())
                }
            } else MiniPreview(colorsFor(m, false), Modifier.fillMaxSize())
            if (selected) Box(Modifier.align(Alignment.TopEnd).padding(6.dp).size(20.dp).clip(CircleShape).background(c.accent), Alignment.Center) {
                Icon(Icons.Default.Check, null, Modifier.size(13.dp), c.onAccent)
            }
        }
        Spacer(Modifier.height(8.dp))
        Text(m.label, color = c.fg, style = MaterialTheme.typography.labelLarge, fontWeight = FontWeight.SemiBold)
        Text(m.caption, color = c.fg3, style = MaterialTheme.typography.labelSmall, maxLines = 1, overflow = TextOverflow.Ellipsis)
    }
}

@Composable
private fun MiniPreview(p: DhColors, modifier: Modifier) {
    Box(modifier.background(p.bg)) {
        Box(Modifier.align(Alignment.TopStart).padding(8.dp).size(28.dp, 8.dp).clip(Radius.pill).background(p.fg.copy(alpha = 0.85f)))
        Row(Modifier.align(Alignment.BottomStart).padding(8.dp), horizontalArrangement = Arrangement.spacedBy(4.dp)) {
            Box(Modifier.size(18.dp).clip(Radius.xs).background(p.surfaceHigh).border(1.dp, p.line, Radius.xs))
            Box(Modifier.size(18.dp).clip(Radius.xs).background(p.folder))
        }
        Box(Modifier.align(Alignment.BottomEnd).padding(8.dp).size(16.dp).clip(CircleShape).background(p.accent))
    }
}
