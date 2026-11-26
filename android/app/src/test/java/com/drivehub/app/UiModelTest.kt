package com.drivehub.app

import com.drivehub.app.data.FsItem
import com.drivehub.app.ui.KindFilter
import com.drivehub.app.ui.ThumbPolicy
import com.drivehub.app.ui.extBadge
import com.drivehub.app.ui.kindOf
import com.drivehub.app.ui.matchesFilter
import com.drivehub.app.ui.mountBrand
import com.drivehub.app.ui.theme.AuroraColors
import com.drivehub.app.ui.theme.MidnightColors
import com.drivehub.app.ui.theme.PaperColors
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
    @Test fun themeKeysRoundTripAndUnknownFallsBackToSystem() {
        ThemeMode.entries.forEach { assertEquals(it, ThemeMode.fromKey(it.key)) }
        assertEquals(ThemeMode.System, ThemeMode.fromKey(null))
        assertEquals(ThemeMode.System, ThemeMode.fromKey("neon-pink"))
    }

    @Test fun systemModeFollowsDarkSetting() {
        assertEquals(ThemeMode.Midnight, ThemeMode.System.resolve(systemDark = true))
        assertEquals(ThemeMode.Paper, ThemeMode.System.resolve(systemDark = false))
        assertEquals(ThemeMode.Aurora, ThemeMode.Aurora.resolve(systemDark = false))
        assertEquals(PaperColors, colorsFor(ThemeMode.System, false))
        assertEquals(MidnightColors, colorsFor(ThemeMode.System, true))
        assertEquals(AuroraColors, colorsFor(ThemeMode.Aurora, false))
        assertTrue(MidnightColors.isDark && AuroraColors.isDark && !PaperColors.isDark)
    }

    @Test fun kindTintsAreDistinctPerKind() {
        val c = MidnightColors
        assertEquals(c.folder, c.kindTint("image", isDir = true))
        val tints = listOf("image", "video", "audio", "pdf", "text", "other").map { c.kindTint(it, false) }
        assertEquals(tints.size, tints.toSet().size)
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
        assertEquals(kinds.size, brands.map { it.iconKey to it.from }.toSet().size)
        assertEquals("PikPak", mountBrand("PIKPAK").label)
        assertEquals("115 网盘", mountBrand("p115").label)
        assertEquals("FTP", mountBrand("ftp").label)
        assertEquals("存储", mountBrand(null).label)
    }
}
