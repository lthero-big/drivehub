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
fun PickupScreen(vm: AppViewModel, onClose: (() -> Unit)? = null) {
    val st by vm.pickup.collectAsStateWithLifecycle()
    var code by remember { mutableStateOf("") }
    var pin by remember { mutableStateOf("") }
    val open = st.open
    if (onClose != null) BackHandler { if (open != null) vm.pickupClose() else onClose() }
    Column(Modifier.fillMaxSize()) {
        TopAppBar(
            title = { Text(if (open == null) "取件码领取" else (open.name ?: open.code)) },
            navigationIcon = {
                IconButton({
                    when {
                        open != null -> vm.pickupClose()
                        onClose != null -> onClose()
                    }
                }) { Icon(if (open != null) Icons.Default.Close else Icons.AutoMirrored.Filled.ArrowBack, "关闭") }
            },
            colors = TopAppBarDefaults.topAppBarColors(containerColor = Ink),
        )
        if (open == null) {
            Column(Modifier.padding(20.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                Text("输入取件码或分享链接，领取文件。", color = TextSecondary, style = MaterialTheme.typography.bodyMedium)
                OutlinedTextField(code, { code = it }, label = { Text("取件码或分享链接") }, singleLine = true, shape = CardShape, modifier = Modifier.fillMaxWidth())
                if (st.needPin) OutlinedTextField(pin, { pin = it }, label = { Text("提取码 PIN") }, singleLine = true, shape = CardShape, modifier = Modifier.fillMaxWidth())
                st.error?.let { Text(it, color = MaterialTheme.colorScheme.error) }
                Button({ vm.claim(code, pin) }, enabled = code.isNotBlank() && !st.busy, modifier = Modifier.fillMaxWidth().height(52.dp), shape = CardShape) {
                    Text("领取", fontWeight = FontWeight.SemiBold)
                }
            }
        } else {
            BackHandler(enabled = st.path != "/") { vm.pickupBrowse(null) }
            LazyColumn {
                if (st.path != "/") item {
                    ListItem({ Text("返回上一级") }, Modifier.clickable { vm.pickupBrowse(null) }, leadingContent = { Icon(Icons.AutoMirrored.Filled.ArrowBack, null) }, colors = ListItemDefaults.colors(containerColor = Color.Transparent))
                }
                items(st.items) { i ->
                    val fake = FsItem(i.name, i.path, i.isDir, i.size, null)
                    ListItem(
                        headlineContent = { Text(i.name, maxLines = 1, overflow = TextOverflow.Ellipsis) },
                        modifier = Modifier.clickable { if (i.isDir) vm.pickupBrowse(i) },
                        supportingContent = { Text(if (i.isDir) "文件夹" else fmtSize(i.size), color = TextSecondary) },
                        leadingContent = { FileGlyph(fake, 44.dp) },
                        trailingContent = {
                            if (!i.isDir && open.allowDownload && !i.missing) IconButton({ vm.pickupDownload(i) }) { Icon(Icons.Default.Download, "下载") }
                        },
                        colors = ListItemDefaults.colors(containerColor = Color.Transparent),
                    )
                }
            }
        }
    }
}
