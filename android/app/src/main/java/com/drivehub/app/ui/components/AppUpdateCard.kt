package com.drivehub.app.ui.components

import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.*
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.SystemUpdate
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.drivehub.app.BuildConfig
import com.drivehub.app.ui.AppUpdateState
import com.drivehub.app.ui.AppViewModel
import com.drivehub.app.ui.fmtSize
import com.drivehub.app.ui.theme.Dh

/** Maps the update flow onto the morphing button states. */
fun updateMorphState(st: AppUpdateState): MorphState = when {
    st.needsPermission -> MorphState.Idle("前往授予安装权限")
    st.downloading -> MorphState.Busy(progress = if (st.total > 0) (st.received.toFloat() / st.total).coerceIn(0f, 1f) else null)
    st.installing -> MorphState.Busy(label = "等待系统安装确认…")
    st.checking -> MorphState.Busy(label = "正在检查…")
    st.error != null && st.pkg != null -> MorphState.Failed("重试")
    else -> MorphState.Idle("下载并安装", Icons.Default.SystemUpdate)
}

@Composable
fun AppUpdateCard(vm: AppViewModel, forced: Boolean = false) {
    val st by vm.appUpdate.collectAsStateWithLifecycle()
    val launchSettings = rememberLauncherForActivityResult(ActivityResultContracts.StartActivityForResult()) { vm.onForeground() }
    if (!forced && st.pkg == null && !st.checking && st.error == null) return
    val c = Dh.c
    DhCard(Modifier.fillMaxWidth(), border = c.accent.copy(alpha = 0.35f)) {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                IconTile(Icons.Default.SystemUpdate, c.accent, 44.dp)
                Spacer(Modifier.width(12.dp))
                Column(Modifier.weight(1f)) {
                    Text(if (st.forced || forced) "请安装新版本" else "发现新版本", style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.SemiBold, color = c.fg)
                    val ver = st.pkg?.let { it.version ?: it.versionCode?.let { v -> "versionCode $v" } }
                    Text(
                        listOfNotNull("当前 ${BuildConfig.VERSION_NAME}", ver?.let { "→ $it" }, st.pkg?.size?.takeIf { it > 0 }?.let { fmtSize(it) }).joinToString("  "),
                        color = c.fg2, style = MaterialTheme.typography.bodySmall,
                    )
                }
            }
            st.pkg?.notes?.takeIf { it.isNotBlank() }?.let { Text(it.take(240), color = c.fg2, style = MaterialTheme.typography.bodySmall) }
            st.error?.let { Text(it, color = c.danger, style = MaterialTheme.typography.bodySmall) }
            if (st.downloading && st.total > 0) Text("${fmtSize(st.received)} / ${fmtSize(st.total)}", color = c.fg3, style = MaterialTheme.typography.labelSmall)
            if (st.pkg != null || st.checking || st.needsPermission) {
                MorphStatusButton(updateMorphState(st), Modifier.fillMaxWidth()) {
                    if (st.needsPermission) launchSettings.launch(vm.installPermissionIntent()) else vm.startAppUpdate()
                }
            }
        }
    }
}
