package com.drivehub.app.core

import java.io.File
import java.io.IOException
import java.security.MessageDigest

/** A downloaded APK's SHA-256 did not match the server-declared digest; the file is deleted. */
class Sha256MismatchException(val expected: String, val actual: String) :
    IOException("APK SHA-256 mismatch (expected $expected, got $actual)")

/** Pure helpers for in-app APK updates: version comparison and digest verification. */
object AppUpdate {
    /**
     * Whether [remoteVersion]/[remoteCode] is a newer package than the installed app.
     * `versionCode` wins when both sides have one; otherwise semver of `version` is used.
     */
    fun isNewer(remoteVersion: String?, remoteCode: Long?, localVersion: String, localCode: Int): Boolean {
        if (remoteCode != null) {
            when {
                remoteCode > localCode.toLong() -> return true
                remoteCode < localCode.toLong() -> return false
            }
        }
        val rv = SemVer.parse(remoteVersion ?: return false) ?: return false
        val lv = SemVer.parse(localVersion) ?: return false
        return rv > lv
    }

    fun sha256Hex(file: File): String {
        val md = MessageDigest.getInstance("SHA-256")
        file.inputStream().use { inp ->
            val buf = ByteArray(64 * 1024)
            while (true) {
                val n = inp.read(buf)
                if (n <= 0) break
                md.update(buf, 0, n)
            }
        }
        return md.digest().joinToString("") { b -> "%02x".format(b) }
    }

    fun verifySha256(file: File, expected: String) {
        val got = sha256Hex(file)
        if (!got.equals(expected.trim(), ignoreCase = true)) {
            file.delete()
            throw Sha256MismatchException(expected.trim(), got)
        }
    }
}
