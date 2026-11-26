package com.drivehub.app.ui

import android.app.Application
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import com.drivehub.app.BuildConfig
import com.drivehub.app.core.Compat
import com.drivehub.app.core.VersionNegotiator
import com.drivehub.app.core.AppUpdate
import com.drivehub.app.core.Sha256MismatchException
import com.drivehub.app.data.*
import com.drivehub.app.ui.theme.ThemeMode
import com.drivehub.app.update.ApkInstaller
import com.drivehub.app.work.Transfers
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
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

data class AppUpdateState(
    val pkg: ClientPackage? = null,
    val checking: Boolean = false,
    val downloading: Boolean = false,
    val installing: Boolean = false,
    val received: Long = 0,
    val total: Long = 0,
    val error: String? = null,
    val needsPermission: Boolean = false,
    val ready: File? = null,
    val forced: Boolean = false,
    val none: Boolean = false,
)

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
    val appUpdate = MutableStateFlow(AppUpdateState())
    val themeMode = MutableStateFlow(ThemeMode.fromKey(prefs.theme))
    val thumbnails = MutableStateFlow(prefs.thumbnails)
    /** Mount points seen at "/" (name -> kind), used for brand chips inside a mount. */
    val mounts = MutableStateFlow<Map<String, String>>(emptyMap())
    private var api: ApiClient? = null
    private var cache: OfflineCache? = null

    /** Coil-backed thumbnail source; reads the current server/token on every request. */
    val thumbs: com.drivehub.app.ui.components.ThumbSource by lazy {
        com.drivehub.app.ui.components.thumbSource(
            getApplication(), enabled = { thumbnails.value }, server = { api?.base?.toString() },
            url = { p -> api?.fileUrl(p, preview = true) }, headers = { api?.clientHeaders() ?: emptyMap() },
        )
    }

    fun setTheme(m: ThemeMode) { prefs.theme = m.key; themeMode.value = m }
    fun setThumbnails(on: Boolean) { prefs.thumbnails = on; thumbnails.value = on }
    /** Kind of the mount that contains [path] (first path segment), if known. */
    fun mountKindOf(path: String): String? = mounts.value[path.trim('/').substringBefore('/')]
    private fun rememberMounts(items: List<FsItem>) {
        val m = items.mapNotNull { i -> i.mountKind?.let { i.name to it } }.toMap()
        if (m.isNotEmpty()) mounts.value = m
    }

    companion object {
        const val CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000L
    }

    init {
        boot()
        viewModelScope.launch {
            ApkInstaller.results.collect { r ->
                appUpdate.value = appUpdate.value.copy(installing = false, error = if (r.success) null else r.userFacing)
                if (r.success) message.value = r.userFacing
            }
        }
        // Acceptance: check the server package list on a timer, not only at connect.
        viewModelScope.launch {
            while (true) {
                delay(CHECK_INTERVAL_MS)
                maybeRefreshAppUpdate()
            }
        }
    }

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
                    var blocked = false
                    if (prefs.accessToken != null || prefs.refreshToken != null) {
                        val ok = withContext(Dispatchers.IO) { runCatching { c.me() } }
                        when {
                            ok.isSuccess -> { stage.value = Stage.Main; loadFiles("/") }
                            ok.exceptionOrNull() is ApiException && (ok.exceptionOrNull() as ApiException).status == 401 -> goLogin(c)
                            ok.exceptionOrNull() is UpgradeRequiredException -> {
                                val compat = (ok.exceptionOrNull() as UpgradeRequiredException).compat
                                stage.value = Stage.Blocked(compat)
                                blocked = true
                                if (compat is Compat.ClientTooOld) refreshAppUpdate(forced = true)
                            }
                            else -> { stage.value = Stage.Main; loadFiles("/") } // offline: cached listings
                        }
                    } else goLogin(c)
                    if (!blocked) refreshAppUpdate(forced = false)
                }
                is Compat.Unreachable ->
                    if (silent && prefs.accessToken != null) { stage.value = Stage.Main; loadFiles("/") }
                    else stage.value = Stage.Setup(VersionNegotiator.message(r))
                else -> {
                    stage.value = Stage.Blocked(r)
                    if (r is Compat.ClientTooOld) refreshAppUpdate(forced = true)
                }
            }
        }
    }

    /** Query /api/client/android/latest and, unless this is a forced upgrade, hide older/equal packages. */
    fun refreshAppUpdate(forced: Boolean = appUpdate.value.forced) {
        val c = api ?: return
        appUpdate.value = AppUpdateState(checking = true, forced = forced)
        viewModelScope.launch {
            val r = withContext(Dispatchers.IO) { runCatching { c.androidLatest() } }
            r.onSuccess { pkg ->
                val newer = AppUpdate.isNewer(pkg.version, pkg.versionCode, BuildConfig.VERSION_NAME, BuildConfig.VERSION_CODE)
                appUpdate.value = if (!forced && !newer) AppUpdateState(none = true)
                else AppUpdateState(pkg = pkg, forced = forced)
            }.onFailure { e ->
                val notFound = (e as? ApiException)?.status == 404
                appUpdate.value = AppUpdateState(
                    forced = forced,
                    none = notFound,
                    error = if (notFound && forced)
                        "服务器尚未提供可下载的安装包，请向管理员索取 APK。\nNo APK is hosted on this server."
                    else if (notFound) null else errText(e),
                )
            }
        }
    }

    fun startAppUpdate() {
        val ctx = getApplication<Application>()
        val cur = appUpdate.value
        val pkg = cur.pkg ?: return
        if (!ApkInstaller.canInstall(ctx)) {
            appUpdate.value = cur.copy(
                needsPermission = true,
                error = "需要先允许本应用安装未知来源应用。系统仍会再弹出一次安装确认，应用不会跳过该确认。\nAllow DriveHub to install unknown apps; the system will still ask you to confirm the install.",
            )
            return
        }
        val ready = cur.ready
        if (ready != null && ready.exists()) { beginInstall(ready); return }
        appUpdate.value = cur.copy(downloading = true, needsPermission = false, error = null, received = 0, total = pkg.size)
        viewModelScope.launch {
            val dest = File(ctx.cacheDir, "updates/drivehub-${pkg.version ?: "update"}.apk")
            dest.parentFile?.mkdirs()
            val r = withContext(Dispatchers.IO) {
                runCatching {
                    api!!.downloadAndroid(pkg, dest, onProgress = { a, b ->
                        appUpdate.value = appUpdate.value.copy(received = a, total = if (b > 0) b else pkg.size)
                    })
                }
            }
            r.onSuccess {
                appUpdate.value = appUpdate.value.copy(downloading = false, ready = dest)
                beginInstall(dest)
            }.onFailure { e ->
                appUpdate.value = appUpdate.value.copy(
                    downloading = false,
                    error = if (e is Sha256MismatchException)
                        "安装包校验失败（SHA-256 不匹配），已删除损坏文件。\nAPK checksum mismatch; the file was deleted."
                    else errText(e),
                )
            }
        }
    }

    private fun beginInstall(apk: File) {
        val ctx = getApplication<Application>()
        if (!ApkInstaller.canInstall(ctx)) {
            appUpdate.value = appUpdate.value.copy(needsPermission = true)
            return
        }
        appUpdate.value = appUpdate.value.copy(installing = true, needsPermission = false, error = null)
        runCatching { ApkInstaller.install(ctx, apk) }
            .onFailure { appUpdate.value = appUpdate.value.copy(installing = false, error = it.message) }
    }

    fun onForeground() {
        val cur = appUpdate.value
        if (cur.needsPermission && cur.pkg != null && ApkInstaller.canInstall(getApplication())) {
            startAppUpdate()
            return
        }
        maybeRefreshAppUpdate()
    }

    private fun maybeRefreshAppUpdate() {
        if (api == null) return
        val cur = appUpdate.value
        if (cur.downloading || cur.installing || cur.checking) return
        refreshAppUpdate()
    }

    fun installPermissionIntent() = ApkInstaller.permissionSettingsIntent(getApplication())

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
                if (path == "/") rememberMounts(it.items)
                files.value = files.value.copy(items = it.items.sortedWith(compareByDescending<FsItem> { i -> i.isDir }.thenBy { i -> i.name.lowercase() }), loading = false, offline = false)
            }.onFailure { e ->
                if (e is ApiException && e.status == 401) { goLogin(c); return@onFailure }
                if (e is UpgradeRequiredException) { stage.value = Stage.Blocked(e.compat); return@onFailure }
                val cached = cache?.loadList(path)
                if (path == "/" && cached != null) rememberMounts(cached.items)
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
