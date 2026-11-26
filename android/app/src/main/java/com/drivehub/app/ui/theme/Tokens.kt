package com.drivehub.app.ui.theme

import androidx.compose.animation.core.CubicBezierEasing
import androidx.compose.animation.core.Spring
import androidx.compose.animation.core.spring
import androidx.compose.animation.core.tween
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.dp

/** Corner radii: one scale for the whole app. */
object Radius {
    val xs = RoundedCornerShape(8.dp)
    val sm = RoundedCornerShape(12.dp)
    val md = RoundedCornerShape(16.dp)
    val lg = RoundedCornerShape(22.dp)
    val xl = RoundedCornerShape(28.dp)
    val pill = RoundedCornerShape(50)
    val sheet = RoundedCornerShape(topStart = 28.dp, topEnd = 28.dp)
}

object Space {
    val xs = 4.dp
    val sm = 8.dp
    val md = 12.dp
    val lg = 16.dp
    val xl = 20.dp
    val xxl = 28.dp
    /** Bottom inset reserved for the floating dock so content never hides behind it. */
    val dockInset = 112.dp
}

/**
 * Motion: folia `bottomDock.css` style — a crisp start with a long, soft tail —
 * plus a slightly bouncy spring for selection indicators.
 */
object Motion {
    val EaseOutLong = CubicBezierEasing(0.16f, 1f, 0.3f, 1f)
    val EaseStandard = CubicBezierEasing(0.2f, 0f, 0f, 1f)
    const val Short = 180
    const val Medium = 320
    const val Long = 560
    fun <T> long() = tween<T>(Long, easing = EaseOutLong)
    fun <T> medium() = tween<T>(Medium, easing = EaseOutLong)
    fun <T> short() = tween<T>(Short, easing = EaseStandard)
    fun <T> bouncy() = spring<T>(dampingRatio = 0.72f, stiffness = Spring.StiffnessMediumLow)
    val offsetSpring = spring(dampingRatio = 0.8f, stiffness = Spring.StiffnessMediumLow, visibilityThreshold = IntOffset(1, 1))
}
