package com.drivehub.app.ui.theme

import androidx.compose.runtime.Immutable
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.graphics.Color

/**
 * Appearance (RHEA-280, 方案 C): Dropit "Paper" family only — warm paper (light) and warm
 * charcoal (dark), or follow the system. Persisted by [key] in Prefs.
 */
enum class ThemeMode(val key: String, val label: String, val caption: String) {
    System("system", "跟随系统", "随系统切换浅色暖纸 / 深色暖炭"),
    Light("paper", "浅色暖纸", "暖白纸面 · 品牌红点缀"),
    Dark("charcoal", "深色暖炭", "低饱和暖炭 · 品牌红点缀");

    /** The concrete palette this mode renders with, given the current system dark setting. */
    fun resolve(systemDark: Boolean): ThemeMode = when (this) {
        System -> if (systemDark) Dark else Light
        else -> this
    }

    companion object {
        /** Unknown or retired keys (RHEA-279 "midnight" / "aurora") fall back to [System]. */
        fun fromKey(key: String?): ThemeMode = entries.firstOrNull { it.key == key } ?: System
    }
}

/**
 * Semantic design tokens (1:1 with Dropit Paper). Screens read colours only from here via [Dh].
 * One brand colour ([accent]) carries every active state and primary action; kind tints are
 * low-saturation and only used for small file / storage glyphs.
 */
@Immutable
data class DhColors(
    val isDark: Boolean,
    /** Canvas. */
    val bg: Color,
    /** Cards and grouped lists. */
    val surface: Color,
    /** Secondary fill: search field, icon slots, segmented controls. */
    val surface2: Color,
    /** 0.5 dp hairline. */
    val line: Color,
    val fg: Color,
    val fg2: Color,
    val fg3: Color,
    /** The only brand colour. */
    val accent: Color,
    val accentSoft: Color,
    val onAccent: Color,
    val danger: Color,
    val success: Color,
    val warning: Color,
    val scrim: Color,
    val folder: Color,
    val image: Color,
    val video: Color,
    val audio: Color,
    val pdf: Color,
    val doc: Color,
    val other: Color,
)

val PaperLight = DhColors(
    isDark = false,
    bg = Color(0xFFF5F3EF),
    surface = Color(0xFFFFFFFF),
    surface2 = Color(0xFFECE8E0),
    line = Color(0xFF1D1B18).copy(alpha = 0.09f),
    fg = Color(0xFF1D1B18),
    fg2 = Color(0xFF6F6A61),
    fg3 = Color(0xFF9C958A),
    accent = Color(0xFFD0021B),
    accentSoft = Color(0xFFD0021B).copy(alpha = 0.09f),
    onAccent = Color.White,
    danger = Color(0xFFD0021B),
    success = Color(0xFF4E7D5B),
    warning = Color(0xFFA0742A),
    scrim = Color(0x661D1B18),
    folder = Color(0xFFB08A4F),
    image = Color(0xFF6A8BA8),
    video = Color(0xFF8C7BA6),
    audio = Color(0xFFA8747E),
    pdf = Color(0xFFB25A50),
    doc = Color(0xFF5E8A80),
    other = Color(0xFF8E887E),
)

val CharcoalDark = DhColors(
    isDark = true,
    bg = Color(0xFF141413),
    surface = Color(0xFF1D1C1A),
    surface2 = Color(0xFF282623),
    line = Color(0xFFFFF8EB).copy(alpha = 0.09f),
    fg = Color(0xFFF2EFE9),
    fg2 = Color(0xFF9B958B),
    fg3 = Color(0xFF6C665D),
    accent = Color(0xFFE5484D),
    accentSoft = Color(0xFFE5484D).copy(alpha = 0.16f),
    onAccent = Color.White,
    danger = Color(0xFFE5484D),
    success = Color(0xFF7FAE8A),
    warning = Color(0xFFCFA65E),
    scrim = Color(0x99000000),
    folder = Color(0xFFC9A66B),
    image = Color(0xFF8AA6BF),
    video = Color(0xFFA797BF),
    audio = Color(0xFFC2939C),
    pdf = Color(0xFFCF7E73),
    doc = Color(0xFF82AAA0),
    other = Color(0xFF8F897F),
)

/** Immersive media preview: warm-charcoal ink on pure black. */
val MediaStage = CharcoalDark.copy(bg = Color.Black, surface = Color(0xFF111110))

fun colorsFor(mode: ThemeMode, systemDark: Boolean): DhColors =
    if (mode.resolve(systemDark) == ThemeMode.Dark) CharcoalDark else PaperLight

val LocalDh = staticCompositionLocalOf { PaperLight }

/** Tint for a file kind (see [com.drivehub.app.ui.kindOf]). */
fun DhColors.kindTint(kind: String, isDir: Boolean): Color = when {
    isDir -> folder
    kind == "image" -> image
    kind == "video" -> video
    kind == "audio" -> audio
    kind == "pdf" -> pdf
    kind == "text" -> doc
    else -> other
}
