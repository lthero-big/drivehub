package com.drivehub.app.ui.theme

import androidx.compose.animation.core.CubicBezierEasing
import androidx.compose.animation.core.tween
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.ui.unit.dp

/** Corner radii: one scale for the whole app; cards and grouped lists are 12 dp. */
object Radius {
    val xs = RoundedCornerShape(6.dp)
    val sm = RoundedCornerShape(8.dp)
    val md = RoundedCornerShape(10.dp)
    val lg = RoundedCornerShape(12.dp)
    val xl = RoundedCornerShape(16.dp)
    val pill = RoundedCornerShape(50)
    val sheet = RoundedCornerShape(topStart = 16.dp, topEnd = 16.dp)
}

/** Hairline width used for every divider and card outline. */
val Hair = 0.5.dp

object Space {
    val xs = 4.dp
    val sm = 8.dp
    val md = 12.dp
    val lg = 16.dp
    val xl = 20.dp
    val xxl = 28.dp
}

/** Motion: short, calm fades — no springs or bounces. */
object Motion {
    val EaseStandard = CubicBezierEasing(0.2f, 0f, 0f, 1f)
    const val Short = 160
    const val Medium = 240
    fun <T> medium() = tween<T>(Medium, easing = EaseStandard)
    fun <T> short() = tween<T>(Short, easing = EaseStandard)
}
