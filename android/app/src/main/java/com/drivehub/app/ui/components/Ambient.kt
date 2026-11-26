package com.drivehub.app.ui.components

import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxScope
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.composed
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.draw.drawWithContent
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import com.drivehub.app.ui.theme.Dh
import com.drivehub.app.ui.theme.Motion

/**
 * Atmosphere layer (folia-style): the theme background plus two slowly drifting radial glows.
 * [tint] overrides the glow colours, e.g. with a colour sampled from the media being previewed.
 */
@Composable
fun AmbientBackground(
    modifier: Modifier = Modifier,
    tint: Color? = null,
    base: Color = Dh.c.bg,
    content: @Composable BoxScope.() -> Unit,
) {
    val c = Dh.c
    val a by animateColorAsState(tint?.copy(alpha = if (c.isDark) 0.34f else 0.30f) ?: c.glowA, Motion.long(), label = "glowA")
    val b by animateColorAsState(tint?.copy(alpha = if (c.isDark) 0.20f else 0.18f) ?: c.glowB, Motion.long(), label = "glowB")
    val drift by rememberInfiniteTransition(label = "drift").animateFloat(
        0f, 1f, infiniteRepeatable(tween(14_000, easing = LinearEasing), RepeatMode.Reverse), label = "drift",
    )
    Box(
        modifier.background(base).drawBehind {
            val r = size.maxDimension * 0.75f
            drawCircle(
                Brush.radialGradient(listOf(a, Color.Transparent), Offset(size.width * (0.05f + 0.25f * drift), size.height * 0.02f), r),
                r, Offset(size.width * (0.05f + 0.25f * drift), size.height * 0.02f),
            )
            drawCircle(
                Brush.radialGradient(listOf(b, Color.Transparent), Offset(size.width * (1.0f - 0.2f * drift), size.height * 0.55f), r * 0.9f),
                r * 0.9f, Offset(size.width * (1.0f - 0.2f * drift), size.height * 0.55f),
            )
        },
        content = content,
    )
}

/** Skeleton shimmer: a soft highlight band sweeping across the element. */
fun Modifier.shimmer(base: Color, highlight: Color): Modifier = composed {
    val x by rememberInfiniteTransition(label = "shimmer").animateFloat(
        -1f, 2f, infiniteRepeatable(tween(1300, easing = LinearEasing)), label = "x",
    )
    background(base).drawWithContent {
        drawContent()
        val w = size.width
        drawRect(Brush.linearGradient(listOf(Color.Transparent, highlight, Color.Transparent), Offset(w * x - w * 0.5f, 0f), Offset(w * x + w * 0.5f, size.height)))
    }
}

/** Slow diagonal sheen used on mount cards ("渐变微光"). */
fun Modifier.sheen(color: Color, periodMs: Int = 4200): Modifier = composed {
    val x by rememberInfiniteTransition(label = "sheen").animateFloat(
        -1.2f, 2.2f, infiniteRepeatable(tween(periodMs, easing = LinearEasing)), label = "x",
    )
    drawWithContent {
        drawContent()
        val w = size.width
        drawRect(Brush.linearGradient(listOf(Color.Transparent, color, Color.Transparent), Offset(w * x - w * 0.35f, 0f), Offset(w * x + w * 0.35f, size.height)))
    }
}
