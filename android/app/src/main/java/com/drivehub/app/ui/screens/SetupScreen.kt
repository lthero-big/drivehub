package com.drivehub.app.ui.screens

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Dns
import androidx.compose.material.icons.filled.SystemUpdate
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import com.drivehub.app.BuildConfig
import com.drivehub.app.core.Compat
import com.drivehub.app.core.VersionNegotiator
import com.drivehub.app.ui.AppViewModel
import com.drivehub.app.ui.Stage
import com.drivehub.app.ui.components.*
import com.drivehub.app.ui.theme.Dh

/** Shared centred column for pre-login screens (handles system bars and keyboard). */
@Composable
internal fun AuthColumn(content: @Composable ColumnScope.() -> Unit) {
    Column(
        Modifier.fillMaxSize().systemBarsPadding().imePadding().verticalScroll(rememberScrollState()).padding(horizontal = 24.dp, vertical = 24.dp),
        verticalArrangement = Arrangement.Center,
        horizontalAlignment = Alignment.CenterHorizontally,
        content = content,
    )
}

@Composable
fun SetupScreen(vm: AppViewModel, s: Stage.Setup) {
    val c = Dh.c
    var url by remember { mutableStateOf(vm.prefs.serverUrl ?: "") }
    AuthColumn {
        Spacer(Modifier.height(40.dp))
        BrandMark()
        Spacer(Modifier.height(20.dp))
        Text("DriveHub", style = MaterialTheme.typography.displaySmall, color = c.fg)
        Text("一个入口，连接你所有的网盘", color = c.fg2, style = MaterialTheme.typography.bodyMedium)
        Spacer(Modifier.height(32.dp))
        DhCard(Modifier.fillMaxWidth()) {
            Column(Modifier.padding(16.dp)) {
                DhTextField(
                    url, { url = it }, "服务器地址", Modifier.fillMaxWidth(), leading = Icons.Default.Dns,
                    placeholder = "https://drive.example.com",
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri, imeAction = ImeAction.Go),
                    keyboardActions = KeyboardActions(onGo = { if (url.isNotBlank()) vm.connect(url) }),
                )
                s.error?.let { Text(it, color = c.danger, modifier = Modifier.padding(top = 10.dp), style = MaterialTheme.typography.bodySmall) }
                Spacer(Modifier.height(16.dp))
                MorphStatusButton(
                    if (s.busy) MorphState.Busy("正在协商版本…") else MorphState.Idle("连接并检查版本"),
                    Modifier.fillMaxWidth(), enabled = url.isNotBlank(),
                ) { vm.connect(url) }
            }
        }
        Spacer(Modifier.height(20.dp))
        Text("App ${BuildConfig.VERSION_NAME}  ·  API v${BuildConfig.API_VERSION}", color = c.fg3, style = MaterialTheme.typography.labelSmall)
    }
}

@Composable
fun BlockedScreen(vm: AppViewModel, comp: Compat) {
    val c = Dh.c
    AuthColumn {
        Box(Modifier.size(72.dp).clip(CircleShape).background(c.accentSoft), Alignment.Center) {
            Icon(Icons.Default.SystemUpdate, null, Modifier.size(34.dp), c.accent)
        }
        Spacer(Modifier.height(18.dp))
        Text(
            when (comp) {
                is Compat.ClientTooOld -> "需要升级 App"
                is Compat.ServerTooOld -> "服务器版本过旧"
                else -> "无法使用此服务器"
            }, style = MaterialTheme.typography.headlineSmall, color = c.fg,
        )
        Spacer(Modifier.height(8.dp))
        Text(VersionNegotiator.message(comp), color = c.fg2, style = MaterialTheme.typography.bodyMedium, textAlign = TextAlign.Center)
        if (comp is Compat.ClientTooOld) {
            Spacer(Modifier.height(20.dp))
            AppUpdateCard(vm, forced = true)
        }
        Spacer(Modifier.height(24.dp))
        Row(horizontalArrangement = Arrangement.spacedBy(12.dp), verticalAlignment = Alignment.CenterVertically) {
            TextButton({ vm.changeServer() }) { Text("更换服务器", color = c.fg2) }
            MorphStatusButton(MorphState.Idle("重试"), height = 44.dp) { vm.boot() }
        }
    }
}
