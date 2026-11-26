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
fun SetupScreen(vm: AppViewModel, s: Stage.Setup) {
    var url by remember { mutableStateOf(vm.prefs.serverUrl ?: "") }
    Column(
        Modifier.fillMaxSize().padding(horizontal = 24.dp),
        verticalArrangement = Arrangement.Center,
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        BrandMark()
        Spacer(Modifier.height(20.dp))
        Text("DriveHub", style = MaterialTheme.typography.displaySmall)
        Text("连接你的网盘  ·  App ${BuildConfig.VERSION_NAME}", color = TextSecondary, style = MaterialTheme.typography.bodyMedium)
        Spacer(Modifier.height(32.dp))
        OutlinedTextField(
            url, { url = it },
            label = { Text("服务器地址") },
            placeholder = { Text("https://drive.example.com") },
            singleLine = true,
            shape = CardShape,
            modifier = Modifier.fillMaxWidth(),
        )
        s.error?.let { Text(it, color = MaterialTheme.colorScheme.error, modifier = Modifier.padding(top = 10.dp), style = MaterialTheme.typography.bodySmall) }
        Spacer(Modifier.height(20.dp))
        Button(
            { vm.connect(url) },
            enabled = url.isNotBlank() && !s.busy,
            modifier = Modifier.fillMaxWidth().height(52.dp),
            shape = CardShape,
        ) {
            if (s.busy) CircularProgressIndicator(Modifier.size(18.dp), color = MaterialTheme.colorScheme.onPrimary, strokeWidth = 2.dp)
            else Text("连接并检查版本", fontWeight = FontWeight.SemiBold)
        }
    }
}
@Composable
fun BlockedScreen(vm: AppViewModel, c: Compat) {
    Column(Modifier.fillMaxSize().padding(24.dp), Arrangement.Center, Alignment.CenterHorizontally) {
        Box(Modifier.size(72.dp).clip(CircleShape).background(Danger.copy(alpha = 0.16f)), Alignment.Center) {
            Icon(Icons.Default.SystemUpdate, null, Modifier.size(36.dp), Danger)
        }
        Spacer(Modifier.height(16.dp))
        Text(when (c) {
            is Compat.ClientTooOld -> "需要升级 App"
            is Compat.ServerTooOld -> "服务器版本过旧"
            else -> "无法使用此服务器"
        }, style = MaterialTheme.typography.headlineSmall)
        Spacer(Modifier.height(8.dp))
        Text(VersionNegotiator.message(c), color = TextSecondary, style = MaterialTheme.typography.bodyMedium)
        if (c is Compat.ClientTooOld) {
            Spacer(Modifier.height(16.dp))
            AppUpdateCard(vm, forced = true)
        }
        Spacer(Modifier.height(24.dp))
        Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            OutlinedButton({ vm.changeServer() }, shape = PillShape) { Text("更换服务器") }
            Button({ vm.boot() }, shape = PillShape) { Text("重试") }
        }
    }
}
