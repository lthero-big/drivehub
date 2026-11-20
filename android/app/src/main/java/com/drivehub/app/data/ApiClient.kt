package com.drivehub.app.data

import com.drivehub.app.core.Compat
import com.drivehub.app.core.VersionNegotiator
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import com.drivehub.app.core.AppUpdate
import java.io.File
import java.io.IOException
import java.io.InputStream
import java.util.concurrent.TimeUnit

class ApiException(val status: Int, val body: String, message: String) : IOException(message) {
    val needPin get() = body.contains("need_pin")
    val needCaptcha get() = body.contains("need_captcha")
}

/** Server answered 426: this app must be upgraded (or the server must). */
class UpgradeRequiredException(val compat: Compat) : IOException(VersionNegotiator.message(compat))

sealed interface LoginResult {
    data class Success(val tokens: TokenPair) : LoginResult
    /** Account has 2FA: call [ApiClient.login] again with `totpCode`. */
    data object TotpRequired : LoginResult
}

/** Persists the token pair. */
interface TokenStore {
    var accessToken: String?
    var refreshToken: String?
}

class MemoryTokenStore(override var accessToken: String? = null, override var refreshToken: String? = null) : TokenStore

/**
 * Hand-written client for the DriveHub REST API described by api/openapi.json (OkHttp +
 * kotlinx-serialization). Blocking: call from Dispatchers.IO / WorkManager.
 * Every request carries `x-drivehub-client: app/<version>` and `x-drivehub-api: <major>` so the
 * server's version gate can reject incompatible apps with HTTP 426.
 */
class ApiClient(
    baseUrl: String,
    private val appVersion: String,
    private val appApi: Int,
    val tokens: TokenStore = MemoryTokenStore(),
    private val http: OkHttpClient = defaultHttp(),
) {
    val base: HttpUrl = normalizeBase(baseUrl).toHttpUrl()
    private val json = AppJson
    private val jsonMt = "application/json".toMediaType()

    // ------------------------------------------------------------------ plumbing
    private fun url(path: String, vararg q: Pair<String, String?>): HttpUrl {
        val b = base.newBuilder()
        path.trim('/').split('/').filter { it.isNotEmpty() }.forEach { b.addPathSegment(it) }
        q.forEach { (k, v) -> if (v != null) b.addQueryParameter(k, v) }
        return b.build()
    }

    private fun builder(u: HttpUrl, auth: Boolean = true): Request.Builder {
        val b = Request.Builder().url(u)
            .header("x-drivehub-client", "app/$appVersion")
            .header("x-drivehub-api", appApi.toString())
            .header("Accept", "application/json, */*")
        if (auth) tokens.accessToken?.let { b.header("Authorization", "Bearer $it") }
        return b
    }

    fun authHeader(): String? = tokens.accessToken?.let { "Bearer $it" }
    fun clientHeaders(): Map<String, String> = buildMap {
        put("x-drivehub-client", "app/$appVersion"); put("x-drivehub-api", appApi.toString())
        authHeader()?.let { put("Authorization", it) }
    }

    /** Executes; maps non-2xx to [ApiException] / [UpgradeRequiredException]; refreshes once on 401. */
    private fun exec(make: () -> Request.Builder, auth: Boolean = true, ok: (Int) -> Boolean = { it in 200..299 }): Response {
        var r = http.newCall(make().build()).execute()
        if (r.code == 401 && auth && tokens.refreshToken != null) {
            r.close()
            if (refreshTokens()) r = http.newCall(make().build()).execute()
            else r = http.newCall(make().build()).execute()
        }
        if (ok(r.code)) return r
        val body = r.use { it.body?.string().orEmpty() }
        throw mapError(r.code, body)
    }

    private fun mapError(code: Int, body: String): IOException {
        if (code == 426 || code == 400) {
            val c = runCatching { json.decodeFromString<CompatBody>(body) }.getOrNull()
            when (c?.status) {
                "client_too_old" -> return UpgradeRequiredException(
                    Compat.ClientTooOld(appVersion, c.minVersion ?: "?", null))
                "server_too_old" -> return UpgradeRequiredException(
                    Compat.ServerTooOld(c.serverApiVersion ?: 0, appApi, null))
            }
        }
        val msg = runCatching { json.decodeFromString<ErrorBody>(body).error }.getOrNull()?.ifBlank { null }
            ?: body.take(200).ifBlank { "HTTP $code" }
        return ApiException(code, body, msg)
    }

    private inline fun <reified T> getJson(u: HttpUrl, auth: Boolean = true): T =
        exec({ builder(u, auth).get() }, auth).use { json.decodeFromString<T>(it.body!!.string()) }

    private inline fun <reified B, reified T> postJson(u: HttpUrl, body: B, auth: Boolean = true, method: String = "POST"): T =
        exec({ builder(u, auth).method(method, json.encodeToString(body).toRequestBody(jsonMt)) }, auth)
            .use { json.decodeFromString<T>(it.body!!.string()) }

    private inline fun <reified B> postUnit(u: HttpUrl, body: B) {
        exec({ builder(u).post(json.encodeToString(body).toRequestBody(jsonMt)) }).close()
    }

    @Synchronized
    private fun refreshTokens(): Boolean {
        val rt = tokens.refreshToken ?: return false
        return try {
            val req = builder(url("api/auth/refresh"), auth = false)
                .post(json.encodeToString(RefreshBody(rt)).toRequestBody(jsonMt)).build()
            http.newCall(req).execute().use {
                if (!it.isSuccessful) { if (it.code == 401) { tokens.accessToken = null; tokens.refreshToken = null }; return false }
                val tp = json.decodeFromString<TokenPair>(it.body!!.string())
                tokens.accessToken = tp.accessToken; tokens.refreshToken = tp.refreshToken
                true
            }
        } catch (e: IOException) { false }
    }

    // ------------------------------------------------------------------ version negotiation
    /** GET /api/version then apply [VersionNegotiator]. Never throws. */
    fun negotiate(): Compat = try {
        val r = http.newCall(builder(url("api/version"), auth = false).get().build()).execute()
        r.use {
            val body = it.body?.string().orEmpty()
            when {
                it.code == 426 -> (mapError(426, body) as? UpgradeRequiredException)?.compat
                    ?: Compat.NotDriveHub("HTTP 426")
                !it.isSuccessful -> Compat.NotDriveHub("HTTP ${it.code}")
                else -> {
                    val info = runCatching { json.decodeFromString<VersionInfo>(body) }.getOrNull()
                        ?: return@use Compat.NotDriveHub("/api/version did not return a DriveHub version document")
                    VersionNegotiator.evaluate(info, appVersion, appApi)
                }
            }
        }
    } catch (e: IOException) {
        Compat.Unreachable(e.message ?: e.javaClass.simpleName)
    } catch (e: IllegalArgumentException) {
        Compat.NotDriveHub(e.message ?: "bad response")
    }

    fun authStatus(): AuthStatus = getJson(url("api/auth/status"))

    // ------------------------------------------------------------------ auth
    fun login(login: String, password: String, totp: String? = null): LoginResult {
        val body = json.encodeToString(LoginBody(login, password, totp?.ifBlank { null })).toRequestBody(jsonMt)
        val r = http.newCall(builder(url("api/auth/login"), auth = false).post(body).build()).execute()
        r.use {
            val text = it.body?.string().orEmpty()
            if (it.isSuccessful) return LoginResult.Success(json.decodeFromString<TokenPair>(text).also(::store))
            if (it.code == 401 && text.contains("totp_required")) return LoginResult.TotpRequired
            throw mapError(it.code, text)
        }
    }

    /** Second step for OAuth logins on 2FA accounts (`ticket` from the OAuth redirect). */
    fun loginTotp(ticket: String, code: String): TokenPair =
        postJson<TicketBody, TokenPair>(url("api/auth/login/totp"), TicketBody(ticket, code), auth = false).also(::store)

    fun store(tp: TokenPair) { tokens.accessToken = tp.accessToken; tokens.refreshToken = tp.refreshToken }

    /** Start URL for the browser/WebView OAuth flow; the redirect ends in `#/oauth?access_token=…`. */
    fun oauthStartUrl(provider: String): String = url("api/auth/oauth/$provider/start").toString()

    fun me(): kotlinx.serialization.json.JsonObject =
        getJson<kotlinx.serialization.json.JsonElement>(url("api/auth/me")).jsonObject

    fun logout() {
        runCatching { exec({ builder(url("api/auth/logout")).post("{}".toRequestBody(jsonMt)) }).close() }
        tokens.accessToken = null; tokens.refreshToken = null
    }

    // ------------------------------------------------------------------ files
    fun list(path: String, page: Int = 0, perPage: Int = 500): ListResp =
        getJson(url("api/fs/list", "path" to path, "page" to page.toString(), "per_page" to perPage.toString()))

    fun search(q: String, limit: Int = 100): SearchResp =
        getJson(url("api/search", "q" to q, "limit" to limit.toString()))

    fun mkdir(path: String) = postUnit(url("api/fs/mkdir"), PathBody(path))
    fun delete(path: String) = postUnit(url("api/fs/delete"), PathBody(path))
    fun rename(path: String, newName: String) = postUnit(url("api/fs/rename"), RenameBody(path, newName))

    /** Direct URL of a file (use with [clientHeaders], e.g. for the video player). */
    fun fileUrl(path: String, preview: Boolean = false): String =
        url("api/fs/download", "path" to path, "preview" to if (preview) "true" else null).toString()

    /**
     * Downloads [path] into [dest]. Resumes from the length of an existing partial [dest]
     * via `Range: bytes=N-`; 200 restarts the file, 206 appends, 416 with a non-empty file = done.
     */
    fun download(path: String, dest: File, resume: Boolean = true, onProgress: (Long, Long) -> Unit = { _, _ -> }, cancelled: () -> Boolean = { false }) =
        downloadUrl({ builder(url("api/fs/download", "path" to path)) }, dest, resume, onProgress, cancelled)

    fun downloadUrl(make: () -> Request.Builder, dest: File, resume: Boolean, onProgress: (Long, Long) -> Unit, cancelled: () -> Boolean) {
        dest.parentFile?.mkdirs()
        val have = if (resume && dest.exists()) dest.length() else 0L
        val r = exec({ make().apply { if (have > 0) header("Range", "bytes=$have-") } }, ok = { it in 200..299 || it == 416 })
        r.use {
            if (it.code == 416) { if (have > 0) return else throw ApiException(416, "", "range not satisfiable") }
            val append = it.code == 206 && have > 0
            val start = if (append) have else 0L
            val total = (it.body!!.contentLength().takeIf { n -> n >= 0 } ?: -1L).let { n -> if (n < 0) -1L else n + start }
            java.io.FileOutputStream(dest, append).use { out ->
                val buf = ByteArray(64 * 1024)
                var done = start
                it.body!!.byteStream().use { ins ->
                    while (true) {
                        if (cancelled()) throw IOException("cancelled")
                        val n = ins.read(buf); if (n < 0) break
                        out.write(buf, 0, n); done += n; onProgress(done, total)
                    }
                }
            }
        }
    }

    fun fetchBytes(path: String, preview: Boolean = true): ByteArray =
        exec({ builder(url("api/fs/download", "path" to path, "preview" to if (preview) "true" else null)) }).use { it.body!!.bytes() }

    // ------------------------------------------------------------------ resumable upload
    fun createUpload(path: String, size: Long, overwrite: Boolean = true): UploadSession =
        postJson(url("api/fs/uploads"), NewUpload(path, size, overwrite))

    fun uploadState(id: String): UploadSession = getJson(url("api/fs/uploads/$id"))

    /** Appends one chunk at [offset]. Server answers 409 + current state on mismatch. */
    fun putChunk(id: String, offset: Long, data: ByteArray, len: Int): UploadSession {
        val body = data.toRequestBody("application/octet-stream".toMediaType(), 0, len)
        return exec({ builder(url("api/fs/uploads/$id", "offset" to offset.toString())).put(body) })
            .use { json.decodeFromString(it.body!!.string()) }
    }

    fun completeUpload(id: String): FsItem =
        exec({ builder(url("api/fs/uploads/$id/complete")).post(ByteArray(0).toRequestBody(null)) })
            .use { json.decodeFromString(it.body!!.string()) }

    fun cancelUpload(id: String) { runCatching { exec({ builder(url("api/fs/uploads/$id")).delete() }).close() } }

    /**
     * Uploads [input] (total [size] bytes) with a resumable session. [sessionId] may be a session
     * from an earlier attempt: we ask the server for its offset and continue there.
     * [skipTo] seeks the input to the server offset.
     */
    fun uploadResumable(
        path: String, size: Long, sessionId: String?, openAt: (Long) -> InputStream,
        onSession: (String) -> Unit, onProgress: (Long, Long) -> Unit, cancelled: () -> Boolean = { false },
    ): FsItem {
        var s: UploadSession? = sessionId?.let {
            try { uploadState(it) } catch (e: ApiException) { if (e.status == 404) null else throw e }
        }
        if (s == null) s = createUpload(path, size)
        onSession(s.id)
        val chunk = s.chunkSize.coerceIn(64 * 1024, 8 * 1024 * 1024).toInt()
        var off = s.offset
        if (size > 0 && off < size || size == 0L) {
            openAt(off).use { ins ->
                val buf = ByteArray(chunk)
                while (off < size) {
                    if (cancelled()) throw IOException("cancelled")
                    var n = 0
                    while (n < buf.size && off + n < size) { val r = ins.read(buf, n, minOf(buf.size - n, (size - off - n).toInt())); if (r < 0) break; n += r }
                    if (n == 0) throw IOException("input ended early at $off of $size")
                    off = try { putChunk(s.id, off, buf, n).offset } catch (e: ApiException) {
                        if (e.status == 409) throw IOException("offset mismatch, retry to resume", e) else throw e
                    }
                    onProgress(off, size)
                }
            }
        }
        return completeUpload(s.id)
    }

    // ------------------------------------------------------------------ shares
    fun shares(): List<Share> = getJson(url("api/shares"))
    fun createShare(b: NewShare): Share = postJson(url("api/shares"), b)
    fun revokeShare(id: Long) { exec({ builder(url("api/shares/$id/revoke")).post("{}".toRequestBody(jsonMt)) }).close() }
    fun deleteShare(id: Long) { exec({ builder(url("api/shares/$id")).delete() }).close() }

    /** Pickup-code claim (anonymous ok). `code` may be `abc`, `abc-PIN`, or a full share URL. */
    fun claim(code: String, pin: String? = null): ShareOpen =
        postJson(url("api/s/claim"), ClaimBody(code.trim(), pin?.ifBlank { null }), auth = true)

    fun shareList(code: String, token: String, path: String = "/"): ShareList =
        getJson(url("api/s/$code/list", "path" to path, "t" to token))

    fun shareDownload(code: String, token: String, path: String, dest: File, onProgress: (Long, Long) -> Unit = { _, _ -> }, resume: Boolean = true, cancelled: () -> Boolean = { false }) =
        downloadUrl({ builder(url("api/s/$code/download", "path" to path, "t" to token)) }, dest, resume, onProgress, cancelled)


    // ------------------------------------------------------------------ in-app Android update
    fun androidLatest(): ClientPackage = getJson(url("api/client/android/latest"))

    /** Resolves a package URL that may be absolute or relative to this server. */
    fun resolvePackageUrl(pkg: ClientPackage): HttpUrl {
        val u = pkg.url
        return when {
            u.startsWith("http://") || u.startsWith("https://") -> u.toHttpUrl()
            u.startsWith("/") -> base.newBuilder().encodedPath(u).query(null).build()
            else -> url(u)
        }
    }

    /**
     * Downloads [pkg] to [dest] and verifies SHA-256 (and size when declared).
     * A digest or size mismatch deletes [dest] and throws.
     */
    fun downloadAndroid(pkg: ClientPackage, dest: File, onProgress: (Long, Long) -> Unit = { _, _ -> }, cancelled: () -> Boolean = { false }) {
        if (dest.exists()) dest.delete()
        downloadUrl({ builder(resolvePackageUrl(pkg)) }, dest, resume = false, onProgress, cancelled)
        if (pkg.size > 0 && dest.length() != pkg.size) {
            val got = dest.length()
            dest.delete()
            throw IOException("APK size mismatch (expected ${pkg.size}, got $got)")
        }
        if (pkg.sha256.isNotBlank()) AppUpdate.verifySha256(dest, pkg.sha256)
    }

    companion object {
        fun defaultHttp(): OkHttpClient = OkHttpClient.Builder()
            .connectTimeout(15, TimeUnit.SECONDS)
            .readTimeout(60, TimeUnit.SECONDS)
            .writeTimeout(60, TimeUnit.SECONDS)
            .build()

        /** Accepts `host:port`, `http://host`, trailing slashes; defaults to https when no scheme. */
        fun normalizeBase(raw: String): String {
            var s = raw.trim().trimEnd('/')
            if (!s.startsWith("http://") && !s.startsWith("https://")) s = "https://$s"
            return "$s/"
        }
    }
}
