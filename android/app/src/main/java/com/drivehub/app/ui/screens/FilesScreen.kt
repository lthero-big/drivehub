@file:OptIn(androidx.compose.material3.ExperimentalMaterial3Api::class)

package com.drivehub.app.ui.screens

import android.provider.OpenableColumns
import androidx.activity.compose.BackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.scaleIn
import androidx.compose.animation.togetherWith
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.GridItemSpan
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.itemsIndexed
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.ViewList
import androidx.compose.material.icons.filled.*
import androidx.compose.material3.*
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.drivehub.app.BuildConfig
import com.drivehub.app.data.FsItem
import com.drivehub.app.ui.AppViewModel
import com.drivehub.app.ui.KindFilter
import com.drivehub.app.ui.components.*
import com.drivehub.app.ui.matchesFilter
import com.drivehub.app.ui.mountBrand
import com.drivehub.app.ui.theme.Dh
import com.drivehub.app.ui.theme.Motion
import com.drivehub.app.ui.theme.Space

@Composable
fun FilesScreen(vm: AppViewModel, addRequest: Int, onPreview: (FsItem) -> Unit) {
    val st by vm.files.collectAsStateWithLifecycle()
    val thumbsOn by vm.thumbnails.collectAsStateWithLifecycle()
    val upd by vm.appUpdate.collectAsStateWithLifecycle()
    val info by vm.serverInfo.collectAsStateWithLifecycle()
    val ctx = LocalContext.current
    val c = Dh.c
    var menu by remember { mutableStateOf<FsItem?>(null) }
    var dialog by remember { mutableStateOf<String?>(null) }
    var account by remember { mutableStateOf(false) }
    var q by rememberSaveable { mutableStateOf("") }
    var grid by rememberSaveable { mutableStateOf(false) }
    var filter by rememberSaveable { mutableStateOf(KindFilter.All) }
    var handledAdd by rememberSaveable { mutableIntStateOf(addRequest) }
    LaunchedEffect(addRequest) { if (addRequest != handledAdd) { handledAdd = addRequest; dialog = "add" } }
    val picker = rememberLauncherForActivityResult(ActivityResultContracts.OpenMultipleDocuments()) { uris ->
        uris.forEach { u ->
            val name = ctx.contentResolver.query(u, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)
                ?.use { if (it.moveToFirst()) it.getString(0) else null } ?: "upload.bin"
            vm.upload(u, name)
        }
    }
    val searching = st.hits != null
    BackHandler(enabled = st.path != "/" || searching) {
        if (searching) { vm.search(""); q = "" } else vm.up()
    }
    val source = st.hits?.map { h -> FsItem(h.name, h.path, h.isDir, h.size, h.modifiedUnix) } ?: st.items
    val atRoot = st.path == "/" && !searching
    val visible = if (atRoot) source else source.filter { matchesFilter(it, filter) }
    val open: (FsItem) -> Unit = { if (it.isDir) vm.loadFiles(it.path) else onPreview(it) }
    val user = vm.prefs.username.orEmpty()

    CompositionLocalProvider(LocalThumbs provides if (thumbsOn) vm.thumbs else null) {
        Column(Modifier.fillMaxSize()) {
            SearchPill(
                q, { q = it }, onSearch = { vm.search(q) }, onClear = { q = ""; vm.search("") },
                avatarInitial = user.firstOrNull()?.uppercaseChar()?.toString() ?: "D",
                updateBadge = upd.pkg != null, onAvatar = { account = true },
                modifier = Modifier.statusBarsPadding().padding(horizontal = 16.dp, vertical = 8.dp),
            )
            FolderHeader(
                atRoot = atRoot, searching = searching, path = st.path, count = visible.size, query = st.query,
                mountKind = vm.mountKindOf(st.path), grid = grid,
                onBack = { if (searching) { vm.search(""); q = "" } else vm.up() },
                onToggleGrid = { grid = !grid }, onRefresh = { vm.refresh() },
            )
            AnimatedVisibility(!atRoot) { FilterPills(filter, { filter = it }) }
            if (st.offline) StatusPill("离线模式 · 显示缓存目录", c.warning, Modifier.padding(horizontal = 20.dp, vertical = 4.dp))
            PullToRefreshBox(st.loading, { vm.refresh() }, Modifier.weight(1f).fillMaxWidth()) {
                val err = st.error
                when {
                    err != null && visible.isEmpty() -> EmptyState(EmptyKind.Error, "加载失败", err, Modifier.padding(bottom = dockInset())) {
                        MorphStatusButton(MorphState.Idle("重试", Icons.Default.Refresh), height = 44.dp) { vm.refresh() }
                    }
                    visible.isEmpty() && !st.loading -> EmptyState(
                        if (searching) EmptyKind.Search else EmptyKind.Folder,
                        if (searching) "没有找到相关文件" else if (filter != KindFilter.All && !atRoot) "没有${filter.label}" else "这里还没有文件",
                        if (searching) "换个关键词，或检查拼写" else if (atRoot) "管理员还没有为你开放任何网盘" else "点右下角 + 上传文件或新建文件夹",
                        Modifier.padding(bottom = dockInset()),
                    )
                    atRoot -> MountBento(visible, open) { menu = it }
                    else -> AnimatedContent(
                        grid,
                        transitionSpec = { (fadeIn(Motion.medium()) + scaleIn(Motion.medium(), initialScale = 0.96f)) togetherWith fadeOut(Motion.short()) },
                        label = "layout",
                    ) { g ->
                        if (g) LazyVerticalGrid(
                            GridCells.Adaptive(108.dp), Modifier.fillMaxSize(),
                            contentPadding = PaddingValues(start = 12.dp, end = 12.dp, top = 4.dp, bottom = dockInset()),
                            horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(6.dp),
                        ) {
                            itemsIndexed(visible, key = { _, it -> it.path }) { _, it -> FileGridCell(it, { open(it) }, { menu = it }) }
                        } else LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(start = 8.dp, end = 4.dp, top = 4.dp, bottom = dockInset())) {
                            items(visible, key = { it.path }) { it -> FileRow(it, { open(it) }, { menu = it }) }
                        }
                    }
                }
            }
        }

        val m = menu
        if (m != null && dialog == null) {
            FileActionSheet(
                m, onDismiss = { menu = null },
                onPreview = { menu = null; onPreview(m) },
                onDownload = { vm.download(m); menu = null },
                onShare = { dialog = "share" }, onRename = { dialog = "rename" }, onDelete = { dialog = "delete" },
            )
        }
        when (dialog) {
            "add" -> AddSheet({ dialog = null }, onUpload = { dialog = null; picker.launch(arrayOf("*/*")) }, onMkdir = { dialog = "mkdir" })
            "mkdir" -> TextDialog("新建文件夹", "", { dialog = null }) { vm.mkdir(it); dialog = null }
            "rename" -> m?.let { TextDialog("重命名", it.name, { dialog = null; menu = null }) { n -> vm.rename(it, n); dialog = null; menu = null } }
            "delete" -> m?.let { ConfirmDeleteDialog(it.name, { dialog = null }) { vm.delete(it); dialog = null; menu = null } }
            "share" -> m?.let { ShareSheet(it, { dialog = null; menu = null }) { perm, days, pin -> vm.createShare(it, perm, days, pin); dialog = null; menu = null } }
        }
        val created by vm.createdShare.collectAsStateWithLifecycle()
        created?.let { s -> ShareCreatedDialog(s) { vm.createdShare.value = null } }
        if (account) {
            AccountSheet(user, vm.prefs.serverUrl ?: "", info?.serverVersion, { account = false }, onLogout = { account = false; vm.logout() }) {
                if (upd.pkg != null || upd.checking || upd.error != null) AppUpdateCard(vm)
                else GroupCard {
                    GroupRow(Icons.Default.Verified, "已是最新版本", "App ${BuildConfig.VERSION_NAME}", iconTint = c.success, first = true,
                        trailing = { TextButton({ vm.refreshAppUpdate() }) { Text("检查更新", color = c.accent) } })
                }
            }
        }
    }
}

@Composable
private fun FolderHeader(
    atRoot: Boolean, searching: Boolean, path: String, count: Int, query: String, mountKind: String?, grid: Boolean,
    onBack: () -> Unit, onToggleGrid: () -> Unit, onRefresh: () -> Unit,
) {
    val c = Dh.c
    Row(Modifier.fillMaxWidth().padding(start = 12.dp, end = 4.dp, top = 4.dp, bottom = 4.dp), verticalAlignment = Alignment.CenterVertically) {
        if (!atRoot) {
            GlassIconButton(Icons.AutoMirrored.Filled.ArrowBack, "返回", onClick = onBack)
            Spacer(Modifier.width(12.dp))
        }
        Column(Modifier.weight(1f).padding(start = if (atRoot) 8.dp else 0.dp)) {
            val title = when {
                searching -> "搜索结果"
                atRoot -> "我的网盘"
                else -> path.trimEnd('/').substringAfterLast('/')
            }
            Text(title, style = if (atRoot) MaterialTheme.typography.headlineMedium else MaterialTheme.typography.titleLarge, color = c.fg, maxLines = 1, overflow = TextOverflow.Ellipsis, fontWeight = FontWeight.Bold)
            when {
                searching -> Text("“$query” · $count 项", color = c.fg3, style = MaterialTheme.typography.bodySmall)
                atRoot -> Text("$count 个存储已连接", color = c.fg3, style = MaterialTheme.typography.bodySmall)
                else -> Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.padding(top = 2.dp)) {
                    val mount = path.trim('/').substringBefore('/')
                    val brand = mountBrand(mountKind).label
                    MountChip(mountKind, if (mount == title) brand else "$brand · $mount")
                    val rest = path.trim('/').substringAfter('/', "")
                    if (rest.contains('/')) Text("  /${rest.substringBeforeLast('/')}", color = c.fg3, style = MaterialTheme.typography.labelSmall, maxLines = 1, overflow = TextOverflow.Ellipsis)
                }
            }
        }
        if (!atRoot) HeaderAction(if (grid) Icons.AutoMirrored.Filled.ViewList else Icons.Default.GridView, "切换视图", onClick = onToggleGrid)
        HeaderAction(Icons.Default.Refresh, "刷新", onClick = onRefresh)
    }
}

/** Root "/" as a Bento grid: first mount is a full-width hero, an odd tail also spans full width. */
@Composable
private fun MountBento(items: List<FsItem>, open: (FsItem) -> Unit, onMore: (FsItem) -> Unit) {
    val mounts = items.filter { it.isDir }
    val others = items.filterNot { it.isDir }
    LazyVerticalGrid(
        GridCells.Fixed(2), Modifier.fillMaxSize(),
        contentPadding = PaddingValues(start = 16.dp, end = 16.dp, top = 8.dp, bottom = dockInset()),
        horizontalArrangement = Arrangement.spacedBy(12.dp), verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        itemsIndexed(mounts, key = { _, it -> it.path }, span = { i, _ ->
            val full = i == 0 || (i == mounts.lastIndex && (mounts.size - 1) % 2 == 1)
            GridItemSpan(if (full) 2 else 1)
        }) { i, it -> MountCard(it, hero = i == 0) { open(it) } }
        itemsIndexed(others, key = { _, it -> it.path }, span = { _, _ -> GridItemSpan(2) }) { _, it -> FileRow(it, { open(it) }, { onMore(it) }) }
    }
}
