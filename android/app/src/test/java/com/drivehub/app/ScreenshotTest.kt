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
import androidx.compose.ui.Alignment
import androidx.compose.ui.unit.dp
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.*
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
 * Thumbnails are synthetic gradients (no server in tests).
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
        val palettes = listOf(intArrayOf(0xFFFF9A62.toInt(), 0xFF8E3BCB.toInt()), intArrayOf(0xFF2BC0E4.toInt(), 0xFF1B3A6B.toInt()),
            intArrayOf(0xFF56AB2F.toInt(), 0xFF0F3D2E.toInt()), intArrayOf(0xFF141E30.toInt(), 0xFF7B5CFF.toInt()), intArrayOf(0xFFF7B733.toInt(), 0xFFFC4A1A.toInt()))
        val p = palettes[(item.name.hashCode() and 0x7fffffff) % palettes.size]
        val bmp = Bitmap.createBitmap(240, 240, Bitmap.Config.ARGB_8888)
        val cv = Canvas(bmp)
        cv.drawRect(0f, 0f, 240f, 240f, Paint().apply { shader = LinearGradient(0f, 0f, 240f, 240f, p[0], p[1], Shader.TileMode.CLAMP) })
        cv.drawCircle(170f, 70f, 34f, Paint().apply { color = 0x66FFFFFF })
        cv.drawRect(0f, 170f, 240f, 240f, Paint().apply { color = 0x33000000 })
        return BitmapPainter(bmp.asImageBitmap())
    }

    private fun vm(files: FilesState): AppViewModel = AppViewModel(ApplicationProvider.getApplicationContext()).apply {
        prefs.username = "lthero"; prefs.serverUrl = "https://drive.lthero.cn"
        stage.value = Stage.Main
        this.files.value = files
        mounts.value = this@ScreenshotTest.mounts.associate { it.name to it.mountKind!! }
    }

    private fun shot(name: String, mode: ThemeMode, screen: Boolean = false, content: @Composable () -> Unit) {
        rule.mainClock.autoAdvance = false
        rule.setContent {
            DriveHubTheme(mode) {
                CompositionLocalProvider(LocalThumbPainter provides { fakeThumb(it) }) { Box(Modifier.fillMaxSize()) { content() } }
            }
        }
        rule.mainClock.advanceTimeBy(1500)
        val path = "build/screenshots/$name.png"
        @OptIn(com.github.takahirom.roborazzi.ExperimentalRoborazziApi::class)
        if (screen) captureScreenRoboImage(path) else rule.onRoot().captureRoboImage(path)
    }

    private fun androidx.compose.ui.test.junit4.ComposeContentTestRule.onRoot() =
        onNode(androidx.compose.ui.test.isRoot())

    @Test fun homeMidnight() { val v = vm(FilesState(items = mounts)); shot("01_home_midnight", ThemeMode.Midnight) { AppRoot(v) } }
    @Test fun homePaper() { val v = vm(FilesState(items = mounts)); shot("02_home_paper", ThemeMode.Paper) { AppRoot(v) } }
    @Test fun homeAurora() { val v = vm(FilesState(items = mounts)); shot("03_home_aurora", ThemeMode.Aurora) { AppRoot(v) } }
    @Test fun folderListMidnight() { val v = vm(FilesState(path = "/local", items = folder)); shot("04_folder_list_midnight", ThemeMode.Midnight) { AppRoot(v) } }
    @Test fun folderListPaper() { val v = vm(FilesState(path = "/local", items = folder)); shot("05_folder_list_paper", ThemeMode.Paper) { AppRoot(v) } }
    @Test fun emptyFolderAurora() { val v = vm(FilesState(path = "/nas/新建文件夹", items = emptyList())); shot("06_empty_aurora", ThemeMode.Aurora) { AppRoot(v) } }
    @Test fun meAppearancePaper() { val v = vm(FilesState()); shot("07_me_paper", ThemeMode.Paper) { AmbientBackground(Modifier.fillMaxSize()) { MeScreen(v) {} } } }
    @Test fun meAppearanceMidnight() { val v = vm(FilesState()); shot("08_me_midnight", ThemeMode.Midnight) { AmbientBackground(Modifier.fillMaxSize()) { MeScreen(v) {} } } }
    @Test fun loginAurora() {
        val v = vm(FilesState()).apply { stage.value = Stage.Login(listOf("github")) }
        shot("09_login_aurora", ThemeMode.Aurora) { AppRoot(v) }
    }
    @Test fun shareSheetMidnight() {
        shot("10_share_sheet_midnight", ThemeMode.Midnight, screen = true) { ShareSheet(folder[1], {}) { _, _, _ -> } }
    }
    @Test fun actionSheetPaper() {
        shot("11_action_sheet_paper", ThemeMode.Paper, screen = true) { FileActionSheet(folder[3], {}, {}, {}, {}, {}, {}) }
    }
    @Test fun shareCreatedAurora() {
        val s = Share(1, "Ab3dE", perm = "download", pickupCode = "K7Q2M9", url = "https://drive.lthero.cn/s/Ab3dE")
        shot("12_share_created_aurora", ThemeMode.Aurora, screen = true) { ShareCreatedDialog(s) {} }
    }
    @Test fun galleryGridMidnight() {
        shot("13_gallery_grid_midnight", ThemeMode.Midnight) {
            AmbientBackground(Modifier.fillMaxSize()) {
                androidx.compose.foundation.lazy.grid.LazyVerticalGrid(
                    androidx.compose.foundation.lazy.grid.GridCells.Adaptive(108.dp),
                    contentPadding = androidx.compose.foundation.layout.PaddingValues(12.dp),
                ) { items(folder.size) { i -> FileGridCell(folder[i], {}, {}) } }
                FloatingDock(
                    listOf(DockTab("f", "文件", Icons.Filled.Folder, Icons.Filled.Folder), DockTab("t", "传输", Icons.Filled.SwapVert, Icons.Filled.SwapVert),
                        DockTab("s", "分享", Icons.Filled.Share, Icons.Filled.Share), DockTab("m", "我的", Icons.Filled.Person, Icons.Filled.Person, badge = true)),
                    "f", {}, true, Modifier.align(Alignment.BottomCenter), actionIcon = Icons.Filled.Add,
                )
            }
        }
    }
    @Test fun addSheetAurora() { shot("14_add_sheet_aurora", ThemeMode.Aurora, screen = true) { AddSheet({}, {}, {}) } }
}
