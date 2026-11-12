package my.maxcom.app.upload

import org.json.JSONArray
import org.json.JSONObject

/** One part of a job as Dart sends it (`UploadPart.toJson`). */
data class PartSpec(
    val index: Int,
    val source: String,
    val bytes: Long,
    val uploadId: String? = null,
    val uploadUri: String? = null,
    val offset: Long = 0,
    val videoId: String? = null,
    val done: Boolean = false,
) {
    // The generated toString would print the upload URI.
    override fun toString() = "PartSpec($index, offset=$offset/$bytes)"
}

/** A job as Dart sends it (`UploadJob.toJson`). */
data class JobSpec(
    val id: String,
    val kuliahId: String?,
    val parts: List<PartSpec>,
    val joined: Boolean,
    val allowMobile: Boolean,
    val replaceLiveVideoId: String?,
    val joinSegments: Boolean,
    /**
     * The original segment files once the job collapsed into one `android:joined` part (Dart sends
     * them only then). Null before the join: the parts are the segments.
     */
    val segments: List<PartSpec>? = null,
) {
    companion object {
        fun parse(json: String): JobSpec {
            val j = JSONObject(json)
            val ps = j.getJSONArray("parts")
            val sg = j.optJSONArray("segments")
            return JobSpec(
                id = j.getString("id"),
                kuliahId = j.optStringOrNull("kuliahId"),
                parts = (0 until ps.length()).map { i ->
                    val p = ps.getJSONObject(i)
                    PartSpec(
                        index = p.getInt("index"),
                        source = p.getString("source"),
                        bytes = p.getLong("bytes"),
                        uploadId = p.optStringOrNull("uploadId"),
                        uploadUri = p.optStringOrNull("uploadUri"),
                        offset = p.optLong("offset", 0),
                        videoId = p.optStringOrNull("videoId"),
                        done = p.optString("state") == "done",
                    )
                },
                joined = j.optBoolean("joined", false),
                allowMobile = j.optBoolean("allowMobile", false),
                replaceLiveVideoId = j.optStringOrNull("replaceLiveVideoId"),
                joinSegments = j.optBoolean("joinSegments", false),
                segments = sg?.let { a ->
                    (0 until a.length()).map { i ->
                        val s = a.getJSONObject(i)
                        PartSpec(index = i + 1, source = s.getString("source"), bytes = s.optLong("bytes", 0))
                    }
                },
            )
        }
    }
}

internal fun JSONObject.optStringOrNull(key: String): String? =
    if (!has(key) || isNull(key)) null else getString(key)

/** Where a part stands; kept between runs so a retry resumes instead of starting over. */
class PartState(
    var state: String = "queued",
    var offset: Long = 0,
    var uploadId: String? = null,
    var uploadUri: String? = null,
    var videoId: String? = null,
)

class JobState(
    val parts: MutableMap<Int, PartState> = linkedMapOf(),
    var joined: Boolean = false,
    var joinedPath: String? = null,
    var joinedBytes: Long = 0,
) {
    fun toJson(): String {
        val o = JSONObject()
        val ps = JSONObject()
        for ((i, p) in parts) {
            ps.put(
                i.toString(),
                JSONObject()
                    .put("state", p.state)
                    .put("offset", p.offset)
                    .put("uploadId", p.uploadId ?: JSONObject.NULL)
                    .put("uploadUri", p.uploadUri ?: JSONObject.NULL)
                    .put("videoId", p.videoId ?: JSONObject.NULL),
            )
        }
        return o.put("parts", ps).put("joined", joined)
            .put("joinedPath", joinedPath ?: JSONObject.NULL)
            .put("joinedBytes", joinedBytes).toString()
    }

    companion object {
        fun fromJson(json: String): JobState {
            val o = JSONObject(json)
            val s = JobState(joined = o.optBoolean("joined"), joinedPath = o.optStringOrNull("joinedPath"),
                joinedBytes = o.optLong("joinedBytes"))
            val ps = o.optJSONObject("parts") ?: JSONObject()
            val keys = ps.keys()
            while (keys.hasNext()) {
                val k = keys.next()
                val p = ps.getJSONObject(k)
                s.parts[k.toInt()] = PartState(
                    state = p.optString("state", "queued"),
                    offset = p.optLong("offset"),
                    uploadId = p.optStringOrNull("uploadId"),
                    uploadUri = p.optStringOrNull("uploadUri"),
                    videoId = p.optStringOrNull("videoId"),
                )
            }
            return s
        }
    }
}

interface UploadStateStore {
    fun load(jobId: String): JobState?
    fun save(jobId: String, state: JobState)
    fun clear(jobId: String)
    fun all(): Map<String, JobState>
}

class MemoryStateStore : UploadStateStore {
    private val m = linkedMapOf<String, String>()
    override fun load(jobId: String) = m[jobId]?.let { JobState.fromJson(it) }
    override fun save(jobId: String, state: JobState) { m[jobId] = state.toJson() }
    override fun clear(jobId: String) { m.remove(jobId) }
    override fun all() = m.mapValues { JobState.fromJson(it.value) }
}

/** What the worker reports; [toMap] is what crosses the event channel. */
data class UploadEvent(
    val jobId: String,
    val partIndex: Int,
    val state: String,
    val offset: Long? = null,
    val total: Long? = null,
    val uploadId: String? = null,
    val uploadUri: String? = null,
    val videoId: String? = null,
    val error: String? = null,
    val resetsAt: String? = null,
    val joined: Boolean? = null,
    val clearSession: Boolean = false,
) {
    fun toMap(): Map<String, Any?> = mapOf(
        "jobId" to jobId, "partIndex" to partIndex, "state" to state, "offset" to offset,
        "total" to total, "uploadId" to uploadId, "uploadUri" to uploadUri, "videoId" to videoId,
        "error" to error, "resetsAt" to resetsAt, "joined" to joined, "clearSession" to clearSession,
    )

    // No URI: this is what a log line would show.
    override fun toString() = "UploadEvent($jobId, $partIndex, $state)"
}
