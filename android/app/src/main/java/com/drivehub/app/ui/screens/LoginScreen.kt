@file:OptIn(androidx.compose.material3.ExperimentalMaterial3Api::class)

package com.drivehub.app.ui.screens

import android.annotation.SuppressLint
import android.net.Uri
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import com.drivehub.app.ui.AppViewModel
import com.drivehub.app.ui.Stage
import com.drivehub.app.ui.components.*
import com.drivehub.app.ui.theme.Dh
import com.drivehub.app.ui.theme.Radius

@Composable
fun LoginScreen(vm: AppViewModel, s: Stage.Login) {
    val c = Dh.c
    var user by remember { mutableStateOf(vm.prefs.username ?: "") }
    var pw by remember { mutableStateOf("") }
    var code by remember { mutableStateOf("") }
    var oauth by remember { mutableStateOf<String?>(null) }
    oauth?.let { p -> OAuthScreen(vm, p) { oauth = null }; return }
    val submit = {
        when {
            s.totpPending && s.ticket != null -> vm.totpTicket(code)
            s.totpPending -> vm.login(user, pw, code)
            else -> vm.login(user, pw, null)
        }
    }
    AuthColumn {
        BrandMark(size = 64.dp)
        Spacer(Modifier.height(18.dp))
        Text(if (s.totpPending) "两步验证" else "欢迎回来", style = MaterialTheme.typography.headlineMedium, color = c.fg)
        Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.padding(top = 6.dp)) {
            StatusPill(vm.prefs.serverUrl?.removePrefix("https://")?.removePrefix("http://") ?: "", c.success)
        }
        Spacer(Modifier.height(28.dp))
        DhCard(Modifier.fillMaxWidth()) {
            Column(Modifier.padding(18.dp), verticalArrangement = Arrangement.spacedBy(14.dp)) {
                if (!s.totpPending) {
                    DhTextField(user, { user = it }, "用户名或邮箱", Modifier.fillMaxWidth(), leading = Icons.Default.Person)
                    DhTextField(
                        pw, { pw = it }, "密码", Modifier.fillMaxWidth(), leading = Icons.Default.Lock,
                        visualTransformation = PasswordVisualTransformation(),
                        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password),
                    )
                } else {
                    Text("该账号已启用两步验证，请输入身份验证器中的 6 位验证码", color = c.fg2, style = MaterialTheme.typography.bodyMedium)
                    DhTextField(code, { code = it.filter(Char::isDigit).take(6) }, "6 位验证码", Modifier.fillMaxWidth(), leading = Icons.Default.Pin,
                        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.NumberPassword))
                }
                s.error?.let { Text(it, color = c.danger, style = MaterialTheme.typography.bodySmall) }
                MorphStatusButton(
                    if (s.busy) MorphState.Busy() else MorphState.Idle(if (s.totpPending) "验证" else "登录"),
                    Modifier.fillMaxWidth(),
                ) { submit() }
            }
        }
        if (!s.totpPending) {
            if (s.providers.isNotEmpty()) {
                Row(Modifier.fillMaxWidth().padding(vertical = 18.dp), verticalAlignment = Alignment.CenterVertically) {
                    HorizontalDivider(Modifier.weight(1f), color = c.line)
                    Text("  或使用  ", color = c.fg3, style = MaterialTheme.typography.labelMedium)
                    HorizontalDivider(Modifier.weight(1f), color = c.line)
                }
                s.providers.forEach { p ->
                    Row(
                        Modifier.fillMaxWidth().padding(bottom = 10.dp).height(50.dp).clip(Radius.pill).border(1.dp, c.lineStrong, Radius.pill).clickable { oauth = p },
                        horizontalArrangement = Arrangement.Center, verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Icon(Icons.Default.Key, null, Modifier.size(18.dp), c.fg2)
                        Spacer(Modifier.width(8.dp))
                        Text("使用 $p 登录", color = c.fg, style = MaterialTheme.typography.labelLarge)
                    }
                }
            }
            TextButton({ vm.changeServer() }, Modifier.padding(top = 6.dp)) { Text("更换服务器", color = c.fg2) }
        }
    }
}

@SuppressLint("SetJavaScriptEnabled")
@Composable
fun OAuthScreen(vm: AppViewModel, provider: String, onClose: () -> Unit) {
    val c = Dh.c
    val start = vm.client()?.oauthStartUrl(provider) ?: return
    Column(Modifier.fillMaxSize().statusBarsPadding()) {
        TopAppBar(
            title = { Text("OAuth · $provider", maxLines = 1, overflow = TextOverflow.Ellipsis) },
            navigationIcon = { IconButton(onClose) { Icon(Icons.Default.Close, "关闭") } },
            colors = TopAppBarDefaults.topAppBarColors(containerColor = c.bg, titleContentColor = c.fg, navigationIconContentColor = c.fg),
            windowInsets = WindowInsets(0),
        )
        AndroidView(factory = { ctx ->
            WebView(ctx).apply {
                settings.javaScriptEnabled = true
                webViewClient = object : WebViewClient() {
                    private fun handle(url: String): Boolean {
                        val i = url.indexOf("#/oauth?")
                        if (i < 0) return false
                        val params = url.substring(i + 8).split('&').filter { it.contains('=') }.associate {
                            Uri.decode(it.substringBefore('=').replace('+', ' ')) to Uri.decode(it.substringAfter('=').replace('+', ' '))
                        }
                        vm.oauthResult(params); onClose(); return true
                    }
                    override fun shouldOverrideUrlLoading(v: WebView, r: WebResourceRequest) = handle(r.url.toString())
                    override fun onPageStarted(v: WebView, url: String, f: android.graphics.Bitmap?) { if (handle(url)) v.stopLoading() }
                }
                loadUrl(start)
            }
        }, modifier = Modifier.fillMaxSize())
    }
}
