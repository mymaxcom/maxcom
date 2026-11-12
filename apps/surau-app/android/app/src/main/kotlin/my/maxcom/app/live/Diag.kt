package my.maxcom.app.live

import android.content.Context
import java.io.File
import java.text.SimpleDateFormat
import java.util.ArrayDeque
import java.util.Date
import java.util.Locale
import java.util.TimeZone

/**
 * A bounded ring of diagnostic lines, `ISO-time event facts`. It exists
 * because some devices hide app logcat. A line carries an event name and
 * short facts only; anything that looks like a URL, a key, a passphrase, a
 * stream id or a token is dropped to `redacted`. Pure: no Android classes.
 */
class DiagRing(private val max: Int = MAX_LINES) {
    companion object {
        const val MAX_LINES = 200
        private const val MAX_FACTS = 120
        private val FORBIDDEN = listOf(
            "://", "srt:", "rtmp", "passphrase", "streamid", "stream_id", "token", "secret", "password", "key=",
        )

        fun isoTime(millis: Long): String {
            val f = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US)
            f.timeZone = TimeZone.getTimeZone("UTC")
            return f.format(Date(millis))
        }

        fun cleanEvent(event: String): String =
            event.lowercase(Locale.US).replace(Regex("[^a-z0-9_.-]"), "_").take(40).ifEmpty { "event" }

        fun cleanFacts(facts: String): String {
            val one = facts.replace(Regex("[\\r\\n\\t]+"), " ").trim().take(MAX_FACTS)
            val low = one.lowercase(Locale.US)
            return if (FORBIDDEN.any { low.contains(it) }) "redacted" else one
        }

        fun line(millis: Long, event: String, facts: String): String {
            val f = cleanFacts(facts)
            val e = cleanEvent(event)
            return if (f.isEmpty()) "${isoTime(millis)} $e" else "${isoTime(millis)} $e $f"
        }
    }

    private val lines = ArrayDeque<String>()

    @Synchronized
    fun load(existing: List<String>) {
        lines.clear()
        existing.takeLast(max).forEach { lines.addLast(it) }
    }

    /** Adds one line, drops the oldest past the cap, returns the line. */
    @Synchronized
    fun add(millis: Long, event: String, facts: String = ""): String {
        val l = line(millis, event, facts)
        lines.addLast(l)
        while (lines.size > max) lines.removeFirst()
        return l
    }

    @Synchronized
    fun snapshot(): List<String> = lines.toList()
}

/**
 * The on-device diagnostic file `getExternalFilesDir(null)/maxcom-diag.log`.
 * Append-only in effect: the newest 200 lines are kept. Never throws; nothing
 * here is sent to the box or the network.
 */
object Diag {
    const val FILE_NAME = "maxcom-diag.log"

    private val ring = DiagRing()
    private var file: File? = null

    @Synchronized
    fun init(context: Context) {
        if (file != null) return
        val dir = context.applicationContext.getExternalFilesDir(null) ?: return
        val f = File(dir, FILE_NAME)
        try {
            if (f.exists()) ring.load(f.readLines())
        } catch (_: Exception) {
        }
        file = f
    }

    fun log(event: String, facts: String = "") {
        try {
            ring.add(System.currentTimeMillis(), event, facts)
            val f = synchronized(this) { file } ?: return
            synchronized(this) { f.writeText(ring.snapshot().joinToString("\n", postfix = "\n")) }
        } catch (_: Exception) {
        }
    }

    /** An exception is recorded by its type only. */
    fun error(event: String, e: Throwable) = log(event, "type=" + e.javaClass.simpleName)
}
