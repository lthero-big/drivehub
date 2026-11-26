@file:OptIn(androidx.compose.material3.ExperimentalMaterial3Api::class)

package com.drivehub.app.ui.screens

import android.provider.OpenableColumns
import androidx.activity.compose.BackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ViewList
import androidx.compose.material.icons.filled.*
import androidx.compose.material3.*
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.drivehub.app.BuildConfig
import com.drivehub.app.data.FsItem
import com.drivehub.app.ui.AppViewModel
import com.drivehub.app.ui.FilesState
import com.drivehub.app.ui.KindFilter
import com.drivehub.app.ui.NavMemory
import com.drivehub.app.ui.components.*
import com.drivehub.app.ui.matchesFilter
import com.drivehub.app.ui.mountBrand
import com.drivehub.app.ui.theme.Dh

@Composable
fun FilesScreen(vm: AppViewModel, onPreview: (FsItem) -> Unit) {
    val st by vm.files.collectAsStateWithLifecycle()
    val thumbsOn by vm.thumbnails.collectAsStateWithLifecycle()
    val upd by vm.appUpdate.collectAsStateWithLifecycle()
    val info by vm.serverInfo.collectAsStateWithLifecycle()
    val grid by vm.gridView.collectAsStateWithLifecycle()
    val recent by vm.recent.collectAsStateWithLifecycle()
    vm.mounts.collectAsStateWithLifecycle().value // recompose when mount labels arrive
    vm.readOnlyMounts.collectAsStateWithLifecycle().value
    val ctx = LocalContext.current
    val c = Dh.c
    var menu by remember { mutableStateOf<FsItem?>(null) }
    var dialog by remember { mutableStateOf<String?>(null) }
    var account by remember { mutableStateOf(false) }
    var q by rememberSaveable { mutableStateOf("") }
    var filter by rememberSaveable { mutableStateOf(KindFilter.All) }
    LaunchedEffect(st.path) { filter = KindFilter.All }
    val picker = rememberLauncherForActivityResult(ActivityResultContracts.OpenMultipleDocuments()) { uris ->
        uris.forEach { u ->
            val name = ctx.contentResolver.query(u, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)
                ?.use { if (it.moveToFirst()) it.getString(0) else null } ?: "upload.bin"
            vm.upload(u, name)
        }
    }
    val searching = st.hits != null
    val clearSearch = { vm.search(""); q = "" }
    BackHandler(enabled = st.path != "/" || searching) { if (searching) clearSearch() else vm.up() }
    val home = st.path == "/" && !searching
    val open: (FsItem) -> Unit = { if (it.isDir) vm.loadFiles(it.path) else onPreview(it) }
    val user = vm.prefs.username.orEmpty()

    CompositionLocalProvider(LocalThumbs provides if (thumbsOn) vm.thumbs else null) {
        if (home) {
            BrowseHome(
                vm, st, recent, q, { q = it }, onSearch = { vm.search(q) }, onClear = clearSearch,
                avatar = user.firstOrNull()?.uppercaseChar()?.toString() ?: "D", badge = upd.pkg != null,
                onAvatar = { account = true }, open = open, onMore = { menu = it },
            )
        } else {
            val source = st.hits?.map { h -> FsItem(h.name, h.path, h.isDir, h.size, h.modifiedUnix) } ?: st.items
            FolderPage(
                vm, st, searching, source.filter { matchesFilter(it, filter) }, filter, { filter = it }, grid,
                canAdd = !searching && !vm.isReadOnly(st.path),
                onBack = { if (searching) clearSearch() else vm.up() },
                onAdd = { dialog = "add" }, open = open, onMore = { menu = it },
            )
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
                    GroupRow(Icons.Default.Verified, "已是最新版本", "App ${BuildConfig.VERSION_NAME}", first = true,
                        trailing = { TextButton({ vm.refreshAppUpdate() }) { Text("检查更新", color = c.accent) } })
                }
            }
        }
    }
}

/**
 * 「浏览」 (Apple Files structure): Large Title + soft search field + Grouped Inset sections —
 * 「位置」 lists every mounted drive, 「最近」 the folders opened lately.
 */
@Composable
private fun BrowseHome(
    vm: AppViewModel, st: FilesState, recent: List<String>,
    q: String, onQuery: (String) -> Unit, onSearch: () -> Unit, onClear: () -> Unit,
    avatar: String, badge: Boolean, onAvatar: () -> Unit,
    open: (FsItem) -> Unit, onMore: (FsItem) -> Unit,
) {
    val c = Dh.c
    val mounts = st.items.filter { it.isDir }
    val others = st.items.filterNot { it.isDir }
    val names = mounts.map { it.name }.toSet()
    val rec = recent.filter { NavMemory.mountOf(it) in names }.take(4)
    PullToRefreshBox(st.loading, { vm.refresh() }, Modifier.fillMaxSize()) {
        LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(bottom = 24.dp)) {
            item {
                ScreenHeader("浏览", actions = { Avatar(avatar, 32.dp, badge, onAvatar); Spacer(Modifier.width(8.dp)) })
                SearchField(q, onQuery, onSearch, onClear, Modifier.padding(horizontal = 16.dp))
                if (st.offline) StatusPill("离线模式 · 显示缓存目录", c.warning, Modifier.padding(start = 16.dp, top = 10.dp))
            }
            val err = st.error
            when {
                err != null && mounts.isEmpty() -> item {
                    EmptyState(EmptyKind.Error, "加载失败", err, Modifier.padding(top = 40.dp)) {
                        MorphStatusButton(MorphState.Idle("重试"), height = 40.dp) { vm.refresh() }
                    }
                }
                mounts.isEmpty() && !st.loading -> item {
                    EmptyState(EmptyKind.Folder, "还没有可用的网盘", "管理员还没有为你开放任何网盘", Modifier.padding(top = 40.dp))
                }
                else -> {
                    item { SectionLabel("位置", Modifier.padding(start = 16.dp)) }
                    itemsIndexed(mounts, key = { _, it -> it.path }) { i, m -> MountRow(m, i == 0, i == mounts.lastIndex) { open(m) } }
                }
            }
            if (rec.isNotEmpty()) {
                item { SectionLabel("最近", Modifier.padding(start = 16.dp)) }
                itemsIndexed(rec, key = { _, p -> "recent:$p" }) { i, p -> RecentRow(p, vm.mountKindOf(p), i == 0, i == rec.lastIndex) { vm.loadFiles(p) } }
            }
            if (others.isNotEmpty()) {
                item { SectionLabel("文件", Modifier.padding(start = 16.dp)) }
                itemsIndexed(others, key = { _, it -> it.path }) { i, it ->
                    FileRow(it, { open(it) }, { onMore(it) }, Modifier.padding(horizontal = 16.dp).groupItem(i == 0, i == others.lastIndex, c, 68.dp))
                }
            }
        }
    }
}

@Composable
private fun MountRow(m: FsItem, first: Boolean, last: Boolean, onClick: () -> Unit) {
    val b = mountBrand(m.mountKind)
    NavRow(first, last, onClick, { BrandTile(b) }, m.name, if (m.readOnly == true) "${b.label} · 只读" else b.label)
}

@Composable
private fun RecentRow(path: String, kind: String?, first: Boolean, last: Boolean, onClick: () -> Unit) {
    val c = Dh.c
    val parts = path.trim('/').split('/')
    val where = listOfNotNull(kind?.let { mountBrand(it).label } ?: parts.first(), parts.dropLast(1).drop(1).joinToString("/").ifEmpty { null })
    NavRow(first, last, onClick, { IconTile(Icons.Default.Folder, c.folder) }, parts.last(), where.joinToString(" · "))
}

/** Grouped Inset navigation row: 30 dp icon, title, small caption, "›". Divider indents to 58 dp. */
@Composable
private fun NavRow(first: Boolean, last: Boolean, onClick: () -> Unit, icon: @Composable () -> Unit, title: String, caption: String) {
    val c = Dh.c
    Row(
        Modifier.padding(horizontal = 16.dp).fillMaxWidth().groupItem(first, last, c, 58.dp).clickable(onClick = onClick)
            .padding(start = 14.dp, end = 10.dp, top = 10.dp, bottom = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        icon()
        Spacer(Modifier.width(14.dp))
        Column(Modifier.weight(1f)) {
            Text(title, color = c.fg, style = MaterialTheme.typography.bodyLarge, maxLines = 1, overflow = TextOverflow.Ellipsis)
            Text(caption, color = c.fg3, style = MaterialTheme.typography.bodySmall, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
        Chevron()
    }
}

/**
 * Folder / search results: "‹ 浏览" back link, view toggle and "+" top-right, Large Title, compact
 * kind chips, then a Grouped Inset list or a 3-column gallery.
 */
@Composable
private fun FolderPage(
    vm: AppViewModel, st: FilesState, searching: Boolean, visible: List<FsItem>,
    filter: KindFilter, onFilter: (KindFilter) -> Unit, grid: Boolean, canAdd: Boolean,
    onBack: () -> Unit, onAdd: () -> Unit, open: (FsItem) -> Unit, onMore: (FsItem) -> Unit,
) {
    val c = Dh.c
    val trimmed = st.path.trimEnd('/')
    val parent = trimmed.substringBeforeLast('/')
    val title = if (searching) "搜索结果" else trimmed.substringAfterLast('/')
    val backLabel = when {
        searching -> "浏览"
        parent.isEmpty() -> "浏览"
        else -> parent.substringAfterLast('/')
    }
    val kind = vm.mountKindOf(st.path)
    val subtitle = if (searching) "“${st.query}” · ${visible.size} 项"
    else listOfNotNull(kind?.let { mountBrand(it).label }, if (vm.isReadOnly(st.path)) "只读" else null, "${visible.size} 项").joinToString(" · ")
    Column(Modifier.fillMaxSize()) {
        ScreenHeader(title, subtitle, leading = { BackLink(backLabel, onBack) }) {
            HeaderAction(if (grid) Icons.AutoMirrored.Filled.ViewList else Icons.Default.GridView, if (grid) "列表视图" else "画廊视图", c.fg) { vm.setGridView(!grid) }
            if (canAdd) {
                Spacer(Modifier.width(2.dp))
                CircleIconButton(Icons.Default.Add, "上传或新建", bg = c.accentSoft, tint = c.accent, onClick = onAdd)
                Spacer(Modifier.width(8.dp))
            }
        }
        if (!searching) FilterChips(filter, onFilter)
        if (st.offline) StatusPill("离线模式 · 显示缓存目录", c.warning, Modifier.padding(start = 16.dp, top = 6.dp))
        PullToRefreshBox(st.loading, { vm.refresh() }, Modifier.weight(1f).fillMaxWidth()) {
            val err = st.error
            when {
                err != null && visible.isEmpty() -> EmptyState(EmptyKind.Error, "加载失败", err) {
                    MorphStatusButton(MorphState.Idle("重试"), height = 40.dp) { vm.refresh() }
                }
                visible.isEmpty() && !st.loading -> EmptyState(
                    if (searching) EmptyKind.Search else EmptyKind.Folder,
                    when {
                        searching -> "没有找到相关文件"
                        filter != KindFilter.All -> "没有${filter.label}"
                        else -> "这里还没有文件"
                    },
                    when {
                        searching -> "换个关键词，或检查拼写"
                        canAdd -> "点右上角 + 上传文件或新建文件夹"
                        else -> "此网盘为只读"
                    },
                )
                grid -> LazyVerticalGrid(
                    GridCells.Fixed(3), Modifier.fillMaxSize(),
                    contentPadding = PaddingValues(start = 16.dp, end = 16.dp, top = 8.dp, bottom = 24.dp),
                    horizontalArrangement = Arrangement.spacedBy(3.dp), verticalArrangement = Arrangement.spacedBy(3.dp),
                ) {
                    items(visible, key = { it.path }) { it -> FileGridCell(it, { open(it) }, { onMore(it) }) }
                }
                else -> LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(top = 8.dp, bottom = 24.dp)) {
                    itemsIndexed(visible, key = { _, it -> it.path }) { i, it ->
                        FileRow(it, { open(it) }, { onMore(it) }, Modifier.padding(horizontal = 16.dp).groupItem(i == 0, i == visible.lastIndex, c, 68.dp))
                    }
                }
            }
        }
    }
}
