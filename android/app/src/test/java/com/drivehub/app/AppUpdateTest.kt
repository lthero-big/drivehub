package com.drivehub.app

import com.drivehub.app.core.AppUpdate
import com.drivehub.app.core.Sha256MismatchException
import org.junit.Assert.*
import org.junit.Test
import java.io.File

class AppUpdateTest {
    @Test fun versionCodeWins() {
        assertTrue(AppUpdate.isNewer("0.1.0", 200, "0.1.0", 100))
        assertFalse(AppUpdate.isNewer("9.0.0", 50, "0.1.0", 100))
        assertFalse(AppUpdate.isNewer("0.1.0", 100, "0.1.0", 100))
    }

    @Test fun semverUsedWhenCodeMissingOrTied() {
        assertTrue(AppUpdate.isNewer("0.2.0", null, "0.1.0", 100))
        assertFalse(AppUpdate.isNewer("0.1.0", null, "0.1.0", 100))
        assertTrue(AppUpdate.isNewer("0.1.1", 100, "0.1.0", 100))
        assertFalse(AppUpdate.isNewer(null, null, "0.1.0", 100))
        assertFalse(AppUpdate.isNewer("nope", null, "0.1.0", 100))
    }

    @Test fun verifySha256AcceptsAndRejects() {
        val f = File.createTempFile("apk", ".bin")
        f.writeText("PK-apk")
        val sha = "cff481d2cf8effe3deeef24847282eaf7492a9740c99801ee875da3152570271"
        assertEquals(sha, AppUpdate.sha256Hex(f))
        AppUpdate.verifySha256(f, sha.uppercase())
        assertTrue(f.exists())
        val e = runCatching { AppUpdate.verifySha256(f, "00".repeat(32)) }.exceptionOrNull()
        assertTrue(e is Sha256MismatchException)
        assertFalse(f.exists())
    }
}
