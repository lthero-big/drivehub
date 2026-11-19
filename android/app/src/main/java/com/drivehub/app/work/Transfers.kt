package com.drivehub.app.work

import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Context
import android.content.pm.ServiceInfo
import android.net.Uri
import android.os.Build
import android.provider.OpenableColumns
import androidx.core.app.NotificationCompat
import androidx.work.*
import com.drivehub.app.data.ApiException
import com.drivehub.app.data.OfflineCache
import com.drivehub.app.data.Prefs
import com.drivehub.app.data.sha1
import java.io.File
import java.io.IOException

const val TAG_TRANSFER = "transfer"
private const val CHANNEL = "transfers"

private suspend fun CoroutineWorker.foreground(title: String, id: Int) {
    try {
        val nm = applicationContext.getSystemService(NotificationManager::class.java)
        if (Build.VERSION.SDK_INT >= 26) nm.createNotificationChannel(NotificationChannel(CHANNEL, "Transfers", NotificationManager.IMPORTANCE_LOW))
        val n = NotificationCompat.Builder(applicationContext, CHANNEL)
            .setSmallIcon(android.R.drawable.stat_sys_download).setContentTitle(title).setOngoing(true).build()
        val type = if (Build.VERSION.SDK_INT >= 29) ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC else 0
        setForeground(ForegroundInfo(id, n, type))
    } catch (_: Exception) { /* notification permission denied / not allowed: keep running as plain work */ }
}

/** Downloads a drive file (kind=fs) or a share item (kind=share) with HTTP Range resume. */
class DownloadWorker(ctx: Context, p: WorkerParameters) : CoroutineWorker(ctx, p) {
    override suspend fun doWork(): Result {
        val kind = inputData.getString("kind") ?: "fs"
        val path = inputData.getString("path") ?: return Result.failure()
        val name = inputData.getString("name") ?: path.substringAfterLast('/')
        val prefs = Prefs(applicationContext)
        val api = prefs.client() ?: return Result.failure(workDataOf("error" to "no server"))
        foreground("↓ $name", name.hashCode())
        val dir = OfflineCache.downloads(applicationContext)
        val part = File(dir, "${sha1(kind + path + (inputData.getString("code") ?: ""))}.part")
        val dest = uniqueFile(dir, name)
        var last = 0L
        return try {
            val progress: (Long, Long) -> Unit = { d, t ->
                val now = System.currentTimeMillis()
                if (now - last > 400) { last = now; setProgressAsync(workDataOf("done" to d, "total" to t, "name" to name)) }
            }
            if (kind == "share") api.shareDownload(inputData.getString("code")!!, inputData.getString("token")!!, path, part, progress, cancelled = { isStopped })
            else api.download(path, part, onProgress = progress, cancelled = { isStopped })
            part.renameTo(dest)
            Result.success(workDataOf("file" to dest.absolutePath, "name" to name))
        } catch (e: ApiException) {
            if (e.status in 500..599 || e.status == 429) Result.retry() else { part.delete(); Result.failure(workDataOf("error" to (e.message ?: "error"))) }
        } catch (e: IOException) {
            if (isStopped) Result.retry() else if (runAttemptCount < 5) Result.retry() else Result.failure(workDataOf("error" to (e.message ?: "io error")))
        }
    }

    private fun uniqueFile(dir: File, name: String): File {
        var f = File(dir, name); var i = 1
        val base = name.substringBeforeLast('.', name); val ext = name.substringAfterLast('.', "")
        while (f.exists()) { f = File(dir, "$base ($i)" + if (ext.isNotEmpty() && ext != name) ".$ext" else ""); i++ }
        return f
    }
}

/** Resumable upload via /api/fs/uploads sessions; the session id survives process death. */
class UploadWorker(ctx: Context, p: WorkerParameters) : CoroutineWorker(ctx, p) {
    override suspend fun doWork(): Result {
        val uri = Uri.parse(inputData.getString("uri") ?: return Result.failure())
        val target = inputData.getString("target") ?: return Result.failure()
        val name = target.substringAfterLast('/')
        val prefs = Prefs(applicationContext)
        val api = prefs.client() ?: return Result.failure(workDataOf("error" to "no server"))
        foreground("↑ $name", target.hashCode())
        val cr = applicationContext.contentResolver
        val size = cr.query(uri, arrayOf(OpenableColumns.SIZE), null, null, null)?.use { if (it.moveToFirst()) it.getLong(0) else -1L } ?: -1L
        if (size < 0) return Result.failure(workDataOf("error" to "cannot read size"))
        val key = sha1("$uri|$target")
        var last = 0L
        return try {
            api.uploadResumable(
                target, size, prefs.uploadSession(key),
                openAt = { off ->
                    val ins = cr.openInputStream(uri) ?: throw IOException("cannot open $uri")
                    var left = off
                    while (left > 0) { val s = ins.skip(left); if (s <= 0) { if (ins.read() < 0) break else left-- } else left -= s }
                    ins
                },
                onSession = { prefs.setUploadSession(key, it) },
                onProgress = { d, t ->
                    val now = System.currentTimeMillis()
                    if (now - last > 400) { last = now; setProgressAsync(workDataOf("done" to d, "total" to t, "name" to name)) }
                },
                cancelled = { isStopped },
            )
            prefs.setUploadSession(key, null)
            Result.success(workDataOf("name" to name))
        } catch (e: ApiException) {
            if (e.status in 500..599 || e.status == 429) Result.retry()
            else { prefs.setUploadSession(key, null); Result.failure(workDataOf("error" to (e.message ?: "error"))) }
        } catch (e: IOException) {
            if (runAttemptCount < 8) Result.retry() else Result.failure(workDataOf("error" to (e.message ?: "io error")))
        }
    }
}

object Transfers {
    private val net = Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build()

    fun download(ctx: Context, path: String, name: String, kind: String = "fs", code: String? = null, token: String? = null) {
        val d = workDataOf("kind" to kind, "path" to path, "name" to name, "code" to code, "token" to token)
        WorkManager.getInstance(ctx).enqueue(
            OneTimeWorkRequestBuilder<DownloadWorker>().setInputData(d).setConstraints(net).addTag(TAG_TRANSFER)
                .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 10, java.util.concurrent.TimeUnit.SECONDS).build())
    }

    fun upload(ctx: Context, uri: Uri, target: String) {
        val d = workDataOf("uri" to uri.toString(), "target" to target)
        WorkManager.getInstance(ctx).enqueue(
            OneTimeWorkRequestBuilder<UploadWorker>().setInputData(d).setConstraints(net).addTag(TAG_TRANSFER)
                .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 10, java.util.concurrent.TimeUnit.SECONDS).build())
    }
}
