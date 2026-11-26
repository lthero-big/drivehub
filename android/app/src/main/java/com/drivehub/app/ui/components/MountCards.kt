package com.drivehub.app.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowForward
import androidx.compose.material.icons.filled.*
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import com.drivehub.app.data.FsItem
import com.drivehub.app.ui.MountBrand
import com.drivehub.app.ui.mountBrand
import com.drivehub.app.ui.theme.Dh
import com.drivehub.app.ui.theme.Radius

fun brandIcon(key: String): ImageVector = when (key) {
    "storage" -> Icons.Default.Storage
    "bucket" -> Icons.Default.Inventory2
    "web" -> Icons.Default.Language
    "sync" -> Icons.Default.SyncAlt
    "hub" -> Icons.Default.Hub
    "bolt" -> Icons.Default.Bolt
    "cloud" -> Icons.Default.Cloud
    else -> Icons.Default.Folder
}

/** Gradient brand tile (44 dp by default) for a storage driver. */
@Composable
fun BrandTile(brand: MountBrand, size: Dp = 44.dp) {
    Box(
        Modifier.size(size).clip(Radius.md).background(Brush.linearGradient(listOf(brand.from, brand.to)))
            .border(1.dp, Color.White.copy(alpha = 0.22f), Radius.md),
        Alignment.Center,
    ) { Icon(brandIcon(brand.iconKey), null, Modifier.size(size * 0.52f), Color.White) }
}

/**
 * Bento card for one mount point at "/": brand gradient wash, slow sheen, status pill.
 * [hero] makes the card taller with a larger tile (first card of the grid).
 */
@Composable
fun MountCard(item: FsItem, hero: Boolean, modifier: Modifier = Modifier, onClick: () -> Unit) {
    val c = Dh.c
    val b = mountBrand(item.mountKind)
    val ro = item.readOnly == true
    Box(
        modifier
            .height(if (hero) 156.dp else 138.dp)
            .clip(Radius.lg)
            .background(c.surface)
            .drawBehind {
                drawRect(Brush.linearGradient(listOf(b.from.copy(alpha = if (c.isDark) 0.30f else 0.20f), Color.Transparent), Offset(size.width, 0f), Offset(size.width * 0.15f, size.height)))
                drawCircle(b.to.copy(alpha = if (c.isDark) 0.22f else 0.14f), size.height * 0.55f, Offset(size.width * 1.02f, -size.height * 0.08f))
            }
            .sheen(Color.White.copy(alpha = if (c.isDark) 0.05f else 0.25f))
            .border(1.dp, c.line, Radius.lg)
            .clickable(onClick = onClick)
            .padding(16.dp),
    ) {
        Column(Modifier.fillMaxSize()) {
            Row(verticalAlignment = Alignment.Top) {
                BrandTile(b, if (hero) 52.dp else 44.dp)
                Spacer(Modifier.weight(1f))
                Box(Modifier.size(30.dp).clip(CircleShape).background(c.fg.copy(alpha = 0.06f)), Alignment.Center) {
                    Icon(Icons.AutoMirrored.Filled.ArrowForward, null, Modifier.size(16.dp), c.fg2)
                }
            }
            Spacer(Modifier.weight(1f))
            Text(item.name, style = if (hero) MaterialTheme.typography.titleLarge else MaterialTheme.typography.titleMedium, color = c.fg, maxLines = 1, overflow = TextOverflow.Ellipsis)
            Spacer(Modifier.height(4.dp))
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(b.label, color = c.fg2, style = MaterialTheme.typography.bodySmall, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f, fill = false))
                Spacer(Modifier.width(8.dp))
                StatusPill(if (ro) "只读" else "可读写", if (ro) c.warning else c.success)
            }
        }
    }
}

/** Compact brand chip shown in a folder header to tell which drive you are in. */
@Composable
fun MountChip(kind: String?, name: String) {
    val c = Dh.c
    val b = mountBrand(kind)
    Row(
        Modifier.clip(Radius.pill).background(c.fg.copy(alpha = 0.06f)).padding(start = 3.dp, end = 10.dp, top = 3.dp, bottom = 3.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(Modifier.size(18.dp).clip(CircleShape).background(Brush.linearGradient(listOf(b.from, b.to))), Alignment.Center) {
            Icon(brandIcon(b.iconKey), null, Modifier.size(11.dp), Color.White)
        }
        Spacer(Modifier.width(6.dp))
        Text(name, color = c.fg2, style = MaterialTheme.typography.labelMedium, fontWeight = FontWeight.Medium, maxLines = 1)
    }
}
