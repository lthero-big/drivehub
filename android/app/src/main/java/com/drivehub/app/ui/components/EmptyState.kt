package com.drivehub.app.ui.components

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.*
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.*
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.drawscope.rotate
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import com.drivehub.app.ui.theme.Dh

enum class EmptyKind(val icon: ImageVector) {
    Folder(Icons.Default.FolderOpen), Search(Icons.Default.SearchOff), Shares(Icons.Default.Link),
    Transfers(Icons.Default.SwapVert), Error(Icons.Default.CloudOff),
}

/**
 * Vector empty-state illustration drawn in code (no bitmap assets): a glow, two tilted
 * "paper" cards, orbiting dots and a centre icon tile — all in the active theme colours.
 */
@Composable
fun EmptyIllustration(kind: EmptyKind, modifier: Modifier = Modifier) {
    val c = Dh.c
    Box(modifier.size(168.dp), Alignment.Center) {
        Canvas(Modifier.fillMaxSize()) {
            val cx = size.width / 2; val cy = size.height / 2
            drawCircle(Brush.radialGradient(listOf(c.accent.copy(alpha = 0.22f), Color.Transparent), Offset(cx, cy), size.minDimension / 2), size.minDimension / 2)
            val cw = size.width * 0.46f; val ch = size.height * 0.56f
            rotate(-10f, Offset(cx, cy)) {
                drawRoundRect(c.surfaceHigh, Offset(cx - cw / 2 - 14.dp.toPx(), cy - ch / 2), Size(cw, ch), CornerRadius(18.dp.toPx()))
                drawRoundRect(c.lineStrong, Offset(cx - cw / 2 - 14.dp.toPx(), cy - ch / 2), Size(cw, ch), CornerRadius(18.dp.toPx()), style = Stroke(1.dp.toPx()))
            }
            rotate(7f, Offset(cx, cy)) {
                val o = Offset(cx - cw / 2 + 12.dp.toPx(), cy - ch / 2 + 6.dp.toPx())
                drawRoundRect(c.surface, o, Size(cw, ch), CornerRadius(18.dp.toPx()))
                drawRoundRect(c.lineStrong, o, Size(cw, ch), CornerRadius(18.dp.toPx()), style = Stroke(1.dp.toPx()))
                listOf(0.62f, 0.72f, 0.82f).forEachIndexed { i, f ->
                    drawRoundRect(c.line, Offset(o.x + 14.dp.toPx(), o.y + ch * f), Size(cw * (0.7f - i * 0.15f), 5.dp.toPx()), CornerRadius(3.dp.toPx()))
                }
            }
            drawCircle(c.accent, 5.dp.toPx(), Offset(cx + size.width * 0.34f, cy - size.height * 0.26f))
            drawCircle(c.glowB.copy(alpha = 0.9f), 3.5.dp.toPx(), Offset(cx - size.width * 0.36f, cy + size.height * 0.22f))
            drawCircle(c.fg3, 2.5.dp.toPx(), Offset(cx - size.width * 0.28f, cy - size.height * 0.32f))
        }
        Box(Modifier.offset(x = 4.dp, y = (-10).dp)) { IconTile(kind.icon, c.accent, 52.dp, filled = false) }
    }
}

@Composable
fun EmptyState(kind: EmptyKind, title: String, subtitle: String, modifier: Modifier = Modifier, action: @Composable (() -> Unit)? = null) {
    val c = Dh.c
    Column(modifier.fillMaxSize().padding(32.dp), Arrangement.Center, Alignment.CenterHorizontally) {
        EmptyIllustration(kind)
        Spacer(Modifier.height(12.dp))
        Text(title, style = MaterialTheme.typography.titleMedium, color = c.fg)
        Spacer(Modifier.height(6.dp))
        Text(subtitle, color = c.fg2, style = MaterialTheme.typography.bodySmall, textAlign = TextAlign.Center)
        action?.let { Spacer(Modifier.height(16.dp)); it() }
    }
}
