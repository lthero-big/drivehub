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
fun TextDialog(title: String, initial: String, onDismiss: () -> Unit, onOk: (String) -> Unit) {
    var v by remember { mutableStateOf(initial) }
    AlertDialog(
        onDismiss,
        title = { Text(title) },
        text = { OutlinedTextField(v, { v = it }, singleLine = true, shape = CardShape, modifier = Modifier.fillMaxWidth()) },
        confirmButton = { TextButton({ if (v.isNotBlank()) onOk(v.trim()) }) { Text("确定") } },
        dismissButton = { TextButton(onDismiss) { Text("取消") } },
        containerColor = InkElevated,
    )
}

@Composable
fun ShareDialog(item: FsItem, onDismiss: () -> Unit, onOk: (String, Long?, Boolean) -> Unit) {
    var perm by remember { mutableStateOf("download") }
    var days by remember { mutableStateOf("7") }
    var pin by remember { mutableStateOf(true) }
    AlertDialog(
        onDismiss,
        title = { Text("分享 ${item.name}") },
        text = {
            Column {
                val perms = buildList { add("preview" to "仅预览"); add("download" to "可下载"); if (item.isDir) add("upload" to "收集上传") }
                perms.forEach { (k, l) ->
                    Row(Modifier.clickable { perm = k }.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                        RadioButton(perm == k, { perm = k }, colors = RadioButtonDefaults.colors(selectedColor = Neon))
                        Text(l)
                    }
                }
                OutlinedTextField(days, { days = it.filter(Char::isDigit) }, label = { Text("有效天数（空=永久）") }, singleLine = true, shape = CardShape, modifier = Modifier.fillMaxWidth())
                Row(Modifier.clickable { pin = !pin }, verticalAlignment = Alignment.CenterVertically) {
                    Checkbox(pin, { pin = it }, colors = CheckboxDefaults.colors(checkedColor = Neon))
                    Text("随机提取码 PIN")
                }
            }
        },
        confirmButton = { TextButton({ onOk(perm, days.toLongOrNull(), pin) }) { Text("创建") } },
        dismissButton = { TextButton(onDismiss) { Text("取消") } },
        containerColor = InkElevated,
    )
}

@Composable
fun ShareCreatedDialog(s: Share, onDismiss: () -> Unit) {
    val ctx = LocalContext.current
    AlertDialog(
        onDismiss,
        title = { Text("分享已创建") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                Text("取件码：${s.pickupCode}", style = MaterialTheme.typography.titleMedium)
                Text("链接：${s.urlWithPin ?: s.url}", color = TextSecondary, style = MaterialTheme.typography.bodySmall)
            }
        },
        confirmButton = { TextButton({ copyText(ctx, s.pickupCode); onDismiss() }) { Text("复制取件码") } },
        dismissButton = { TextButton({ copyText(ctx, s.urlWithPin ?: s.url); onDismiss() }) { Text("复制链接") } },
        containerColor = InkElevated,
    )
}
