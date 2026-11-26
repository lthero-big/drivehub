@file:OptIn(androidx.compose.material3.ExperimentalMaterial3Api::class)

package com.drivehub.app.ui.components

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
import com.drivehub.app.ui.screens.*
import com.drivehub.app.ui.theme.*
import com.drivehub.app.work.TAG_TRANSFER
import java.text.DateFormat
import java.util.Date

@Composable
fun AppUpdateCard(vm: AppViewModel, forced: Boolean = false) {
    val st by vm.appUpdate.collectAsStateWithLifecycle()
    val launchSettings = rememberLauncherForActivityResult(ActivityResultContracts.StartActivityForResult()) { vm.onForeground() }
    if (!forced && st.pkg == null && !st.checking && st.error == null) return
    Surface(Modifier.fillMaxWidth(), shape = CardShape, color = MaterialTheme.colorScheme.surfaceVariant) {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            val ver = st.pkg?.let { it.version ?: it.versionCode?.let { c -> "versionCode $c" } }.orEmpty()
            Text(if (st.forced || forced) "请安装新版本" else "发现新版本", style = MaterialTheme.typography.titleSmall)
            if (ver.isNotBlank()) Text(ver, color = TextSecondary, style = MaterialTheme.typography.bodySmall)
            if (st.checking) LinearProgressIndicator(Modifier.fillMaxWidth(), color = Neon)
            st.error?.let { Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall) }
            when {
                st.needsPermission -> Button({ launchSettings.launch(vm.installPermissionIntent()) }, Modifier.fillMaxWidth(), shape = PillShape) {
                    Text("前往授予安装权限")
                }
                st.downloading -> {
                    val tot = st.total
                    if (tot > 0) LinearProgressIndicator((st.received.toFloat() / tot).coerceIn(0f, 1f), Modifier.fillMaxWidth(), color = Neon)
                    else LinearProgressIndicator(Modifier.fillMaxWidth(), color = Neon)
                    Text("正在下载 ${fmtSize(st.received)}" + if (tot > 0) " / ${fmtSize(tot)}" else "", style = MaterialTheme.typography.bodySmall)
                }
                st.installing -> Text("等待系统安装确认…", style = MaterialTheme.typography.bodySmall)
                st.pkg != null -> Button({ vm.startAppUpdate() }, Modifier.fillMaxWidth(), enabled = !st.checking, shape = PillShape) {
                    Text("下载并安装")
                }
            }
        }
    }
}
