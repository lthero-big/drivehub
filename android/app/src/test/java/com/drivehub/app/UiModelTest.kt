package com.drivehub.app

import com.drivehub.app.data.FsItem
import com.drivehub.app.ui.KindFilter
import com.drivehub.app.ui.ThumbPolicy
import com.drivehub.app.ui.extBadge
import com.drivehub.app.ui.kindOf
import com.drivehub.app.ui.matchesFilter
import com.drivehub.app.ui.mountBrand
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.toArgb
import com.drivehub.app.ui.NavMemory
import com.drivehub.app.ui.theme.CharcoalDark
import com.drivehub.app.ui.theme.PaperLight
import com.drivehub.app.ui.theme.ThemeMode
import com.drivehub.app.ui.theme.colorsFor
import com.drivehub.app.ui.theme.kindTint
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class UiModelTest {
    // ---------------------------------------------------------------- theme
    @Test fun onlyThreeThemesAndRetiredKeysFallBackToSystem() {
        assertEquals(listOf(ThemeMode.System, ThemeMode.Light, ThemeMode.Dark), ThemeMode.entries.toList())
        ThemeMode.entries.forEach { assertEquals(it, ThemeMode.fromKey(it.key)) }
        assertEquals(ThemeMode.System, ThemeMode.fromKey(null))
        assertEquals(ThemeMode.System, ThemeMode.fromKey("midnight"))
        assertEquals(ThemeMode.System, ThemeMode.fromKey("aurora"))
        assertEquals(ThemeMode.Light, ThemeMode.fromKey("paper"))
    }

    @Test fun systemModeFollowsDarkSetting() {
        assertEquals(ThemeMode.Dark, ThemeMode.System.resolve(systemDark = true))
        assertEquals(ThemeMode.Light, ThemeMode.System.resolve(systemDark = false))
        assertEquals(ThemeMode.Dark, ThemeMode.Dark.resolve(systemDark = false))
        assertEquals(PaperLight, colorsFor(ThemeMode.System, false))
        assertEquals(CharcoalDark, colorsFor(ThemeMode.System, true))
        assertEquals(PaperLight, colorsFor(ThemeMode.Light, true))
        assertTrue(CharcoalDark.isDark && !PaperLight.isDark)
    }

    @Test fun palettesMatchDropitPaper() {
        fun hex(c: Color) = "%08X".format(c.toArgb())
        assertEquals("FFF5F3EF", hex(PaperLight.bg)); assertEquals("FFFFFFFF", hex(PaperLight.surface))
        assertEquals("FFECE8E0", hex(PaperLight.surface2)); assertEquals("FF1D1B18", hex(PaperLight.fg))
        assertEquals("FF6F6A61", hex(PaperLight.fg2)); assertEquals("FF9C958A", hex(PaperLight.fg3))
        assertEquals("FFD0021B", hex(PaperLight.accent))
        assertEquals("FF141413", hex(CharcoalDark.bg)); assertEquals("FF1D1C1A", hex(CharcoalDark.surface))
        assertEquals("FF282623", hex(CharcoalDark.surface2)); assertEquals("FFF2EFE9", hex(CharcoalDark.fg))
        assertEquals("FF9B958B", hex(CharcoalDark.fg2)); assertEquals("FF6C665D", hex(CharcoalDark.fg3))
        assertEquals("FFE5484D", hex(CharcoalDark.accent))
        assertEquals(0.09f, PaperLight.line.alpha, 0.005f); assertEquals(0.09f, CharcoalDark.line.alpha, 0.005f)
        assertEquals(0.09f, PaperLight.accentSoft.alpha, 0.005f); assertEquals(0.16f, CharcoalDark.accentSoft.alpha, 0.005f)
    }

    @Test fun kindTintsAreDistinctPerKind() {
        listOf(PaperLight, CharcoalDark).forEach { c ->
            assertEquals(c.folder, c.kindTint("image", isDir = true))
            val tints = listOf("image", "video", "audio", "pdf", "text", "other").map { c.kindTint(it, false) }
            assertEquals(tints.size, tints.toSet().size)
        }
    }

    // ---------------------------------------------------------------- navigation memory
    @Test fun coldStartLandsInLastMountOnlyIfItStillExists() {
        assertEquals("/", NavMemory.startPath(null, listOf("pikpak")))
        assertEquals("/", NavMemory.startPath("", null))
        assertEquals("/pikpak", NavMemory.startPath("pikpak", null))
        assertEquals("/pikpak", NavMemory.startPath("pikpak", listOf("local", "pikpak")))
        assertEquals("/", NavMemory.startPath("gone", listOf("local", "pikpak")))
        assertEquals("pikpak", NavMemory.mountOf("/pikpak/电影/2026"))
        assertEquals(null, NavMemory.mountOf("/"))
    }

    @Test fun recentFoldersAreDedupedCappedAndSkipMountRoots() {
        var r = emptyList<String>()
        r = NavMemory.pushRecent(r, "/pikpak")
        assertEquals(emptyList<String>(), r)
        r = NavMemory.pushRecent(r, "/pikpak/电影")
        r = NavMemory.pushRecent(r, "/local/相册/")
        r = NavMemory.pushRecent(r, "/pikpak/电影")
        assertEquals(listOf("/pikpak/电影", "/local/相册"), r)
        repeat(10) { r = NavMemory.pushRecent(r, "/local/d$it") }
        assertEquals(NavMemory.MAX_RECENT, r.size)
        assertEquals("/local/d9", r.first())
    }

    @Test fun folderChipsAreAllVideoImageDoc() {
        assertEquals(listOf(KindFilter.All, KindFilter.Video, KindFilter.Image, KindFilter.Doc), KindFilter.chips)
    }

    // ---------------------------------------------------------------- kinds & filters
    private fun f(name: String, size: Long = 1000, dir: Boolean = false) = FsItem(name, "/m/$name", dir, size, 1700000000)

    @Test fun kindDetectionIsCaseInsensitive() {
        assertEquals("image", kindOf("IMG_001.JPG"))
        assertEquals("image", kindOf("pic.heif"))
        assertEquals("video", kindOf("clip.MOV"))
        assertEquals("audio", kindOf("song.opus"))
        assertEquals("other", kindOf("README"))
        assertEquals("JPG", extBadge("a.jpg"))
        assertEquals("", extBadge("Makefile"))
    }

    @Test fun filtersMatchKinds() {
        val items = listOf(f("dir", dir = true), f("a.png"), f("b.mp4"), f("c.flac"), f("d.pdf"), f("e.md"), f("f.zip"))
        fun names(k: KindFilter) = items.filter { matchesFilter(it, k) }.map { it.name }
        assertEquals(items.size, names(KindFilter.All).size)
        assertEquals(listOf("dir"), names(KindFilter.Folder))
        assertEquals(listOf("a.png"), names(KindFilter.Image))
        assertEquals(listOf("b.mp4"), names(KindFilter.Video))
        assertEquals(listOf("c.flac"), names(KindFilter.Audio))
        assertEquals(listOf("d.pdf", "e.md"), names(KindFilter.Doc))
    }

    // ---------------------------------------------------------------- thumbnails
    @Test fun thumbPolicyOnlyLoadsSmallMediaWhenEnabled() {
        assertTrue(ThumbPolicy.shouldLoad(f("a.jpg"), enabled = true))
        assertTrue(ThumbPolicy.shouldLoad(f("b.mp4", ThumbPolicy.MAX_BYTES), enabled = true))
        assertFalse(ThumbPolicy.shouldLoad(f("a.jpg"), enabled = false))
        assertFalse(ThumbPolicy.shouldLoad(f("big.jpg", ThumbPolicy.MAX_BYTES + 1), enabled = true))
        assertFalse(ThumbPolicy.shouldLoad(f("empty.jpg", 0), enabled = true))
        assertFalse(ThumbPolicy.shouldLoad(f("doc.pdf"), enabled = true))
        assertFalse(ThumbPolicy.shouldLoad(f("photos.jpg", dir = true), enabled = true))
    }

    @Test fun thumbCacheKeyChangesWhenFileChanges() {
        val a = f("a.jpg")
        val k = ThumbPolicy.cacheKey("https://d.example.com/", a)
        assertEquals(k, ThumbPolicy.cacheKey("https://d.example.com", a))
        assertNotEquals(k, ThumbPolicy.cacheKey("https://d.example.com", a.copy(size = 2000)))
        assertNotEquals(k, ThumbPolicy.cacheKey("https://d.example.com", a.copy(modifiedUnix = 1)))
        assertNotEquals(k, ThumbPolicy.cacheKey("https://other.example.com", a))
    }

    // ---------------------------------------------------------------- mount brands
    @Test fun everyDriverHasItsOwnBrand() {
        val kinds = listOf("fs", "s3", "webdav", "rclone", "openlist", "pikpak", "p115")
        val brands = kinds.map { mountBrand(it) }
        assertEquals(kinds.size, brands.map { it.label }.toSet().size)
        assertEquals(kinds.size, brands.map { it.iconKey to it.tint }.toSet().size)
        assertEquals("PikPak", mountBrand("PIKPAK").label)
        assertEquals("115 网盘", mountBrand("p115").label)
        assertEquals("FTP", mountBrand("ftp").label)
        assertEquals("存储", mountBrand(null).label)
    }
}
