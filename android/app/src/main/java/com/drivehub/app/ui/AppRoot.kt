package com.drivehub.app.ui

import androidx.compose.foundation.layout.*
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Snackbar
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.drivehub.app.ui.components.AmbientBackground
import com.drivehub.app.ui.screens.BlockedScreen
import com.drivehub.app.ui.screens.LoginScreen
import com.drivehub.app.ui.screens.MainScreen
import com.drivehub.app.ui.screens.SetupScreen
import com.drivehub.app.ui.theme.Dh
import com.drivehub.app.ui.theme.Radius

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
    val c = Dh.c
    AmbientBackground(Modifier.fillMaxSize()) {
        when (val s = stage) {
            Stage.Boot -> Box(Modifier.fillMaxSize(), Alignment.Center) { CircularProgressIndicator(color = c.accent) }
            is Stage.Setup -> SetupScreen(vm, s)
            is Stage.Blocked -> BlockedScreen(vm, s.compat)
            is Stage.Login -> LoginScreen(vm, s)
            Stage.Main -> MainScreen(vm)
        }
        SnackbarHost(
            snack,
            Modifier.align(Alignment.BottomCenter).navigationBarsPadding().imePadding().padding(bottom = if (stage == Stage.Main) 84.dp else 12.dp),
        ) { d ->
            Snackbar(shape = Radius.md, containerColor = c.fg, contentColor = c.bg, modifier = Modifier.padding(horizontal = 16.dp)) { Text(d.visuals.message) }
        }
    }
}
