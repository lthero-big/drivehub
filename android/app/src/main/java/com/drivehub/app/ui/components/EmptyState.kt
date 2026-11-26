package com.drivehub.app.ui.components

import androidx.compose.foundation.layout.*
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.*
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import com.drivehub.app.ui.theme.Dh

enum class EmptyKind(val icon: ImageVector) {
    Folder(Icons.Outlined.FolderOpen), Search(Icons.Outlined.SearchOff), Shares(Icons.Outlined.Link),
    Transfers(Icons.Outlined.SwapVert), Error(Icons.Outlined.CloudOff),
}

/** Monochrome outline glyph — no glow, no floating dots. */
@Composable
fun EmptyIllustration(kind: EmptyKind, modifier: Modifier = Modifier) {
    Icon(kind.icon, null, modifier.size(44.dp), Dh.c.fg3)
}

@Composable
fun EmptyState(kind: EmptyKind, title: String, subtitle: String, modifier: Modifier = Modifier, action: @Composable (() -> Unit)? = null) {
    val c = Dh.c
    Column(modifier.fillMaxSize().padding(32.dp), Arrangement.Center, Alignment.CenterHorizontally) {
        EmptyIllustration(kind)
        Spacer(Modifier.height(14.dp))
        Text(title, style = MaterialTheme.typography.titleMedium, color = c.fg, textAlign = TextAlign.Center)
        Spacer(Modifier.height(4.dp))
        Text(subtitle, color = c.fg3, style = MaterialTheme.typography.bodySmall, textAlign = TextAlign.Center)
        action?.let { Spacer(Modifier.height(16.dp)); it() }
    }
}
