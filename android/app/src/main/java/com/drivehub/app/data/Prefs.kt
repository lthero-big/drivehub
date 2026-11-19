package com.drivehub.app.data

import android.content.Context
import com.drivehub.app.BuildConfig
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.encodeToString
import java.io.File
import java.security.MessageDigest

/** Server address + tokens (SharedPreferences, app-private). */
class Prefs(ctx: Context) : TokenStore {
    private val sp = ctx.applicationContext.getSharedPreferences("drivehub", Context.MODE_PRIVATE)
    var serverUrl: String?
        get() = sp.getString("server", null)
        set(v) { sp.edit().putString("server", v).apply() }
    override var accessToken: String?
        get() = sp.getString("access", null)
        set(v) { sp.edit().putString("access", v).apply() }
    override var refreshToken: String?
        get() = sp.getString("refresh", null)
        set(v) { sp.edit().putString("refresh", v).apply() }
    var username: String?
        get() = sp.getString("user", null)
        set(v) { sp.edit().putString("user", v).apply() }

    fun uploadSession(key: String): String? = sp.getString("up:$key", null)
    fun setUploadSession(key: String, id: String?) { sp.edit().apply { if (id == null) remove("up:$key") else putString("up:$key", id) }.apply() }

    fun client(): ApiClient? = serverUrl?.let { ApiClient(it, BuildConfig.VERSION_NAME, BuildConfig.API_VERSION, this) }
}

fun sha1(s: String): String =
    MessageDigest.getInstance("SHA-1").digest(s.toByteArray()).joinToString("") { "%02x".format(it) }.take(16)

/**
 * Offline cache: directory listings (JSON, per server+path) so browsing works without network,
 * plus the downloaded-files folder (app-specific external storage, no permission needed).
 */
class OfflineCache(private val ctx: Context, private val server: String) {
    private val dir = File(ctx.filesDir, "listings").apply { mkdirs() }
    private fun f(path: String) = File(dir, sha1("$server|$path") + ".json")

    fun saveList(path: String, r: ListResp) { runCatching { f(path).writeText(AppJson.encodeToString(r)) } }
    fun loadList(path: String): ListResp? = runCatching { AppJson.decodeFromString<ListResp>(f(path).readText()) }.getOrNull()
    fun cachedAt(path: String): Long? = f(path).takeIf { it.exists() }?.lastModified()

    companion object {
        fun downloads(ctx: Context): File =
            (ctx.getExternalFilesDir("Download") ?: File(ctx.filesDir, "Download")).apply { mkdirs() }
        fun previews(ctx: Context): File = File(ctx.cacheDir, "preview").apply { mkdirs() }
    }
}
