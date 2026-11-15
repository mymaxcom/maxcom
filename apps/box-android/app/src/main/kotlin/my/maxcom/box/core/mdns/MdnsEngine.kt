package my.maxcom.box.core.mdns

import java.io.IOException
import java.net.DatagramPacket
import java.net.Inet4Address
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.MulticastSocket
import java.net.NetworkInterface
import java.util.concurrent.ScheduledThreadPoolExecutor
import java.util.concurrent.TimeUnit

/** One LAN interface and its IPv4 address; [ni] is null only in tests (no multicast group is joined then). */
class IfaceAddr(val ni: NetworkInterface?, val addr: ByteArray, val prefix: Int, ident: String? = null) {
    init { require(addr.size == 4 && prefix in 0..32) }

    /** The interface identity (name and index); a renamed or re-created interface with the same address differs. */
    val ident: String = ident ?: (ni?.let { it.name + "#" + it.index } ?: "")

    fun contains(other: ByteArray): Boolean {
        if (other.size != 4) return false
        var bits = prefix
        for (i in 0 until 4) {
            val take = minOf(8, bits)
            if (take <= 0) break
            val mask = (0xFF shl (8 - take)) and 0xFF
            if ((addr[i].toInt() and mask) != (other[i].toInt() and mask)) return false
            bits -= take
        }
        return true
    }
}

/**
 * The mDNS node of the box: one socket on UDP 5353 (IPv4 only), answers for `boxN-surau.local` and the
 * `_maxcom._tcp` service while the name is claimed, probes and defends it through [NameClaim]. Java networking only
 * (no Android classes), so a unit test drives it over loopback; the Android wrapper adds the multicast lock and the
 * interface list.
 *
 * All state lives on one single-thread executor; the receiver thread only hands packets to it. A packet is
 * accepted only from a source on one of our own subnets and never from our own addresses; a response must come
 * from port 5353 (RFC 6762 11). Packets are rate limited per source address ([MAX_PACKETS_PER_SOURCE]) in front of
 * the global cap ([MAX_PACKETS_PER_SECOND]), so one flooder cannot starve the others.
 *
 * When the socket cannot be bound or joined, or the receive loop dies, the node reports [bound] false with the
 * [failure] reason and retries after 5 s, 30 s, 2 min and then every 5 min ([onStatus] is told each change).
 */
class MdnsEngine(
    private val port: Int = MDNS_PORT,
    private val multicast: Boolean = true,
    private val random: (Int) -> Int = { bound -> java.util.concurrent.ThreadLocalRandom.current().nextInt(bound) },
    private val nowMs: () -> Long = { System.nanoTime() / 1_000_000 },
    private val onAction: (ClaimAction) -> Unit = {},
    private val log: (String) -> Unit = {},
    /** The source port of real mDNS peers (5353); a test uses another one. Anything else is a legacy unicast asker. */
    private val peerPort: Int = MDNS_PORT,
    /** Asked at each renumber decision (see [NameClaim.renumberGate]); false keeps the current name. */
    private val renumberGate: () -> Boolean = { true },
    /** Called on every change of [bound] with the failure reason (null when bound). */
    private val onStatus: (bound: Boolean, reason: String?) -> Unit = { _, _ -> },
    /** Delays before each bind retry; the last one repeats. */
    private val backoffMs: List<Long> = listOf(5_000L, 30_000L, 120_000L, 300_000L),
    private val maxPerSource: Int = MAX_PACKETS_PER_SOURCE,
) {
    private val exec = ScheduledThreadPoolExecutor(1) { r -> Thread(r, "box-mdns").also { it.isDaemon = true } }
    private var socket: MulticastSocket? = null
    private var ifaces: List<IfaceAddr> = emptyList()
    private var claim: NameClaim? = null
    private var boxId: String? = null
    private var caShort: String? = null
    private var windowStart = 0L
    private var windowCount = 0
    private val sources = HashMap<Int, SourceWindow>()
    private var startN = 1
    private var attempt = 0
    private var retryPending = false

    private class SourceWindow(var start: Long, var count: Int)

    @Volatile
    private var stopped = false

    /** True while the socket is bound and the group joined; false before the first bind and after a failure. */
    @Volatile
    var bound: Boolean = false
        private set

    /** Why the node is not bound (a short class name, no addresses), or null. */
    @Volatile
    var failure: String? = null
        private set

    @Volatile
    var localPort: Int = -1
        private set

    /** The claimed host name, or null while probing, when stopped or when no name is free. */
    @Volatile
    var claimedHost: String? = null
        private set

    @Volatile
    var exhausted: Boolean = false
        private set

    /** Starts the node: binds the socket, joins the group on each interface and begins probing at [startN]. */
    fun start(startN: Int, list: List<IfaceAddr>) {
        post {
            this.startN = startN
            ifaces = list
            attemptBind()
        }
    }

    /** Binds the socket and joins the group; on failure reports it and schedules the retry. Executor only. */
    private fun attemptBind() {
        if (stopped || bound) return
        var s: MulticastSocket? = null
        try {
            s = MulticastSocket(null)
            s.reuseAddress = true
            s.bind(InetSocketAddress(port))
            s.timeToLive = 255
            socket = s
            localPort = s.localPort
            joinAll(ifaces)
            val c = NameClaim(claim?.n ?: startN, random)
            c.renumberGate = renumberGate
            c.setAddresses(ifaces.map { it.addr })
            claim = c
            bound = true
            failure = null
            attempt = 0
            val sock = s
            Thread({ receiveLoop(sock) }, "box-mdns-rx").also { it.isDaemon = true }.start()
            try { onStatus(true, null) } catch (_: Exception) { }
            if (ifaces.isNotEmpty()) c.start(nowMs())
            reschedule()
        } catch (e: Exception) {
            try { s?.close() } catch (_: Exception) { }
            if (socket === s) socket = null
            fail("bind: " + e.javaClass.simpleName)
        }
    }

    /** The claim is released without a conflict (interfaces gone, socket lost): tell the owner the name is gone. */
    private fun released() {
        val h = claimedHost ?: return
        claimedHost = null
        try { onAction(ClaimAction.Lost(h)) } catch (_: Exception) { }
    }

    /** The node is not (or no longer) usable: say so, drop the socket and try again later. Executor only. */
    private fun fail(reason: String) {
        if (stopped) return
        val wasBound = bound
        bound = false
        failure = reason
        exhausted = false
        released()
        claim?.stop()
        try { socket?.close() } catch (_: Exception) { }
        socket = null
        log("mdns not bound: $reason")
        if (wasBound || attempt == 0) try { onStatus(false, reason) } catch (_: Exception) { }
        if (retryPending) return
        retryPending = true
        val delay = backoffMs[minOf(attempt, backoffMs.size - 1)]
        attempt++
        try {
            exec.schedule({ post { retryPending = false; attemptBind() } }, delay, TimeUnit.MILLISECONDS)
        } catch (_: java.util.concurrent.RejectedExecutionException) {
        }
    }

    /**
     * The interface set changed: goodbyes on gone ones, join new ones, probe again at once. A change of interface
     * identity (name or index) with the same addresses counts too: the old membership died with the old interface.
     */
    fun updateInterfaces(list: List<IfaceAddr>) {
        post {
            if (!bound) { ifaces = list; return@post } // the next bind attempt uses the current list
            val c = claim ?: return@post
            if (sameInterfaces(list, ifaces)) return@post
            val removed = ifaces.filter { old -> list.none { sameIface(it, old) } }
            val id = identity()
            if (c.claimed && id != null) for (r in removed) send(r, MdnsAnswerer.goodbye(id, r.addr))
            for (r in removed) leave(r)
            val added = list.filter { n -> ifaces.none { sameIface(it, n) } }
            ifaces = list
            joinAll(added)
            c.setAddresses(list.map { it.addr })
            released()
            if (list.isNotEmpty()) c.restart(nowMs()) else c.stop()
            reschedule()
        }
    }

    /** The public hints in the TXT record changed; announce again when the name is ours. */
    fun setTxt(id: String?, ca: String?) {
        post {
            val changed = id != boxId || ca != caShort
            boxId = id
            caShort = ca
            val c = claim
            if (changed && c != null && c.claimed) announce()
        }
    }

    /** Sends goodbyes, closes the socket and stops the thread. Does not block the caller. */
    fun stop() {
        if (stopped) return
        stopped = true
        try {
            exec.execute {
                try {
                    val c = claim
                    val id = identity()
                    if (c != null && c.claimed && id != null) for (r in ifaces) send(r, MdnsAnswerer.goodbye(id, r.addr))
                } catch (_: Exception) {
                }
                released()
                bound = false
                try { socket?.close() } catch (_: Exception) { }
                socket = null
            }
        } catch (_: java.util.concurrent.RejectedExecutionException) {
        }
        exec.shutdown()
    }

    // ---- internals (all on the executor) --------------------------------------------------------

    private fun post(block: () -> Unit) {
        if (stopped) return
        try {
            exec.execute {
                if (stopped) return@execute
                try { block() } catch (e: Exception) { log("mdns step failed: " + e.javaClass.simpleName) }
            }
        } catch (_: java.util.concurrent.RejectedExecutionException) {
        }
    }

    private fun sameIface(x: IfaceAddr, y: IfaceAddr): Boolean =
        x.addr.contentEquals(y.addr) && x.prefix == y.prefix && x.ident == y.ident

    /** Same addresses, prefixes and interface identities (name + index). */
    private fun sameInterfaces(a: List<IfaceAddr>, b: List<IfaceAddr>): Boolean =
        a.size == b.size && a.all { x -> b.any { y -> sameIface(x, y) } }

    private fun identity(): MdnsIdentity? {
        val c = claim ?: return null
        return MdnsIdentity(c.n, boxId, caShort)
    }

    private fun reschedule() {
        val c = claim ?: return
        val due = c.nextDeadline() ?: return
        val wait = maxOf(0L, due - nowMs())
        try {
            exec.schedule({ post { tick() } }, wait, TimeUnit.MILLISECONDS)
        } catch (_: java.util.concurrent.RejectedExecutionException) {
        }
    }

    private fun tick() {
        val c = claim ?: return
        handle(c.tick(nowMs()))
        reschedule()
    }

    private fun handle(actions: List<ClaimAction>) {
        val c = claim ?: return
        for (a in actions) {
            when (a) {
                is ClaimAction.Probe -> for (r in ifaces) send(r, MdnsAnswerer.probe(a.host, r.addr))
                is ClaimAction.Announce -> announce()
                is ClaimAction.Claimed -> { claimedHost = c.host; exhausted = false }
                is ClaimAction.Lost -> {
                    claimedHost = null
                    val n = a.oldHost.removePrefix("box").substringBefore("-").toIntOrNull()
                    if (n != null) {
                        val old = MdnsIdentity(n, boxId, caShort)
                        for (r in ifaces) send(r, MdnsAnswerer.goodbye(old, r.addr))
                    }
                }
                ClaimAction.Exhausted -> { claimedHost = null; exhausted = true }
                is ClaimAction.RenumberDenied -> log("mdns renumber cap reached, keeping the name")
            }
            try { onAction(a) } catch (_: Exception) { }
        }
        claimedHost = if (c.claimed) c.host else null
    }

    private fun announce() {
        val id = identity() ?: return
        for (r in ifaces) send(r, MdnsAnswerer.announcement(id, r.addr))
    }

    private fun receiveLoop(s: MulticastSocket) {
        val buf = ByteArray(DnsMessage.MAX_PACKET)
        while (!stopped) {
            val p = DatagramPacket(buf, buf.size)
            try {
                s.receive(p)
            } catch (e: IOException) {
                if (!stopped) {
                    log("mdns receive ended: " + e.javaClass.simpleName)
                    post { if (socket === s) fail("receive: " + e.javaClass.simpleName) }
                }
                return
            }
            val data = p.data.copyOfRange(p.offset, p.offset + p.length)
            val from = p.address
            val fromPort = p.port
            post { onPacket(data, from, fromPort) }
        }
    }

    private fun onPacket(data: ByteArray, from: InetAddress, fromPort: Int) {
        val c = claim ?: return
        val src = (from as? Inet4Address)?.address ?: return
        if (ifaces.any { it.addr.contentEquals(src) }) return // our own packet, looped back
        val iface = ifaces.firstOrNull { it.contains(src) } ?: return // not on one of our subnets: ignore
        val now = nowMs()
        // per source first: one flooder runs into its own cap and does not use up the global budget
        val key = ((src[0].toInt() and 0xFF) shl 24) or ((src[1].toInt() and 0xFF) shl 16) or ((src[2].toInt() and 0xFF) shl 8) or (src[3].toInt() and 0xFF)
        if (sources.size > MAX_TRACKED_SOURCES) sources.entries.removeAll { now - it.value.start >= 1000 }
        if (sources.size > MAX_TRACKED_SOURCES) sources.clear()
        val w = sources.getOrPut(key) { SourceWindow(now, 0) }
        if (now - w.start >= 1000) { w.start = now; w.count = 0 }
        if (++w.count > maxPerSource) return
        if (now - windowStart >= 1000) { windowStart = now; windowCount = 0 }
        if (++windowCount > MAX_PACKETS_PER_SECOND) return
        val msg = DnsMessage.decode(data) ?: return
        // Responses and probes (queries that propose records) only count from the mDNS port (RFC 6762 11): a
        // legacy unicast asker can neither claim a conflict nor push the box to another number.
        if ((msg.isResponse || msg.authorities.isNotEmpty()) && fromPort != peerPort) return

        handle(c.onMessage(msg, now))
        reschedule()
        if (!c.claimed || msg.isResponse) return
        val id = identity() ?: return
        val reply = MdnsAnswerer.reply(id, iface.addr, msg, legacy = fromPort != peerPort) ?: return
        // A defence against a probe is always multicast (unless the asker is a legacy non-5353 one): a unicast answer to
        // port 5353 reaches only one of the sockets sharing it (Android's own mDNS daemon may hold it), and the prober
        // could miss the conflict.
        val isProbe = msg.authorities.isNotEmpty()
        if (reply.unicast && (!isProbe || fromPort != peerPort)) sendTo(reply.message, from, fromPort) else send(iface, reply.message)
    }

    private fun send(r: IfaceAddr, m: DnsMessage) {
        if (!multicast) return
        val s = socket ?: return
        try {
            if (r.ni != null) s.networkInterface = r.ni
            val b = m.encode()
            s.send(DatagramPacket(b, b.size, InetAddress.getByName(GROUP), MDNS_PORT))
        } catch (e: IOException) {
            log("mdns send failed: " + e.javaClass.simpleName)
        }
    }

    private fun sendTo(m: DnsMessage, to: InetAddress, toPort: Int) {
        val s = socket ?: return
        try {
            val b = m.encode()
            s.send(DatagramPacket(b, b.size, to, toPort))
        } catch (e: IOException) {
            log("mdns send failed: " + e.javaClass.simpleName)
        }
    }

    /** Joins the group on each interface; throws when there were interfaces to join and none could be joined. */
    private fun joinAll(list: List<IfaceAddr>) {
        val s = socket ?: return
        if (!multicast) return
        var tried = 0
        var joined = 0
        var last: IOException? = null
        for (r in list) {
            val ni = r.ni ?: continue
            tried++
            try {
                s.joinGroup(InetSocketAddress(InetAddress.getByName(GROUP), 0), ni)
                joined++
            } catch (e: IOException) {
                last = e
                log("mdns join failed: " + e.javaClass.simpleName)
            }
        }
        if (tried > 0 && joined == 0) throw IOException("join failed", last)
    }

    private fun leave(r: IfaceAddr) {
        val s = socket ?: return
        val ni = r.ni ?: return
        if (!multicast) return
        try { s.leaveGroup(InetSocketAddress(InetAddress.getByName(GROUP), 0), ni) } catch (_: IOException) { }
    }

    companion object {
        const val MDNS_PORT = 5353
        const val GROUP = "224.0.0.251"
        const val MAX_PACKETS_PER_SECOND = 200
        const val MAX_PACKETS_PER_SOURCE = 20
        private const val MAX_TRACKED_SOURCES = 512
    }
}
