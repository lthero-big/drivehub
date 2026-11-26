package com.drivehub.app.ui.components

import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.*
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import com.drivehub.app.ui.MountBrand

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

/** 30 dp storage icon: low-saturation wash + glyph in the driver's tint (no gradient, no rim). */
@Composable
fun BrandTile(brand: MountBrand, size: Dp = 30.dp) = IconTile(brandIcon(brand.iconKey), brand.tint, size)
