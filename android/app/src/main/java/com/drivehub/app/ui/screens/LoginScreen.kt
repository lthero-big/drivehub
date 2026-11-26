@file:OptIn(androidx.compose.material3.ExperimentalMaterial3Api::class)

package com.drivehub.app.ui.screens

import android.annotation.SuppressLint
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.net.Uri
import android.provider.OpenableColumns
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.activity.compose.BackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.InsertDriveFile
import androidx.compose.material.icons.automirrored.filled.Logout
import androidx.compose.material.icons.filled.*
import androidx.compose.material.icons.outlined.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.work.WorkInfo
import androidx.work.WorkManager
import com.drivehub.app.BuildConfig
import com.drivehub.app.core.Compat
import com.drivehub.app.core.VersionNegotiator
import com.drivehub.app.data.*
import com.drivehub.app.ui.*
import com.drivehub.app.ui.components.*
import com.drivehub.app.ui.theme.*
import com.drivehub.app.work.TAG_TRANSFER
import java.text.DateFormat
import java.util.Date

@Composable
fun LoginScreen(vm: AppViewModel, s: Stage.Login) {
    var user by remember { mutableStateOf(vm.prefs.username ?: "") }
    var pw by remember { mutableStateOf("") }
    var code by remember { mutableStateOf("") }
    var oauth by remember { mutableStateOf<String?>(null) }
    oauth?.let { p -> OAuthScreen(vm, p) { oauth = null }; return }
    Column(
        Modifier.fillMaxSize().padding(horizontal = 24.dp),
        verticalArrangement = Arrangement.Center,
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        BrandMark()
        Spacer(Modifier.height(16.dp))
        Text("欢迎回来", style = MaterialTheme.typography.headlineMedium)
        Text(vm.prefs.serverUrl ?: "", color = TextSecondary, style = MaterialTheme.typography.bodySmall, maxLines = 1, overflow = TextOverflow.Ellipsis)
        Spacer(Modifier.height(28.dp))
        if (!s.totpPending) {
            OutlinedTextField(user, { user = it }, label = { Text("用户名或邮箱") }, singleLine = true, shape = CardShape, modifier = Modifier.fillMaxWidth())
            Spacer(Modifier.height(10.dp))
            OutlinedTextField(
                pw, { pw = it }, label = { Text("密码") }, singleLine = true,
                visualTransformation = PasswordVisualTransformation(),
                shape = CardShape, modifier = Modifier.fillMaxWidth(),
            )
        } else {
            Text("该账号已启用两步验证，请输入验证码", color = TextSecondary, style = MaterialTheme.typography.bodyMedium)
            Spacer(Modifier.height(10.dp))
            OutlinedTextField(code, { code = it }, label = { Text("6 位验证码") }, singleLine = true, shape = CardShape, modifier = Modifier.fillMaxWidth())
        }
        s.error?.let { Text(it, color = MaterialTheme.colorScheme.error, modifier = Modifier.padding(top = 10.dp), style = MaterialTheme.typography.bodySmall) }
        Spacer(Modifier.height(20.dp))
        Button({
            when {
                s.totpPending && s.ticket != null -> vm.totpTicket(code)
                s.totpPending -> vm.login(user, pw, code)
                else -> vm.login(user, pw, null)
            }
        }, enabled = !s.busy, modifier = Modifier.fillMaxWidth().height(52.dp), shape = CardShape) {
            if (s.busy) CircularProgressIndicator(Modifier.size(18.dp), color = MaterialTheme.colorScheme.onPrimary, strokeWidth = 2.dp)
            else Text(if (s.totpPending) "验证" else "登录", fontWeight = FontWeight.SemiBold)
        }
        if (!s.totpPending) {
            s.providers.forEach { p ->
                OutlinedButton({ oauth = p }, modifier = Modifier.fillMaxWidth().padding(top = 8.dp), shape = CardShape) {
                    Text("使用 $p 登录")
                }
            }
            TextButton({ vm.changeServer() }) { Text("更换服务器", color = TextSecondary) }
        }
    }
}

@SuppressLint("SetJavaScriptEnabled")
@Composable
fun OAuthScreen(vm: AppViewModel, provider: String, onClose: () -> Unit) {
    val start = vm.client()?.oauthStartUrl(provider) ?: return
    Column(Modifier.fillMaxSize()) {
        TopAppBar(
            title = { Text("OAuth · $provider") },
            navigationIcon = { IconButton(onClose) { Icon(Icons.Default.Close, null) } },
            colors = TopAppBarDefaults.topAppBarColors(containerColor = Ink),
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
