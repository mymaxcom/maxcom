package my.maxcom.app.upload

import android.content.ContentUris
import android.content.Context
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.os.Handler
import android.os.Looper
import android.provider.MediaStore
import android.util.Base64
import androidx.work.BackoffPolicy
import androidx.work.Constraints
import androidx.work.Data
import androidx.work.ExistingWorkPolicy
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.OutOfQuotaPolicy
import androidx.work.WorkManager
import io.flutter.embedding.engine.FlutterEngine
import io.flutter.plugin.common.EventChannel
import io.flutter.plugin.common.MethodCall
import io.flutter.plugin.common.MethodChannel
import java.io.File
import java.util.concurrent.TimeUnit
import org.json.JSONObject

/** Where the worker's events leave for Dart (the app may be closed: then they are dropped; `status` replays). */
object UploadEvents {
    @Volatile
    var sink: ((Map<String, Any?>) -> Unit)? = null

    fun emit(e: UploadEvent) {
        sink?.invoke(e.toMap())
    }
}

/**
 * MethodChannel `my.maxcom/upload` and EventChannel `my.maxcom/upload/events` (Plan 6 Task 10).
 * Register from `configureFlutterEngine`: `UploadChannel.register(flutterEngine, this)`.
 *
 * `enqueue` carries the job, the cloud base URL, the session token and the root CA once; they go
 * straight into the work request and are not stored, logged or put in the notification. Errors to
 * Dart carry reason codes only.
 */
class UploadChannel private constructor(private val context: Context) :
    MethodChannel.MethodCallHandler, EventChannel.StreamHandler {

    companion object {
        const val METHOD = "my.maxcom/upload"
        const val EVENTS = "my.maxcom/upload/events"

        fun register(flutter: FlutterEngine, context: Context) {
            val ch = UploadChannel(context.applicationContext)
            MethodChannel(flutter.dartExecutor.binaryMessenger, METHOD).setMethodCallHandler(ch)
            EventChannel(flutter.dartExecutor.binaryMessenger, EVENTS).setStreamHandler(ch)
        }

        /** The unique work request of one job. */
        fun request(jobJson: String, base: String, token: String, caB64: String, allowMobile: Boolean) =
            OneTimeWorkRequestBuilder<UploadWorker>()
                .setConstraints(Constraints.Builder().setRequiredNetworkType(UploadPlan.networkType(allowMobile)).build())
                .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 30, TimeUnit.SECONDS)
                .setExpedited(OutOfQuotaPolicy.RUN_AS_NON_EXPEDITED_WORK_REQUEST)
                .setInputData(
                    Data.Builder()
                        .putString(UploadWorker.KEY_JOB, jobJson)
                        .putString(UploadWorker.KEY_BASE, base)
                        .putString(UploadWorker.KEY_TOKEN, token)
                        .putString(UploadWorker.KEY_CA, caB64)
                        .build(),
                )
                .build()
    }

    private val main = Handler(Looper.getMainLooper())

    override fun onListen(arguments: Any?, events: EventChannel.EventSink?) {
        UploadEvents.sink = events?.let { s -> { m -> main.post { try { s.success(m) } catch (_: RuntimeException) {} } } }
    }

    override fun onCancel(arguments: Any?) {
        UploadEvents.sink = null
    }

    override fun onMethodCall(call: MethodCall, result: MethodChannel.Result) {
        when (call.method) {
            "enqueue" -> enqueue(call, result)
            "cancel" -> {
                val id = call.argument<String>("jobId")
                if (id == null) result.error("bad_args", null, null) else {
                    WorkManager.getInstance(context).cancelUniqueWork(UploadWorker.workName(id))
                    result.success(null)
                }
            }
            "forget" -> {
                val id = call.argument<String>("jobId")
                if (id == null) result.error("bad_args", null, null) else {
                    WorkManager.getInstance(context).cancelUniqueWork(UploadWorker.workName(id))
                    PrefsStateStore(context).clear(id)
                    UploadWorker.joinedFile(context, id).delete()
                    result.success(null)
                }
            }
            "status" -> result.success(status())
            "network" -> result.success(network())
            "findSegments" -> result.success(findSegments(call.argument<List<String>>("names") ?: emptyList()))
            "deleteRecordings" -> {
                val names = call.argument<List<String>>("names")
                if (names == null) result.error("bad_args", null, null) else result.success(deleteRecordings(names))
            }
            else -> result.notImplemented()
        }
    }

    private fun enqueue(call: MethodCall, result: MethodChannel.Result) {
        val job = call.argument<Map<String, Any?>>("job")
        val base = call.argument<String>("base")
        val token = call.argument<String>("token")
        if (job == null || base == null || token == null) {
            result.error("bad_args", null, null)
            return
        }
        val ca = call.argument<ByteArray>("ca")
        val caB64 = if (ca == null) "" else Base64.encodeToString(ca, Base64.NO_WRAP)
        val jobJson = JSONObject(job).toString()
        val id = job["id"] as? String
        if (id == null) {
            result.error("bad_args", null, null)
            return
        }
        if (!UploadPlan.fitsInput(jobJson, base, token, caB64)) {
            result.error("job_too_large", null, null)
            return
        }
        val req = request(jobJson, base, token, caB64, job["allowMobile"] == true)
        // REPLACE: the new request carries the fresh session token; the worker keeps its own
        // progress, so the replaced run resumes where it was.
        WorkManager.getInstance(context)
            .enqueueUniqueWork(UploadWorker.workName(id), ExistingWorkPolicy.REPLACE, req)
        result.success(null)
    }

    /** Persisted state of every job the worker knows, as events (Dart replays them at start). */
    private fun status(): List<Map<String, Any?>> {
        val out = ArrayList<Map<String, Any?>>()
        for ((jobId, s) in PrefsStateStore(context).all()) {
            for ((i, p) in s.parts) {
                out.add(
                    UploadEvent(
                        jobId = jobId, partIndex = i, state = p.state, offset = p.offset,
                        uploadId = p.uploadId, uploadUri = p.uploadUri, videoId = p.videoId,
                        joined = if (s.joined) true else null,
                        total = if (s.joined) s.joinedBytes else null,
                    ).toMap(),
                )
            }
        }
        return out
    }

    private fun network(): String {
        val cm = context.getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
        val net = cm.activeNetwork ?: return "none"
        val caps = cm.getNetworkCapabilities(net) ?: return "none"
        if (!caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)) return "none"
        return when {
            caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) ||
                caps.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET) -> "wifi"
            caps.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR) -> "cellular"
            else -> "wifi"
        }
    }

    /**
     * Looks up exactly the files the live wrote, by the names the engine reported (`sessionRecordings`):
     * a MediaStore row in `Movies/MAXCOM` owned by this app (Android 10 and later) or a file in the app's
     * own folder (where a segment stays when the copy to the gallery failed). No name scan, no prefix, no
     * date: a recording that was not named is never found. Read only: nothing is moved, renamed or deleted
     * here (see [deleteRecordings]).
     */
    private fun findSegments(asked: List<String>): List<Map<String, Any?>> {
        val found = LinkedHashMap<String, Map<String, Any?>>()
        val names = RecordingGuard.askedNames(asked)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            for (name in names) {
                context.contentResolver.query(
                    MediaStore.Video.Media.EXTERNAL_CONTENT_URI,
                    arrayOf(
                        MediaStore.Video.Media._ID,
                        MediaStore.Video.Media.SIZE,
                        MediaStore.Video.Media.RELATIVE_PATH,
                        MediaStore.Video.Media.OWNER_PACKAGE_NAME,
                    ),
                    "${MediaStore.Video.Media.DISPLAY_NAME} = ?",
                    arrayOf(name),
                    null,
                )?.use { c ->
                    while (c.moveToNext()) {
                        if (!RecordingGuard.acceptMediaRow(name, c.getString(2), c.getString(3), context.packageName)) continue
                        found[name] = mapOf(
                            "uri" to ContentUris.withAppendedId(MediaStore.Video.Media.EXTERNAL_CONTENT_URI, c.getLong(0)).toString(),
                            "name" to name,
                            "bytes" to c.getLong(1),
                        )
                        break
                    }
                }
            }
        }
        val dir = context.getExternalFilesDir(Environment.DIRECTORY_MOVIES)?.let { File(it, "MAXCOM") }
        if (dir != null) {
            for (name in names) {
                val f = File(dir, name)
                if (f.isFile && RecordingGuard.acceptAppFile(dir.path, name, f.path) && !found.containsKey(name)) {
                    found[name] = mapOf("uri" to Uri.fromFile(f).toString(), "name" to name, "bytes" to f.length())
                }
            }
        }
        // In the order the live wrote them.
        return names.mapNotNull { found[it] }
    }

    /**
     * Deletes the app's own recordings by name (Plan 6 Task 13, after YouTube verified them). Only names that
     * pass [RecordingGuard] are looked at; a MediaStore row must also sit in `Movies/MAXCOM` and be owned by
     * this app's package, and an app-folder file must sit directly in the app's `Movies/MAXCOM`. A row the app
     * may not delete (a `SecurityException`, which includes `RecoverableSecurityException`) is skipped, never
     * prompted for. Returns counts and bytes only: no name, no address.
     */
    private fun deleteRecordings(asked: List<String>): Map<String, Any?> {
        var deleted = 0
        var skipped = 0
        var bytes = 0L
        val names = RecordingGuard.askedNames(asked)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            for (name in names) {
                try {
                    context.contentResolver.query(
                        MediaStore.Video.Media.EXTERNAL_CONTENT_URI,
                        arrayOf(
                            MediaStore.Video.Media._ID,
                            MediaStore.Video.Media.SIZE,
                            MediaStore.Video.Media.RELATIVE_PATH,
                            MediaStore.Video.Media.OWNER_PACKAGE_NAME,
                        ),
                        "${MediaStore.Video.Media.DISPLAY_NAME} = ?",
                        arrayOf(name),
                        null,
                    )?.use { c ->
                        while (c.moveToNext()) {
                            if (!RecordingGuard.acceptMediaRow(name, c.getString(2), c.getString(3), context.packageName)) {
                                skipped++
                                continue
                            }
                            val uri = ContentUris.withAppendedId(MediaStore.Video.Media.EXTERNAL_CONTENT_URI, c.getLong(0))
                            val size = c.getLong(1)
                            if (context.contentResolver.delete(uri, null, null) > 0) {
                                deleted++
                                bytes += size
                            } else {
                                skipped++
                            }
                        }
                    }
                } catch (_: SecurityException) {
                    skipped++
                }
            }
        }
        val dir = context.getExternalFilesDir(Environment.DIRECTORY_MOVIES)?.let { File(it, "MAXCOM") }
        if (dir != null) {
            for (name in names) {
                val f = File(dir, name)
                if (!f.isFile || !RecordingGuard.acceptAppFile(dir.path, name, f.path)) continue
                val size = f.length()
                if (f.delete()) {
                    deleted++
                    bytes += size
                } else {
                    skipped++
                }
            }
        }
        return mapOf("deleted" to deleted, "skipped" to skipped, "bytes" to bytes)
    }
}
