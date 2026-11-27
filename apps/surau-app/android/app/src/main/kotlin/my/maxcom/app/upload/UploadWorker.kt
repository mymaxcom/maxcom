package my.maxcom.app.upload

import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Context
import android.content.SharedPreferences
import android.content.pm.ServiceInfo
import android.net.Uri
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.work.CoroutineWorker
import androidx.work.ForegroundInfo
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import java.io.File
import java.nio.ByteBuffer
import my.maxcom.app.live.Diag
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

/** The worker's progress and session state, in the app's private preferences. */
class PrefsStateStore(context: Context) : UploadStateStore {
    private val prefs: SharedPreferences =
        context.getSharedPreferences("maxcom_upload_state", Context.MODE_PRIVATE)

    override fun load(jobId: String): JobState? =
        prefs.getString(jobId, null)?.let { try { JobState.fromJson(it) } catch (_: Exception) { null } }

    override fun save(jobId: String, state: JobState) {
        prefs.edit().putString(jobId, state.toJson()).apply()
    }

    override fun clear(jobId: String) {
        prefs.edit().remove(jobId).apply()
    }

    override fun all(): Map<String, JobState> =
        prefs.all.mapNotNull { (k, v) ->
            (v as? String)?.let { s -> try { k to JobState.fromJson(s) } catch (_: Exception) { null } }
        }.toMap()
}

/** A file or content URI read at random positions. */
class ChannelSource(private val pfd: android.os.ParcelFileDescriptor) : OpenSource {
    // AutoCloseInputStream owns the descriptor: one close, no double-close.
    private val input = android.os.ParcelFileDescriptor.AutoCloseInputStream(pfd)
    private val channel = input.channel
    override val length: Long = channel.size()

    override fun read(start: Long, endExclusive: Long): ByteArray {
        val buf = ByteBuffer.allocate((endExclusive - start).toInt())
        var pos = start
        while (buf.hasRemaining()) {
            val n = channel.read(buf, pos)
            if (n < 0) break
            pos += n
        }
        return buf.array().copyOf(buf.position())
    }

    override fun close() {
        try { input.close() } catch (_: Exception) {}
    }
}

/**
 * The background catch-up upload (Plan 6 Task 10, spec 12b B). One unique work request per job, so
 * it survives an app kill and a reboot. It runs with a foreground notification (title, progress,
 * cancel action; the text is numbers only, never a URI or a file name), joins the recorded
 * segments with MediaMuxer when asked, and sends them with [UploadJobRunner].
 *
 * 2026.11.15 (B1, U7): the worker talks to Google only. WorkManager's input data holds the job and nothing else
 * ([UploadPlan.inputValues]): no session token, no box address, no certificate. The Google upload address of each
 * part comes inside the job (the app got it from the MAXCOM box) and is additionally kept in the worker's private
 * preferences ([PrefsStateStore]) so a retry resumes; it dies with the job and never goes to a log or a
 * notification. Nothing leaves [doWork] as an exception (U3): a failure is logged by its class and shown as
 * `runner_error`.
 */
class UploadWorker(context: Context, params: WorkerParameters) : CoroutineWorker(context, params) {

    companion object {
        const val KEY_JOB = UploadPlan.KEY_JOB

        fun workName(jobId: String) = "maxcom-upload-$jobId"

        fun joinedFile(context: Context, jobId: String) =
            File(File(context.cacheDir, "maxcom-upload"), "$jobId.mp4")

        fun notificationId(jobId: String) = 4200 + (jobId.hashCode() and 0xFFF)
    }

    private val jobId: String by lazy { inputData.getString(KEY_JOB)?.let { JobSpec.parse(it).id } ?: "unknown" }

    override suspend fun getForegroundInfo(): ForegroundInfo = foreground(0, 1, 0, 0)

    private fun foreground(index: Int, count: Int, sent: Long, total: Long): ForegroundInfo {
        val nm = applicationContext.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        if (nm.getNotificationChannel(UploadPlan.CHANNEL_ID) == null) {
            nm.createNotificationChannel(
                NotificationChannel(UploadPlan.CHANNEL_ID, UploadPlan.CHANNEL_NAME, NotificationManager.IMPORTANCE_LOW),
            )
        }
        val pct = UploadPlan.percent(sent, total)
        val n = NotificationCompat.Builder(applicationContext, UploadPlan.CHANNEL_ID)
            .setSmallIcon(android.R.drawable.stat_sys_upload)
            .setContentTitle(UploadPlan.TITLE)
            .setContentText(UploadPlan.notificationText(index, count, sent, total))
            .setProgress(100, pct, total <= 0)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .addAction(
                android.R.drawable.ic_menu_close_clear_cancel,
                UploadPlan.CANCEL,
                WorkManager.getInstance(applicationContext).createCancelPendingIntent(id),
            )
            .build()
        val nid = notificationId(jobId)
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            ForegroundInfo(nid, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
        } else {
            ForegroundInfo(nid, n)
        }
    }

    override suspend fun doWork(): Result = withContext(Dispatchers.IO) {
        Diag.init(applicationContext)
        val specJson = inputData.getString(KEY_JOB) ?: return@withContext Result.failure()
        val spec = try {
            JobSpec.parse(specJson)
        } catch (e: Exception) {
            Diag.error("upload_job_unreadable", e)
            return@withContext Result.failure()
        }
        try {
            work(spec)
        } catch (e: CancellationException) {
            throw e // the system or the person stopped the work: WorkManager's own business
        } catch (e: Exception) {
            // U3: no exception ends the worker silently. The class is logged, the card shows a reason.
            Diag.error("upload_worker_failed", e)
            val first = spec.parts.firstOrNull { !it.done } ?: spec.parts.firstOrNull()
            if (first != null) UploadEvents.emit(UploadEvent(spec.id, first.index, "failed", error = "runner_error"))
            Result.failure()
        }
    }

    private suspend fun work(spec: JobSpec): Result {
        Diag.log("upload_worker_start", "parts=${spec.parts.size} attempt=$runAttemptCount")
        try {
            setForeground(foreground(0, 1, 0, 0))
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            // Not allowed now (B1d): the upload still runs, without the notification; the reason is on record.
            Diag.error("upload_foreground_failed", e)
        }

        val store = PrefsStateStore(applicationContext)
        val state = store.load(spec.id) ?: JobState().also { s ->
            for (p in spec.parts) {
                s.parts[p.index] = PartState(
                    state = if (p.done) "done" else "queued", offset = p.offset,
                    uploadId = p.uploadId, uploadUri = p.uploadUri, videoId = p.videoId,
                )
            }
        }
        // The app's own record can be ahead of a worker that never started.
        for (p in spec.parts) {
            val s = state.parts.getOrPut(p.index) { PartState() }
            if (p.done) s.state = "done"
            if (s.videoId == null && p.videoId != null) s.videoId = p.videoId
            // The app got a (new) upload address from the box: it wins over what the worker dropped or never had.
            if (s.videoId == null && p.uploadUri != null && s.uploadUri != p.uploadUri) {
                val fresh = s.uploadUri != null
                s.uploadUri = p.uploadUri
                s.uploadId = p.uploadId
                s.offset = if (fresh) 0 else p.offset
                s.error = null
            }
        }

        val emit: (UploadEvent) -> Unit = { UploadEvents.emit(it) }
        val parts = joinIfAsked(spec, state, store, emit)

        val runner = UploadJobRunner(
            spec = spec,
            state = state,
            uploader = ResumableUploader(UrlConnectionTransport(), sleep = { ms -> sleepUnlessStopped(ms) }),
            openSource = { source -> open(spec.id, source) },
            store = store,
            emit = emit,
            shouldStop = { isStopped },
            onProgress = { index, count, sent, total ->
                try {
                    // Progress notification; best effort, off the upload's critical path.
                    val nm = applicationContext.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
                    nm.notify(notificationId(spec.id), foreground(index, count, sent, total).notification)
                } catch (_: Exception) {}
            },
            log = { event, type -> Diag.log(event, "type=$type") },
        )

        val end = runner.run(parts)
        Diag.log("upload_worker_end", "end=${end.name.lowercase()}")
        return when (end) {
            RunEnd.DONE -> {
                joinedFile(applicationContext, spec.id).delete()
                Result.success()
            }
            RunEnd.WAIT -> Result.success()
            RunEnd.FAILED -> Result.failure()
            RunEnd.RETRY, RunEnd.STOPPED -> Result.retry()
        }
    }

    /** No part of the job has an upload address or a video yet (so its files may still be joined into one). */
    private fun untouched(spec: JobSpec, state: JobState): Boolean =
        spec.parts.none { it.uploadUri != null || it.videoId != null } &&
            state.parts.values.none { it.uploadUri != null || it.videoId != null }

    /** Joins the segments into one file when asked; falls back to one video per segment. */
    private fun joinIfAsked(
        spec: JobSpec, state: JobState, store: UploadStateStore, emit: (UploadEvent) -> Unit,
    ): List<PartSpec> {
        val out = joinedFile(applicationContext, spec.id)
        val segments = spec.parts
        fun joinedPart(bytes: Long) = listOf(PartSpec(1, "android:joined", bytes))

        if (state.joined || spec.joined) {
            val known = state.joinedBytes.takeIf { it > 0 } ?: spec.parts.firstOrNull()?.bytes ?: out.length()
            val partDone = state.parts[1]?.state == "done" || spec.parts.firstOrNull()?.done == true
            return when (UploadPlan.joinedFilePlan(out.exists(), partDone, UploadPlan.canRejoin(spec.segments))) {
                UploadPlan.JoinedFilePlan.USE_FILE -> joinedPart(if (out.exists()) out.length() else known)
                UploadPlan.JoinedFilePlan.MISSING -> joinedPart(known)
                UploadPlan.JoinedFilePlan.REJOIN -> rejoin(spec, state, store, emit, out, known)
            }
        }
        // An upload address is made for one file of one size: once any part has one, the parts are sent as they are.
        if (!spec.joinSegments || segments.size < 2 || segments.any { !it.source.startsWith("android:") || it.done } ||
            !untouched(spec, state)
        ) {
            return segments
        }
        emit(UploadEvent(spec.id, 1, "joining", total = segments.sumOf { it.bytes }))
        return try {
            SegmentJoiner.join(
                applicationContext,
                segments.map { Uri.parse(it.source.removePrefix("android:")) },
                out,
            )
            state.joined = true
            state.joinedPath = out.path
            state.joinedBytes = out.length()
            state.parts.clear()
            state.parts[1] = PartState()
            store.save(spec.id, state)
            emit(UploadEvent(spec.id, 1, "queued", total = out.length(), joined = true))
            joinedPart(out.length())
        } catch (_: Exception) {
            // Per-segment upload; the screen says so.
            emit(UploadEvent(spec.id, 1, "queued", error = "join_failed"))
            segments
        }
    }

    /**
     * The joined cache file was purged: make it again from the original segment files. When the new
     * file differs in size the YouTube session of the old one no longer fits, so it is dropped and
     * the part starts again. If the segments cannot be joined the part fails `source_missing` as
     * before; no recording is touched either way.
     */
    private fun rejoin(
        spec: JobSpec, state: JobState, store: UploadStateStore, emit: (UploadEvent) -> Unit,
        out: File, known: Long,
    ): List<PartSpec> {
        val segments = spec.segments ?: return listOf(PartSpec(1, "android:joined", known))
        emit(UploadEvent(spec.id, 1, "joining", total = segments.sumOf { it.bytes }))
        return try {
            SegmentJoiner.join(
                applicationContext,
                segments.map { Uri.parse(it.source.removePrefix("android:")) },
                out,
            )
            val len = out.length()
            val sameSize = len == known
            state.joined = true
            state.joinedPath = out.path
            state.joinedBytes = len
            if (!sameSize) state.parts[1] = PartState()
            store.save(spec.id, state)
            emit(UploadEvent(spec.id, 1, "queued", total = len, joined = true, clearSession = !sameSize))
            listOf(PartSpec(1, "android:joined", len))
        } catch (_: Exception) {
            try { out.delete() } catch (_: Exception) {}
            emit(UploadEvent(spec.id, 1, "queued", error = "join_failed"))
            listOf(PartSpec(1, "android:joined", known))
        }
    }

    private fun open(jobId: String, source: String): OpenSource {
        val uri = if (source == "android:joined") {
            Uri.fromFile(joinedFile(applicationContext, jobId))
        } else {
            Uri.parse(source.removePrefix("android:"))
        }
        val pfd = applicationContext.contentResolver.openFileDescriptor(uri, "r")
            ?: throw java.io.IOException("open")
        return ChannelSource(pfd)
    }

    /** Sleeps in short steps so a stopped job wakes at once. */
    private fun sleepUnlessStopped(ms: Long) {
        var left = ms
        while (left > 0 && !isStopped) {
            val step = minOf(left, 250L)
            Thread.sleep(step)
            left -= step
        }
    }
}
