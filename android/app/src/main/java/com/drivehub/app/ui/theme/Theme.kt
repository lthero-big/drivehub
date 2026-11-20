package com.drivehub.app.ui.theme

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.sp
import androidx.compose.material3.Typography

val Ink = Color(0xFF0E0F11)
val InkElevated = Color(0xFF181A1F)
val InkCard = Color(0xFF22252B)
val InkChip = Color(0xFF2A2E36)
val Neon = Color(0xFF2EEA8C)
val NeonDim = Color(0xFF1BBF6E)
val TextPrimary = Color(0xFFF4F5F7)
val TextSecondary = Color(0xFF9AA0A8)
val TextTertiary = Color(0xFF6B717A)
val Danger = Color(0xFFFF6B6B)
val FolderAmber = Color(0xFFFFC14D)
val VideoViolet = Color(0xFFB388FF)
val ImageBlue = Color(0xFF5B9DFF)
val AudioPink = Color(0xFFFF7AB6)
val PdfRed = Color(0xFFFF6B6B)
val DocCyan = Color(0xFF5AD0E8)
val OtherGray = Color(0xFF8A9099)

private val DarkColors = darkColorScheme(
    primary = Neon,
    onPrimary = Color(0xFF052315),
    primaryContainer = Neon.copy(alpha = 0.18f),
    onPrimaryContainer = Neon,
    secondary = Neon,
    onSecondary = Color(0xFF052315),
    background = Ink,
    onBackground = TextPrimary,
    surface = Ink,
    onSurface = TextPrimary,
    surfaceVariant = InkCard,
    onSurfaceVariant = TextSecondary,
    surfaceContainer = InkElevated,
    surfaceContainerHigh = InkCard,
    surfaceContainerHighest = InkChip,
    surfaceContainerLow = InkElevated,
    surfaceContainerLowest = Ink,
    error = Danger,
    onError = Color(0xFF3B0000),
    outline = Color(0xFF3A3F47),
    outlineVariant = Color(0xFF2A2E36),
    inverseSurface = Color(0xFFF4F5F7),
    inverseOnSurface = Color(0xFF121316),
    scrim = Color(0x99000000),
)

private val LightColors = lightColorScheme(
    primary = NeonDim,
    onPrimary = Color.White,
    primaryContainer = Color(0xFFD4FBE6),
    onPrimaryContainer = Color(0xFF05331C),
    secondary = NeonDim,
    background = Color(0xFFF6F7F9),
    onBackground = Color(0xFF14161A),
    surface = Color(0xFFF6F7F9),
    onSurface = Color(0xFF14161A),
    surfaceVariant = Color(0xFFEEF0F3),
    onSurfaceVariant = Color(0xFF5C6370),
    surfaceContainer = Color.White,
    surfaceContainerHigh = Color.White,
    surfaceContainerHighest = Color(0xFFEEF0F3),
    error = Danger,
    outline = Color(0xFFD0D4DA),
    outlineVariant = Color(0xFFE4E7EC),
)

private val DhTypography = Typography(
    displaySmall = TextStyle(fontWeight = FontWeight.SemiBold, fontSize = 32.sp, lineHeight = 38.sp),
    headlineMedium = TextStyle(fontWeight = FontWeight.SemiBold, fontSize = 26.sp, lineHeight = 32.sp),
    headlineSmall = TextStyle(fontWeight = FontWeight.SemiBold, fontSize = 22.sp, lineHeight = 28.sp),
    titleLarge = TextStyle(fontWeight = FontWeight.SemiBold, fontSize = 20.sp, lineHeight = 26.sp),
    titleMedium = TextStyle(fontWeight = FontWeight.Medium, fontSize = 16.sp, lineHeight = 22.sp),
    titleSmall = TextStyle(fontWeight = FontWeight.Medium, fontSize = 14.sp, lineHeight = 20.sp),
    bodyLarge = TextStyle(fontWeight = FontWeight.Normal, fontSize = 16.sp, lineHeight = 22.sp),
    bodyMedium = TextStyle(fontWeight = FontWeight.Normal, fontSize = 14.sp, lineHeight = 20.sp),
    bodySmall = TextStyle(fontWeight = FontWeight.Normal, fontSize = 12.sp, lineHeight = 16.sp),
    labelLarge = TextStyle(fontWeight = FontWeight.Medium, fontSize = 14.sp, lineHeight = 20.sp),
    labelMedium = TextStyle(fontWeight = FontWeight.Medium, fontSize = 12.sp, lineHeight = 16.sp),
    labelSmall = TextStyle(fontWeight = FontWeight.Medium, fontSize = 11.sp, lineHeight = 14.sp),
)

@Composable
fun DriveHubTheme(
    darkTheme: Boolean = true,
    content: @Composable () -> Unit,
) {
    val systemDark = isSystemInDarkTheme()
    // PikPak-like default is dark; still honor an explicit light scheme if ever switched.
    MaterialTheme(
        colorScheme = if (darkTheme || systemDark) DarkColors else LightColors,
        typography = DhTypography,
        content = content,
    )
}

fun kindTint(kind: String, isDir: Boolean): Color = when {
    isDir -> FolderAmber
    kind == "image" -> ImageBlue
    kind == "video" -> VideoViolet
    kind == "audio" -> AudioPink
    kind == "pdf" -> PdfRed
    kind == "text" -> DocCyan
    else -> OtherGray
}
