package com.drivehub.app.ui

import com.drivehub.app.data.FsItem

/** File-kind helpers shared by lists, previews and thumbnails (pure; unit-tested). */
fun kindOf(name: String): String = when (name.substringAfterLast('.', "").lowercase()) {
    "jpg", "jpeg", "png", "gif", "webp", "bmp", "heic", "heif", "avif" -> "image"
    "mp4", "mkv", "webm", "mov", "m4v", "3gp" -> "video"
    "mp3", "m4a", "wav", "flac", "ogg", "aac", "opus" -> "audio"
    "pdf" -> "pdf"
    "txt", "md", "log", "json", "csv", "xml", "yml", "yaml", "toml", "rs", "kt", "py", "js", "ts" -> "text"
    else -> "other"
}

enum class KindFilter(val label: String) {
    All("全部"), Folder("文件夹"), Image("图片"), Video("视频"), Audio("音频"), Doc("文档");

    companion object {
        /** The compact chip row shown in a folder (RHEA-280): 全部 / 视频 / 图片 / 文档. */
        val chips = listOf(All, Video, Image, Doc)
    }
}

fun matchesFilter(item: FsItem, f: KindFilter): Boolean = when (f) {
    KindFilter.All -> true
    KindFilter.Folder -> item.isDir
    KindFilter.Video -> !item.isDir && kindOf(item.name) == "video"
    KindFilter.Image -> !item.isDir && kindOf(item.name) == "image"
    KindFilter.Audio -> !item.isDir && kindOf(item.name) == "audio"
    KindFilter.Doc -> !item.isDir && kindOf(item.name) in setOf("pdf", "text")
}

/** Short uppercase extension badge, e.g. "JPG"; empty when there is no extension. */
fun extBadge(name: String): String = name.substringAfterLast('.', "").uppercase().take(4)

fun fmtSize(n: Long): String = when {
    n < 1024 -> "$n B"; n < 1 shl 20 -> "%.1f KB".format(n / 1024.0)
    n < 1 shl 30 -> "%.1f MB".format(n / 1048576.0); else -> "%.2f GB".format(n / 1073741824.0)
}

/**
 * Thumbnail policy. There is no server-side thumbnail endpoint, so a thumbnail means fetching the
 * file itself: only images/videos up to [MAX_BYTES] are loaded, and only when the user enabled it.
 */
object ThumbPolicy {
    const val MAX_BYTES = 15L * 1024 * 1024
    /** Decoded edge length in px for list/grid cells (Coil samples down to this). */
    const val SIZE_PX = 320

    fun shouldLoad(item: FsItem, enabled: Boolean): Boolean {
        if (!enabled || item.isDir) return false
        val k = kindOf(item.name)
        if (k != "image" && k != "video") return false
        return item.size in 1..MAX_BYTES
    }

    /** Stable cache key: changes when the file is replaced (mtime/size), scoped per server. */
    fun cacheKey(server: String, item: FsItem): String =
        "thumb:${server.trimEnd('/')}|${item.path}|${item.size}|${item.modifiedUnix ?: 0}"
}
