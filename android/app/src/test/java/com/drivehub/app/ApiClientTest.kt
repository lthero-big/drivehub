package com.drivehub.app

import com.drivehub.app.core.Compat
import com.drivehub.app.data.*
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test
import java.io.File

class ApiClientTest {
    private lateinit var srv: MockWebServer
    private lateinit var api: ApiClient
    private val tokens = MemoryTokenStore()

    @Before fun setUp() { srv = MockWebServer(); srv.start(); api = ApiClient(srv.url("/").toString(), "0.1.0", 1, tokens) }
    @After fun tearDown() { srv.shutdown() }

    private fun json(body: String, code: Int = 200) = MockResponse().setResponseCode(code).setHeader("Content-Type", "application/json").setBody(body)

    @Test fun negotiateOkSendsClientHeaders() {
        srv.enqueue(json("""{"server_version":"0.1.0","api_version":1,"min_app_version":"0.1.0","min_web_version":"0.1.0","extra":1}"""))
        val c = api.negotiate()
        assertTrue(c is Compat.Ok)
        val r = srv.takeRequest()
        assertEquals("/api/version", r.path)
        assertEquals("app/0.1.0", r.getHeader("x-drivehub-client"))
        assertEquals("1", r.getHeader("x-drivehub-api"))
    }

    @Test fun negotiateDetectsTooOldApp() {
        srv.enqueue(json("""{"server_version":"0.3.0","api_version":1,"min_app_version":"0.2.0","min_web_version":"0.1.0"}"""))
        val c = api.negotiate()
        assertTrue(c is Compat.ClientTooOld); assertEquals("0.2.0", (c as Compat.ClientTooOld).minVersion)
    }

    @Test fun negotiateMaps426() {
        srv.enqueue(json("""{"status":"client_too_old","min_version":"0.5.0"}""", 426))
        val c = api.negotiate()
        assertTrue(c is Compat.ClientTooOld); assertEquals("0.5.0", (c as Compat.ClientTooOld).minVersion)
    }

    @Test fun negotiateRejectsNonDriveHub() {
        srv.enqueue(MockResponse().setBody("<html>hello</html>"))
        assertTrue(api.negotiate() is Compat.NotDriveHub)
        srv.enqueue(MockResponse().setResponseCode(404))
        assertTrue(api.negotiate() is Compat.NotDriveHub)
    }

    @Test fun negotiateUnreachable() {
        val dead = ApiClient("http://127.0.0.1:1", "0.1.0", 1)
        assertTrue(dead.negotiate() is Compat.Unreachable)
    }

    @Test fun loginStoresTokens() {
        srv.enqueue(json("""{"access_token":"A","refresh_token":"R","token_type":"Bearer","expires_in":900,"session_id":"s"}"""))
        val r = api.login("alice", "pw")
        assertTrue(r is LoginResult.Success)
        assertEquals("A", tokens.accessToken); assertEquals("R", tokens.refreshToken)
        assertEquals("""{"login":"alice","password":"pw"}""", srv.takeRequest().body.readUtf8())
    }

    @Test fun loginTotpRequired() {
        srv.enqueue(json("""{"error":"totp required","totp_required":true}""", 401))
        assertEquals(LoginResult.TotpRequired, api.login("alice", "pw"))
        srv.enqueue(json("""{"access_token":"A2","refresh_token":"R2","token_type":"Bearer","expires_in":1,"session_id":"s"}"""))
        assertTrue(api.login("alice", "pw", "123456") is LoginResult.Success)
        srv.takeRequest()
        assertTrue(srv.takeRequest().body.readUtf8().contains(""""totp_code":"123456""""))
    }

    @Test fun loginBadPasswordAndUpgradeRequired() {
        srv.enqueue(json("""{"error":"invalid credentials"}""", 401))
        val e = runCatching { api.login("a", "b") }.exceptionOrNull()
        assertTrue(e is ApiException); assertEquals(401, (e as ApiException).status)
        srv.enqueue(json("""{"status":"client_too_old","min_version":"9.0.0"}""", 426))
        assertTrue(runCatching { api.login("a", "b") }.exceptionOrNull() is UpgradeRequiredException)
    }

    @Test fun listParsesAndSendsBearer() {
        tokens.accessToken = "tok"
        srv.enqueue(json("""{"path":"/m","total":2,"page":0,"per_page":500,"items":[
            {"name":"a.txt","path":"/m/a.txt","is_dir":false,"size":5,"modified_unix":1700000000},
            {"name":"d","path":"/m/d","is_dir":true,"size":0,"mount_kind":null,"new_field":true}]}"""))
        val l = api.list("/m")
        assertEquals(2, l.items.size); assertTrue(l.items[1].isDir); assertEquals(1700000000L, l.items[0].modifiedUnix)
        val r = srv.takeRequest()
        assertEquals("Bearer tok", r.getHeader("Authorization"))
        assertTrue(r.path!!.startsWith("/api/fs/list?path=%2Fm"))
    }

    @Test fun refreshOn401RetriesOnce() {
        tokens.accessToken = "old"; tokens.refreshToken = "rt"
        srv.enqueue(json("""{"error":"expired"}""", 401))
        srv.enqueue(json("""{"access_token":"new","refresh_token":"rt2","token_type":"Bearer","expires_in":1,"session_id":"s"}"""))
        srv.enqueue(json("""{"path":"/","items":[]}"""))
        api.list("/")
        assertEquals("new", tokens.accessToken); assertEquals("rt2", tokens.refreshToken)
        srv.takeRequest(); srv.takeRequest()
        assertEquals("Bearer new", srv.takeRequest().getHeader("Authorization"))
    }

    @Test fun downloadResumesWithRange() {
        val f = File.createTempFile("dlt", ".part"); f.writeText("hello ")
        srv.enqueue(MockResponse().setResponseCode(206).setHeader("Content-Range", "bytes 6-10/11").setBody("world"))
        api.download("/m/x.txt", f)
        assertEquals("hello world", f.readText())
        assertEquals("bytes=6-", srv.takeRequest().getHeader("Range"))
    }

    @Test fun downloadServerIgnoresRangeRestarts() {
        val f = File.createTempFile("dlt", ".part"); f.writeText("junk")
        srv.enqueue(MockResponse().setResponseCode(200).setBody("fresh"))
        api.download("/m/x.txt", f)
        assertEquals("fresh", f.readText())
    }

    @Test fun resumableUploadContinuesFromServerOffset() {
        val data = ByteArray(10) { it.toByte() }
        srv.enqueue(json("""{"id":"u1","path":"/m/f","size":10,"offset":4,"chunk_size":1048576}""")) // GET state
        srv.enqueue(json("""{"id":"u1","path":"/m/f","size":10,"offset":10,"chunk_size":1048576}""")) // PUT chunk
        srv.enqueue(json("""{"name":"f","path":"/m/f","is_dir":false,"size":10}""")) // complete
        var seenAt = -1L
        val item = api.uploadResumable("/m/f", 10, "u1", { off -> seenAt = off; data.inputStream().also { it.skip(off) } }, {}, { _, _ -> })
        assertEquals("f", item.name); assertEquals(4L, seenAt)
        assertEquals("GET", srv.takeRequest().method)
        val put = srv.takeRequest()
        assertTrue(put.path!!.endsWith("/api/fs/uploads/u1?offset=4"))
        assertArrayEquals(data.copyOfRange(4, 10), put.body.readByteArray())
        assertTrue(srv.takeRequest().path!!.endsWith("/complete"))
    }

    @Test fun claimReportsNeedPin() {
        srv.enqueue(json("""{"error":"pin required","need_pin":true}""", 401))
        val e = runCatching { api.claim("abc") }.exceptionOrNull() as ApiException
        assertTrue(e.needPin)
        srv.enqueue(json("""{"id":1,"code":"abc","perm":"download","token":"T","items":[{"name":"a.txt","path":"/a.txt","is_dir":false,"size":3}]}"""))
        val o = api.claim("abc", "1234")
        assertEquals("T", o.token); assertEquals("a.txt", o.items[0].name)
        srv.takeRequest()
        assertTrue(srv.takeRequest().body.readUtf8().contains(""""pin":"1234""""))
    }

    @Test fun normalizeBase() {
        assertEquals("https://a.b/", ApiClient.normalizeBase("a.b"))
        assertEquals("http://1.2.3.4:8470/", ApiClient.normalizeBase(" http://1.2.3.4:8470// "))
    }

    @Test fun androidLatestParsesPackage() {
        srv.enqueue(json("""{"source":"local","version":"0.2.0","version_code":200,"url":"/api/client/android/download","sha256":"abc","size":6}"""))
        val p = api.androidLatest()
        assertEquals("local", p.source)
        assertEquals("0.2.0", p.version)
        assertEquals(200L, p.versionCode)
        assertEquals("/api/client/android/download", p.url)
        val r = srv.takeRequest()
        assertEquals("/api/client/android/latest", r.path)
        assertEquals("app/0.1.0", r.getHeader("x-drivehub-client"))
    }

    @Test fun downloadAndroidVerifiesSha256() {
        val body = "PK-apk"
        val sha = "cff481d2cf8effe3deeef24847282eaf7492a9740c99801ee875da3152570271"
        srv.enqueue(MockResponse().setHeader("Content-Type", "application/vnd.android.package-archive").setBody(body))
        val f = File.createTempFile("apk", ".apk")
        val pkg = ClientPackage(source = "local", version = "0.2.0", versionCode = 200,
            url = "/api/client/android/download", sha256 = sha, size = body.length.toLong())
        api.downloadAndroid(pkg, f)
        assertEquals(body, f.readText())
        assertEquals("/api/client/android/download", srv.takeRequest().path)
    }

    @Test fun downloadAndroidRejectsBadSha256AndDeletesFile() {
        val sha = "cff481d2cf8effe3deeef24847282eaf7492a9740c99801ee875da3152570271"
        srv.enqueue(MockResponse().setBody("not-the-apk"))
        val f = File.createTempFile("apk", ".apk")
        f.writeText("stale")
        val pkg = ClientPackage(source = "manifest", version = "0.2.0", url = "/v/app.apk", sha256 = sha, size = 0)
        val e = runCatching { api.downloadAndroid(pkg, f) }.exceptionOrNull()
        assertTrue(e is com.drivehub.app.core.Sha256MismatchException)
        assertFalse("corrupt file must be deleted", f.exists())
        assertEquals("/v/app.apk", srv.takeRequest().path)
    }

    @Test fun downloadAndroidRejectsSizeMismatchAndDeletesFile() {
        val sha = "cff481d2cf8effe3deeef24847282eaf7492a9740c99801ee875da3152570271"
        srv.enqueue(MockResponse().setBody("PK-apk"))
        val f = File.createTempFile("apk", ".apk")
        val pkg = ClientPackage(url = "/api/client/android/download", sha256 = sha, size = 99)
        val e = runCatching { api.downloadAndroid(pkg, f) }.exceptionOrNull()
        assertTrue(e is java.io.IOException)
        assertTrue(e!!.message!!.contains("size mismatch"))
        assertFalse(f.exists())
    }

    @Test fun androidLatestRelativeAndAbsoluteUrlsResolve() {
        val rel = ClientPackage(url = "/api/client/android/download", sha256 = "x")
        assertEquals("/api/client/android/download", api.resolvePackageUrl(rel).encodedPath)
        val abs = ClientPackage(url = srv.url("/v2/app.apk").toString(), sha256 = "x")
        assertEquals("/v2/app.apk", api.resolvePackageUrl(abs).encodedPath)
        assertEquals(srv.hostName, api.resolvePackageUrl(abs).host)
    }
}
