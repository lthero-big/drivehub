package com.drivehub.app.ui.theme

import androidx.compose.runtime.Immutable
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.graphics.Color

/** User-selectable atmosphere. Persisted by [key] in Prefs; unknown keys fall back to [System]. */
enum class ThemeMode(val key: String, val label: String, val caption: String) {
    System("system", "跟随系统", "浅色用暖纸，深色用暗夜"),
    Midnight("midnight", "暗夜流光", "霓虹绿 · 深墨"),
    Paper("paper", "暖纸档案", "米白纸感 · 陶土橙"),
    Aurora("aurora", "深海极光", "深海蓝 · 极光青");

    /** The concrete palette this mode renders with, given the current system dark setting. */
    fun resolve(systemDark: Boolean): ThemeMode = when (this) {
        System -> if (systemDark) Midnight else Paper
        else -> this
    }

    companion object {
        fun fromKey(key: String?): ThemeMode = entries.firstOrNull { it.key == key } ?: System
    }
}

/**
 * Semantic design tokens. Screens read colours only from here (via [LocalDh]) so every
 * atmosphere re-skins the whole app; Material's colorScheme is derived from it.
 */
@Immutable
data class DhColors(
    val isDark: Boolean,
    val bg: Color,
    /** Two soft ambient glows painted behind content (folia-style atmosphere). */
    val glowA: Color,
    val glowB: Color,
    val surface: Color,
    val surfaceHigh: Color,
    val surfaceSunken: Color,
    val line: Color,
    val lineStrong: Color,
    val fg: Color,
    val fg2: Color,
    val fg3: Color,
    val accent: Color,
    val onAccent: Color,
    val accentSoft: Color,
    val danger: Color,
    val warning: Color,
    val success: Color,
    /** Floating dock: translucent fill + top highlight. */
    val dock: Color,
    val dockHighlight: Color,
    val scrim: Color,
    val folder: Color,
    val image: Color,
    val video: Color,
    val audio: Color,
    val pdf: Color,
    val doc: Color,
    val other: Color,
)

val MidnightColors = DhColors(
    isDark = true,
    bg = Color(0xFF0B0C0F),
    glowA = Color(0xFF2EEA8C).copy(alpha = 0.10f),
    glowB = Color(0xFF7C5CFF).copy(alpha = 0.12f),
    surface = Color(0xFF15171C),
    surfaceHigh = Color(0xFF1E2128),
    surfaceSunken = Color(0xFF101216),
    line = Color(0xFF23272E),
    lineStrong = Color(0xFF353A43),
    fg = Color(0xFFF4F5F7),
    fg2 = Color(0xFF9AA0A8),
    fg3 = Color(0xFF656B74),
    accent = Color(0xFF2EEA8C),
    onAccent = Color(0xFF052315),
    accentSoft = Color(0xFF2EEA8C).copy(alpha = 0.16f),
    danger = Color(0xFFFF6B6B),
    warning = Color(0xFFFFC14D),
    success = Color(0xFF2EEA8C),
    dock = Color(0xFF1A1D23).copy(alpha = 0.86f),
    dockHighlight = Color.White.copy(alpha = 0.10f),
    scrim = Color(0x99000000),
    folder = Color(0xFFFFC14D),
    image = Color(0xFF5B9DFF),
    video = Color(0xFFB388FF),
    audio = Color(0xFFFF7AB6),
    pdf = Color(0xFFFF6B6B),
    doc = Color(0xFF5AD0E8),
    other = Color(0xFF8A9099),
)

val PaperColors = DhColors(
    isDark = false,
    bg = Color(0xFFF4EFE6),
    glowA = Color(0xFFF0C987).copy(alpha = 0.30f),
    glowB = Color(0xFFE8A598).copy(alpha = 0.22f),
    surface = Color(0xFFFBF8F2),
    surfaceHigh = Color(0xFFFFFFFF),
    surfaceSunken = Color(0xFFEBE4D6),
    line = Color(0xFFE3DACA),
    lineStrong = Color(0xFFCFC3AE),
    fg = Color(0xFF2A2520),
    fg2 = Color(0xFF6E6457),
    fg3 = Color(0xFF9C9080),
    accent = Color(0xFFC2552D),
    onAccent = Color(0xFFFFFFFF),
    accentSoft = Color(0xFFC2552D).copy(alpha = 0.12f),
    danger = Color(0xFFC9473D),
    warning = Color(0xFFD99A2B),
    success = Color(0xFF3F8F5A),
    dock = Color(0xFFFFFCF6).copy(alpha = 0.90f),
    dockHighlight = Color.White.copy(alpha = 0.85f),
    scrim = Color(0x662A2520),
    folder = Color(0xFFD99A2B),
    image = Color(0xFF3F7FD9),
    video = Color(0xFF8A5CD6),
    audio = Color(0xFFD6517F),
    pdf = Color(0xFFC9473D),
    doc = Color(0xFF2F9BB3),
    other = Color(0xFF8C8273),
)

val AuroraColors = DhColors(
    isDark = true,
    bg = Color(0xFF06121B),
    glowA = Color(0xFF22D3EE).copy(alpha = 0.14f),
    glowB = Color(0xFFA78BFA).copy(alpha = 0.16f),
    surface = Color(0xFF0D1E2A),
    surfaceHigh = Color(0xFF142A38),
    surfaceSunken = Color(0xFF091822),
    line = Color(0xFF173041),
    lineStrong = Color(0xFF244459),
    fg = Color(0xFFE8F4F8),
    fg2 = Color(0xFF8FB0BF),
    fg3 = Color(0xFF5A7C8C),
    accent = Color(0xFF5EEAD4),
    onAccent = Color(0xFF032421),
    accentSoft = Color(0xFF5EEAD4).copy(alpha = 0.15f),
    danger = Color(0xFFFB7185),
    warning = Color(0xFFFCD34D),
    success = Color(0xFF5EEAD4),
    dock = Color(0xFF0F2331).copy(alpha = 0.86f),
    dockHighlight = Color(0xFF8BE9FF).copy(alpha = 0.14f),
    scrim = Color(0x99010A10),
    folder = Color(0xFFFCD34D),
    image = Color(0xFF60A5FA),
    video = Color(0xFFC4B5FD),
    audio = Color(0xFFF9A8D4),
    pdf = Color(0xFFFB7185),
    doc = Color(0xFF67E8F9),
    other = Color(0xFF8BA3B0),
)

fun colorsFor(mode: ThemeMode, systemDark: Boolean): DhColors = when (mode.resolve(systemDark)) {
    ThemeMode.Paper -> PaperColors
    ThemeMode.Aurora -> AuroraColors
    else -> MidnightColors
}

val LocalDh = staticCompositionLocalOf { MidnightColors }

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
