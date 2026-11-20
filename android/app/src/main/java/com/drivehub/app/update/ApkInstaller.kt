package com.drivehub.app.update

import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageInstaller
import android.net.Uri
import android.os.Build
import android.provider.Settings
import kotlinx.coroutines.flow.MutableSharedFlow
import java.io.File

/**
 * Installs a verified APK through [PackageInstaller]. The system confirmation prompt is
 * always shown (never silent). A successful in-place upgrade requires the new APK to be
 * signed with the same certificate as the installed app; a mismatch is reported as a
 * conflict / failure, it is not bypassed.
 */
object ApkInstaller {
    const val ACTION_RESULT = "com.drivehub.app.INSTALL_RESULT"

    data class Result(val status: Int, val message: String?) {
        val pendingUserAction get() = status == PackageInstaller.STATUS_PENDING_USER_ACTION
        val success get() = status == PackageInstaller.STATUS_SUCCESS
        val signatureMismatch get() =
            status == PackageInstaller.STATUS_FAILURE_CONFLICT ||
                (message?.contains("signature", ignoreCase = true) == true)
        val userFacing: String get() = when {
            success -> "安装完成 / Install finished"
            signatureMismatch ->
                "安装失败：新包与已安装应用的签名证书不一致，无法覆盖安装。正式覆盖安装必须使用同一份发布证书。\n" +
                    "Install failed: the APK is not signed with the same certificate as the installed app."
            status == PackageInstaller.STATUS_FAILURE_ABORTED -> "安装已取消 / Install cancelled"
            status == PackageInstaller.STATUS_FAILURE_STORAGE -> "存储空间不足 / Not enough storage"
            else -> "安装失败 / Install failed${message?.let { ": $it" } ?: ""} (status $status)"
        }
    }

    val results = MutableSharedFlow<Result>(extraBufferCapacity = 8)

    fun canInstall(ctx: Context): Boolean =
        ctx.packageManager.canRequestPackageInstalls()

    fun permissionSettingsIntent(ctx: Context): Intent =
        Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:${ctx.packageName}"))

    fun install(ctx: Context, apk: File) {
        val installer = ctx.packageManager.packageInstaller
        val params = PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL)
        if (Build.VERSION.SDK_INT >= 31) {
            params.setRequireUserAction(PackageInstaller.SessionParams.USER_ACTION_REQUIRED)
        }
        val sessionId = installer.createSession(params)
        installer.openSession(sessionId).use { session ->
            session.openWrite("app.apk", 0, apk.length()).use { out ->
                apk.inputStream().use { it.copyTo(out) }
                session.fsync(out)
            }
            val flags = PendingIntent.FLAG_UPDATE_CURRENT or
                (if (Build.VERSION.SDK_INT >= 31) PendingIntent.FLAG_MUTABLE else 0)
            val pi = PendingIntent.getBroadcast(
                ctx,
                sessionId,
                Intent(ctx, InstallResultReceiver::class.java).apply {
                    action = ACTION_RESULT
                    setPackage(ctx.packageName)
                },
                flags,
            )
            session.commit(pi.intentSender)
        }
    }
}

class InstallResultReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val status = intent.getIntExtra(
            PackageInstaller.EXTRA_STATUS,
            PackageInstaller.STATUS_FAILURE,
        )
        if (status == PackageInstaller.STATUS_PENDING_USER_ACTION) {
            val confirm = if (Build.VERSION.SDK_INT >= 33) {
                intent.getParcelableExtra(Intent.EXTRA_INTENT, Intent::class.java)
            } else {
                @Suppress("DEPRECATION")
                intent.getParcelableExtra(Intent.EXTRA_INTENT)
            }
            confirm?.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            if (confirm != null) context.startActivity(confirm)
            return
        }
        val msg = intent.getStringExtra(PackageInstaller.EXTRA_STATUS_MESSAGE)
        ApkInstaller.results.tryEmit(ApkInstaller.Result(status, msg))
    }
}
