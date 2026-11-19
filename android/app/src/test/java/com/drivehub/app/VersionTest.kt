package com.drivehub.app

import com.drivehub.app.core.Compat
import com.drivehub.app.core.SemVer
import com.drivehub.app.core.VersionNegotiator
import com.drivehub.app.data.VersionInfo
import org.junit.Assert.*
import org.junit.Test

class VersionTest {
    private fun info(min: String = "0.1.0", api: Int = 1) = VersionInfo("0.1.0", api, min, "0.1.0")

    @Test fun semverOrdering() {
        assertTrue(SemVer.parse("0.1.0")!! < SemVer.parse("0.1.1")!!)
        assertTrue(SemVer.parse("0.9.9")!! < SemVer.parse("0.10.0")!!)
        assertTrue(SemVer.parse("1.0.0-rc.1")!! < SemVer.parse("1.0.0")!!)
        assertTrue(SemVer.parse("1.0.0-rc.2")!! > SemVer.parse("1.0.0-rc.1")!!)
        assertTrue(SemVer.parse("1.0.0-alpha")!! < SemVer.parse("1.0.0-alpha.1")!!)
        assertEquals(SemVer(1, 2, 3), SemVer.parse("v1.2.3"))
        assertNull(SemVer.parse("abc")); assertNull(SemVer.parse("1.2"))
    }

    @Test fun sameVersionIsOk() = assertTrue(VersionNegotiator.evaluate(info(), "0.1.0", 1) is Compat.Ok)

    @Test fun newerAppIsOk() = assertTrue(VersionNegotiator.evaluate(info(), "0.2.0", 1) is Compat.Ok)

    @Test fun appBelowMinimumMustUpgrade() {
        val c = VersionNegotiator.evaluate(info(min = "0.2.0"), "0.1.0", 1)
        assertTrue(c is Compat.ClientTooOld)
        c as Compat.ClientTooOld
        assertEquals("0.2.0", c.minVersion)
        val msg = VersionNegotiator.message(c)
        assertTrue(msg.contains("升级") && msg.contains("0.2.0") && msg.contains("0.1.0"))
    }

    @Test fun serverApiOlderThanApp() {
        val c = VersionNegotiator.evaluate(info(api = 1), "0.1.0", 2)
        assertTrue(c is Compat.ServerTooOld)
        assertTrue(VersionNegotiator.message(c).contains("服务器"))
    }

    @Test fun badServerMinVersion() = assertTrue(VersionNegotiator.evaluate(info(min = "x"), "0.1.0", 1) is Compat.NotDriveHub)
}
