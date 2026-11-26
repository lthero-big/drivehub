package com.drivehub.app.ui.components

import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.animateContentSize
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.togetherWith
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.ErrorOutline
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import com.drivehub.app.ui.theme.Dh
import com.drivehub.app.ui.theme.Motion
import com.drivehub.app.ui.theme.Radius

/** States of a [MorphStatusButton]. */
sealed interface MorphState {
    data class Idle(val label: String, val icon: ImageVector? = null) : MorphState
    /** [progress] in 0..1, or null for indeterminate. */
    data class Busy(val label: String? = null, val progress: Float? = null) : MorphState
    data class Done(val label: String) : MorphState
    data class Failed(val label: String) : MorphState
}

/**
 * Primary button (12 dp corners, flat brand red) whose colour and content fade between
 * idle → busy (spinner / ring + %) → done / failed.
 */
@Composable
fun MorphStatusButton(state: MorphState, modifier: Modifier = Modifier, height: Dp = 48.dp, enabled: Boolean = true, onClick: () -> Unit) {
    val c = Dh.c
    val bg by animateColorAsState(
        when (state) {
            is MorphState.Idle -> if (enabled) c.accent else c.surface2
            is MorphState.Busy -> c.accentSoft
            is MorphState.Done -> c.success.copy(alpha = 0.14f)
            is MorphState.Failed -> c.danger.copy(alpha = 0.10f)
        }, Motion.medium(), label = "morphBg",
    )
    val fg = when (state) {
        is MorphState.Idle -> if (enabled) c.onAccent else c.fg3
        is MorphState.Busy -> c.accent
        is MorphState.Done -> c.success
        is MorphState.Failed -> c.danger
    }
    Box(
        modifier.height(height).clip(Radius.lg).background(bg)
            .clickable(enabled = enabled && state is MorphState.Idle || state is MorphState.Failed, onClick = onClick)
            .animateContentSize(Motion.medium())
            .padding(horizontal = 22.dp),
        Alignment.Center,
    ) {
        AnimatedContent(
            state,
            transitionSpec = { fadeIn(Motion.short()) togetherWith fadeOut(Motion.short()) },
            contentKey = { it::class },
            label = "morph",
        ) { s ->
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.Center) {
                when (s) {
                    is MorphState.Idle -> {
                        s.icon?.let { Icon(it, null, Modifier.size(18.dp), fg); Spacer(Modifier.width(8.dp)) }
                        Text(s.label, color = fg, style = MaterialTheme.typography.labelLarge, fontWeight = FontWeight.SemiBold)
                    }
                    is MorphState.Busy -> {
                        val p = s.progress
                        if (p != null) CircularProgressIndicator(progress = { p }, Modifier.size(20.dp), color = fg, strokeWidth = 2.5.dp, trackColor = fg.copy(alpha = 0.2f))
                        else CircularProgressIndicator(Modifier.size(20.dp), color = fg, strokeWidth = 2.5.dp)
                        val text = s.label ?: p?.let { "${(it * 100).toInt()}%" }
                        text?.let { Spacer(Modifier.width(10.dp)); Text(it, color = fg, style = MaterialTheme.typography.labelLarge) }
                    }
                    is MorphState.Done -> {
                        Icon(Icons.Default.Check, null, Modifier.size(18.dp), fg); Spacer(Modifier.width(8.dp))
                        Text(s.label, color = fg, style = MaterialTheme.typography.labelLarge, fontWeight = FontWeight.SemiBold)
                    }
                    is MorphState.Failed -> {
                        Icon(Icons.Default.ErrorOutline, null, Modifier.size(18.dp), fg); Spacer(Modifier.width(8.dp))
                        Text(s.label, color = fg, style = MaterialTheme.typography.labelLarge, fontWeight = FontWeight.SemiBold)
                    }
                }
            }
        }
    }
}
