package my.maxcom.app.upload

import androidx.work.NetworkType
import org.json.JSONArray
import org.json.JSONObject

/**
 * The small decisions of the upload worker that need no Android framework, so unit tests reach
 * them: which network a job needs, what the notification says, whether a job fits WorkManager's
 * input data.
 */
object UploadPlan {
    /** `UNMETERED` (Wi-Fi) by default, any network once the person allows mobile data. */
    fun networkType(allowMobile: Boolean): NetworkType =
        if (allowMobile) NetworkType.CONNECTED else NetworkType.UNMETERED

    // ---- what goes into WorkManager's input data (U7) ----

    /** The one key of the work request. There is no token, box address or certificate key any more. */
    const val KEY_JOB = "job"

    private val JOB_KEYS = listOf("id", "joined", "allowMobile", "joinSegments")
    private val PART_KEYS = listOf("index", "source", "bytes", "uploadId", "uploadUri", "offset", "videoId", "state")
    private val SEGMENT_KEYS = listOf("source", "bytes")

    /**
     * The job as the worker gets it: built key by key from an allow list, so nothing else Dart may put on a job (a
     * session token, a box address, a title) can reach WorkManager's database. Throws on a job with no id or parts.
     */
    fun workJob(job: Map<String, Any?>): String {
        val out = JSONObject()
        for (k in JOB_KEYS) if (job[k] != null) out.put(k, job[k])
        if (out.optString("id").isEmpty()) throw IllegalArgumentException("bad_args")
        val parts = job["parts"] as? List<*> ?: throw IllegalArgumentException("bad_args")
        out.put("parts", pick(parts, PART_KEYS))
        (job["segments"] as? List<*>)?.let { out.put("segments", pick(it, SEGMENT_KEYS)) }
        return out.toString()
    }

    private fun pick(rows: List<*>, keys: List<String>): JSONArray {
        val a = JSONArray()
        for (r in rows) {
            val m = r as? Map<*, *> ?: continue
            val o = JSONObject()
            for (k in keys) if (m[k] != null) o.put(k, m[k])
            a.put(o)
        }
        return a
    }

    /** The input data of the work request: the job and nothing else. */
    fun inputValues(jobJson: String): Map<String, String> = mapOf(KEY_JOB to jobJson)

    /**
     * What makes two requests of one job the same work: the files, the upload addresses and the network rule. The
     * offsets and states are left out, since they move while the worker runs and the worker keeps its own.
     */
    fun jobDigest(jobJson: String): String {
        val j = JSONObject(jobJson)
        val sb = StringBuilder(j.optString("id")).append('|').append(j.optBoolean("allowMobile"))
            .append('|').append(j.optBoolean("joined")).append('|').append(j.optBoolean("joinSegments"))
        val ps = j.optJSONArray("parts") ?: JSONArray()
        for (i in 0 until ps.length()) {
            val p = ps.getJSONObject(i)
            sb.append('|').append(p.optInt("index")).append(',').append(p.optString("source")).append(',')
                .append(p.optLong("bytes")).append(',').append(p.optString("uploadUri")).append(',')
                .append(p.optString("state") == "done")
        }
        val md = java.security.MessageDigest.getInstance("SHA-256").digest(sb.toString().toByteArray(Charsets.UTF_8))
        return md.joinToString("") { "%02x".format(it) }
    }

    /**
     * U8: the same job queued again (the app restarted, the box record changed) must not cancel the worker that is
     * sending it. True = keep the work that exists; false = the job changed (a new upload address, mobile data
     * allowed), so the new request replaces it. A finished work never blocks: KEEP only holds unfinished work.
     */
    fun keepExisting(lastDigest: String?, newDigest: String): Boolean = lastDigest != null && lastDigest == newDigest

    /**
     * What the app is told about the network (B1c). `wifi` promises that a Wi-Fi-only job can run, and WorkManager
     * runs it only on an UNMETERED network: so a metered Wi-Fi (a phone hotspot) counts as `cellular`, and the screen
     * then says it is waiting for Wi-Fi instead of stalling silently.
     */
    fun networkKind(internet: Boolean, wifiOrEthernet: Boolean, cellular: Boolean, unmetered: Boolean): String = when {
        !internet -> "none"
        cellular && !wifiOrEthernet -> "cellular"
        !unmetered -> "cellular"
        else -> "wifi"
    }

    /** WorkManager refuses input data over 10 KB. */
    const val MAX_INPUT_BYTES = 10_240

    /** Headroom for the keys and the type tags WorkManager adds. */
    fun fitsInput(vararg values: String): Boolean =
        values.sumOf { it.toByteArray(Charsets.UTF_8).size } < MAX_INPUT_BYTES - 512

    /** What the worker does about the joined cache file of a job that was collapsed into it. */
    enum class JoinedFilePlan { USE_FILE, REJOIN, MISSING }

    /**
     * The joined file lives in the cache folder, which Android may purge. [partDone]: the video is
     * already up, the file is no longer needed. [canRejoin]: the original segment files are known
     * (all `android:` sources, none of them the joined file itself).
     */
    fun joinedFilePlan(fileExists: Boolean, partDone: Boolean, canRejoin: Boolean): JoinedFilePlan = when {
        fileExists || partDone -> JoinedFilePlan.USE_FILE
        canRejoin -> JoinedFilePlan.REJOIN
        else -> JoinedFilePlan.MISSING
    }

    fun canRejoin(segments: List<PartSpec>?): Boolean =
        !segments.isNullOrEmpty() && segments.all { it.source.startsWith("android:") && it.source != "android:joined" }

    const val TITLE = "MAXCOM memuat naik rakaman"
    const val CANCEL = "Batal"
    const val CHANNEL_ID = "maxcom_upload"
    const val CHANNEL_NAME = "Muat naik rakaman"

    /**
     * The notification body. It takes numbers only, so no upload URI, token, file name or kuliah
     * title can reach the notification.
     */
    fun notificationText(partIndex: Int, partCount: Int, sentBytes: Long, totalBytes: Long): String {
        val pct = percent(sentBytes, totalBytes)
        return if (partCount > 1) {
            "Bahagian $partIndex daripada $partCount: $pct%"
        } else {
            "$pct%"
        }
    }

    fun percent(sent: Long, total: Long): Int =
        if (total <= 0) 0 else (sent.coerceIn(0, total) * 100 / total).toInt()
}
