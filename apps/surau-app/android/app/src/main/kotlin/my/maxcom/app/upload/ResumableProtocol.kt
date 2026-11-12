package my.maxcom.app.upload

import java.io.IOException

/**
 * The YouTube resumable upload protocol (Plan 6 Task 10, spec 12b B), the Kotlin twin of
 * `lib/upload/resumable_client.dart`. Pure JVM code: no Android classes, so it runs in plain unit
 * tests. The upload URI is a bearer secret: nothing here puts it in an exception message or a log.
 *
 *   PUT uri  Content-Range: bytes from-to/total   (8 MB chunks)
 *   308 + Range: bytes=0-n   -> continue at n + 1 (no Range: nothing kept)
 *   200 | 201 + video JSON   -> done, videoId = id
 *   PUT uri  Content-Range: bytes * /total, empty body -> where are we?
 *   404 | 410                -> the session is gone
 *   403 quotaExceeded | uploadLimitExceeded -> quota
 *   5xx, 429, I/O errors     -> wait 5 s, 15 s, 60 s, 5 min (then 5 min again), probe, continue
 */
object ResumableProtocol {
    const val CHUNK_BYTES = 8L * 1024 * 1024
    val BACKOFF_MS = longArrayOf(5_000, 15_000, 60_000, 300_000)

    fun contentRange(from: Long, endExclusive: Long, total: Long) =
        "bytes $from-${endExclusive - 1}/$total"

    fun probeRange(total: Long) = "bytes */$total"

    /** `bytes=0-n` -> n + 1; no header or no match -> 0. */
    fun nextOffset(rangeHeader: String?): Long {
        val m = Regex("""bytes=0-(\d+)""").find(rangeHeader ?: "") ?: return 0L
        return m.groupValues[1].toLong() + 1
    }

    private val ID = Regex(""""id"\s*:\s*"([^"]+)"""")
    private val REASON = Regex(""""reason"\s*:\s*"([^"]+)"""")

    fun videoId(body: String): String? = ID.find(body)?.groupValues?.get(1)

    fun reason(body: String): String = REASON.find(body)?.groupValues?.get(1) ?: "unknown"

    sealed class Reply {
        data class Offset(val offset: Long) : Reply()
        data class Complete(val videoId: String) : Reply()
        object SessionLost : Reply()
        data class Quota(val reason: String) : Reply()
        data class Rejected(val status: Int, val reason: String) : Reply()
        /** 5xx or 429: try again later. */
        object Retry : Reply()
    }

    fun classify(status: Int, rangeHeader: String?, body: String): Reply = when {
        status == 200 || status == 201 -> {
            val id = videoId(body)
            if (id == null) Reply.Rejected(200, "no_video_id") else Reply.Complete(id)
        }
        status == 308 -> Reply.Offset(nextOffset(rangeHeader))
        status == 404 || status == 410 -> Reply.SessionLost
        status >= 500 || status == 429 -> Reply.Retry
        status == 403 && reason(body).let { it == "quotaExceeded" || it == "uploadLimitExceeded" } ->
            Reply.Quota(reason(body))
        else -> Reply.Rejected(status, reason(body))
    }
}

class PutResponse(val status: Int, val rangeHeader: String?, val body: String)

/** One PUT to the session URI. Throws [IOException] when the network fails. */
fun interface PutTransport {
    @Throws(IOException::class)
    fun put(uri: String, contentRange: String, body: ByteArray): PutResponse
}

/** A file read in slices. */
interface ByteSource {
    val length: Long
    fun read(start: Long, endExclusive: Long): ByteArray
}

class ByteArraySource(private val bytes: ByteArray) : ByteSource {
    override val length: Long get() = bytes.size.toLong()
    override fun read(start: Long, endExclusive: Long): ByteArray =
        bytes.copyOfRange(start.toInt(), endExclusive.toInt())
}

/** Where the device may send the recording: only to Google (S1). */
object UploadUri {
    /**
     * True only for https with no user info and a host of `googleapis.com`'s `www` or any subdomain
     * of it. The cloud checks the address it mints; the device checks again before the first PUT
     * and when it resumes from a stored one.
     */
    fun isYoutube(raw: String): Boolean {
        val u = try { java.net.URI(raw) } catch (_: Exception) { return false }
        if (u.scheme != "https" || u.rawUserInfo != null) return false
        val host = u.host?.lowercase(java.util.Locale.ROOT) ?: return false
        return host == "www.googleapis.com" || host.endsWith(".googleapis.com")
    }
}

sealed class UploadResult {
    data class Complete(val videoId: String) : UploadResult()
    data class Offset(val offset: Long) : UploadResult()
    object SessionLost : UploadResult()
    data class Quota(val reason: String) : UploadResult()
    data class Stopped(val offset: Long) : UploadResult()
    data class Rejected(val status: Int, val reason: String) : UploadResult()
}

class ResumableUploader(
    private val transport: PutTransport,
    private val chunkBytes: Long = ResumableProtocol.CHUNK_BYTES,
    private val backoffMs: LongArray = ResumableProtocol.BACKOFF_MS,
    /** Waits [ms]; the worker's version wakes early when the job is stopped. */
    private val sleep: (Long) -> Unit = { Thread.sleep(it) },
) {
    fun probe(uri: String, total: Long): UploadResult =
        when (val r = reply(uri, ResumableProtocol.probeRange(total), ByteArray(0))) {
            null -> UploadResult.Rejected(0, "network")
            else -> toResult(ResumableProtocol.classify(r.status, r.rangeHeader, r.body))
        }

    /**
     * Sends [source] from [offset] to the end. Network errors and 5xx wait and probe, without end,
     * until [shouldStop] says so.
     */
    fun upload(
        uri: String,
        source: ByteSource,
        offset: Long = 0,
        onProgress: (Long) -> Unit = {},
        shouldStop: () -> Boolean = { false },
    ): UploadResult {
        val total = source.length
        if (total <= 0) return UploadResult.Rejected(0, "empty_file")
        var at = offset
        var attempt = 0
        var needProbe = false
        while (true) {
            if (shouldStop()) return UploadResult.Stopped(at)
            val r = if (needProbe) {
                reply(uri, ResumableProtocol.probeRange(total), ByteArray(0))
            } else {
                val end = minOf(at + chunkBytes, total)
                reply(uri, ResumableProtocol.contentRange(at, end, total), source.read(at, end))
            }
            val c = r?.let { ResumableProtocol.classify(it.status, it.rangeHeader, it.body) }
            if (c == null || c is ResumableProtocol.Reply.Retry) {
                sleep(backoffMs[minOf(attempt++, backoffMs.size - 1)])
                needProbe = true
                continue
            }
            attempt = 0
            when (c) {
                is ResumableProtocol.Reply.Offset -> {
                    at = c.offset
                    needProbe = at >= total
                    if (needProbe) sleep(backoffMs[0])
                    onProgress(at)
                }
                else -> return toResult(c)
            }
        }
    }

    /** Null means the request itself failed (I/O). */
    private fun reply(uri: String, range: String, body: ByteArray): PutResponse? =
        try {
            transport.put(uri, range, body)
        } catch (_: IOException) {
            null
        }

    private fun toResult(c: ResumableProtocol.Reply): UploadResult = when (c) {
        is ResumableProtocol.Reply.Offset -> UploadResult.Offset(c.offset)
        is ResumableProtocol.Reply.Complete -> UploadResult.Complete(c.videoId)
        ResumableProtocol.Reply.SessionLost -> UploadResult.SessionLost
        is ResumableProtocol.Reply.Quota -> UploadResult.Quota(c.reason)
        is ResumableProtocol.Reply.Rejected -> UploadResult.Rejected(c.status, c.reason)
        ResumableProtocol.Reply.Retry -> UploadResult.Rejected(0, "retry")
    }
}
