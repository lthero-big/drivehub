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

internal enum class KindFilter(val label: String) {
    All("全部"), Folder("文件夹"), Video("视频"), Image("图片"), Audio("音频"), Doc("文档")
}

internal fun matchesFilter(item: FsItem, f: KindFilter): Boolean = when (f) {
    KindFilter.All -> true
    KindFilter.Folder -> item.isDir
    KindFilter.Video -> !item.isDir && kindOf(item.name) == "video"
    KindFilter.Image -> !item.isDir && kindOf(item.name) == "image"
    KindFilter.Audio -> !item.isDir && kindOf(item.name) == "audio"
    KindFilter.Doc -> !item.isDir && kindOf(item.name) in setOf("pdf", "text")
}

@Composable
fun FilesScreen(vm: AppViewModel, onPreview: (FsItem) -> Unit) {
    val st by vm.files.collectAsStateWithLifecycle()
    val ctx = LocalContext.current
    var menu by remember { mutableStateOf<FsItem?>(null) }
    var dialog by remember { mutableStateOf<String?>(null) }
    var searching by remember { mutableStateOf(false) }
    var q by remember { mutableStateOf("") }
    var grid by remember { mutableStateOf(false) }
    var filter by remember { mutableStateOf(KindFilter.All) }
    val picker = rememberLauncherForActivityResult(ActivityResultContracts.OpenMultipleDocuments()) { uris ->
        uris.forEach { u ->
            val name = ctx.contentResolver.query(u, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)
                ?.use { if (it.moveToFirst()) it.getString(0) else null } ?: "upload.bin"
            vm.upload(u, name)
        }
    }
    BackHandler(enabled = st.path != "/" || st.hits != null) {
        if (st.hits != null) { vm.search(""); q = ""; searching = false } else vm.up()
    }
    val title = if (st.path == "/") "文件" else st.path.trimEnd('/').substringAfterLast('/')
    val source = st.hits?.map { h -> FsItem(h.name, h.path, h.isDir, h.size, h.modifiedUnix) } ?: st.items
    val visible = source.filter { matchesFilter(it, filter) }
    val canWrite = st.path != "/"
    Column(Modifier.fillMaxSize()) {
        Row(
            Modifier.fillMaxWidth().padding(start = 8.dp, end = 4.dp, top = 4.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            if (st.path != "/" && !searching) {
                IconButton({ vm.up() }) { Icon(Icons.AutoMirrored.Filled.ArrowBack, "返回", tint = TextPrimary) }
            }
            Column(Modifier.weight(1f).padding(horizontal = 8.dp, vertical = 8.dp)) {
                Text(title, style = MaterialTheme.typography.headlineMedium, maxLines = 1, overflow = TextOverflow.Ellipsis)
                if (st.path != "/" && !searching) {
                    Text(st.path, style = MaterialTheme.typography.labelSmall, color = TextTertiary, maxLines = 1, overflow = TextOverflow.Ellipsis)
                }
            }
            IconButton({ grid = !grid }) {
                Icon(if (grid) Icons.Default.ViewList else Icons.Default.GridView, "切换视图")
            }
            IconButton({ vm.refresh() }) { Icon(Icons.Default.Refresh, "刷新") }
        }
        OutlinedTextField(
            q,
            {
                q = it
                if (!searching) searching = true
            },
            modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 4.dp),
            placeholder = { Text("搜索文件名") },
            leadingIcon = { Icon(Icons.Default.Search, null) },
            trailingIcon = {
                if (q.isNotEmpty() || searching) IconButton({
                    q = ""; searching = false; vm.search("")
                }) { Icon(Icons.Default.Close, "清除") }
            },
            singleLine = true,
            shape = PillShape,
            keyboardOptions = KeyboardOptions(imeAction = ImeAction.Search),
            keyboardActions = KeyboardActions(onSearch = { searching = true; vm.search(q) }),
            colors = OutlinedTextFieldDefaults.colors(
                focusedContainerColor = InkCard,
                unfocusedContainerColor = InkCard,
                focusedBorderColor = Neon.copy(alpha = 0.5f),
                unfocusedBorderColor = Color.Transparent,
            ),
        )
        if (st.hits == null) {
            ScrollableChipRow(filter) { filter = it }
        }
        if (st.offline) {
            Text("离线模式：显示缓存", Modifier.padding(horizontal = 16.dp, vertical = 4.dp), color = Neon, style = MaterialTheme.typography.labelMedium)
        }
        if (st.loading) LinearProgressIndicator(Modifier.fillMaxWidth(), color = Neon, trackColor = InkCard)
        st.error?.let { Text(it, color = MaterialTheme.colorScheme.error, modifier = Modifier.padding(16.dp), style = MaterialTheme.typography.bodySmall) }
        Box(Modifier.weight(1f).fillMaxWidth()) {
            if (visible.isEmpty() && !st.loading && st.error == null) {
                EmptyFiles(st.hits != null)
            } else if (grid) {
                LazyVerticalGrid(
                    GridCells.Adaptive(112.dp),
                    Modifier.fillMaxSize(),
                    contentPadding = PaddingValues(start = 12.dp, end = 12.dp, top = 8.dp, bottom = 88.dp),
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                    verticalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    items(visible, key = { it.path }) { it ->
                        FileGridCell(it, { if (it.isDir) vm.loadFiles(it.path) else onPreview(it) }, { menu = it })
                    }
                }
            } else {
                LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(bottom = 88.dp)) {
                    items(visible, key = { it.path }) { it ->
                        FileRow(it, { if (it.isDir) vm.loadFiles(it.path) else onPreview(it) }, { menu = it })
                    }
                }
            }
            if (canWrite) {
                FloatingActionButton(
                    onClick = { dialog = "add" },
                    modifier = Modifier.align(Alignment.BottomEnd).padding(20.dp),
                    containerColor = Neon,
                    contentColor = Color(0xFF052315),
                    shape = RoundedCornerShape(18.dp),
                ) { Icon(Icons.Default.Add, "添加") }
            }
        }
    }
    val m = menu
    if (m != null && dialog == null) {
        ModalBottomSheet({ menu = null }, containerColor = InkElevated, shape = RoundedCornerShape(topStart = 24.dp, topEnd = 24.dp)) {
            Column(Modifier.padding(bottom = 28.dp)) {
                Row(Modifier.padding(horizontal = 20.dp, vertical = 8.dp), verticalAlignment = Alignment.CenterVertically) {
                    FileGlyph(m, 44.dp)
                    Spacer(Modifier.width(12.dp))
                    Column {
                        Text(m.name, style = MaterialTheme.typography.titleMedium, maxLines = 2, overflow = TextOverflow.Ellipsis)
                        Text(fileSubtitle(m), color = TextSecondary, style = MaterialTheme.typography.bodySmall)
                    }
                }
                Spacer(Modifier.height(8.dp))
                if (!m.isDir) SheetItem(Icons.Default.Visibility, "预览") { menu = null; onPreview(m) }
                if (!m.isDir) SheetItem(Icons.Default.Download, "下载") { vm.download(m); menu = null }
                SheetItem(Icons.Default.Share, "分享") { dialog = "share" }
                SheetItem(Icons.Default.Edit, "重命名") { dialog = "rename" }
                SheetItem(Icons.Default.Delete, "删除", tint = Danger) { dialog = "delete" }
            }
        }
    }
    when (dialog) {
        "add" -> ModalBottomSheet({ dialog = null }, containerColor = InkElevated, shape = RoundedCornerShape(topStart = 24.dp, topEnd = 24.dp)) {
            Column(Modifier.padding(bottom = 28.dp)) {
                Text("添加", Modifier.padding(horizontal = 20.dp, vertical = 8.dp), style = MaterialTheme.typography.titleMedium)
                SheetItem(Icons.Default.Upload, "上传文件") { dialog = null; picker.launch(arrayOf("*/*")) }
                SheetItem(Icons.Default.CreateNewFolder, "新建文件夹") { dialog = "mkdir" }
            }
        }
        "mkdir" -> TextDialog("新建文件夹", "", { dialog = null }) { vm.mkdir(it); dialog = null }
        "rename" -> m?.let { TextDialog("重命名", it.name, { dialog = null; menu = null }) { n -> vm.rename(it, n); dialog = null; menu = null } }
        "delete" -> m?.let {
            AlertDialog(
                { dialog = null },
                title = { Text("删除 ${it.name}？") },
                text = { Text("此操作无法撤销。", color = TextSecondary) },
                confirmButton = { TextButton({ vm.delete(it); dialog = null; menu = null }) { Text("删除", color = Danger) } },
                dismissButton = { TextButton({ dialog = null }) { Text("取消") } },
                containerColor = InkElevated,
            )
        }
        "share" -> m?.let { ShareDialog(it, { dialog = null; menu = null }) { perm, days, pin -> vm.createShare(it, perm, days, pin); dialog = null; menu = null } }
    }
    val created by vm.createdShare.collectAsStateWithLifecycle()
    created?.let { s -> ShareCreatedDialog(s) { vm.createdShare.value = null } }
}
@Composable
internal fun ScrollableChipRow(current: KindFilter, onPick: (KindFilter) -> Unit) {
    Row(
        Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()).padding(horizontal = 16.dp, vertical = 8.dp),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        KindFilter.entries.forEach { f ->
            val on = current == f
            FilterChip(
                selected = on,
                onClick = { onPick(f) },
                label = { Text(f.label) },
                colors = FilterChipDefaults.filterChipColors(
                    selectedContainerColor = Neon.copy(alpha = 0.18f),
                    selectedLabelColor = Neon,
                    containerColor = InkCard,
                    labelColor = TextSecondary,
                ),
                border = FilterChipDefaults.filterChipBorder(enabled = true, selected = on, selectedBorderColor = Color.Transparent, borderColor = Color.Transparent),
            )
        }
    }
}

@Composable
internal fun EmptyFiles(searching: Boolean) {
    Column(Modifier.fillMaxSize(), Arrangement.Center, Alignment.CenterHorizontally) {
        Icon(if (searching) Icons.Default.SearchOff else Icons.Outlined.FolderOff, null, Modifier.size(56.dp), TextTertiary)
        Spacer(Modifier.height(12.dp))
        Text(if (searching) "没有结果" else "这里还没有文件", style = MaterialTheme.typography.titleMedium, color = TextSecondary)
        Text(if (searching) "换个关键词试试" else "点右下角加号上传或新建文件夹", color = TextTertiary, style = MaterialTheme.typography.bodySmall)
    }
}
