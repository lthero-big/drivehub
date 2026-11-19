package com.drivehub.app

import com.drivehub.app.core.Compat
import com.drivehub.app.data.*
import org.junit.Assert.*
import org.junit.Assume.assumeTrue
import org.junit.Test
import java.io.File

/**
 * Runs the real [ApiClient] against a live DriveHub server. Skipped unless
 * DRIVEHUB_TEST_BASE (+ DRIVEHUB_TEST_USER / DRIVEHUB_TEST_PW, and a writable mount
 * DRIVEHUB_TEST_MOUNT, default /phone) are set — see scripts/smoke-android-api.sh for a server.
 */
class LiveServerTest {
    private val base = System.getenv("DRIVEHUB_TEST_BASE")
    private val user = System.getenv("DRIVEHUB_TEST_USER") ?: "admin"
    private val pw = System.getenv("DRIVEHUB_TEST_PW") ?: ""
    private val mount = System.getenv("DRIVEHUB_TEST_MOUNT") ?: "/phone"
    private fun client(ver: String = BuildConfigStub.VERSION, api: Int = 1) = ApiClient(base, ver, api)

    object BuildConfigStub { val VERSION = File("../../VERSION").readText().trim() }

    @Test fun coreFlowAgainstRealServer() {
        assumeTrue(base != null)
        val c = client()
        assertTrue("negotiate: ${c.negotiate()}", c.negotiate() is Compat.Ok)
        assertTrue(c.login(user, pw) is LoginResult.Success)
        assertTrue(c.list("/").items.any { it.path == mount })
        val dir = "$mount/live-${System.nanoTime()}"
        c.mkdir(dir)
        // resumable upload: first call dies mid-way (cancel after first chunk), second resumes via session id
        val data = ByteArray(20_000_000) { (it * 31).toByte() }
        var session: String? = null
        var calls = 0
        val e = runCatching {
            c.uploadResumable("$dir/big.bin", data.size.toLong(), null, { off -> data.inputStream().also { it.skip(off) } },
                { session = it }, { _, _ -> }, cancelled = { ++calls > 1 })
        }.exceptionOrNull()
        assertNotNull("first attempt must be interrupted", e)
        assertNotNull(session)
        val st = c.uploadState(session!!)
        assertTrue("server kept partial offset ${st.offset}", st.offset in 1 until data.size)
        var resumedFrom = -1L
        val item = c.uploadResumable("$dir/big.bin", data.size.toLong(), session, { off -> resumedFrom = off; data.inputStream().also { it.skip(off) } }, {}, { _, _ -> })
        assertEquals(st.offset, resumedFrom); assertEquals(data.size.toLong(), item.size)
        // download with resume: partial file then Range continuation
        val f = File.createTempFile("live", ".bin"); f.deleteOnExit()
        f.writeBytes(data.copyOfRange(0, 5_000_000))
        c.download("$dir/big.bin", f)
        assertArrayEquals(data, f.readBytes())
        assertTrue(c.search("big", 10).hits.size >= 0)
        // share + pickup claim
        val sh = c.createShare(NewShare(listOf(dir), perm = "download", days = 1, randomPin = true))
        val anon = ApiClient(base, BuildConfigStub.VERSION, 1)
        val open = anon.claim(sh.pickupCode)
        val out = File.createTempFile("share", ".bin"); out.deleteOnExit()
        anon.shareDownload(open.code, open.token, "/" + dir.substringAfterLast('/') + "/big.bin", out)
        assertArrayEquals(data, out.readBytes())
        val noPin = runCatching { anon.claim(sh.code) }.exceptionOrNull()
        assertTrue(noPin is ApiException && noPin.needPin)
        c.revokeShare(sh.id)
        assertEquals(410, (runCatching { anon.claim(sh.pickupCode) }.exceptionOrNull() as ApiException).status)
        c.deleteShare(sh.id)
        c.delete(dir)
    }

    @Test fun incompatibleAppIsRejectedByRealServer() {
        assumeTrue(base != null)
        val old = client("0.0.1")
        val r = old.negotiate()
        // /api/version itself is ungated (so the app can explain), the evaluation says "too old"
        assertTrue("negotiate(0.0.1) = $r", r is Compat.ClientTooOld)
        val e = runCatching { old.login(user, pw) }.exceptionOrNull()
        assertTrue("login by old app: $e", e is UpgradeRequiredException)
        val api2 = client(api = 99).negotiate()
        assertTrue("api 99: $api2", api2 is Compat.ServerTooOld)
    }
}
