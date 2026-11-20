@file:OptIn(androidx.compose.material3.ExperimentalMaterial3Api::class)

package com.drivehub.app.ui

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
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.InsertDriveFile
import androidx.compose.material.icons.filled.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.input.PasswordVisualTransformation
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
import com.drivehub.app.work.TAG_TRANSFER
import java.text.DateFormat
import java.util.Date

fun fmtSize(n: Long): String = when {
    n < 1024 -> "$n B"; n < 1 shl 20 -> "%.1f KB".format(n / 1024.0)
    n < 1 shl 30 -> "%.1f MB".format(n / 1048576.0); else -> "%.2f GB".format(n / 1073741824.0)
}

fun copyText(ctx: Context, text: String) {
    (ctx.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager).setPrimaryClip(ClipData.newPlainText("DriveHub", text))
}

@Composable
fun AppRoot(vm: AppViewModel) {
    val stage by vm.stage.collectAsStateWithLifecycle()
    val msg by vm.message.collectAsStateWithLifecycle()
    val snack = remember { SnackbarHostState() }
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    DisposableEffect(lifecycle, vm) {
        val obs = LifecycleEventObserver { _, e -> if (e == Lifecycle.Event.ON_RESUME) vm.onForeground() }
        lifecycle.addObserver(obs)
        onDispose { lifecycle.removeObserver(obs) }
    }
    LaunchedEffect(msg) { msg?.let { snack.showSnackbar(it); vm.message.value = null } }
    Scaffold(snackbarHost = { SnackbarHost(snack) }) { pad ->
        Box(Modifier.padding(pad).fillMaxSize()) {
            when (val s = stage) {
                Stage.Boot -> Box(Modifier.fillMaxSize(), Alignment.Center) { CircularProgressIndicator() }
                is Stage.Setup -> SetupScreen(vm, s)
                is Stage.Blocked -> BlockedScreen(vm, s.compat)
                is Stage.Login -> LoginScreen(vm, s)
                Stage.Main -> MainScreen(vm)
            }
        }
    }
}

@Composable
fun SetupScreen(vm: AppViewModel, s: Stage.Setup) {
    var url by remember { mutableStateOf(vm.prefs.serverUrl ?: "") }
    Column(Modifier.fillMaxSize().padding(24.dp), Arrangement.Center) {
        Text("DriveHub", style = MaterialTheme.typography.displaySmall)
        Text("App ${BuildConfig.VERSION_NAME}", style = MaterialTheme.typography.labelMedium)
        Spacer(Modifier.height(24.dp))
        OutlinedTextField(url, { url = it }, label = { Text("服务器地址 / Server URL") },
            placeholder = { Text("https://drive.example.com 或 http://192.168.1.10:8470") },
            singleLine = true, modifier = Modifier.fillMaxWidth())
        s.error?.let { Text(it, color = MaterialTheme.colorScheme.error, modifier = Modifier.padding(top = 8.dp)) }
        Spacer(Modifier.height(16.dp))
        Button({ vm.connect(url) }, enabled = url.isNotBlank() && !s.busy, modifier = Modifier.fillMaxWidth()) {
            if (s.busy) CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp) else Text("连接并检查版本")
        }
    }
}

@Composable
fun BlockedScreen(vm: AppViewModel, c: Compat) {
    Column(Modifier.fillMaxSize().padding(24.dp), Arrangement.Center) {
        Icon(Icons.Default.SystemUpdate, null, Modifier.size(56.dp), MaterialTheme.colorScheme.error)
        Spacer(Modifier.height(12.dp))
        Text(when (c) {
            is Compat.ClientTooOld -> "需要升级 App / App update required"
            is Compat.ServerTooOld -> "服务器版本过旧 / Server too old"
            else -> "无法使用此服务器 / Cannot use this server"
        }, style = MaterialTheme.typography.headlineSmall)
        Spacer(Modifier.height(12.dp))
        Text(VersionNegotiator.message(c))
        if (c is Compat.ClientTooOld) {
            Spacer(Modifier.height(16.dp))
            AppUpdateCard(vm, forced = true)
        }
        Spacer(Modifier.height(24.dp))
        Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            OutlinedButton({ vm.changeServer() }) { Text("更换服务器") }
            Button({ vm.boot() }) { Text("重试") }
        }
    }
}

@Composable
fun AppUpdateCard(vm: AppViewModel, forced: Boolean = false) {
    val st by vm.appUpdate.collectAsStateWithLifecycle()
    val launchSettings = rememberLauncherForActivityResult(ActivityResultContracts.StartActivityForResult()) { vm.onForeground() }
    if (!forced && st.pkg == null && !st.checking && st.error == null) return
    Column(Modifier.fillMaxWidth().padding(horizontal = 8.dp, vertical = 4.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        val ver = st.pkg?.let { it.version ?: it.versionCode?.let { c -> "versionCode $c" } }.orEmpty()
        if (st.checking) LinearProgressIndicator(Modifier.fillMaxWidth())
        st.error?.let { Text(it, color = MaterialTheme.colorScheme.error) }
        when {
            st.needsPermission -> {
                Button({ launchSettings.launch(vm.installPermissionIntent()) }, Modifier.fillMaxWidth()) {
                    Text("前往授予安装权限 / Allow installing apps")
                }
            }
            st.downloading -> {
                val tot = st.total
                if (tot > 0) LinearProgressIndicator((st.received.toFloat() / tot).coerceIn(0f, 1f), Modifier.fillMaxWidth())
                else LinearProgressIndicator(Modifier.fillMaxWidth())
                Text("正在下载 ${fmtSize(st.received)}" + if (tot > 0) " / ${fmtSize(tot)}" else "")
            }
            st.installing -> Text("等待系统安装确认… / Waiting for the system install confirmation")
            st.pkg != null -> {
                Text(if (st.forced || forced) "请安装新版本 $ver 后继续 / Install $ver to continue" else "发现新版本 $ver / Update $ver is available")
                Button({ vm.startAppUpdate() }, Modifier.fillMaxWidth(), enabled = !st.checking) { Text("下载并安装 / Download and install") }
            }
        }
    }
}

@Composable
fun LoginScreen(vm: AppViewModel, s: Stage.Login) {
    var user by remember { mutableStateOf(vm.prefs.username ?: "") }
    var pw by remember { mutableStateOf("") }
    var code by remember { mutableStateOf("") }
    var oauth by remember { mutableStateOf<String?>(null) }
    oauth?.let { p -> OAuthScreen(vm, p) { oauth = null }; return }
    Column(Modifier.fillMaxSize().padding(24.dp), Arrangement.Center) {
        Text("登录 / Sign in", style = MaterialTheme.typography.headlineMedium)
        Text(vm.prefs.serverUrl ?: "", style = MaterialTheme.typography.labelMedium)
        Spacer(Modifier.height(16.dp))
        if (!s.totpPending) {
            OutlinedTextField(user, { user = it }, label = { Text("用户名或邮箱") }, singleLine = true, modifier = Modifier.fillMaxWidth())
            Spacer(Modifier.height(8.dp))
            OutlinedTextField(pw, { pw = it }, label = { Text("密码") }, singleLine = true,
                visualTransformation = PasswordVisualTransformation(), modifier = Modifier.fillMaxWidth())
        } else {
            Text("该账号已启用两步验证，请输入验证码 / Enter your 2FA code")
            OutlinedTextField(code, { code = it }, label = { Text("6 位验证码") }, singleLine = true, modifier = Modifier.fillMaxWidth())
        }
        s.error?.let { Text(it, color = MaterialTheme.colorScheme.error, modifier = Modifier.padding(top = 8.dp)) }
        Spacer(Modifier.height(16.dp))
        Button({
            when {
                s.totpPending && s.ticket != null -> vm.totpTicket(code)
                s.totpPending -> vm.login(user, pw, code)
                else -> vm.login(user, pw, null)
            }
        }, enabled = !s.busy, modifier = Modifier.fillMaxWidth()) {
            if (s.busy) CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp) else Text(if (s.totpPending) "验证" else "登录")
        }
        if (!s.totpPending) s.providers.forEach { p ->
            OutlinedButton({ oauth = p }, modifier = Modifier.fillMaxWidth().padding(top = 8.dp)) { Text("使用 $p 登录") }
        }
        TextButton({ vm.changeServer() }) { Text("更换服务器") }
    }
}

@SuppressLint("SetJavaScriptEnabled")
@Composable
fun OAuthScreen(vm: AppViewModel, provider: String, onClose: () -> Unit) {
    val start = vm.client()!!.oauthStartUrl(provider)
    BackHandler { onClose() }
    Column(Modifier.fillMaxSize()) {
        TopAppBar(title = { Text("OAuth · $provider") }, navigationIcon = { IconButton(onClose) { Icon(Icons.Default.Close, null) } })
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

private enum class Tab(val label: String, val icon: androidx.compose.ui.graphics.vector.ImageVector) {
    Files("文件", Icons.Default.Folder), Shares("分享", Icons.Default.Share), Pickup("取件码", Icons.Default.Key),
    Transfers("传输", Icons.Default.SwapVert), Me("我的", Icons.Default.Person)
}

@Composable
fun MainScreen(vm: AppViewModel) {
    var tab by remember { mutableStateOf(Tab.Files) }
    var preview by remember { mutableStateOf<FsItem?>(null) }
    preview?.let { PreviewScreen(vm, it) { preview = null }; return }
    Scaffold(bottomBar = {
        NavigationBar {
            Tab.values().forEach { t ->
                NavigationBarItem(tab == t, { tab = t; if (t == Tab.Shares) vm.loadShares() }, { Icon(t.icon, t.label) }, label = { Text(t.label) })
            }
        }
    }) { pad ->
        Column(Modifier.padding(pad).fillMaxSize()) {
            AppUpdateCard(vm)
            Box(Modifier.weight(1f).fillMaxWidth()) {
                when (tab) {
                    Tab.Files -> FilesScreen(vm) { preview = it }
                    Tab.Shares -> SharesScreen(vm)
                    Tab.Pickup -> PickupScreen(vm)
                    Tab.Transfers -> TransfersScreen()
                    Tab.Me -> MeScreen(vm)
                }
            }
        }
    }
}

@Composable
fun FilesScreen(vm: AppViewModel, onPreview: (FsItem) -> Unit) {
    val st by vm.files.collectAsStateWithLifecycle()
    val ctx = LocalContext.current
    var menu by remember { mutableStateOf<FsItem?>(null) }
    var dialog by remember { mutableStateOf<String?>(null) }   // "mkdir" | "rename" | "delete" | "share"
    var searching by remember { mutableStateOf(false) }
    var q by remember { mutableStateOf("") }
    val picker = rememberLauncherForActivityResult(ActivityResultContracts.OpenMultipleDocuments()) { uris ->
        uris.forEach { u ->
            val name = ctx.contentResolver.query(u, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { if (it.moveToFirst()) it.getString(0) else null } ?: "upload.bin"
            vm.upload(u, name)
        }
    }
    BackHandler(enabled = st.path != "/" || st.hits != null) { if (st.hits != null) { vm.search(""); q = ""; searching = false } else vm.up() }
    Column(Modifier.fillMaxSize()) {
        TopAppBar(
            title = {
                if (searching) OutlinedTextField(q, { q = it }, singleLine = true, placeholder = { Text("搜索文件名") }, modifier = Modifier.fillMaxWidth())
                else Text(st.path, maxLines = 1)
            },
            navigationIcon = { if (st.path != "/" && !searching) IconButton({ vm.up() }) { Icon(Icons.AutoMirrored.Filled.ArrowBack, "up") } },
            actions = {
                if (searching) {
                    IconButton({ vm.search(q) }) { Icon(Icons.Default.Search, "go") }
                    IconButton({ searching = false; q = ""; vm.search("") }) { Icon(Icons.Default.Close, "close") }
                } else {
                    IconButton({ searching = true }) { Icon(Icons.Default.Search, "search") }
                    IconButton({ vm.refresh() }) { Icon(Icons.Default.Refresh, "refresh") }
                    if (st.path != "/") {
                        IconButton({ dialog = "mkdir" }) { Icon(Icons.Default.CreateNewFolder, "mkdir") }
                        IconButton({ picker.launch(arrayOf("*/*")) }) { Icon(Icons.Default.Upload, "upload") }
                    }
                }
            })
        if (st.offline) Text("离线模式：显示缓存 / Offline: showing cached listing", Modifier.fillMaxWidth().padding(8.dp), color = MaterialTheme.colorScheme.tertiary)
        if (st.loading) LinearProgressIndicator(Modifier.fillMaxWidth())
        st.error?.let { Text(it, color = MaterialTheme.colorScheme.error, modifier = Modifier.padding(16.dp)) }
        val hits = st.hits
        LazyColumn(Modifier.fillMaxSize()) {
            if (hits != null) {
                if (hits.isEmpty() && !st.loading) item { Text("没有结果 / No results", Modifier.padding(16.dp)) }
                items(hits) { h ->
                    val it = FsItem(h.name, h.path, h.isDir, h.size, h.modifiedUnix)
                    FileRow(it, { if (h.isDir) { vm.loadFiles(h.path) } else onPreview(it) }, { menu = it })
                }
            } else {
                if (st.items.isEmpty() && !st.loading && st.error == null) item { Text("空目录 / Empty", Modifier.padding(16.dp)) }
                items(st.items) { it -> FileRow(it, { if (it.isDir) vm.loadFiles(it.path) else onPreview(it) }, { menu = it }) }
            }
        }
    }
    val m = menu
    if (m != null && dialog == null) {
        ModalBottomSheet({ menu = null }) {
            Text(m.name, Modifier.padding(16.dp), style = MaterialTheme.typography.titleMedium)
            if (!m.isDir) SheetItem(Icons.Default.Visibility, "预览") { menu = null; onPreview(m) }
            if (!m.isDir) SheetItem(Icons.Default.Download, "下载") { vm.download(m); menu = null }
            SheetItem(Icons.Default.Share, "分享") { dialog = "share" }
            SheetItem(Icons.Default.Edit, "重命名") { dialog = "rename" }
            SheetItem(Icons.Default.Delete, "删除") { dialog = "delete" }
            Spacer(Modifier.height(24.dp))
        }
    }
    when (dialog) {
        "mkdir" -> TextDialog("新建文件夹", "", { dialog = null }) { vm.mkdir(it); dialog = null }
        "rename" -> m?.let { TextDialog("重命名", it.name, { dialog = null; menu = null }) { n -> vm.rename(it, n); dialog = null; menu = null } }
        "delete" -> m?.let {
            AlertDialog({ dialog = null }, title = { Text("删除 ${it.name}？") },
                confirmButton = { TextButton({ vm.delete(it); dialog = null; menu = null }) { Text("删除") } },
                dismissButton = { TextButton({ dialog = null }) { Text("取消") } })
        }
        "share" -> m?.let { ShareDialog(it, { dialog = null; menu = null }) { perm, days, pin -> vm.createShare(it, perm, days, pin); dialog = null; menu = null } }
    }
    val created by vm.createdShare.collectAsStateWithLifecycle()
    created?.let { s -> ShareCreatedDialog(s) { vm.createdShare.value = null } }
}

@Composable
fun SheetItem(icon: androidx.compose.ui.graphics.vector.ImageVector, label: String, onClick: () -> Unit) {
    ListItem({ Text(label) }, Modifier.clickable { onClick() }, leadingContent = { Icon(icon, null) })
}

@Composable
fun FileRow(it: FsItem, onClick: () -> Unit, onMore: () -> Unit) {
    ListItem(
        headlineContent = { Text(it.name, maxLines = 1) },
        supportingContent = {
            Text(buildString {
                if (!it.isDir) append(fmtSize(it.size))
                it.modifiedUnix?.let { t -> if (isNotEmpty()) append(" · "); append(DateFormat.getDateTimeInstance(DateFormat.SHORT, DateFormat.SHORT).format(Date(t * 1000))) }
            })
        },
        leadingContent = { Icon(if (it.isDir) Icons.Default.Folder else iconFor(it.name), null) },
        trailingContent = { IconButton(onMore) { Icon(Icons.Default.MoreVert, "more") } },
        modifier = Modifier.clickable { onClick() },
    )
}

fun kindOf(name: String): String = when (name.substringAfterLast('.', "").lowercase()) {
    "jpg", "jpeg", "png", "gif", "webp", "bmp", "heic" -> "image"
    "mp4", "mkv", "webm", "mov", "m4v", "3gp" -> "video"
    "mp3", "m4a", "wav", "flac", "ogg", "aac" -> "audio"
    "pdf" -> "pdf"
    "txt", "md", "log", "json", "csv", "xml", "yml", "yaml", "toml", "rs", "kt", "py", "js", "ts" -> "text"
    else -> "other"
}

fun iconFor(name: String) = when (kindOf(name)) {
    "image" -> Icons.Default.Image; "video" -> Icons.Default.Movie; "audio" -> Icons.Default.MusicNote
    "pdf" -> Icons.Default.PictureAsPdf; else -> Icons.AutoMirrored.Filled.InsertDriveFile
}

@Composable
fun TextDialog(title: String, initial: String, onDismiss: () -> Unit, onOk: (String) -> Unit) {
    var v by remember { mutableStateOf(initial) }
    AlertDialog(onDismiss, title = { Text(title) }, text = { OutlinedTextField(v, { v = it }, singleLine = true) },
        confirmButton = { TextButton({ if (v.isNotBlank()) onOk(v.trim()) }) { Text("确定") } },
        dismissButton = { TextButton(onDismiss) { Text("取消") } })
}

@Composable
fun ShareDialog(item: FsItem, onDismiss: () -> Unit, onOk: (String, Long?, Boolean) -> Unit) {
    var perm by remember { mutableStateOf("download") }
    var days by remember { mutableStateOf("7") }
    var pin by remember { mutableStateOf(true) }
    AlertDialog(onDismiss, title = { Text("分享 ${item.name}") }, text = {
        Column {
            val perms = buildList { add("preview" to "仅预览"); add("download" to "可下载"); if (item.isDir) add("upload" to "收集上传") }
            perms.forEach { (k, l) -> Row(Modifier.clickable { perm = k }, verticalAlignment = Alignment.CenterVertically) { RadioButton(perm == k, { perm = k }); Text(l) } }
            OutlinedTextField(days, { days = it.filter(Char::isDigit) }, label = { Text("有效天数（空=永久）") }, singleLine = true)
            Row(Modifier.clickable { pin = !pin }, verticalAlignment = Alignment.CenterVertically) { Checkbox(pin, { pin = it }); Text("随机提取码 PIN") }
        }
    }, confirmButton = { TextButton({ onOk(perm, days.toLongOrNull(), pin) }) { Text("创建") } },
        dismissButton = { TextButton(onDismiss) { Text("取消") } })
}

@Composable
fun ShareCreatedDialog(s: Share, onDismiss: () -> Unit) {
    val ctx = LocalContext.current
    AlertDialog(onDismiss, title = { Text("分享已创建") }, text = {
        Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
            Text("取件码：${s.pickupCode}", style = MaterialTheme.typography.titleMedium)
            Text("链接：${s.urlWithPin ?: s.url}")
        }
    }, confirmButton = { TextButton({ copyText(ctx, s.pickupCode); onDismiss() }) { Text("复制取件码") } },
        dismissButton = { TextButton({ copyText(ctx, s.urlWithPin ?: s.url); onDismiss() }) { Text("复制链接") } })
}

@Composable
fun SharesScreen(vm: AppViewModel) {
    val list by vm.shares.collectAsStateWithLifecycle()
    val err by vm.sharesError.collectAsStateWithLifecycle()
    val ctx = LocalContext.current
    LaunchedEffect(Unit) { vm.loadShares() }
    Column(Modifier.fillMaxSize()) {
        TopAppBar(title = { Text("我的分享") }, actions = { IconButton({ vm.loadShares() }) { Icon(Icons.Default.Refresh, "refresh") } })
        err?.let { Text(it, color = MaterialTheme.colorScheme.error, modifier = Modifier.padding(16.dp)) }
        LazyColumn {
            if (list.isEmpty() && err == null) item { Text("还没有分享，在文件列表中长按…菜单创建", Modifier.padding(16.dp)) }
            items(list) { s ->
                ListItem(
                    headlineContent = { Text(s.name?.ifBlank { null } ?: s.items.firstOrNull() ?: s.code) },
                    supportingContent = { Text("取件码 ${s.pickupCode} · ${s.perm} · ${s.status} · 访问 ${s.visits} 下载 ${s.downloads}") },
                    trailingContent = {
                        Row {
                            IconButton({ copyText(ctx, s.pickupCode) }) { Icon(Icons.Default.ContentCopy, "copy") }
                            if (!s.revoked) IconButton({ vm.revoke(s) }) { Icon(Icons.Default.Block, "revoke") }
                            IconButton({ vm.deleteShare(s) }) { Icon(Icons.Default.Delete, "delete") }
                        }
                    })
                HorizontalDivider()
            }
        }
    }
}

@Composable
fun PickupScreen(vm: AppViewModel) {
    val st by vm.pickup.collectAsStateWithLifecycle()
    var code by remember { mutableStateOf("") }
    var pin by remember { mutableStateOf("") }
    val open = st.open
    Column(Modifier.fillMaxSize()) {
        TopAppBar(title = { Text(if (open == null) "取件码领取" else (open.name ?: open.code)) },
            navigationIcon = { if (open != null) IconButton({ vm.pickupClose() }) { Icon(Icons.Default.Close, "close") } })
        if (open == null) {
            Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                OutlinedTextField(code, { code = it }, label = { Text("取件码或分享链接") }, singleLine = true, modifier = Modifier.fillMaxWidth())
                if (st.needPin) OutlinedTextField(pin, { pin = it }, label = { Text("提取码 PIN") }, singleLine = true, modifier = Modifier.fillMaxWidth())
                st.error?.let { Text(it, color = MaterialTheme.colorScheme.error) }
                Button({ vm.claim(code, pin) }, enabled = code.isNotBlank() && !st.busy, modifier = Modifier.fillMaxWidth()) { Text("领取") }
            }
        } else {
            BackHandler(enabled = st.path != "/") { vm.pickupBrowse(null) }
            LazyColumn {
                if (st.path != "/") item { ListItem({ Text("‥ 返回") }, Modifier.clickable { vm.pickupBrowse(null) }) }
                items(st.items) { i ->
                    ListItem({ Text(i.name) }, Modifier.clickable { if (i.isDir) vm.pickupBrowse(i) },
                        supportingContent = { Text(if (i.isDir) "文件夹" else fmtSize(i.size)) },
                        leadingContent = { Icon(if (i.isDir) Icons.Default.Folder else iconFor(i.name), null) },
                        trailingContent = { if (!i.isDir && open.allowDownload && !i.missing) IconButton({ vm.pickupDownload(i) }) { Icon(Icons.Default.Download, "download") } })
                }
            }
        }
    }
}

@Composable
fun TransfersScreen() {
    val ctx = LocalContext.current
    val infos by WorkManager.getInstance(ctx).getWorkInfosByTagFlow(TAG_TRANSFER).collectAsStateWithLifecycle(emptyList())
    Column(Modifier.fillMaxSize()) {
        TopAppBar(title = { Text("传输") }, actions = { IconButton({ WorkManager.getInstance(ctx).pruneWork() }) { Icon(Icons.Default.CleaningServices, "prune") } })
        LazyColumn {
            if (infos.isEmpty()) item { Text("没有传输任务。文件下载到：\n${com.drivehub.app.data.OfflineCache.downloads(ctx).absolutePath}", Modifier.padding(16.dp)) }
            items(infos.sortedByDescending { it.state == WorkInfo.State.RUNNING }) { w ->
                val name = w.progress.getString("name") ?: w.outputData.getString("name") ?: w.id.toString().take(8)
                val done = w.progress.getLong("done", 0); val total = w.progress.getLong("total", 0)
                ListItem({ Text(name) }, supportingContent = {
                    Column {
                        Text(when (w.state) {
                            WorkInfo.State.SUCCEEDED -> "完成" + (w.outputData.getString("file")?.let { " → $it" } ?: "")
                            WorkInfo.State.FAILED -> "失败：${w.outputData.getString("error") ?: ""}"
                            WorkInfo.State.ENQUEUED -> "等待网络/重试中（已重试 ${w.runAttemptCount} 次）"
                            WorkInfo.State.RUNNING -> "${fmtSize(done)} / ${if (total > 0) fmtSize(total) else "?"}"
                            else -> w.state.name
                        })
                        if (w.state == WorkInfo.State.RUNNING && total > 0) LinearProgressIndicator(progress = { done.toFloat() / total }, modifier = Modifier.fillMaxWidth())
                    }
                }, trailingContent = { if (!w.state.isFinished) IconButton({ WorkManager.getInstance(ctx).cancelWorkById(w.id) }) { Icon(Icons.Default.Close, "cancel") } })
                HorizontalDivider()
            }
        }
    }
}

@Composable
fun MeScreen(vm: AppViewModel) {
    val info by vm.serverInfo.collectAsStateWithLifecycle()
    Column(Modifier.fillMaxSize().padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Text("DriveHub App ${BuildConfig.VERSION_NAME} (API v${BuildConfig.API_VERSION})", style = MaterialTheme.typography.titleMedium)
        Text("服务器：${vm.prefs.serverUrl}")
        info?.let { Text("服务器版本 ${it.serverVersion} · API v${it.apiVersion} · 最低 App ${it.minAppVersion}") }
        vm.prefs.username?.let { Text("用户：$it") }
        AppUpdateCard(vm)
        TextButton({ vm.refreshAppUpdate() }) { Text("检查更新 / Check for update") }
        Spacer(Modifier.height(8.dp))
        OutlinedButton({ vm.changeServer() }) { Text("更换服务器") }
        Button({ vm.logout() }) { Text("退出登录") }
    }
}

@Composable
fun PreviewScreen(vm: AppViewModel, item: FsItem, onClose: () -> Unit) {
    BackHandler { onClose() }
    val ctx = LocalContext.current
    Column(Modifier.fillMaxSize()) {
        TopAppBar(title = { Text(item.name, maxLines = 1) },
            navigationIcon = { IconButton(onClose) { Icon(Icons.AutoMirrored.Filled.ArrowBack, "back") } },
            actions = { IconButton({ vm.download(item) }) { Icon(Icons.Default.Download, "download") } })
        Box(Modifier.fillMaxSize(), Alignment.Center) {
            when (kindOf(item.name)) {
                "image" -> ImagePreview(vm, item)
                "video", "audio" -> MediaPreview(vm, item)
                "pdf" -> PdfPreview(vm, item)
                "text" -> TextPreview(vm, item)
                else -> Column(horizontalAlignment = Alignment.CenterHorizontally) {
                    Text("此类型暂不支持预览 / No preview for this type"); Text(fmtSize(item.size))
                    Button({ vm.download(item) }, Modifier.padding(top = 12.dp)) { Text("下载") }
                }
            }
        }
    }
}

@Composable
private fun <T> produceLoad(key: Any, block: suspend () -> T): State<Result<T>?> =
    produceState<Result<T>?>(null, key) { value = runCatching { block() } }

@Composable
fun ImagePreview(vm: AppViewModel, item: FsItem) {
    val r by produceLoad(item.path) { vm.previewBitmap(item.path) }
    when {
        r == null -> CircularProgressIndicator()
        r!!.isFailure -> Text(vm.errText(r!!.exceptionOrNull()!!), Modifier.padding(16.dp))
        r!!.getOrNull() == null -> Text("无法解码图片")
        else -> Image(r!!.getOrNull()!!.asImageBitmap(), item.name, Modifier.fillMaxSize(), contentScale = ContentScale.Fit)
    }
}

@Composable
fun TextPreview(vm: AppViewModel, item: FsItem) {
    val r by produceLoad(item.path) { vm.previewFile(item.path).readText().take(200_000) }
    when {
        r == null -> CircularProgressIndicator()
        r!!.isFailure -> Text(vm.errText(r!!.exceptionOrNull()!!), Modifier.padding(16.dp))
        else -> Text(r!!.getOrNull()!!, Modifier.fillMaxSize().verticalScroll(androidx.compose.foundation.rememberScrollState()).padding(12.dp), style = MaterialTheme.typography.bodySmall)
    }
}


@Composable
fun PdfPreview(vm: AppViewModel, item: FsItem) {
    val r by produceLoad(item.path) {
        val f = vm.previewFile(item.path)
        kotlinx.coroutines.withContext(kotlinx.coroutines.Dispatchers.IO) {
            val pfd = android.os.ParcelFileDescriptor.open(f, android.os.ParcelFileDescriptor.MODE_READ_ONLY)
            val rd = android.graphics.pdf.PdfRenderer(pfd)
            val pages = (0 until rd.pageCount).map { i ->
                rd.openPage(i).use { p ->
                    val w = 1080; val h = (w.toFloat() * p.height / p.width).toInt()
                    val bmp = android.graphics.Bitmap.createBitmap(w, h, android.graphics.Bitmap.Config.ARGB_8888)
                    bmp.eraseColor(android.graphics.Color.WHITE)
                    p.render(bmp, null, null, android.graphics.pdf.PdfRenderer.Page.RENDER_MODE_FOR_DISPLAY); bmp
                }
            }
            rd.close(); pfd.close(); pages
        }
    }
    when {
        r == null -> CircularProgressIndicator()
        r!!.isFailure -> Text(vm.errText(r!!.exceptionOrNull()!!), Modifier.padding(16.dp))
        else -> LazyColumn(Modifier.fillMaxSize(), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            items(r!!.getOrNull()!!) { b -> Image(b.asImageBitmap(), null, Modifier.fillMaxWidth(), contentScale = ContentScale.FillWidth) }
        }
    }
}

@Composable
fun MediaPreview(vm: AppViewModel, item: FsItem) {
    val ctx = LocalContext.current
    val api = vm.client() ?: return
    val player = remember(item.path) {
        val ds = androidx.media3.datasource.okhttp.OkHttpDataSource.Factory(ApiClient.defaultHttp()).setDefaultRequestProperties(api.clientHeaders())
        androidx.media3.exoplayer.ExoPlayer.Builder(ctx)
            .setMediaSourceFactory(androidx.media3.exoplayer.source.DefaultMediaSourceFactory(ctx).setDataSourceFactory(ds)).build().apply {
                setMediaItem(androidx.media3.common.MediaItem.fromUri(api.fileUrl(item.path, preview = true))); prepare(); playWhenReady = true
            }
    }
    DisposableEffect(player) { onDispose { player.release() } }
    AndroidView({ c -> androidx.media3.ui.PlayerView(c).apply { this.player = player } }, Modifier.fillMaxSize())
}
