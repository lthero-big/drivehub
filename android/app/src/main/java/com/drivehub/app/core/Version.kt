package com.drivehub.app.core

import com.drivehub.app.data.VersionInfo

/** Minimal semver (X.Y.Z[-pre]) with precedence per semver.org (pre-release < release). */
data class SemVer(val major: Int, val minor: Int, val patch: Int, val pre: String? = null) : Comparable<SemVer> {
    override fun compareTo(other: SemVer): Int {
        val c = compareValuesBy(this, other, { it.major }, { it.minor }, { it.patch })
        if (c != 0) return c
        if (pre == other.pre) return 0
        if (pre == null) return 1
        if (other.pre == null) return -1
        val a = pre.split('.')
        val b = other.pre.split('.')
        for (i in 0 until maxOf(a.size, b.size)) {
            val x = a.getOrNull(i) ?: return -1
            val y = b.getOrNull(i) ?: return 1
            val xn = x.toIntOrNull()
            val yn = y.toIntOrNull()
            val r = when {
                xn != null && yn != null -> xn.compareTo(yn)
                xn != null -> -1
                yn != null -> 1
                else -> x.compareTo(y)
            }
            if (r != 0) return r
        }
        return 0
    }

    override fun toString() = "$major.$minor.$patch" + (pre?.let { "-$it" } ?: "")

    companion object {
        private val RE = Regex("""^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$""")
        fun parse(s: String): SemVer? = RE.matchEntire(s.trim())?.let {
            SemVer(it.groupValues[1].toInt(), it.groupValues[2].toInt(), it.groupValues[3].toInt(),
                it.groupValues[4].ifEmpty { null })
        }
    }
}

/** Outcome of the startup version negotiation against a server. */
sealed interface Compat {
    data class Ok(val info: VersionInfo) : Compat
    /** App is older than the server's `min_app_version`: user must upgrade the app. */
    data class ClientTooOld(val appVersion: String, val minVersion: String, val serverVersion: String?) : Compat
    /** App speaks a newer API major than the server: the server must be upgraded. */
    data class ServerTooOld(val serverApi: Int, val appApi: Int, val serverVersion: String?) : Compat
    /** Server answered but is not a (compatible) DriveHub. */
    data class NotDriveHub(val reason: String) : Compat
    data class Unreachable(val reason: String) : Compat
}

object VersionNegotiator {
    /** Pure rule, mirrors the server's `negotiate` (server/crates/core/src/version.rs). */
    fun evaluate(info: VersionInfo, appVersion: String, appApi: Int): Compat {
        val app = SemVer.parse(appVersion)
            ?: return Compat.NotDriveHub("app version '$appVersion' is not semver")
        if (appApi > info.apiVersion) return Compat.ServerTooOld(info.apiVersion, appApi, info.serverVersion)
        val min = SemVer.parse(info.minAppVersion)
            ?: return Compat.NotDriveHub("server min_app_version '${info.minAppVersion}' is not semver")
        if (app < min) return Compat.ClientTooOld(appVersion, info.minAppVersion, info.serverVersion)
        return Compat.Ok(info)
    }

    /** Human readable (Chinese + English) explanation shown on the blocking screen. */
    fun message(c: Compat): String = when (c) {
        is Compat.Ok -> "服务器版本 ${c.info.serverVersion} / Server ${c.info.serverVersion}"
        is Compat.ClientTooOld ->
            "App 版本 ${c.appVersion} 低于服务器要求的最低版本 ${c.minVersion}，请升级 App。\n" +
                "This app (${c.appVersion}) is older than the minimum ${c.minVersion} required by the server. Please update the app."
        is Compat.ServerTooOld ->
            "服务器 API v${c.serverApi} 低于 App 需要的 API v${c.appApi}，请联系管理员升级服务器。\n" +
                "The server API (v${c.serverApi}) is older than this app needs (v${c.appApi}). Ask the admin to upgrade the server."
        is Compat.NotDriveHub -> "该地址不是兼容的 DriveHub 服务器：${c.reason}\nNot a compatible DriveHub server: ${c.reason}"
        is Compat.Unreachable -> "无法连接服务器：${c.reason}\nCannot reach the server: ${c.reason}"
    }
}
