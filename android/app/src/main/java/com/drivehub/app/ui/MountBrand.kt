package com.drivehub.app.ui

import androidx.compose.ui.graphics.Color

/**
 * Visual identity per storage driver (server `mount_kind`): a label, a Material symbol and one
 * low-saturation tint for the small 30 dp icon slot. No gradients, no third-party logos.
 */
data class MountBrand(val label: String, val iconKey: String, val tint: Color)

fun mountBrand(kind: String?): MountBrand = when (kind?.lowercase()) {
    "fs", "local" -> MountBrand("本地磁盘", "storage", Color(0xFF8C7B65))
    "s3" -> MountBrand("S3 对象存储", "bucket", Color(0xFFA0785A))
    "webdav" -> MountBrand("WebDAV", "web", Color(0xFF5F7F99))
    "rclone" -> MountBrand("Rclone", "sync", Color(0xFF5F8C84))
    "openlist", "alist" -> MountBrand("OpenList", "hub", Color(0xFF7D6F9C))
    "pikpak" -> MountBrand("PikPak", "bolt", Color(0xFF5C76A8))
    "p115", "115" -> MountBrand("115 网盘", "cloud", Color(0xFF4F86A6))
    else -> MountBrand(kind?.ifBlank { null }?.uppercase() ?: "存储", "folder", Color(0xFF8A847A))
}
