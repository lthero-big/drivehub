package com.drivehub.app.ui.screens

import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.scaleIn
import androidx.compose.animation.togetherWith
import androidx.compose.foundation.layout.*
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.*
import androidx.compose.material.icons.outlined.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.input.nestedscroll.NestedScrollConnection
import androidx.compose.ui.input.nestedscroll.NestedScrollSource
import androidx.compose.ui.input.nestedscroll.nestedScroll
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.drivehub.app.data.FsItem
import com.drivehub.app.ui.AppViewModel
import com.drivehub.app.ui.components.DockTab
import com.drivehub.app.ui.components.FloatingDock
import com.drivehub.app.ui.theme.Motion

internal enum class Tab(val label: String, val icon: ImageVector, val selected: ImageVector) {
    Files("文件", Icons.Outlined.Folder, Icons.Filled.Folder),
    Transfers("传输", Icons.Outlined.SwapVert, Icons.Filled.SwapVert),
    Shares("分享", Icons.Outlined.Share, Icons.Filled.Share),
    Me("我的", Icons.Outlined.Person, Icons.Filled.Person),
}

/**
 * Scroll-direction tracker: hides the dock while the user scrolls down a list and brings it back
 * on any upward scroll (threshold avoids flicker on tiny drags).
 */
internal class DockScrollConnection(private val onVisible: (Boolean) -> Unit) : NestedScrollConnection {
    override fun onPreScroll(available: Offset, source: NestedScrollSource): Offset {
        if (available.y < -6f) onVisible(false) else if (available.y > 6f) onVisible(true)
        return Offset.Zero
    }
}

@Composable
fun MainScreen(vm: AppViewModel) {
    var tab by rememberSaveable { mutableStateOf(Tab.Files) }
    var preview by remember { mutableStateOf<FsItem?>(null) }
    var pickup by remember { mutableStateOf(false) }
    var dockVisible by remember { mutableStateOf(true) }
    var addRequest by rememberSaveable { mutableIntStateOf(0) }
    val files by vm.files.collectAsStateWithLifecycle()
    val upd by vm.appUpdate.collectAsStateWithLifecycle()
    preview?.let { PreviewScreen(vm, it) { preview = null }; return }
    if (pickup) { PickupScreen(vm) { pickup = false }; return }
    val conn = remember { DockScrollConnection { dockVisible = it } }
    LaunchedEffect(tab, files.path) { dockVisible = true }
    val canAdd = tab == Tab.Files && files.path != "/" && files.hits == null
    Box(Modifier.fillMaxSize()) {
        AnimatedContent(
            tab,
            Modifier.fillMaxSize().nestedScroll(conn),
            transitionSpec = { (fadeIn(Motion.medium()) + scaleIn(Motion.medium(), initialScale = 0.98f)) togetherWith fadeOut(Motion.short()) },
            label = "tab",
        ) { t ->
            when (t) {
                Tab.Files -> FilesScreen(vm, addRequest) { preview = it }
                Tab.Transfers -> TransfersScreen()
                Tab.Shares -> SharesScreen(vm, onPickup = { pickup = true })
                Tab.Me -> MeScreen(vm, onPickup = { pickup = true })
            }
        }
        FloatingDock(
            tabs = Tab.entries.map { DockTab(it.name, it.label, it.icon, it.selected, badge = it == Tab.Me && upd.pkg != null) },
            selected = tab.name,
            onSelect = { k ->
                val t = Tab.valueOf(k)
                if (t == Tab.Shares) vm.loadShares()
                tab = t; dockVisible = true
            },
            visible = dockVisible,
            modifier = Modifier.align(Alignment.BottomCenter),
            actionIcon = if (canAdd) Icons.Filled.Add else null,
            actionDesc = "添加",
            onAction = { addRequest++ },
        )
    }
}
