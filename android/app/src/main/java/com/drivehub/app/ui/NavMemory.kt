package com.drivehub.app.ui

/**
 * Pure navigation memory rules (unit-tested): which mount a path belongs to, where a cold start
 * lands ("remember the last drive", PikPak-style), and the short list of recent folders.
 */
object NavMemory {
    const val MAX_RECENT = 6

    /** First path segment ("/pikpak/电影" -> "pikpak"), or null at "/". */
    fun mountOf(path: String): String? = path.trim('/').substringBefore('/').ifEmpty { null }

    /**
     * Cold-start destination: the last mount when it still exists, else the "浏览" root.
     * [mounts] null means the mount list is not known yet (trust [lastMount]).
     */
    fun startPath(lastMount: String?, mounts: Collection<String>?): String = when {
        lastMount.isNullOrBlank() -> "/"
        mounts != null && lastMount !in mounts -> "/"
        else -> "/$lastMount"
    }

    /** Most-recent-first folders inside a mount (mount roots already live under 「位置」). */
    fun pushRecent(list: List<String>, path: String, max: Int = MAX_RECENT): List<String> {
        val p = "/" + path.trim('/')
        if (p.trim('/').split('/').size < 2) return list
        return (listOf(p) + list.filter { it != p }).take(max)
    }
}
