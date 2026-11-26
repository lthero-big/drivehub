package com.drivehub.app.ui.components

import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.*
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Folder
import androidx.compose.material.icons.filled.MoreHoriz
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.drivehub.app.data.FsItem
import com.drivehub.app.ui.kindOf
import com.drivehub.app.ui.theme.Dh
import com.drivehub.app.ui.theme.Radius
import com.drivehub.app.ui.theme.kindTint

/**
 * List row: 40 dp icon / thumbnail, name, "大小 · 时间", "···". Long-press also opens the sheet.
 * Callers wrap it with [groupItem] so rows read as one Grouped Inset card (divider starts at 68 dp).
 */
@OptIn(ExperimentalFoundationApi::class)
@Composable
fun FileRow(it: FsItem, onClick: () -> Unit, onMore: () -> Unit, modifier: Modifier = Modifier) {
    val c = Dh.c
    Row(
        modifier.fillMaxWidth().combinedClickable(onClick = onClick, onLongClick = onMore)
            .padding(start = 14.dp, end = 4.dp, top = 9.dp, bottom = 9.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        FileThumb(it, Modifier.size(40.dp), Radius.sm, glyph = 22.dp)
        Spacer(Modifier.width(14.dp))
        Column(Modifier.weight(1f)) {
            Text(it.name, maxLines = 1, overflow = TextOverflow.Ellipsis, style = MaterialTheme.typography.bodyLarge, color = c.fg)
            Text(fileSubtitle(it), color = c.fg3, style = MaterialTheme.typography.bodySmall, maxLines = 1)
        }
        IconButton(onMore) { Icon(Icons.Default.MoreHoriz, "更多", Modifier.size(20.dp), c.fg3) }
    }
}

/**
 * Gallery cell: a clean square. Media shows the bare thumbnail (only videos get a tiny dark play
 * mark); folders and documents show a quiet glyph with the name. Long-press opens the sheet.
 */
@OptIn(ExperimentalFoundationApi::class)
@Composable
fun FileGridCell(it: FsItem, onClick: () -> Unit, onMore: () -> Unit, modifier: Modifier = Modifier) {
    val c = Dh.c
    val kind = kindOf(it.name)
    val media = !it.isDir && (kind == "image" || kind == "video")
    Box(modifier.fillMaxWidth().aspectRatio(1f).clip(Radius.xs).combinedClickable(onClick = onClick, onLongClick = onMore)) {
        if (media) FileThumb(it, Modifier.fillMaxSize(), Radius.xs, glyph = 30.dp, videoMark = true)
        else Column(
            Modifier.fillMaxSize().background(c.surface).padding(8.dp),
            verticalArrangement = Arrangement.Center, horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            Icon(if (it.isDir) Icons.Default.Folder else iconFor(it.name), null, Modifier.size(30.dp), c.kindTint(kind, it.isDir))
            Spacer(Modifier.height(6.dp))
            Text(it.name, color = c.fg2, style = MaterialTheme.typography.labelSmall, maxLines = 2, overflow = TextOverflow.Ellipsis, textAlign = TextAlign.Center)
        }
    }
}
