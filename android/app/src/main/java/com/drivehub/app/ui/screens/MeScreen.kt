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
fun MeScreen(vm: AppViewModel, onPickup: () -> Unit) {
    val info by vm.serverInfo.collectAsStateWithLifecycle()
    val user = vm.prefs.username.orEmpty()
    val initial = user.firstOrNull()?.uppercaseChar()?.toString() ?: "D"
    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(horizontal = 16.dp, vertical = 12.dp)) {
        Text("我的", style = MaterialTheme.typography.headlineMedium, modifier = Modifier.padding(horizontal = 4.dp, vertical = 8.dp))
        Surface(shape = CardShape, color = MaterialTheme.colorScheme.surfaceVariant, modifier = Modifier.fillMaxWidth()) {
            Row(Modifier.padding(16.dp), verticalAlignment = Alignment.CenterVertically) {
                Box(Modifier.size(56.dp).clip(CircleShape).background(Neon), Alignment.Center) {
                    Text(initial, color = Color(0xFF052315), style = MaterialTheme.typography.headlineSmall)
                }
                Spacer(Modifier.width(14.dp))
                Column(Modifier.weight(1f)) {
                    Text(user.ifBlank { "已登录" }, style = MaterialTheme.typography.titleLarge, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    Text(vm.prefs.serverUrl ?: "", color = TextSecondary, style = MaterialTheme.typography.bodySmall, maxLines = 2, overflow = TextOverflow.Ellipsis)
                    info?.let {
                        Text("服务器 ${it.serverVersion}  ·  API v${it.apiVersion}", color = TextTertiary, style = MaterialTheme.typography.labelSmall)
                    }
                }
            }
        }
        Spacer(Modifier.height(16.dp))
        AppUpdateCard(vm)
        Spacer(Modifier.height(12.dp))
        Surface(shape = CardShape, color = MaterialTheme.colorScheme.surfaceVariant, modifier = Modifier.fillMaxWidth()) {
            Column {
                MeRow(Icons.Default.Key, "取件码领取", "用取件码或链接领取文件", onClick = onPickup)
                HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)
                MeRow(Icons.Default.SystemUpdate, "检查更新", "App ${BuildConfig.VERSION_NAME}") { vm.refreshAppUpdate() }
            }
        }
        Spacer(Modifier.height(12.dp))
        Surface(shape = CardShape, color = MaterialTheme.colorScheme.surfaceVariant, modifier = Modifier.fillMaxWidth()) {
            Column {
                MeRow(Icons.Default.Dns, "更换服务器", vm.prefs.serverUrl ?: "") { vm.changeServer() }
                HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)
                MeRow(Icons.AutoMirrored.Filled.Logout, "退出登录", null, tint = Danger) { vm.logout() }
            }
        }
        Text(
            "DriveHub App ${BuildConfig.VERSION_NAME}  ·  API v${BuildConfig.API_VERSION}",
            color = TextTertiary,
            style = MaterialTheme.typography.labelSmall,
            modifier = Modifier.padding(16.dp).align(Alignment.CenterHorizontally),
        )
    }
}

@Composable
internal fun MeRow(icon: ImageVector, title: String, subtitle: String?, tint: Color = TextPrimary, onClick: () -> Unit) {
    ListItem(
        headlineContent = { Text(title, color = tint) },
        supportingContent = subtitle?.let { { Text(it, color = TextSecondary, maxLines = 1, overflow = TextOverflow.Ellipsis) } },
        leadingContent = { Icon(icon, null, tint = tint) },
        trailingContent = { Icon(Icons.Default.ChevronRight, null, tint = TextTertiary) },
        modifier = Modifier.clickable { onClick() },
        colors = ListItemDefaults.colors(containerColor = Color.Transparent),
    )
}
