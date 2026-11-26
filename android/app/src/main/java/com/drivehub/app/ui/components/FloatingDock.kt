package com.drivehub.app.ui.components

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.core.animateDpAsState
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.expandHorizontally
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.scaleIn
import androidx.compose.animation.scaleOut
import androidx.compose.animation.shrinkHorizontally
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.rotate
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.drivehub.app.ui.theme.Dh
import com.drivehub.app.ui.theme.Motion
import com.drivehub.app.ui.theme.Radius

data class DockTab(val key: String, val label: String, val icon: ImageVector, val selectedIcon: ImageVector, val badge: Boolean = false)

/**
 * Floating capsule navigation (folia `bottomDock`): translucent pill with a highlight rim,
 * an expanding selection indicator, and an optional companion action button.
 * Slides away when [visible] is false (list scrolled down) and springs back.
 */
@Composable
fun FloatingDock(
    tabs: List<DockTab>,
    selected: String,
    onSelect: (String) -> Unit,
    visible: Boolean,
    modifier: Modifier = Modifier,
    actionIcon: ImageVector? = null,
    actionDesc: String? = null,
    onAction: () -> Unit = {},
) {
    val c = Dh.c
    val offset by animateDpAsState(if (visible) 0.dp else 140.dp, Motion.long(), label = "dockOffset")
    val alpha by animateFloatAsState(if (visible) 1f else 0f, Motion.medium(), label = "dockAlpha")
    Row(
        modifier
            .graphicsLayer { translationY = offset.toPx(); this.alpha = alpha }
            .navigationBarsPadding()
            .padding(horizontal = 18.dp, vertical = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        Row(
            Modifier
                .shadow(24.dp, Radius.pill, ambientColor = Color.Black.copy(alpha = 0.5f), spotColor = Color.Black.copy(alpha = 0.5f))
                .clip(Radius.pill)
                .background(c.dock)
                .border(1.dp, Brush.verticalGradient(listOf(c.dockHighlight, c.dockHighlight.copy(alpha = 0.02f))), Radius.pill)
                .padding(6.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            tabs.forEach { t -> DockItem(t, t.key == selected) { onSelect(t.key) } }
        }
        AnimatedVisibility(
            actionIcon != null,
            enter = scaleIn(Motion.bouncy()) + fadeIn(),
            exit = scaleOut(Motion.short()) + fadeOut(Motion.short()),
        ) {
            val rot by animateFloatAsState(if (actionIcon != null) 0f else -90f, Motion.bouncy(), label = "fabRot")
            Box(
                Modifier
                    .shadow(20.dp, CircleShape, ambientColor = c.accent, spotColor = c.accent)
                    .size(58.dp)
                    .clip(CircleShape)
                    .background(Brush.linearGradient(listOf(c.accent, c.accent.copy(alpha = 0.78f))))
                    .border(1.dp, Color.White.copy(alpha = 0.25f), CircleShape)
                    .clickable(onClick = onAction),
                Alignment.Center,
            ) {
                actionIcon?.let { Icon(it, actionDesc, Modifier.size(26.dp).rotate(rot), c.onAccent) }
            }
        }
    }
}

@Composable
private fun DockItem(t: DockTab, on: Boolean, onClick: () -> Unit) {
    val c = Dh.c
    val bg by animateColorAsState(if (on) c.accentSoft else Color.Transparent, Motion.medium(), label = "dockBg")
    val fg by animateColorAsState(if (on) c.accent else c.fg3, Motion.medium(), label = "dockFg")
    Row(
        Modifier
            .clip(Radius.pill)
            .background(bg)
            .clickable(remember { MutableInteractionSource() }, indication = null, onClick = onClick)
            .padding(horizontal = 14.dp, vertical = 11.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box {
            Icon(if (on) t.selectedIcon else t.icon, t.label, Modifier.size(22.dp), fg)
            if (t.badge) Box(Modifier.align(Alignment.TopEnd).offset(x = 3.dp, y = (-2).dp).size(8.dp).clip(CircleShape).background(c.danger))
        }
        AnimatedVisibility(on, enter = expandHorizontally(Motion.bouncy()) + fadeIn(), exit = shrinkHorizontally(Motion.short()) + fadeOut(Motion.short())) {
            Text(t.label, color = fg, style = MaterialTheme.typography.labelLarge, fontWeight = FontWeight.SemiBold, modifier = Modifier.padding(start = 8.dp))
        }
    }
}

/** Bottom padding for scrollable content so the last item clears the dock and the nav bar. */
@Composable
fun dockInset(): androidx.compose.ui.unit.Dp =
    com.drivehub.app.ui.theme.Space.dockInset + WindowInsets.navigationBars.asPaddingValues().calculateBottomPadding()
