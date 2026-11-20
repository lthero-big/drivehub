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
import com.drivehub.app.ui.theme.*
import com.drivehub.app.work.TAG_TRANSFER
import java.text.DateFormat
import java.util.Date

fun fmtSize(n: Long): String = when {
    n < 1024 -> "$n B"; n < 1 shl 20 -> "%.1f KB".format(n / 1024.0)
    n < 1 shl 30 -> "%.1f MB".format(n / 1048576.0); else -> "%.2f GB".format(n / 1073741824.0)
}

fun copyText(ctx: Context, text: String) {
    (ctx.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager)
        .setPrimaryClip(ClipData.newPlainText("DriveHub", text))
}

private val CardShape = RoundedCornerShape(18.dp)
private val IconShape = RoundedCornerShape(14.dp)
private val PillShape = RoundedCornerShape(50)

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
    Scaffold(
        containerColor = MaterialTheme.colorScheme.background,
        snackbarHost = { SnackbarHost(snack) },
    ) { pad ->
        Box(Modifier.padding(pad).fillMaxSize()) {
            when (val s = stage) {
                Stage.Boot -> Box(Modifier.fillMaxSize(), Alignment.Center) { CircularProgressIndicator(color = Neon) }
                is Stage.Setup -> SetupScreen(vm, s)
                is Stage.Blocked -> BlockedScreen(vm, s.compat)
                is Stage.Login -> LoginScreen(vm, s)
                Stage.Main -> MainScreen(vm)
            }
        }
    }
}

@Composable
private fun BrandMark(modifier: Modifier = Modifier) {
    Box(
        modifier.size(72.dp).clip(RoundedCornerShape(22.dp)).background(Neon),
        contentAlignment = Alignment.Center,
    ) {
        Icon(Icons.Default.CloudQueue, null, Modifier.size(38.dp), Color(0xFF052315))
    }
}

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
private enum class Tab(val label: String, val icon: ImageVector, val selected: ImageVector) {
    Files("文件", Icons.Outlined.Folder, Icons.Default.Folder),
    Transfers("传输", Icons.Outlined.SwapVert, Icons.Default.SwapVert),
    Shares("分享", Icons.Outlined.Share, Icons.Default.Share),
    Me("我的", Icons.Outlined.Person, Icons.Default.Person),
}

@Composable
fun MainScreen(vm: AppViewModel) {
    var tab by remember { mutableStateOf(Tab.Files) }
    var preview by remember { mutableStateOf<FsItem?>(null) }
    var pickup by remember { mutableStateOf(false) }
    preview?.let { PreviewScreen(vm, it) { preview = null }; return }
    if (pickup) { PickupScreen(vm) { pickup = false }; return }
    Scaffold(
        containerColor = MaterialTheme.colorScheme.background,
        bottomBar = {
            NavigationBar(containerColor = InkElevated, tonalElevation = 0.dp) {
                Tab.entries.forEach { t ->
                    NavigationBarItem(
                        selected = tab == t,
                        onClick = { tab = t; if (t == Tab.Shares) vm.loadShares() },
                        icon = { Icon(if (tab == t) t.selected else t.icon, t.label) },
                        label = { Text(t.label) },
                        colors = NavigationBarItemDefaults.colors(
                            selectedIconColor = Neon,
                            selectedTextColor = Neon,
                            unselectedIconColor = TextTertiary,
                            unselectedTextColor = TextTertiary,
                            indicatorColor = Neon.copy(alpha = 0.16f),
                        ),
                    )
                }
            }
        },
    ) { pad ->
        Column(Modifier.padding(pad).fillMaxSize()) {
            Box(Modifier.weight(1f).fillMaxWidth()) {
                when (tab) {
                    Tab.Files -> FilesScreen(vm) { preview = it }
                    Tab.Transfers -> TransfersScreen()
                    Tab.Shares -> SharesScreen(vm, onPickup = { pickup = true })
                    Tab.Me -> MeScreen(vm, onPickup = { pickup = true })
                }
            }
        }
    }
}

private enum class KindFilter(val label: String) {
    All("全部"), Folder("文件夹"), Video("视频"), Image("图片"), Audio("音频"), Doc("文档")
}

private fun matchesFilter(item: FsItem, f: KindFilter): Boolean = when (f) {
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
private fun ScrollableChipRow(current: KindFilter, onPick: (KindFilter) -> Unit) {
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
private fun EmptyFiles(searching: Boolean) {
    Column(Modifier.fillMaxSize(), Arrangement.Center, Alignment.CenterHorizontally) {
        Icon(if (searching) Icons.Default.SearchOff else Icons.Outlined.FolderOff, null, Modifier.size(56.dp), TextTertiary)
        Spacer(Modifier.height(12.dp))
        Text(if (searching) "没有结果" else "这里还没有文件", style = MaterialTheme.typography.titleMedium, color = TextSecondary)
        Text(if (searching) "换个关键词试试" else "点右下角加号上传或新建文件夹", color = TextTertiary, style = MaterialTheme.typography.bodySmall)
    }
}

@Composable
fun SheetItem(icon: ImageVector, label: String, tint: Color = TextPrimary, onClick: () -> Unit) {
    ListItem(
        headlineContent = { Text(label, color = tint) },
        modifier = Modifier.clickable { onClick() },
        leadingContent = { Icon(icon, null, tint = tint) },
        colors = ListItemDefaults.colors(containerColor = Color.Transparent),
    )
}

@Composable
fun FileGlyph(item: FsItem, size: Dp) {
    val kind = kindOf(item.name)
    val tint = kindTint(kind, item.isDir)
    Box(Modifier.size(size).clip(IconShape).background(tint.copy(alpha = 0.16f)), Alignment.Center) {
        Icon(if (item.isDir) Icons.Default.Folder else iconFor(item.name), null, Modifier.size(size * 0.5f), tint)
    }
}

private fun fileSubtitle(it: FsItem): String = buildString {
    if (it.isDir) append("文件夹") else append(fmtSize(it.size))
    it.modifiedUnix?.let { t ->
        if (isNotEmpty()) append("  ·  ")
        append(DateFormat.getDateTimeInstance(DateFormat.SHORT, DateFormat.SHORT).format(Date(t * 1000)))
    }
}

@Composable
fun FileRow(it: FsItem, onClick: () -> Unit, onMore: () -> Unit) {
    ListItem(
        headlineContent = { Text(it.name, maxLines = 1, overflow = TextOverflow.Ellipsis, style = MaterialTheme.typography.titleMedium) },
        supportingContent = { Text(fileSubtitle(it), color = TextSecondary) },
        leadingContent = { FileGlyph(it, 48.dp) },
        trailingContent = { IconButton(onMore) { Icon(Icons.Default.MoreVert, "更多", tint = TextTertiary) } },
        modifier = Modifier.clickable { onClick() },
        colors = ListItemDefaults.colors(containerColor = Color.Transparent),
    )
}

@Composable
fun FileGridCell(it: FsItem, onClick: () -> Unit, onMore: () -> Unit) {
    Column(
        Modifier.clip(CardShape).clickable { onClick() }.padding(8.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Box(Modifier.fillMaxWidth(), contentAlignment = Alignment.TopCenter) {
            FileGlyph(it, 56.dp)
            IconButton(onMore, Modifier.align(Alignment.TopEnd).size(28.dp)) {
                Icon(Icons.Default.MoreVert, "更多", Modifier.size(16.dp), TextTertiary)
            }
        }
        Spacer(Modifier.height(8.dp))
        Text(it.name, maxLines = 2, overflow = TextOverflow.Ellipsis, style = MaterialTheme.typography.bodySmall, modifier = Modifier.fillMaxWidth())
    }
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
    "image" -> Icons.Default.Image
    "video" -> Icons.Default.Movie
    "audio" -> Icons.Default.MusicNote
    "pdf" -> Icons.Default.PictureAsPdf
    else -> Icons.AutoMirrored.Filled.InsertDriveFile
}

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
@Composable
fun SharesScreen(vm: AppViewModel, onPickup: () -> Unit) {
    val list by vm.shares.collectAsStateWithLifecycle()
    val err by vm.sharesError.collectAsStateWithLifecycle()
    val ctx = LocalContext.current
    LaunchedEffect(Unit) { vm.loadShares() }
    Column(Modifier.fillMaxSize()) {
        Row(Modifier.fillMaxWidth().padding(start = 20.dp, end = 4.dp, top = 12.dp, bottom = 4.dp), verticalAlignment = Alignment.CenterVertically) {
            Text("分享", style = MaterialTheme.typography.headlineMedium, modifier = Modifier.weight(1f))
            TextButton(onPickup) { Text("取件") }
            IconButton({ vm.loadShares() }) { Icon(Icons.Default.Refresh, "刷新") }
        }
        err?.let { Text(it, color = MaterialTheme.colorScheme.error, modifier = Modifier.padding(16.dp)) }
        if (list.isEmpty() && err == null) {
            EmptyHint("还没有分享", "在文件列表中点「更多」即可创建")
        } else {
            LazyColumn(contentPadding = PaddingValues(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                items(list, key = { it.id }) { s ->
                    Surface(shape = CardShape, color = MaterialTheme.colorScheme.surfaceVariant, modifier = Modifier.fillMaxWidth()) {
                        Column(Modifier.padding(16.dp)) {
                            Text(s.name?.ifBlank { null } ?: s.items.firstOrNull() ?: s.code, style = MaterialTheme.typography.titleMedium, maxLines = 1, overflow = TextOverflow.Ellipsis)
                            Spacer(Modifier.height(4.dp))
                            Text("取件码 ${s.pickupCode}  ·  ${s.perm}  ·  ${s.status}", color = TextSecondary, style = MaterialTheme.typography.bodySmall)
                            Text("访问 ${s.visits}  ·  下载 ${s.downloads}", color = TextTertiary, style = MaterialTheme.typography.labelSmall)
                            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) {
                                IconButton({ copyText(ctx, s.pickupCode) }) { Icon(Icons.Default.ContentCopy, "复制") }
                                if (!s.revoked) IconButton({ vm.revoke(s) }) { Icon(Icons.Default.Block, "撤销") }
                                IconButton({ vm.deleteShare(s) }) { Icon(Icons.Default.Delete, "删除", tint = Danger) }
                            }
                        }
                    }
                }
            }
        }
    }
}

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

@Composable
fun TransfersScreen() {
    val ctx = LocalContext.current
    val infos by WorkManager.getInstance(ctx).getWorkInfosByTagFlow(TAG_TRANSFER).collectAsStateWithLifecycle(emptyList())
    val downloadDir = OfflineCache.downloads(ctx).absolutePath
    Column(Modifier.fillMaxSize()) {
        Row(Modifier.fillMaxWidth().padding(start = 20.dp, end = 4.dp, top = 12.dp, bottom = 4.dp), verticalAlignment = Alignment.CenterVertically) {
            Text("传输", style = MaterialTheme.typography.headlineMedium, modifier = Modifier.weight(1f))
            IconButton({ WorkManager.getInstance(ctx).pruneWork() }) { Icon(Icons.Default.CleaningServices, "清理") }
        }
        if (infos.isEmpty()) {
            EmptyHint("没有传输任务", "下载的文件保存在\n$downloadDir")
        } else {
            LazyColumn(contentPadding = PaddingValues(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                items(infos.sortedByDescending { it.state == WorkInfo.State.RUNNING }, key = { it.id }) { w ->
                    val name = w.progress.getString("name") ?: w.outputData.getString("name") ?: w.id.toString().take(8)
                    val done = w.progress.getLong("done", 0); val total = w.progress.getLong("total", 0)
                    Surface(shape = CardShape, color = MaterialTheme.colorScheme.surfaceVariant, modifier = Modifier.fillMaxWidth()) {
                        Column(Modifier.padding(16.dp)) {
                            Row(verticalAlignment = Alignment.CenterVertically) {
                                Icon(
                                    when (w.state) {
                                        WorkInfo.State.SUCCEEDED -> Icons.Default.CheckCircle
                                        WorkInfo.State.FAILED -> Icons.Default.Error
                                        WorkInfo.State.RUNNING -> Icons.Default.Downloading
                                        else -> Icons.Default.Schedule
                                    },
                                    null,
                                    tint = when (w.state) {
                                        WorkInfo.State.SUCCEEDED -> Neon
                                        WorkInfo.State.FAILED -> Danger
                                        WorkInfo.State.RUNNING -> Neon
                                        else -> TextSecondary
                                    },
                                )
                                Spacer(Modifier.width(10.dp))
                                Text(name, style = MaterialTheme.typography.titleSmall, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
                                if (!w.state.isFinished) IconButton({ WorkManager.getInstance(ctx).cancelWorkById(w.id) }) { Icon(Icons.Default.Close, "取消") }
                            }
                            Spacer(Modifier.height(6.dp))
                            Text(
                                when (w.state) {
                                    WorkInfo.State.SUCCEEDED -> "完成" + (w.outputData.getString("file")?.let { "  →  $it" } ?: "")
                                    WorkInfo.State.FAILED -> "失败：${w.outputData.getString("error") ?: ""}"
                                    WorkInfo.State.ENQUEUED -> "等待网络 / 重试中（已重试 ${w.runAttemptCount} 次）"
                                    WorkInfo.State.RUNNING -> "${fmtSize(done)} / ${if (total > 0) fmtSize(total) else "?"}"
                                    else -> w.state.name
                                },
                                color = TextSecondary,
                                style = MaterialTheme.typography.bodySmall,
                            )
                            if (w.state == WorkInfo.State.RUNNING && total > 0) {
                                Spacer(Modifier.height(8.dp))
                                LinearProgressIndicator(progress = { done.toFloat() / total }, modifier = Modifier.fillMaxWidth(), color = Neon, trackColor = InkChip)
                            }
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun EmptyHint(title: String, subtitle: String) {
    Column(Modifier.fillMaxSize().padding(32.dp), Arrangement.Center, Alignment.CenterHorizontally) {
        Text(title, style = MaterialTheme.typography.titleMedium, color = TextSecondary)
        Spacer(Modifier.height(6.dp))
        Text(subtitle, color = TextTertiary, style = MaterialTheme.typography.bodySmall)
    }
}
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
private fun MeRow(icon: ImageVector, title: String, subtitle: String?, tint: Color = TextPrimary, onClick: () -> Unit) {
    ListItem(
        headlineContent = { Text(title, color = tint) },
        supportingContent = subtitle?.let { { Text(it, color = TextSecondary, maxLines = 1, overflow = TextOverflow.Ellipsis) } },
        leadingContent = { Icon(icon, null, tint = tint) },
        trailingContent = { Icon(Icons.Default.ChevronRight, null, tint = TextTertiary) },
        modifier = Modifier.clickable { onClick() },
        colors = ListItemDefaults.colors(containerColor = Color.Transparent),
    )
}

@Composable
fun PreviewScreen(vm: AppViewModel, item: FsItem, onClose: () -> Unit) {
    BackHandler { onClose() }
    Column(Modifier.fillMaxSize().background(Ink)) {
        TopAppBar(
            title = { Text(item.name, maxLines = 1, overflow = TextOverflow.Ellipsis) },
            navigationIcon = { IconButton(onClose) { Icon(Icons.AutoMirrored.Filled.ArrowBack, "back") } },
            actions = { IconButton({ vm.download(item) }) { Icon(Icons.Default.Download, "download") } },
            colors = TopAppBarDefaults.topAppBarColors(containerColor = Ink),
        )
        Box(Modifier.fillMaxSize(), Alignment.Center) {
            when (kindOf(item.name)) {
                "image" -> ImagePreview(vm, item)
                "video", "audio" -> MediaPreview(vm, item)
                "pdf" -> PdfPreview(vm, item)
                "text" -> TextPreview(vm, item)
                else -> Column(horizontalAlignment = Alignment.CenterHorizontally) {
                    FileGlyph(item, 72.dp)
                    Spacer(Modifier.height(12.dp))
                    Text("此类型暂不支持预览", color = TextSecondary)
                    Text(fmtSize(item.size), color = TextTertiary, style = MaterialTheme.typography.bodySmall)
                    Button({ vm.download(item) }, Modifier.padding(top = 16.dp), shape = PillShape) { Text("下载") }
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
        r == null -> CircularProgressIndicator(color = Neon)
        r!!.isFailure -> Text(vm.errText(r!!.exceptionOrNull()!!), Modifier.padding(16.dp))
        r!!.getOrNull() == null -> Text("无法解码图片", color = TextSecondary)
        else -> Image(r!!.getOrNull()!!.asImageBitmap(), item.name, Modifier.fillMaxSize(), contentScale = ContentScale.Fit)
    }
}

@Composable
fun TextPreview(vm: AppViewModel, item: FsItem) {
    val r by produceLoad(item.path) { vm.previewFile(item.path).readText().take(200_000) }
    when {
        r == null -> CircularProgressIndicator(color = Neon)
        r!!.isFailure -> Text(vm.errText(r!!.exceptionOrNull()!!), Modifier.padding(16.dp))
        else -> Text(r!!.getOrNull()!!, Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(16.dp), style = MaterialTheme.typography.bodySmall, color = TextPrimary)
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
        r == null -> CircularProgressIndicator(color = Neon)
        r!!.isFailure -> Text(vm.errText(r!!.exceptionOrNull()!!), Modifier.padding(16.dp))
        else -> LazyColumn(Modifier.fillMaxSize(), verticalArrangement = Arrangement.spacedBy(8.dp), contentPadding = PaddingValues(12.dp)) {
            items(r!!.getOrNull()!!) { b -> Image(b.asImageBitmap(), null, Modifier.fillMaxWidth().clip(RoundedCornerShape(8.dp)), contentScale = ContentScale.FillWidth) }
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
