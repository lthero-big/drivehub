package com.drivehub.app.ui

import androidx.compose.ui.graphics.Color

/**
 * Visual identity per storage driver (server `mount_kind`). Colours are original brand-ish
 * gradients, icons are Material symbols — no third-party logos are bundled.
 */
data class MountBrand(val label: String, val iconKey: String, val from: Color, val to: Color)

fun mountBrand(kind: String?): MountBrand = when (kind?.lowercase()) {
    "fs", "local" -> MountBrand("本地磁盘", "storage", Color(0xFFF59E0B), Color(0xFFEA580C))
    "s3" -> MountBrand("S3 对象存储", "bucket", Color(0xFFFF9F43), Color(0xFFE2541C))
    "webdav" -> MountBrand("WebDAV", "web", Color(0xFF3B82F6), Color(0xFF06B6D4))
    "rclone" -> MountBrand("Rclone", "sync", Color(0xFF14B8A6), Color(0xFF0EA5E9))
    "openlist", "alist" -> MountBrand("OpenList", "hub", Color(0xFF8B5CF6), Color(0xFF6366F1))
    "pikpak" -> MountBrand("PikPak", "bolt", Color(0xFF2563EB), Color(0xFF38BDF8))
    "p115", "115" -> MountBrand("115 网盘", "cloud", Color(0xFF1D7BF5), Color(0xFF22D3EE))
    else -> MountBrand(kind?.ifBlank { null }?.uppercase() ?: "存储", "folder", Color(0xFF64748B), Color(0xFF94A3B8))
}
