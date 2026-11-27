package my.maxcom.box.core

import java.io.ByteArrayOutputStream
import java.io.InputStream
import java.net.HttpURLConnection
import java.net.URL
import org.json.JSONObject

/** What the box server says about a follower: the name of the main box it follows (may be empty). */
class FollowerInfo(val masterName: String)

object FollowerInfoParser {
    private const val MAX_NAME = 60

    /**
     * The box state answer (`GET /api/box/state`) as a follower reads it. Null for a main box (`mode` absent or
     * not `follower`, which is also how an old server answers) and for anything that is not a JSON object.
     */
    fun parse(body: String): FollowerInfo? = try {
        val json = JSONObject(body)
        if (json.optString("mode", "") != "follower") null
        else FollowerInfo(cleanName(json.optJSONObject("master")?.optString("name", "") ?: ""))
    } catch (_: Exception) {
        null
    }

    /** One line of printable text: control characters become spaces, the ends are trimmed, the length is capped. */
    fun cleanName(raw: String): String =
        raw.map { if (it.isISOControl()) ' ' else it }.joinToString("").trim().replace(Regex(" {2,}"), " ").take(MAX_NAME).trim()
}

/** The recovery code from before the link, as a person types it on the remote: 16 letters or digits, dashes and spaces allowed. */
object RecoveryCodeInput {
    const val LENGTH = 16

    /** Dashes and spaces dropped, upper case: the same cleaning the box server does. */
    fun normalise(raw: String): String = raw.filter { !it.isWhitespace() && it != '-' }.uppercase()

    /** True when the cleaned input has the length of a code and only letters and digits. */
    fun isComplete(raw: String): Boolean {
        val n = normalise(raw)
        return n.length == LENGTH && n.all { it in 'A'..'Z' || it in '0'..'9' }
    }
}

/** The answer of `POST /api/follow/revert` or `POST /api/follow/empty`. A refusal is a code, never a sentence. */
sealed class LeaveAnswer {
    /** 200: the box restarts by itself. */
    object Done : LeaveAnswer()

    /** A refusal code of the server (`wrong_code`, `locked`, `no_backup`, `has_backup`, `not_local`, ...). */
    class Refused(val code: String, val retryAfterSec: Int) : LeaveAnswer()

    /** The box server did not answer. */
    object Unreachable : LeaveAnswer()
}

object LeaveAnswerParser {
    private val CODE = Regex("[a-z][a-z0-9_]{0,31}")

    /** The status and body of one answer as the screen reads it. */
    fun parse(status: Int, body: String): LeaveAnswer {
        val json = try { JSONObject(body) } catch (_: Exception) { null }
        if (status == 200) {
            return if (json != null && json.optBoolean("ok", false)) LeaveAnswer.Done else LeaveAnswer.Refused("unknown", 0)
        }
        var code = json?.optString("code", "") ?: ""
        if (code.isEmpty()) code = json?.optJSONArray("errors")?.optString(0, "") ?: ""
        if (!CODE.matches(code)) code = "unknown"
        val retry = (json?.optInt("retryAfterSec", 0) ?: 0).coerceIn(0, 7200)
        return LeaveAnswer.Refused(code, retry)
    }

    /** The one sentence for a refusal: the name of its string (`leave_err_<key>`); the code itself is shown only for the generic line. */
    fun textKey(code: String): String = when (code) {
        "wrong_code", "locked", "no_backup", "has_backup", "not_local" -> code
        else -> "generic"
    }

    /** Whole minutes to wait for a `locked` answer, at least one. */
    fun minutes(retryAfterSec: Int): Int = maxOf(1, (retryAfterSec + 59) / 60)

    /** The JSON body of the revert call: the cleaned code, escaped by the JSON writer. */
    fun revertBody(rawCode: String): String = JSONObject().put("recoveryCode", RecoveryCodeInput.normalise(rawCode)).toString()
}

/**
 * The per-start secret that lets this app, and only this app, ask the box server to leave a follow. [BoxService] makes it
 * at each start, gives it to the server child as `SURAU_LEAVE_SECRET` and holds it here in memory (never on disk, never
 * in a log). The maintenance screen reads it and sends it as header `X-Maxcom-Leave`.
 */
object LeaveSecret {
    @Volatile
    private var value: String? = null

    fun set(secret: String) {
        value = secret
    }

    /** Null before the first service start of this process: the calls are then sent without it and the server refuses. */
    fun get(): String? = value

    fun clear() {
        value = null
    }
}

/** Asks the box server on loopback whether this box is a follower: `GET /api/box/state` (loopback alone may read it). */
class FollowerClient(private val host: String = "127.0.0.1", private val timeoutMs: Int = 2000) {
    /** `POST /api/follow/revert`: back to the data from before the link. The code is not logged and not kept. */
    fun revert(port: Int, rawCode: String, secret: String? = LeaveSecret.get()): LeaveAnswer =
        post(port, "/api/follow/revert", LeaveAnswerParser.revertBody(rawCode), secret)

    /** `POST /api/follow/empty`: a box that was new returns to first setup. */
    fun empty(port: Int, secret: String? = LeaveSecret.get()): LeaveAnswer = post(port, "/api/follow/empty", "{}", secret)

    /** The secret goes in the header `X-Maxcom-Leave` and nowhere else; without it the server answers `not_local`. */
    private fun post(port: Int, path: String, json: String, secret: String?): LeaveAnswer {
        var conn: HttpURLConnection? = null
        return try {
            conn = (URL("http", host, port, path).openConnection() as HttpURLConnection).apply {
                connectTimeout = LEAVE_TIMEOUT_MS
                readTimeout = LEAVE_TIMEOUT_MS
                instanceFollowRedirects = false
                useCaches = false
                requestMethod = "POST"
                doOutput = true
                setRequestProperty("Content-Type", "application/json")
                if (!secret.isNullOrEmpty()) setRequestProperty(LEAVE_HEADER, secret)
            }
            conn.outputStream.use { it.write(json.toByteArray(Charsets.UTF_8)) }
            val status = conn.responseCode
            val stream = if (status in 200..399) conn.inputStream else conn.errorStream
            val body = stream?.use { readCapped(it, MAX_BODY) } ?: ByteArray(0)
            LeaveAnswerParser.parse(status, String(body, Charsets.UTF_8))
        } catch (_: Exception) {
            LeaveAnswer.Unreachable
        } finally {
            try {
                conn?.disconnect()
            } catch (_: Exception) {
            }
        }
    }

    fun read(port: Int): FollowerInfo? {
        var conn: HttpURLConnection? = null
        return try {
            conn = (URL("http", host, port, "/api/box/state").openConnection() as HttpURLConnection).apply {
                connectTimeout = timeoutMs
                readTimeout = timeoutMs
                instanceFollowRedirects = false
                useCaches = false
                requestMethod = "GET"
            }
            if (conn.responseCode != 200) return null
            val body = conn.inputStream.use { readCapped(it, MAX_BODY) }
            FollowerInfoParser.parse(String(body, Charsets.UTF_8))
        } catch (_: Exception) {
            null
        } finally {
            try {
                conn?.disconnect()
            } catch (_: Exception) {
            }
        }
    }

    private fun readCapped(input: InputStream, max: Int): ByteArray {
        val out = ByteArrayOutputStream()
        val buf = ByteArray(2048)
        while (out.size() < max) {
            val n = input.read(buf, 0, minOf(buf.size, max - out.size()))
            if (n < 0) break
            out.write(buf, 0, n)
        }
        return out.toByteArray()
    }

    private companion object {
        const val MAX_BODY = 64 * 1024
        const val LEAVE_TIMEOUT_MS = 15_000
        const val LEAVE_HEADER = "X-Maxcom-Leave"
    }
}
