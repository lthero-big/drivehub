package com.drivehub.app.ui.components

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.scaleIn
import androidx.compose.animation.scaleOut
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.Article
import androidx.compose.material.icons.filled.*
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.scale
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.unit.dp
import com.drivehub.app.ui.KindFilter
import com.drivehub.app.ui.theme.Dh
import com.drivehub.app.ui.theme.Motion
import com.drivehub.app.ui.theme.Radius

/**
 * Large pill search (Google Drive style) with the account avatar on the right; a pulsing dot on
 * the avatar signals a downloadable app update.
 */
@Composable
fun SearchPill(
    query: String,
    onQuery: (String) -> Unit,
    onSearch: () -> Unit,
    onClear: () -> Unit,
    avatarInitial: String,
    updateBadge: Boolean,
    onAvatar: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val c = Dh.c
    var focused by remember { mutableStateOf(false) }
    val border by animateColorAsState(if (focused) c.accent.copy(alpha = 0.6f) else c.line, Motion.short(), label = "searchBorder")
    Row(
        modifier.fillMaxWidth().height(56.dp).clip(Radius.pill).background(c.surface).border(1.dp, border, Radius.pill)
            .padding(start = 18.dp, end = 6.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(Icons.Default.Search, null, Modifier.size(22.dp), if (focused) c.accent else c.fg2)
        Spacer(Modifier.width(12.dp))
        Box(Modifier.weight(1f)) {
            if (query.isEmpty()) Text("搜索所有网盘中的文件", color = c.fg3, style = MaterialTheme.typography.bodyLarge, maxLines = 1)
            BasicTextField(
                query, onQuery,
                singleLine = true,
                textStyle = MaterialTheme.typography.bodyLarge.copy(color = c.fg),
                cursorBrush = SolidColor(c.accent),
                keyboardOptions = KeyboardOptions(imeAction = ImeAction.Search),
                keyboardActions = KeyboardActions(onSearch = { onSearch() }),
                modifier = Modifier.fillMaxWidth().onFocusChanged { focused = it.isFocused },
            )
        }
        AnimatedVisibility(query.isNotEmpty(), enter = scaleIn() + fadeIn(), exit = scaleOut() + fadeOut()) {
            Box(Modifier.size(36.dp).clip(CircleShape).clickable(onClick = onClear), Alignment.Center) {
                Icon(Icons.Default.Close, "清除", Modifier.size(20.dp), c.fg2)
            }
        }
        Spacer(Modifier.width(4.dp))
        Avatar(avatarInitial, 44, updateBadge, onAvatar)
    }
}

@Composable
fun Avatar(initial: String, sizeDp: Int, badge: Boolean, onClick: (() -> Unit)? = null) {
    val c = Dh.c
    val pulse by rememberInfiniteTransition(label = "badge").animateFloat(
        1f, 1.6f, infiniteRepeatable(tween(1100), RepeatMode.Reverse), label = "pulse",
    )
    Box(Modifier.size(sizeDp.dp)) {
        Box(
            Modifier.fillMaxSize().clip(CircleShape)
                .background(Brush.linearGradient(listOf(c.accent, c.glowB.copy(alpha = 1f))))
                .let { if (onClick != null) it.clickable(onClick = onClick) else it },
            Alignment.Center,
        ) { Text(initial, color = c.onAccent, style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.Bold) }
        if (badge) {
            Box(Modifier.align(Alignment.TopEnd).size(14.dp), Alignment.Center) {
                Box(Modifier.size(12.dp).scale(pulse).clip(CircleShape).background(c.danger.copy(alpha = 0.35f)))
                Box(Modifier.size(11.dp).clip(CircleShape).background(c.danger).border(2.dp, c.surface, CircleShape))
            }
        }
    }
}

private fun filterIcon(f: KindFilter): ImageVector = when (f) {
    KindFilter.All -> Icons.Default.Apps
    KindFilter.Folder -> Icons.Default.Folder
    KindFilter.Image -> Icons.Default.Image
    KindFilter.Video -> Icons.Default.Movie
    KindFilter.Audio -> Icons.Default.MusicNote
    KindFilter.Doc -> Icons.AutoMirrored.Filled.Article
}

/** Kind filter capsules with animated selection. */
@Composable
fun FilterPills(current: KindFilter, onPick: (KindFilter) -> Unit, modifier: Modifier = Modifier) {
    val c = Dh.c
    Row(
        modifier.fillMaxWidth().horizontalScroll(rememberScrollState()).padding(horizontal = 16.dp, vertical = 6.dp),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        KindFilter.entries.forEach { f ->
            val on = current == f
            val bg by animateColorAsState(if (on) c.fg else c.surface, Motion.medium(), label = "pillBg")
            val fg by animateColorAsState(if (on) c.bg else c.fg2, Motion.medium(), label = "pillFg")
            Row(
                Modifier.clip(Radius.pill).background(bg).border(1.dp, if (on) Color.Transparent else c.line, Radius.pill)
                    .clickable { onPick(f) }.padding(horizontal = 14.dp, vertical = 8.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Icon(filterIcon(f), null, Modifier.size(16.dp), fg)
                Spacer(Modifier.width(6.dp))
                Text(f.label, color = fg, style = MaterialTheme.typography.labelLarge)
            }
        }
    }
}
