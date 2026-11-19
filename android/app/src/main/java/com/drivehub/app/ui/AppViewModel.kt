package com.drivehub.app.ui

import android.app.Application
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import com.drivehub.app.BuildConfig
import com.drivehub.app.core.Compat
import com.drivehub.app.core.VersionNegotiator
import com.drivehub.app.data.*
import com.drivehub.app.work.Transfers
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.File

sealed interface Stage {
    data object Boot : Stage
    data class Setup(val error: String? = null, val busy: Boolean = false) : Stage
    /** Version negotiation failed: the user can only change the server or retry. */
    data class Blocked(val compat: Compat) : Stage
    data class Login(val providers: List<String>, val totpPending: Boolean = false, val ticket: String? = null,
                     val error: String? = null, val busy: Boolean = false) : Stage
    data object Main : Stage
}

data class FilesState(
    val path: String = "/", val items: List<FsItem> = emptyList(), val loading: Boolean = false,
    val error: String? = null, val offline: Boolean = false,
    val query: String = "", val hits: List<SearchHit>? = null,
)

data class PickupState(val busy: Boolean = false, val error: String? = null, val needPin: Boolean = false,
                       val open: ShareOpen? = null, val path: String = "/", val items: List<SharedItem> = emptyList())

class AppViewModel(app: Application) : AndroidViewModel(app) {
    val prefs = Prefs(app)
    val stage = MutableStateFlow<Stage>(Stage.Boot)
    val files = MutableStateFlow(FilesState())
    val shares = MutableStateFlow<List<Share>>(emptyList())
    val sharesError = MutableStateFlow<String?>(null)
    val pickup = MutableStateFlow(PickupState())
    val message = MutableStateFlow<String?>(null)
    val createdShare = MutableStateFlow<Share?>(null)
    val serverInfo = MutableStateFlow<VersionInfo?>(null)
    private var api: ApiClient? = null
    private var cache: OfflineCache? = null

    init { boot() }

    private fun mk(url: String) = ApiClient(url, BuildConfig.VERSION_NAME, BuildConfig.API_VERSION, prefs).also { api = it; cache = OfflineCache(getApplication(), it.base.toString()) }

    fun boot() {
        val url = prefs.serverUrl
        if (url == null) { stage.value = Stage.Setup(); return }
        connect(url, silent = true)
    }

    /** Version negotiation first; only compatible servers reach the login screen. */
    fun connect(rawUrl: String, silent: Boolean = false) {
        val c = try { mk(rawUrl) } catch (e: IllegalArgumentException) { stage.value = Stage.Setup("地址无效 / Invalid address: $rawUrl"); return }
        if (!silent) stage.value = Stage.Setup(busy = true)
        viewModelScope.launch {
            val r = withContext(Dispatchers.IO) { c.negotiate() }
            when (r) {
                is Compat.Ok -> {
                    serverInfo.value = r.info
                    prefs.serverUrl = c.base.toString().trimEnd('/')
                    if (prefs.accessToken != null || prefs.refreshToken != null) {
                        val ok = withContext(Dispatchers.IO) { runCatching { c.me() } }
                        when {
                            ok.isSuccess -> { stage.value = Stage.Main; loadFiles("/") }
                            ok.exceptionOrNull() is ApiException && (ok.exceptionOrNull() as ApiException).status == 401 -> goLogin(c)
                            ok.exceptionOrNull() is UpgradeRequiredException -> stage.value = Stage.Blocked((ok.exceptionOrNull() as UpgradeRequiredException).compat)
                            else -> { stage.value = Stage.Main; loadFiles("/") } // offline: cached listings
                        }
                    } else goLogin(c)
                }
                is Compat.Unreachable ->
                    if (silent && prefs.accessToken != null) { stage.value = Stage.Main; loadFiles("/") }
                    else stage.value = Stage.Setup(VersionNegotiator.message(r))
                else -> stage.value = Stage.Blocked(r)
            }
        }
    }

    private suspend fun goLogin(c: ApiClient) {
        val providers = withContext(Dispatchers.IO) { runCatching { c.authStatus().oauthProviders }.getOrDefault(emptyList()) }
        stage.value = Stage.Login(providers)
    }

    fun changeServer() { stage.value = Stage.Setup() }

    // ------------------------------------------------------------------ auth
    fun login(user: String, pw: String, totp: String?) {
        val c = api ?: return
        val cur = stage.value as? Stage.Login ?: return
        stage.value = cur.copy(busy = true, error = null)
        viewModelScope.launch {
            val r = withContext(Dispatchers.IO) { runCatching { c.login(user, pw, totp) } }
            r.onSuccess {
                when (it) {
                    is LoginResult.Success -> { prefs.username = user; stage.value = Stage.Main; loadFiles("/") }
                    LoginResult.TotpRequired -> stage.value = cur.copy(totpPending = true, busy = false, error = null)
                }
            }.onFailure { stage.value = cur.copy(busy = false, error = errText(it)) }
        }
    }

    fun totpTicket(code: String) {
        val c = api ?: return
        val cur = stage.value as? Stage.Login ?: return
        val t = cur.ticket ?: return
        stage.value = cur.copy(busy = true)
        viewModelScope.launch {
            runCatching { withContext(Dispatchers.IO) { c.loginTotp(t, code) } }
                .onSuccess { stage.value = Stage.Main; loadFiles("/") }
                .onFailure { stage.value = cur.copy(busy = false, error = errText(it)) }
        }
    }

    /** Result of the OAuth WebView: tokens, a 2FA ticket, or an error. */
    fun oauthResult(params: Map<String, String>) {
        val cur = stage.value as? Stage.Login ?: return
        val c = api ?: return
        when {
            params["access_token"] != null -> {
                c.tokens.accessToken = params["access_token"]; c.tokens.refreshToken = params["refresh_token"]
                stage.value = Stage.Main; loadFiles("/")
            }
            params["totp_ticket"] != null -> stage.value = cur.copy(totpPending = true, ticket = params["totp_ticket"], error = null)
            else -> stage.value = cur.copy(error = params["error"] ?: "OAuth failed")
        }
    }

    fun logout() {
        val c = api
        viewModelScope.launch {
            withContext(Dispatchers.IO) { c?.logout() }
            prefs.accessToken = null; prefs.refreshToken = null
            files.value = FilesState(); shares.value = emptyList()
            if (c != null) goLogin(c) else stage.value = Stage.Setup()
        }
    }

    // ------------------------------------------------------------------ files
    fun loadFiles(path: String) {
        val c = api ?: return
        files.value = files.value.copy(path = path, loading = true, error = null, hits = null, query = "")
        viewModelScope.launch {
            val r = withContext(Dispatchers.IO) { runCatching { c.list(path) } }
            r.onSuccess {
                cache?.saveList(path, it)
                files.value = files.value.copy(items = it.items.sortedWith(compareByDescending<FsItem> { i -> i.isDir }.thenBy { i -> i.name.lowercase() }), loading = false, offline = false)
            }.onFailure { e ->
                if (e is ApiException && e.status == 401) { goLogin(c); return@onFailure }
                if (e is UpgradeRequiredException) { stage.value = Stage.Blocked(e.compat); return@onFailure }
                val cached = cache?.loadList(path)
                files.value = if (cached != null && e !is ApiException)
                    files.value.copy(items = cached.items, loading = false, offline = true, error = null)
                else files.value.copy(items = emptyList(), loading = false, error = errText(e))
            }
        }
    }

    fun up() { val p = files.value.path; if (p != "/") loadFiles(p.trimEnd('/').substringBeforeLast('/').ifEmpty { "/" }) }
    fun refresh() = loadFiles(files.value.path)

    fun search(q: String) {
        val c = api ?: return
        if (q.isBlank()) { files.value = files.value.copy(hits = null, query = ""); return }
        files.value = files.value.copy(query = q, loading = true, error = null)
        viewModelScope.launch {
            runCatching { withContext(Dispatchers.IO) { c.search(q) } }
                .onSuccess { files.value = files.value.copy(hits = it.hits, loading = false, error = if (!it.enabled) it.message else null) }
                .onFailure { files.value = files.value.copy(loading = false, error = errText(it)) }
        }
    }

    private fun act(ok: String? = null, block: suspend (ApiClient) -> Unit) {
        val c = api ?: return
        viewModelScope.launch {
            runCatching { withContext(Dispatchers.IO) { block(c) } }
                .onSuccess { ok?.let { m -> message.value = m }; refresh() }
                .onFailure { message.value = errText(it) }
        }
    }

    fun childPath(name: String) = files.value.path.trimEnd('/') + "/" + name
    fun mkdir(name: String) = act { it.mkdir(childPath(name)) }
    fun delete(item: FsItem) = act("已删除 ${item.name}") { it.delete(item.path) }
    fun rename(item: FsItem, newName: String) = act { it.rename(item.path, newName) }
    fun download(item: FsItem) { Transfers.download(getApplication(), item.path, item.name); message.value = "已加入下载队列：${item.name}" }
    fun upload(uri: android.net.Uri, name: String) { Transfers.upload(getApplication(), uri, childPath(name)); message.value = "已加入上传队列：$name" }

    // ------------------------------------------------------------------ preview
    fun client(): ApiClient? = api
    suspend fun previewBitmap(path: String): Bitmap? = withContext(Dispatchers.IO) {
        val c = api ?: return@withContext null
        val f = File(OfflineCache.previews(getApplication()), sha1(path))
        if (!f.exists()) { val tmp = File(f.path + ".tmp"); c.download(path, tmp, resume = false); tmp.renameTo(f) }
        val o = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        BitmapFactory.decodeFile(f.path, o)
        var s = 1; while (o.outWidth / s > 2400 || o.outHeight / s > 2400) s *= 2
        BitmapFactory.decodeFile(f.path, BitmapFactory.Options().apply { inSampleSize = s })
    }

    suspend fun previewFile(path: String): File = withContext(Dispatchers.IO) {
        val c = api!!
        val f = File(OfflineCache.previews(getApplication()), sha1(path) + "." + path.substringAfterLast('.', "bin"))
        if (!f.exists()) { val tmp = File(f.path + ".tmp"); c.download(path, tmp, resume = false); tmp.renameTo(f) }
        f
    }

    // ------------------------------------------------------------------ shares
    fun loadShares() {
        val c = api ?: return
        viewModelScope.launch {
            runCatching { withContext(Dispatchers.IO) { c.shares() } }
                .onSuccess { shares.value = it; sharesError.value = null }
                .onFailure { sharesError.value = errText(it) }
        }
    }

    fun createShare(item: FsItem, perm: String, days: Long?, pin: Boolean) {
        val c = api ?: return
        viewModelScope.launch {
            runCatching { withContext(Dispatchers.IO) { c.createShare(NewShare(listOf(item.path), perm = perm, days = days, randomPin = pin)) } }
                .onSuccess { createdShare.value = it; loadShares() }
                .onFailure { message.value = errText(it) }
        }
    }

    fun revoke(s: Share) = shareAct { it.revokeShare(s.id) }
    fun deleteShare(s: Share) = shareAct { it.deleteShare(s.id) }
    private fun shareAct(block: (ApiClient) -> Unit) {
        val c = api ?: return
        viewModelScope.launch {
            runCatching { withContext(Dispatchers.IO) { block(c) } }.onFailure { message.value = errText(it) }
            loadShares()
        }
    }

    // ------------------------------------------------------------------ pickup
    fun claim(code: String, pin: String) {
        val c = api ?: return
        pickup.value = pickup.value.copy(busy = true, error = null, needPin = false)
        viewModelScope.launch {
            runCatching { withContext(Dispatchers.IO) { c.claim(code, pin) } }
                .onSuccess { pickup.value = PickupState(open = it, items = it.items) }
                .onFailure { e ->
                    pickup.value = PickupState(error = errText(e), needPin = (e as? ApiException)?.needPin == true)
                }
        }
    }

    fun pickupBrowse(item: SharedItem?) {
        val c = api ?: return
        val o = pickup.value.open ?: return
        if (item == null) { pickup.value = pickup.value.copy(path = "/", items = o.items); return }
        viewModelScope.launch {
            runCatching { withContext(Dispatchers.IO) { c.shareList(o.code, o.token, item.path) } }
                .onSuccess { pickup.value = pickup.value.copy(path = item.path, items = it.items.map { x -> x.copy(path = item.path.trimEnd('/') + "/" + x.name) }) }
                .onFailure { message.value = errText(it) }
        }
    }

    fun pickupDownload(item: SharedItem) {
        val o = pickup.value.open ?: return
        Transfers.download(getApplication(), item.path, item.name, kind = "share", code = o.code, token = o.token)
        message.value = "已加入下载队列：${item.name}"
    }

    fun pickupClose() { pickup.value = PickupState() }

    fun errText(e: Throwable): String = when (e) {
        is UpgradeRequiredException -> VersionNegotiator.message(e.compat)
        is ApiException -> when (e.status) {
            401 -> "未登录或凭据错误 / Unauthorized: ${e.message}"
            403 -> "没有权限 / Forbidden: ${e.message}"
            404 -> "未找到 / Not found: ${e.message}"
            410 -> "已过期或失效 / Expired: ${e.message}"
            429 -> "操作过于频繁，请稍后再试 / Rate limited"
            else -> "${e.status}: ${e.message}"
        }
        else -> "${e.javaClass.simpleName}: ${e.message}"
    }
}
