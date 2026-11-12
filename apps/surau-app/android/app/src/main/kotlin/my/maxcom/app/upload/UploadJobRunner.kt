package my.maxcom.app.upload

import java.io.Closeable
import java.io.IOException

/** A [ByteSource] that holds a file open. */
interface OpenSource : ByteSource, Closeable

/** How a run ended. */
enum class RunEnd { DONE, STOPPED, WAIT, FAILED, RETRY }

/**
 * Runs the unfinished parts of one job in order: begin a session on the cloud, PUT the bytes to
 * YouTube in 8 MB chunks, resume after any interruption, tell the cloud when YouTube has the video.
 * The Kotlin twin of `lib/upload/upload_loop.dart`; pure JVM code (the Android bits come in as
 * [openSource] and [cloud]), so unit tests drive it with fakes. Progress goes to [emit] and to
 * [store] after every step, so a WorkManager retry resumes instead of beginning again.
 */
class UploadJobRunner(
    private val spec: JobSpec,
    private val state: JobState,
    private val cloud: CloudApi,
    private val uploader: ResumableUploader,
    private val openSource: (source: String) -> OpenSource,
    private val store: UploadStateStore,
    private val emit: (UploadEvent) -> Unit,
    private val shouldStop: () -> Boolean,
    private val maxSessions: Int = 5,
    /** Called with the sent and total bytes of the part, for the notification. */
    private val onProgress: (partIndex: Int, partCount: Int, sent: Long, total: Long) -> Unit = { _, _, _, _ -> },
) {
    private var lastIndex = 0

    fun run(parts: List<PartSpec>): RunEnd {
        val count = parts.size
        lastIndex = parts.lastOrNull()?.index ?: 0
        for (p in parts) {
            if (shouldStop()) return RunEnd.STOPPED
            val st = state.parts.getOrPut(p.index) { PartState() }
            if (st.state == "done" || p.done) continue
            val end = part(p, count, st)
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
        if (clearSession) { st.offset = 0; st.uploadId = null; st.uploadUri = null }
        if (offset != null) st.offset = offset
        if (uploadId != null) st.uploadId = uploadId
        if (uploadUri != null) st.uploadUri = uploadUri
        if (videoId != null) st.videoId = videoId
        if (state == "done") st.uploadUri = null
        this.state.parts[p.index] = st
        store.save(spec.id, this.state)
        emit(
            UploadEvent(
                jobId = spec.id, partIndex = p.index, state = state, offset = offset, total = p.bytes,
                uploadId = uploadId, uploadUri = uploadUri, videoId = videoId, error = error,
                resetsAt = resetsAt, clearSession = clearSession,
            ),
        )
    }

    /** Null when the part is done and the next may start; else how the run ends. */
    private fun part(p: PartSpec, count: Int, st: PartState): RunEnd? {
        var resumed = st.uploadUri != null
        for (session in 0 until maxSessions) {
            if (shouldStop()) return RunEnd.STOPPED
            if (st.videoId == null) {
                if (st.uploadUri == null || st.uploadId == null) {
                    ev(p, st, "beginning")
                    try {
                        val b = cloud.begin(
                            spec.kuliahId,
                            if (count > 1) p.index else null,
                            if (count > 1) count else null,
                            p.bytes,
                            // The live is hidden only after the last part is up.
                            if (p.index == lastIndex) spec.replaceLiveVideoId else null,
                        )
                        st.uploadId = b.uploadId
                        st.uploadUri = b.uploadUri
                        st.offset = 0
                        resumed = false
                    } catch (q: CloudQuota) {
                        ev(p, st, "quota", resetsAt = q.resetsAt)
                        return RunEnd.WAIT
                    } catch (_: CloudNeedsUnlock) {
                        ev(p, st, "failed", error = "needs_unlock")
                        return RunEnd.FAILED
                    } catch (r: CloudRefused) {
                        ev(p, st, "failed", error = safeCode(r.code))
                        return RunEnd.FAILED
                    } catch (_: IOException) {
                        ev(p, st, "queued", error = "begin_failed")
                        return RunEnd.RETRY
                    }
                }
                val uri = st.uploadUri!!
                if (!UploadUri.isYoutube(uri)) {
                    // Neither a new nor a stored address leads anywhere but Google: it is dropped, never sent to.
                    ev(p, st, "failed", error = "bad_upload_uri", clearSession = true)
                    return RunEnd.FAILED
                }
                ev(p, st, "uploading", offset = st.offset, uploadId = st.uploadId, uploadUri = st.uploadUri)

                val file = try {
                    openSource(p.source)
                } catch (_: Exception) {
                    ev(p, st, "failed", error = "source_missing")
                    return RunEnd.FAILED
                }
                file.use { src ->
                    if (resumed) {
                        // A session from before: ask where YouTube is, do not guess.
                        when (val r = uploader.probe(uri, src.length)) {
                            is UploadResult.SessionLost -> {
                                ev(p, st, "queued", clearSession = true)
                                return@use
                            }
                            is UploadResult.Complete -> st.videoId = r.videoId
                            is UploadResult.Offset -> st.offset = r.offset
                            else -> {}
                        }
                        resumed = false
                    }
                    if (st.uploadUri == null) return@use // session lost on the probe: begin again
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
                            is UploadResult.Complete -> {
                                st.videoId = out.videoId
                                ev(p, st, "uploading", offset = p.bytes, videoId = out.videoId)
                            }
                            is UploadResult.SessionLost -> {
                                ev(p, st, "queued", clearSession = true)
                                return@use
                            }
                            is UploadResult.Quota -> {
                                ev(p, st, "quota", resetsAt = cloud.quotaResetsAt())
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
                            is UploadResult.Offset -> {}
                        }
                    }
                    Unit
                }
                if (st.videoId == null) continue // a lost session: round again
            }
            return finish(p, st)
        }
        ev(p, st, "failed", error = "session_lost")
        return RunEnd.FAILED
    }

    private fun finish(p: PartSpec, st: PartState): RunEnd? {
        val id = st.uploadId
        val vid = st.videoId!!
        if (id == null) {
            ev(p, st, "failed", error = "done_failed", videoId = vid)
            return RunEnd.FAILED
        }
        try {
            cloud.done(id, vid)
        } catch (_: CloudNeedsUnlock) {
            ev(p, st, "failed", error = "needs_unlock", videoId = vid)
            return RunEnd.FAILED
        } catch (_: Exception) {
            // The video is on YouTube: its id is kept, so a retry only calls done.
            ev(p, st, "queued", error = "done_failed", videoId = vid)
            return RunEnd.RETRY
        }
        ev(p, st, "done", offset = p.bytes, videoId = vid)
        return null
    }

    private fun safeCode(code: String) = if (Regex("^[a-z0-9_]{1,40}$").matches(code)) code else "error"
}
