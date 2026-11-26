package com.drivehub.app.ui.screens

import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.togetherWith
import androidx.compose.foundation.layout.*
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.*
import androidx.compose.material.icons.outlined.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.drivehub.app.data.FsItem
import com.drivehub.app.ui.AppViewModel
import com.drivehub.app.ui.components.TabBar
import com.drivehub.app.ui.components.TabItem
import com.drivehub.app.ui.theme.Motion

internal enum class Tab(val label: String, val icon: ImageVector, val selected: ImageVector) {
    Files("文件", Icons.Outlined.Folder, Icons.Filled.Folder),
    Transfers("传输", Icons.Outlined.SwapVert, Icons.Filled.SwapVert),
    Shares("分享", Icons.Outlined.Link, Icons.Filled.Link),
    Me("我的", Icons.Outlined.Person, Icons.Filled.Person),
}

/**
 * Main shell: content above an opaque 4-tab bar (文件 / 传输 / 分享 / 我的). Re-tapping 文件
 * returns to the 「浏览」 root. The "+" entry lives in the folder header, not on the bar.
 */
@Composable
fun MainScreen(vm: AppViewModel) {
    var tab by rememberSaveable { mutableStateOf(Tab.Files) }
    var preview by remember { mutableStateOf<FsItem?>(null) }
    var pickup by remember { mutableStateOf(false) }
    val upd by vm.appUpdate.collectAsStateWithLifecycle()
    preview?.let { PreviewScreen(vm, it) { preview = null }; return }
    if (pickup) { PickupScreen(vm) { pickup = false }; return }
    Column(Modifier.fillMaxSize()) {
        AnimatedContent(
            tab,
            Modifier.weight(1f).fillMaxWidth(),
            transitionSpec = { fadeIn(Motion.short()) togetherWith fadeOut(Motion.short()) },
            label = "tab",
        ) { t ->
            when (t) {
                Tab.Files -> FilesScreen(vm) { preview = it }
                Tab.Transfers -> TransfersScreen()
                Tab.Shares -> SharesScreen(vm, onPickup = { pickup = true })
                Tab.Me -> MeScreen(vm, onPickup = { pickup = true })
            }
        }
        TabBar(
            tabs = Tab.entries.map { TabItem(it.name, it.label, it.icon, it.selected, badge = it == Tab.Me && upd.pkg != null) },
            selected = tab.name,
            onSelect = { k ->
                val t = Tab.valueOf(k)
                if (t == Tab.Files && tab == Tab.Files) vm.browseHome()
                if (t == Tab.Shares) vm.loadShares()
                tab = t
            },
        )
    }
}
