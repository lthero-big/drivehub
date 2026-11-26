package com.drivehub.app.ui.components

import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.*
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.MoreHoriz
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.drivehub.app.data.FsItem
import com.drivehub.app.ui.theme.Dh
import com.drivehub.app.ui.theme.Radius

/** List row: 52 dp thumbnail/icon, name, meta line, overflow button. Long-press opens the sheet. */
@OptIn(ExperimentalFoundationApi::class)
@Composable
fun FileRow(it: FsItem, onClick: () -> Unit, onMore: () -> Unit, modifier: Modifier = Modifier) {
    val c = Dh.c
    Row(
        modifier.fillMaxWidth().clip(Radius.md).combinedClickable(onClick = onClick, onLongClick = onMore)
            .padding(horizontal = 12.dp, vertical = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        FileThumb(it, Modifier.size(52.dp), Radius.md, glyph = 26.dp, badges = false)
        Spacer(Modifier.width(14.dp))
        Column(Modifier.weight(1f)) {
            Text(it.name, maxLines = 1, overflow = TextOverflow.Ellipsis, style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.SemiBold, color = c.fg)
            Spacer(Modifier.height(2.dp))
            Text(fileSubtitle(it), color = c.fg3, style = MaterialTheme.typography.bodySmall, maxLines = 1)
        }
        IconButton(onMore) { Icon(Icons.Default.MoreVert, "更多", tint = c.fg3) }
    }
}

/** Gallery cell: square thumbnail with badges, name below, glass overflow button. */
@OptIn(ExperimentalFoundationApi::class)
@Composable
fun FileGridCell(it: FsItem, onClick: () -> Unit, onMore: () -> Unit, modifier: Modifier = Modifier) {
    val c = Dh.c
    Column(modifier.clip(Radius.lg).combinedClickable(onClick = onClick, onLongClick = onMore).padding(4.dp)) {
        Box(Modifier.fillMaxWidth().aspectRatio(1f)) {
            FileThumb(it, Modifier.fillMaxSize(), Radius.lg, glyph = 40.dp)
            GlassIconButton(Icons.Default.MoreHoriz, "更多", Modifier.align(Alignment.TopEnd).padding(6.dp), size = 30.dp, onClick = onMore)
        }
        Spacer(Modifier.height(6.dp))
        Text(it.name, maxLines = 1, overflow = TextOverflow.Ellipsis, style = MaterialTheme.typography.labelLarge, color = c.fg, modifier = Modifier.padding(horizontal = 4.dp))
        Text(if (it.isDir) "文件夹" else com.drivehub.app.ui.fmtSize(it.size), style = MaterialTheme.typography.labelSmall, color = c.fg3, modifier = Modifier.padding(horizontal = 4.dp))
    }
}
