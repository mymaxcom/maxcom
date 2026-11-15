package my.maxcom.box.core.mdns

import my.maxcom.box.core.BoxName

/** What the owner of a [NameClaim] must do next. */
sealed class ClaimAction {
    /** Send a probe (a query for [host], type ANY, with our A records in the authority section) on every interface. */
    data class Probe(val host: String) : ClaimAction()

    /** The name is ours: persist [n] and announce the records (twice, one second apart). */
    data class Claimed(val n: Int) : ClaimAction()

    /** Announce again (second announcement, or after a re-probe kept the name). */
    data class Announce(val host: String) : ClaimAction()

    /** Our name was taken: stop answering for [oldHost] (send goodbyes) before probing the next number. */
    data class Lost(val oldHost: String) : ClaimAction()

    /** All 99 names are taken: advertise nothing, IP access only. */
    object Exhausted : ClaimAction()

    /** A confirmed conflict wanted a new number but the 24 hour renumber cap is used up: the name [host] is kept. */
    data class RenumberDenied(val host: String) : ClaimAction()
}

/**
 * RFC 6762 probing, claiming and defending of `boxN-surau.local` as a pure state machine: no sockets, no
 * threads, no clock of its own. The owner passes the time in milliseconds and feeds in the messages it hears.
 *
 * - [start] and [restart] begin probing at the persisted number: a random 0..250 ms wait, then three probes
 *   250 ms apart, then 250 ms more; with no conflict the name is claimed and announced twice.
 * - A response that carries our host name with an address that is not ours, or a simultaneous probe that wins the
 *   tiebreak against ours (lexicographically later address data), makes us take the next number (never a lower one).
 * - Records with TTL 0 (goodbyes) never count as a conflict.
 * - After the claim, a conflicting response only triggers a re-probe of the same name (at most one per
 *   [REPROBE_GAP_MS]); the name moves only if a conflicting response answers one of OUR probes of that re-probe
 *   (RFC 6762 8.1/9), so one spoofed packet cannot move it. A conflicting probe from another host is simply answered
 *   by the responder.
 * - Every real renumber asks [renumberGate] first (the owner keeps a persisted cap, 3 per 24 h); when it says no the
 *   name is kept ([ClaimAction.RenumberDenied]) and conflicts are ignored for [RENUMBER_GAP_MS].
 * - Flap guard: after the first claim at most one renumber per [RENUMBER_GAP_MS]; 15 conflicts within 10 s pause the
 *   machine for 5 s. Before the first claim (boot) a renumber is not delayed by the 60 s rule.
 * - At 99 with no free name the state is [State.EXHAUSTED] ([ClaimAction.Exhausted]).
 */
class NameClaim(
    startN: Int,
    private val random: (bound: Int) -> Int,
) {
    enum class State { IDLE, WAITING, PROBING, CLAIMED, EXHAUSTED }

    var state: State = State.IDLE
        private set
    var n: Int = startN.coerceIn(1, BoxName.MAX_N)
        private set
    private val startNumber = n

    /** Our IPv4 addresses (4 bytes each), all interfaces; set by the owner before [start]. */
    private var addrs: List<ByteArray> = emptyList()

    private var nextAt = 0L
    private var probesSent = 0
    private var announcesLeft = 0
    private var reprobe = false
    private var everClaimed = false
    private var lastRenumberAt = Long.MIN_VALUE
    private val conflicts = ArrayDeque<Long>()
    private var reprobeNotBefore = Long.MIN_VALUE
    private var quietUntil = Long.MIN_VALUE

    /**
     * Asked at the moment a renumber is decided; true allows it (and the owner records it), false keeps the name.
     * Called on the owner's thread, must be quick.
     */
    var renumberGate: () -> Boolean = { true }

    val host: String get() = BoxName.hostFor(n)

    /** True while the box may answer queries for its name. */
    val claimed: Boolean get() = state == State.CLAIMED

    fun setAddresses(list: List<ByteArray>) {
        addrs = list.map { it.copyOf() }
    }

    /** Begin (or begin again after a network change) probing at the current number. */
    fun start(now: Long): List<ClaimAction> {
        if (state == State.EXHAUSTED) n = startNumber
        beginProbing(now, immediate = false)
        return emptyList()
    }

    fun restart(now: Long): List<ClaimAction> = start(now)

    /** Stop claiming (no network); the number is kept for the next [start]. */
    fun stop() {
        state = State.IDLE
        announcesLeft = 0
        reprobe = false
    }

    /** The earliest time [tick] has work, or null when nothing is pending. */
    fun nextDeadline(): Long? = when (state) {
        State.WAITING, State.PROBING -> nextAt
        State.CLAIMED -> if (announcesLeft > 0) nextAt else null
        else -> null
    }

    fun tick(now: Long): List<ClaimAction> {
        val out = ArrayList<ClaimAction>()
        when (state) {
            State.WAITING -> if (now >= nextAt) beginProbing(now, immediate = true)
            State.PROBING -> if (now >= nextAt) {
                if (probesSent < PROBES) {
                    probesSent++
                    nextAt = now + PROBE_GAP_MS
                    out.add(ClaimAction.Probe(host))
                } else {
                    state = State.CLAIMED
                    everClaimed = true
                    announcesLeft = 1
                    nextAt = now + ANNOUNCE_GAP_MS
                    out.add(ClaimAction.Claimed(n))
                    out.add(ClaimAction.Announce(host))
                    if (reprobe) reprobe = false
                }
            }
            State.CLAIMED -> if (announcesLeft > 0 && now >= nextAt) {
                announcesLeft--
                out.add(ClaimAction.Announce(host))
            }
            else -> Unit
        }
        return out
    }

    /** A message heard on the wire. The owner drops packets that came from our own addresses first. */
    fun onMessage(msg: DnsMessage, now: Long): List<ClaimAction> {
        if (state != State.PROBING && state != State.CLAIMED) return emptyList()
        if (now < quietUntil) return emptyList()
        val key = dnsKey(host)
        if (msg.isResponse) {
            // TTL 0 is a goodbye: the sender gives the name up, it never contests ours
            val theirs = (msg.answers + msg.additionals).filter { it.type == DnsType.A && it.ttl > 0 && dnsKey(it.name) == key }
            if (theirs.isEmpty()) return emptyList()
            if (theirs.all { isOurs(it) }) return emptyList()
            if (state == State.CLAIMED) {
                // not confirmed yet: look again, and let only an answer to one of our probes move the name
                if (now < reprobeNotBefore) return emptyList()
                reprobe = true
                reprobeNotBefore = now + REPROBE_GAP_MS
                beginProbing(now, immediate = false)
                return emptyList()
            }
            // a re-probe: only an answer that comes after our first probe of it is a confirmed conflict
            if (reprobe && probesSent == 0) return emptyList()
            return conflict(now)
        }
        // a probe from another host: a query naming our host with proposed records in the authority section
        if (state == State.PROBING && !reprobe && msg.questions.any { dnsKey(it.name) == key }) {
            val theirs = msg.authorities.filter { it.type == DnsType.A && dnsKey(it.name) == key }
            if (theirs.isEmpty()) return emptyList()
            if (theirs.all { isOurs(it) }) return emptyList()
            return if (loses(theirs)) conflict(now) else emptyList()
        }
        return emptyList()
    }

    private fun isOurs(r: DnsRecord): Boolean {
        val a = r.data as? RData.A ?: return false
        return addrs.any { it.contentEquals(a.addr) }
    }

    /** RFC 6762 8.2: the host whose data sorts later wins; we lose when ours sorts earlier. */
    private fun loses(theirs: List<DnsRecord>): Boolean {
        val mine = addrs.sortedWith(::compareBytes)
        val other = theirs.mapNotNull { (it.data as? RData.A)?.addr }.sortedWith(::compareBytes)
        val c = compareLists(mine, other)
        return c < 0
    }

    private fun conflict(now: Long): List<ClaimAction> {
        val out = ArrayList<ClaimAction>()
        conflicts.addLast(now)
        while (conflicts.isNotEmpty() && now - conflicts.first() > STORM_WINDOW_MS) conflicts.removeFirst()
        val storm = conflicts.size >= STORM_COUNT
        val old = host
        if (n < BoxName.MAX_N && !renumberGate()) {
            // the persisted cap is used up: keep the name (spoofing must not walk the box through the numbers)
            reprobe = false
            quietUntil = now + RENUMBER_GAP_MS
            state = State.CLAIMED
            everClaimed = true
            announcesLeft = 1
            nextAt = now + ANNOUNCE_GAP_MS
            out.add(ClaimAction.RenumberDenied(old))
            out.add(ClaimAction.Claimed(n))
            out.add(ClaimAction.Announce(old))
            return out
        }
        if (everClaimed) out.add(ClaimAction.Lost(old))
        if (n >= BoxName.MAX_N) {
            state = State.EXHAUSTED
            nextAt = 0
            out.add(ClaimAction.Exhausted)
            return out
        }
        n++
        reprobe = false
        var wait = 0L
        if (everClaimed && lastRenumberAt != Long.MIN_VALUE) wait = maxOf(wait, lastRenumberAt + RENUMBER_GAP_MS - now)
        if (storm) wait = maxOf(wait, STORM_PAUSE_MS)
        if (everClaimed) lastRenumberAt = now
        if (wait > 0) {
            state = State.WAITING
            nextAt = now + wait
        } else {
            beginProbing(now, immediate = false)
        }
        return out
    }

    private fun beginProbing(now: Long, immediate: Boolean) {
        state = State.PROBING
        probesSent = 0
        announcesLeft = 0
        nextAt = now + if (immediate) 0 else random(INITIAL_JITTER_MS + 1).toLong()
    }

    companion object {
        const val PROBES = 3
        const val PROBE_GAP_MS = 250L
        const val ANNOUNCE_GAP_MS = 1000L
        const val INITIAL_JITTER_MS = 250
        const val RENUMBER_GAP_MS = 60_000L
        const val REPROBE_GAP_MS = 10_000L
        const val STORM_COUNT = 15
        const val STORM_WINDOW_MS = 10_000L
        const val STORM_PAUSE_MS = 5_000L

        private fun compareBytes(a: ByteArray, b: ByteArray): Int {
            for (i in 0 until minOf(a.size, b.size)) {
                val d = (a[i].toInt() and 0xFF) - (b[i].toInt() and 0xFF)
                if (d != 0) return d
            }
            return a.size - b.size
        }

        private fun compareLists(a: List<ByteArray>, b: List<ByteArray>): Int {
            for (i in 0 until minOf(a.size, b.size)) {
                val d = compareBytes(a[i], b[i])
                if (d != 0) return d
            }
            return a.size - b.size
        }
    }
}
