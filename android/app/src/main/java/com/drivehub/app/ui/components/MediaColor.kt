package com.drivehub.app.ui.components

import android.graphics.Bitmap
import androidx.compose.ui.graphics.Color
import androidx.palette.graphics.Palette
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

/** Picks a vivid-but-soft colour from a bitmap for ambient glows behind previews/players. */
suspend fun dominantColor(bmp: Bitmap): Color? = withContext(Dispatchers.Default) {
    runCatching {
        val p = Palette.from(bmp).maximumColorCount(16).resizeBitmapArea(160 * 160).generate()
        val sw = p.vibrantSwatch ?: p.lightVibrantSwatch ?: p.dominantSwatch ?: p.mutedSwatch
        sw?.rgb?.let { Color(it) }
    }.getOrNull()
}
