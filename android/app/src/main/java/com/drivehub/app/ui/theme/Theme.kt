package com.drivehub.app.ui.theme

import android.app.Activity
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Typography
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.ReadOnlyComposable
import androidx.compose.runtime.SideEffect
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.sp
import androidx.core.view.WindowCompat

private val DhTypography = Typography(
    displaySmall = TextStyle(fontWeight = FontWeight.Bold, fontSize = 32.sp, lineHeight = 38.sp, letterSpacing = (-0.5).sp),
    headlineMedium = TextStyle(fontWeight = FontWeight.Bold, fontSize = 28.sp, lineHeight = 34.sp, letterSpacing = (-0.4).sp),
    headlineSmall = TextStyle(fontWeight = FontWeight.SemiBold, fontSize = 22.sp, lineHeight = 28.sp),
    titleLarge = TextStyle(fontWeight = FontWeight.SemiBold, fontSize = 20.sp, lineHeight = 26.sp),
    titleMedium = TextStyle(fontWeight = FontWeight.SemiBold, fontSize = 16.sp, lineHeight = 22.sp),
    titleSmall = TextStyle(fontWeight = FontWeight.Medium, fontSize = 14.sp, lineHeight = 20.sp),
    bodyLarge = TextStyle(fontWeight = FontWeight.Normal, fontSize = 16.sp, lineHeight = 22.sp),
    bodyMedium = TextStyle(fontWeight = FontWeight.Normal, fontSize = 14.sp, lineHeight = 20.sp),
    bodySmall = TextStyle(fontWeight = FontWeight.Normal, fontSize = 12.sp, lineHeight = 16.sp),
    labelLarge = TextStyle(fontWeight = FontWeight.SemiBold, fontSize = 14.sp, lineHeight = 20.sp),
    labelMedium = TextStyle(fontWeight = FontWeight.Medium, fontSize = 12.sp, lineHeight = 16.sp),
    labelSmall = TextStyle(fontWeight = FontWeight.Medium, fontSize = 11.sp, lineHeight = 14.sp, letterSpacing = 0.2.sp),
)

private fun schemeOf(c: DhColors) = if (c.isDark) darkColorScheme(
    primary = c.accent, onPrimary = c.onAccent, primaryContainer = c.accentSoft, onPrimaryContainer = c.accent,
    secondary = c.accent, onSecondary = c.onAccent,
    background = c.bg, onBackground = c.fg, surface = c.bg, onSurface = c.fg,
    surfaceVariant = c.surfaceHigh, onSurfaceVariant = c.fg2,
    surfaceContainerLowest = c.bg, surfaceContainerLow = c.surface, surfaceContainer = c.surface,
    surfaceContainerHigh = c.surfaceHigh, surfaceContainerHighest = c.surfaceHigh,
    error = c.danger, outline = c.lineStrong, outlineVariant = c.line, scrim = c.scrim,
    inverseSurface = c.fg, inverseOnSurface = c.bg,
) else lightColorScheme(
    primary = c.accent, onPrimary = c.onAccent, primaryContainer = c.accentSoft, onPrimaryContainer = c.accent,
    secondary = c.accent, onSecondary = c.onAccent,
    background = c.bg, onBackground = c.fg, surface = c.bg, onSurface = c.fg,
    surfaceVariant = c.surfaceSunken, onSurfaceVariant = c.fg2,
    surfaceContainerLowest = c.surfaceHigh, surfaceContainerLow = c.surface, surfaceContainer = c.surface,
    surfaceContainerHigh = c.surfaceHigh, surfaceContainerHighest = c.surfaceSunken,
    error = c.danger, outline = c.lineStrong, outlineVariant = c.line, scrim = c.scrim,
    inverseSurface = c.fg, inverseOnSurface = c.bg,
)

@Composable
fun DriveHubTheme(
    mode: ThemeMode = ThemeMode.System,
    content: @Composable () -> Unit,
) {
    val colors = colorsFor(mode, isSystemInDarkTheme())
    val view = LocalView.current
    if (!view.isInEditMode) {
        SideEffect {
            (view.context as? Activity)?.window?.let { w ->
                WindowCompat.getInsetsController(w, view).apply {
                    isAppearanceLightStatusBars = !colors.isDark
                    isAppearanceLightNavigationBars = !colors.isDark
                }
            }
        }
    }
    CompositionLocalProvider(LocalDh provides colors) {
        MaterialTheme(colorScheme = schemeOf(colors), typography = DhTypography, content = content)
    }
}

/** Shorthand: `Dh.c.accent`. */
object Dh {
    val c: DhColors
        @Composable @ReadOnlyComposable get() = LocalDh.current
}
