package my.maxcom.box.core.mdns

import java.io.File
import java.io.IOException
import java.time.Duration
import java.time.Instant
import java.time.format.DateTimeParseException
import my.maxcom.box.core.BoxCa
import my.maxcom.box.core.BoxName

/** The persisted claim: number [n] (1..99), when it was first claimed and when it was last renumbered (newest last). */
data class StoredName(val n: Int, val claimedAt: Instant, val renumbers: List<Instant> = emptyList())

/**
 * `data/box-name.json`: `{ "n": 1, "claimedAt": "2026-11-14T10:00:00Z", "renumbers": [1794650000] }`. The optional
 * `renumbers` array holds epoch seconds of the renumbers done in the last 24 hours (the cap is [MAX_RENUMBERS_PER_DAY]).
 * Read strictly (a damaged or odd file is "no name", never a guess), written as a temporary file then an atomic rename,
 * so a power cut leaves the old value or the new one.
 */
class BoxNameStore(private val file: File) {
    fun read(): StoredName? {
        if (!file.isFile || file.length() > MAX_BYTES) return null
        val text = try { file.readText(Charsets.UTF_8) } catch (e: IOException) { return null }
        if (!OBJECT.matches(text)) return null
        val n = N.find(text)?.groupValues?.get(1)?.toIntOrNull() ?: return null
        if (n !in 1..BoxName.MAX_N) return null
        val at = CLAIMED.find(text)?.groupValues?.get(1) ?: return null
        val instant = try { Instant.parse(at) } catch (e: DateTimeParseException) { return null }
        val renumbers = RENUMBERS.find(text)?.groupValues?.get(1)?.let { list ->
            list.split(',').mapNotNull { it.trim().toLongOrNull() }.take(MAX_STORED).map { Instant.ofEpochSecond(it) }
        } ?: emptyList()
        return StoredName(n, instant, renumbers)
    }

    /** Writes the claim; the stored renumber times are kept (only the ones of the last 24 hours). */
    fun write(n: Int, claimedAt: Instant) {
        write(n, claimedAt, read()?.renumbers ?: emptyList())
    }

    private fun write(n: Int, claimedAt: Instant, renumbers: List<Instant>) {
        require(n in 1..BoxName.MAX_N) { "box number must be 1..${BoxName.MAX_N}" }
        val tail = if (renumbers.isEmpty()) "" else ",\"renumbers\":[" + renumbers.joinToString(",") { it.epochSecond.toString() } + "]"
        val json = "{\"n\":$n,\"claimedAt\":\"$claimedAt\"$tail}\n"
        BoxCa.writeAtomic(file.toPath(), json.toByteArray(Charsets.US_ASCII), secret = false)
    }

    /** How many renumbers are recorded within 24 hours before [now]. */
    fun renumbersInLastDay(now: Instant): Int {
        val cutoff = now.minus(WINDOW)
        return read()?.renumbers?.count { it.isAfter(cutoff) } ?: 0
    }

    /**
     * The renumber cap: when fewer than [MAX_RENUMBERS_PER_DAY] renumbers happened in the last 24 hours, records one
     * at [now] and returns true; otherwise records nothing and returns false. With no stored name the box has never
     * claimed one, so there is nothing to cap and the first claim is allowed.
     */
    fun tryRecordRenumber(now: Instant): Boolean {
        val cur = read() ?: return true
        val cutoff = now.minus(WINDOW)
        // an entry in the future (the box clock was wrong when it was written) still counts: the cap errs safe
        val recent = cur.renumbers.filter { it.isAfter(cutoff) }
        if (recent.size >= MAX_RENUMBERS_PER_DAY) return false
        write(cur.n, cur.claimedAt, recent + now)
        return true
    }

    /** Stores the claimed number; `claimedAt` changes only when the number does; the renumber record is kept. */
    fun persistClaim(n: Int, now: Instant) {
        val cur = read()
        if (cur?.n == n) return
        write(n, now, cur?.renumbers ?: emptyList())
    }

    companion object {
        const val MAX_RENUMBERS_PER_DAY = 3
        private val WINDOW: Duration = Duration.ofHours(24)
        private const val MAX_STORED = 16
        private const val MAX_BYTES = 1024L
        private val OBJECT = Regex("^\\s*\\{[^{}]*\\}\\s*$")
        private val N = Regex("\"n\"\\s*:\\s*([0-9]{1,3})\\s*[,}]")
        private val CLAIMED = Regex("\"claimedAt\"\\s*:\\s*\"([0-9TZ:.+-]{10,40})\"")
        private val RENUMBERS = Regex("\"renumbers\"\\s*:\\s*\\[([0-9,\\s]{0,400})]")
    }
}
