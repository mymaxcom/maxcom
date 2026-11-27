package my.maxcom.app.upload

import java.io.Closeable
import java.io.IOException

/** A [ByteSource] that holds a file open. */
interface OpenSource : ByteSource, Closeable

/** How a run ended. */
enum class RunEnd { DONE, STOPPED, WAIT, FAILED, RETRY }

/**
 * Runs the unfinished parts of one job in order: PUT the bytes to YouTube in 8 MB chunks at the upload address the
 * app handed over, resume after any interruption, and stop at `uploaded` once YouTube has the video.
 *
 * 2026.11.15 (B1, U7): the worker talks to Google and to nothing else. The app asks the MAXCOM box for the upload
 * address before it queues the job and tells the box afterwards, with its own client; so there is no box address, no
 * session token and no certificate here. What the runner says instead:
 * - `uploaded` (with the video id): YouTube has the part; the app confirms it with the box when it can reach it.
 * - `queued` with error `needs_begin` (and `clearSession` when an address died): the part has no usable upload
 *   address; the app gets a new one and queues the job again.
 *
 * Pure JVM code (the Android bits come in as [openSource]), so unit tests drive it with fakes. Progress goes to
 * [emit] and to [store] after every step, so a WorkManager retry resumes instead of beginning again. Nothing here
 * throws: an unexpected exception ends the run as a visible `runner_error` (U3), its class goes to [log].
 */
class UploadJobRunner(
    private val spec: JobSpec,
    private val state: JobState,
    private val uploader: ResumableUploader,
    private val openSource: (source: String) -> OpenSource,
    private val store: UploadStateStore,
    private val emit: (UploadEvent) -> Unit,
    private val shouldStop: () -> Boolean,
    /** Called with the sent and total bytes of the part, for the notification. */
    private val onProgress: (partIndex: Int, partCount: Int, sent: Long, total: Long) -> Unit = { _, _, _, _ -> },
    /** An event name and the exception class; never a message (it may hold an address). */
    private val log: (event: String, type: String) -> Unit = { _, _ -> },
) {
    companion object {
        /** YouTube has the bytes and gave the video id; the box has not been told yet. */
        const val UPLOADED = "uploaded"
        /** The part has no usable upload address: the app must ask the box for one. */
        const val NEEDS_BEGIN = "needs_begin"
    }

    fun run(parts: List<PartSpec>): RunEnd {
        val count = parts.size
        for (p in parts) {
            if (shouldStop()) return RunEnd.STOPPED
            val st = state.parts.getOrPut(p.index) { PartState() }
            if (st.state == "done" || p.done) continue
            val end = try {
                part(p, count, st)
            } catch (e: IOException) {
                log("upload_part_io", e.javaClass.simpleName)
                ev(p, st, "queued", error = "network")
                RunEnd.RETRY
            } catch (e: Exception) {
                // U3: nothing escapes the worker silently (a JSON, security or state error is shown, not swallowed).
                log("upload_part_failed", e.javaClass.simpleName)
                ev(p, st, "failed", error = "runner_error")
                RunEnd.FAILED
            }
            if (end != null) return end
        }
        return RunEnd.DONE
    }

    private fun ev(
        p: PartSpec, st: PartState, state: String,
        offset: Long? = null, uploadId: String? = null, uploadUri: String? = null,
        videoId: String? = null, error: String? = null, resetsAt: String? = null,
        clearSession: Boolean = false,
    ) {
        st.state = state
        st.error = error
        if (clearSession) { st.offset = 0; st.uploadId = null; st.uploadUri = null }
        if (offset != null) st.offset = offset
        if (uploadId != null) st.uploadId = uploadId
        if (uploadUri != null) st.uploadUri = uploadUri
        if (videoId != null) st.videoId = videoId
        // The video is up: the address has done its work and is not kept.
        if (state == "done" || state == UPLOADED) st.uploadUri = null
        this.state.parts[p.index] = st
        store.save(spec.id, this.state)
        emit(
            UploadEvent(
                jobId = spec.id, partIndex = p.index, state = state, offset = offset, total = p.bytes,
                uploadId = uploadId ?: st.uploadId, uploadUri = uploadUri, videoId = videoId, error = error,
                resetsAt = resetsAt, clearSession = clearSession,
            ),
        )
    }

    /** Null when the part is up and the next may start; else how the run ends. */
    private fun part(p: PartSpec, count: Int, st: PartState): RunEnd? {
        if (shouldStop()) return RunEnd.STOPPED
        if (st.videoId != null) {
            // Sent in an earlier run: say so again (the app may have missed it) and go on.
            ev(p, st, UPLOADED, offset = p.bytes, videoId = st.videoId)
            return null
        }
        val uri = st.uploadUri
        if (uri == null) {
            ev(p, st, "queued", error = NEEDS_BEGIN)
            return RunEnd.WAIT
        }
        if (!UploadUri.isYoutube(uri)) {
            // Neither a new nor a stored address leads anywhere but Google: it is dropped, never sent to.
            ev(p, st, "failed", error = "bad_upload_uri", clearSession = true)
            return RunEnd.FAILED
        }
        ev(p, st, "uploading", offset = st.offset, uploadUri = uri)

        val file = try {
            openSource(p.source)
        } catch (_: Exception) {
            ev(p, st, "failed", error = "source_missing")
            return RunEnd.FAILED
        }
        file.use { src ->
            if (src.length <= 0) {
                // B3: a recording with nothing in it is never sent.
                ev(p, st, "failed", error = "empty_file")
                return RunEnd.FAILED
            }
            // Ask YouTube where it is, do not guess: the address may be minutes old or from an earlier run.
            when (val r = uploader.probe(uri, src.length)) {
                is UploadResult.SessionLost -> {
                    ev(p, st, "queued", error = NEEDS_BEGIN, clearSession = true)
                    return RunEnd.WAIT
                }
                is UploadResult.Complete -> st.videoId = r.videoId
                is UploadResult.Offset -> st.offset = r.offset
                else -> {}
            }
            if (st.videoId == null) {
                when (
                    val out = uploader.upload(
                        uri, src, st.offset,
                        onProgress = { o ->
                            ev(p, st, "uploading", offset = o)
                            onProgress(p.index, count, o, p.bytes)
                        },
                        shouldStop = shouldStop,
                    )
                ) {
                    is UploadResult.Complete -> st.videoId = out.videoId
                    is UploadResult.SessionLost -> {
                        ev(p, st, "queued", error = NEEDS_BEGIN, clearSession = true)
                        return RunEnd.WAIT
                    }
                    is UploadResult.Quota -> {
                        ev(p, st, "quota")
                        return RunEnd.WAIT
                    }
                    is UploadResult.Stopped -> {
                        ev(p, st, "queued", offset = out.offset)
                        return RunEnd.STOPPED
                    }
                    is UploadResult.Rejected -> {
                        ev(p, st, "failed", error = "rejected_${out.status}")
                        return RunEnd.FAILED
                    }
                    is UploadResult.Offset -> {
                        // upload() only returns at an end state; an offset here means it stopped short.
                        ev(p, st, "queued", offset = out.offset, error = "network")
                        return RunEnd.RETRY
                    }
                }
            }
        }
        ev(p, st, UPLOADED, offset = p.bytes, videoId = st.videoId)
        return null
    }
}
