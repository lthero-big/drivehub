package com.drivehub.app.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.drivehub.app.ui.theme.Dh
import com.drivehub.app.ui.theme.Hair

data class TabItem(val key: String, val label: String, val icon: ImageVector, val selectedIcon: ImageVector, val badge: Boolean = false)

/**
 * Standard bottom tab bar: opaque paper / charcoal fill with a 0.5 dp top hairline. It sits below
 * the content (never over it), so list text can never show through. Selected tab = brand red.
 */
@Composable
fun TabBar(tabs: List<TabItem>, selected: String, onSelect: (String) -> Unit, modifier: Modifier = Modifier) {
    val c = Dh.c
    Column(modifier.fillMaxWidth().background(c.bg)) {
        Box(Modifier.fillMaxWidth().height(Hair).background(c.line))
        Row(Modifier.fillMaxWidth().navigationBarsPadding().height(54.dp)) {
            tabs.forEach { t ->
                val on = t.key == selected
                val tint = if (on) c.accent else c.fg3
                Column(
                    Modifier.weight(1f).fillMaxHeight()
                        .selectable(on, remember { MutableInteractionSource() }, indication = null, role = Role.Tab) { onSelect(t.key) },
                    verticalArrangement = Arrangement.Center,
                    horizontalAlignment = Alignment.CenterHorizontally,
                ) {
                    Box {
                        Icon(if (on) t.selectedIcon else t.icon, null, Modifier.size(24.dp), tint)
                        if (t.badge) Box(Modifier.align(Alignment.TopEnd).offset(x = 3.dp, y = (-1).dp).size(7.dp).clip(CircleShape).background(c.accent))
                    }
                    Spacer(Modifier.height(2.dp))
                    Text(t.label, color = tint, fontSize = 10.sp, fontWeight = FontWeight.Medium)
                }
            }
        }
    }
}
