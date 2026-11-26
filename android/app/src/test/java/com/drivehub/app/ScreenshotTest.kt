package com.drivehub.app

import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.LinearGradient
import android.graphics.Paint
import android.graphics.Shader
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.Modifier
import androidx.compose.foundation.background
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.graphics.painter.BitmapPainter
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.drivehub.app.data.FsItem
import com.drivehub.app.data.Share
import com.drivehub.app.ui.AppRoot
import com.drivehub.app.ui.AppViewModel
import com.drivehub.app.ui.FilesState
import com.drivehub.app.ui.Stage
import com.drivehub.app.ui.components.*
import com.drivehub.app.ui.kindOf
import com.drivehub.app.ui.theme.Dh
import com.drivehub.app.ui.theme.DriveHubTheme
import com.drivehub.app.ui.theme.ThemeMode
import com.drivehub.app.ui.screens.MeScreen
import com.github.takahirom.roborazzi.captureRoboImage
import com.github.takahirom.roborazzi.captureScreenRoboImage
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/**
 * Layout screenshots rendered on the JVM (Robolectric native graphics + Roborazzi).
 * Opt-in: `./gradlew testDebugUnitTest -Pscreenshots` writes PNGs to app/build/screenshots/.
 * Thumbnails are synthetic muted gradients standing in for photos (no server in tests).
 */
@RunWith(AndroidJUnit4::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [34], qualifiers = "w400dp-h860dp-xxhdpi")
class ScreenshotTest {
    @get:Rule val rule = createComposeRule()

    private val mounts = listOf(
        FsItem("local", "/local", true, mountKind = "fs"),
        FsItem("pikpak", "/pikpak", true, mountKind = "pikpak"),
        FsItem("p115", "/p115", true, mountKind = "p115", readOnly = true),
        FsItem("s3-backup", "/s3-backup", true, mountKind = "s3"),
        FsItem("nas", "/nas", true, mountKind = "webdav"),
    )
    private val folder = listOf(
        FsItem("相册 2026", "/local/相册 2026", true, modifiedUnix = 1764100000),
        FsItem("夕阳.jpg", "/local/夕阳.jpg", false, 3_400_000, 1764100000),
        FsItem("海边.png", "/local/海边.png", false, 5_100_000, 1764000000),
        FsItem("vlog-day1.mp4", "/local/vlog-day1.mp4", false, 12_800_000, 1763900000),
        FsItem("森林.webp", "/local/森林.webp", false, 2_200_000, 1763800000),
        FsItem("夜景.jpg", "/local/夜景.jpg", false, 4_800_000, 1763700000),
        FsItem("周报.pdf", "/local/周报.pdf", false, 820_000, 1763600000),
        FsItem("bgm.flac", "/local/bgm.flac", false, 31_000_000, 1763500000),
        FsItem("notes.md", "/local/notes.md", false, 12_000, 1763400000),
        FsItem("backup.zip", "/local/backup.zip", false, 1_200_000_000, 1763300000),
    )

    private fun fakeThumb(item: FsItem): BitmapPainter? {
        val k = kindOf(item.name)
        if (k != "image" && k != "video") return null
        val palettes = listOf(intArrayOf(0xFFC9B79C.toInt(), 0xFF7A6A55.toInt()), intArrayOf(0xFF9DB4C0.toInt(), 0xFF4F6772.toInt()),
            intArrayOf(0xFF8FA383.toInt(), 0xFF3F5240.toInt()), intArrayOf(0xFF3A3F4A.toInt(), 0xFF7E7F8C.toInt()), intArrayOf(0xFFE0B48A.toInt(), 0xFF9C5B3F.toInt()))
        val p = palettes[(item.name.hashCode() and 0x7fffffff) % palettes.size]
        val bmp = Bitmap.createBitmap(240, 240, Bitmap.Config.ARGB_8888)
        val cv = Canvas(bmp)
        cv.drawRect(0f, 0f, 240f, 240f, Paint().apply { shader = LinearGradient(0f, 0f, 240f, 240f, p[0], p[1], Shader.TileMode.CLAMP) })
        cv.drawCircle(170f, 70f, 34f, Paint().apply { color = 0x33FFFFFF })
        cv.drawRect(0f, 170f, 240f, 240f, Paint().apply { color = 0x33000000 })
        return BitmapPainter(bmp.asImageBitmap())
    }

    private fun vm(files: FilesState, grid: Boolean = false): AppViewModel = AppViewModel(ApplicationProvider.getApplicationContext()).apply {
        prefs.username = "lthero"; prefs.serverUrl = "https://drive.lthero.cn"
        stage.value = Stage.Main
        this.files.value = files
        mounts.value = this@ScreenshotTest.mounts.associate { it.name to it.mountKind!! }
        readOnlyMounts.value = this@ScreenshotTest.mounts.filter { it.readOnly == true }.map { it.name }.toSet()
        recent.value = listOf("/pikpak/电影/2026", "/local/相册 2026", "/nas/工作/周报")
        gridView.value = grid
    }

    private fun shot(name: String, mode: ThemeMode, screen: Boolean = false, content: @Composable () -> Unit) {
        rule.mainClock.autoAdvance = false
        rule.setContent {
            DriveHubTheme(mode) {
                CompositionLocalProvider(LocalThumbPainter provides { fakeThumb(it) }) {
                    Box(Modifier.fillMaxSize().background(Dh.c.bg)) { content() }
                }
            }
        }
        rule.mainClock.advanceTimeBy(1500)
        val path = "build/screenshots/$name.png"
        @OptIn(com.github.takahirom.roborazzi.ExperimentalRoborazziApi::class)
        if (screen) captureScreenRoboImage(path) else rule.onRoot().captureRoboImage(path)
    }

    private fun androidx.compose.ui.test.junit4.ComposeContentTestRule.onRoot() =
        onNode(androidx.compose.ui.test.isRoot())

    private val L = ThemeMode.Light
    private val D = ThemeMode.Dark

    @Test fun browseLight() { val v = vm(FilesState(items = mounts)); shot("01_browse_light", L) { AppRoot(v) } }
    @Test fun browseDark() { val v = vm(FilesState(items = mounts)); shot("02_browse_dark", D) { AppRoot(v) } }
    @Test fun folderListLight() { val v = vm(FilesState(path = "/local", items = folder)); shot("03_folder_list_light", L) { AppRoot(v) } }
    @Test fun folderListDark() { val v = vm(FilesState(path = "/local", items = folder)); shot("04_folder_list_dark", D) { AppRoot(v) } }
    @Test fun galleryLight() { val v = vm(FilesState(path = "/local", items = folder), grid = true); shot("05_gallery_light", L) { AppRoot(v) } }
    @Test fun galleryDark() { val v = vm(FilesState(path = "/local", items = folder), grid = true); shot("06_gallery_dark", D) { AppRoot(v) } }
    @Test fun meLight() { val v = vm(FilesState()); shot("07_me_light", L) { MeScreen(v) {} } }
    @Test fun meDark() { val v = vm(FilesState()); shot("08_me_dark", D) { MeScreen(v) {} } }
    @Test fun emptyLight() { val v = vm(FilesState(path = "/nas/新建文件夹", items = emptyList())); shot("09_empty_light", L) { AppRoot(v) } }
    @Test fun emptyDark() { val v = vm(FilesState(path = "/p115/资料", items = emptyList())); shot("10_empty_readonly_dark", D) { AppRoot(v) } }
    @Test fun actionSheetLight() { shot("11_action_sheet_light", L, screen = true) { FileActionSheet(folder[3], {}, {}, {}, {}, {}, {}) } }
    @Test fun actionSheetDark() { shot("12_action_sheet_dark", D, screen = true) { FileActionSheet(folder[1], {}, {}, {}, {}, {}, {}) } }
    @Test fun shareSheetLight() { shot("13_share_sheet_light", L, screen = true) { ShareSheet(folder[1], {}) { _, _, _ -> } } }
    @Test fun addSheetDark() { shot("14_add_sheet_dark", D, screen = true) { AddSheet({}, {}, {}) } }
    @Test fun loginLight() {
        val v = vm(FilesState()).apply { stage.value = Stage.Login(listOf("github")) }
        shot("15_login_light", L) { AppRoot(v) }
    }
    @Test fun shareCreatedDark() {
        val s = Share(1, "Ab3dE", perm = "download", pickupCode = "K7Q2M9", url = "https://drive.lthero.cn/s/Ab3dE")
        shot("16_share_created_dark", D, screen = true) { ShareCreatedDialog(s) {} }
    }
}
