package my.maxcom.box.core.mdns

import java.net.DatagramPacket
import java.net.DatagramSocket
import java.net.InetAddress
import java.util.concurrent.CopyOnWriteArrayList
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The responder over real UDP on loopback: the engine binds an ephemeral port instead of 5353 and joins no
 * multicast group; the client's source port is not 5353, so it is a "legacy unicast" asker and gets a unicast answer.
 */
class MdnsEngineLoopbackTest {
    private val ours = byteArrayOf(127, 0, 0, 2)
    private val iface = IfaceAddr(null, ours, 8)
    private val actions = CopyOnWriteArrayList<ClaimAction>()
    private var engine: MdnsEngine? = null

    private fun engine(jitter: Int, peerPort: Int = MdnsEngine.MDNS_PORT): MdnsEngine =
        MdnsEngine(port = 0, multicast = false, random = { jitter }, onAction = { actions.add(it) }, peerPort = peerPort).also { engine = it }

    @After
    fun stop() {
        engine?.stop()
    }

    private fun waitFor(ms: Long = 6000, cond: () -> Boolean): Boolean {
        val end = System.nanoTime() + ms * 1_000_000
        while (System.nanoTime() < end) {
            if (cond()) return true
            Thread.sleep(20)
        }
        return cond()
    }

    private fun ask(port: Int, msg: DnsMessage): DnsMessage? {
        DatagramSocket().use { s ->
            s.soTimeout = 2000
            val b = msg.encode()
            s.send(DatagramPacket(b, b.size, InetAddress.getByName("127.0.0.1"), port))
            val buf = ByteArray(9000)
            val p = DatagramPacket(buf, buf.size)
            return try {
                s.receive(p)
                DnsMessage.decode(p.data.copyOfRange(0, p.length))
            } catch (e: java.net.SocketTimeoutException) {
                null
            }
        }
    }

    private fun send(port: Int, msg: DnsMessage) {
        DatagramSocket().use { s ->
            val b = msg.encode()
            s.send(DatagramPacket(b, b.size, InetAddress.getByName("127.0.0.1"), port))
        }
    }

    @Test
    fun aQuietNetworkClaimsTheStoredNumberAndAnswersAQuery() {
        val e = engine(jitter = 0)
        e.start(3, listOf(iface))
        assertTrue("claimed", waitFor { e.claimedHost != null })
        assertEquals("box3-surau.local", e.claimedHost)
        assertTrue(actions.contains(ClaimAction.Claimed(3)))

        val reply = ask(e.localPort, DnsMessage(0x4321, 0, listOf(DnsQuestion("Box3-Surau.Local", DnsType.A))))
        assertNotNull("an answer", reply)
        assertEquals(0x4321, reply!!.id)
        val a = reply.answers.single { it.type == DnsType.A }
        assertEquals(RData.A(ours), a.data)
        assertEquals("box3-surau.local", dnsKey(a.name))
    }

    @Test
    fun theServiceIsDiscoverableWithTheHints() {
        val e = engine(jitter = 0)
        e.start(1, listOf(iface))
        assertTrue(waitFor { e.claimedHost != null })
        e.setTxt("0123456789abcdef", "fedcba9876543210")
        Thread.sleep(200)
        val reply = ask(e.localPort, DnsMessage(9, 0, listOf(DnsQuestion("_maxcom._tcp.local", DnsType.PTR))))!!
        assertEquals(RData.Ptr("MAXCOM box1._maxcom._tcp.local"), reply.answers.single().data)
        val txt = reply.additionals.first { it.type == DnsType.TXT }.data as RData.Txt
        assertEquals(listOf("v=1", "id=0123456789abcdef", "ca=fedcba9876543210"), txt.strings)
    }

    @Test
    fun noAnswerBeforeTheNameIsClaimed() {
        val e = engine(jitter = 250)
        e.start(1, listOf(iface))
        assertTrue(waitFor { e.localPort > 0 })
        assertNull(e.claimedHost)
        // inside the probe window (the claim needs at least 1 s here) the query is dropped, not answered
        assertNull(ask(e.localPort, DnsMessage(2, 0, listOf(DnsQuestion("box1-surau.local", DnsType.A)))))
    }

    @Test
    fun aSimultaneousProbeWithLaterDataMakesTheEngineTakeTheNextNumber() {
        // the "other host" sends from its own fixed port, which this engine treats as the mDNS port
        DatagramSocket().use { peer ->
            val e = engine(jitter = 250, peerPort = peer.localPort)
            e.start(1, listOf(iface))
            assertTrue(waitFor { e.localPort > 0 })
            Thread.sleep(300) // inside the probing window
            assertNull(e.claimedHost)
            val b = MdnsAnswerer.probe("box1-surau.local", byteArrayOf(127, 0, 0, 9)).encode()
            peer.send(DatagramPacket(b, b.size, InetAddress.getByName("127.0.0.1"), e.localPort))
            assertTrue("claimed 2", waitFor { e.claimedHost == "box2-surau.local" })
            assertTrue(actions.contains(ClaimAction.Claimed(2)))
            assertFalse(actions.contains(ClaimAction.Claimed(1)))
        }
    }

    @Test
    fun aProbeOrAResponseFromAnotherSourcePortIsIgnored() {
        val e = engine(jitter = 250)
        e.start(1, listOf(iface))
        assertTrue(waitFor { e.localPort > 0 })
        Thread.sleep(300)
        send(e.localPort, MdnsAnswerer.probe("box1-surau.local", byteArrayOf(127, 0, 0, 9)))
        send(e.localPort, DnsMessage.response(listOf(DnsRecord("box1-surau.local", DnsType.A, RData.A(byteArrayOf(127, 0, 0, 9)), 120))))
        assertTrue("still box1", waitFor { e.claimedHost == "box1-surau.local" })
        assertFalse(actions.contains(ClaimAction.Claimed(2)))
    }

    @Test
    fun otherNamesGetNothing() {
        val e = engine(jitter = 0)
        e.start(1, listOf(iface))
        assertTrue(waitFor { e.claimedHost != null })
        assertNull(ask(e.localPort, DnsMessage(5, 0, listOf(DnsQuestion("box2-surau.local", DnsType.A)))))
        assertNull(ask(e.localPort, DnsMessage(6, 0, listOf(DnsQuestion("box.surau.local", DnsType.ANY)))))
    }

    @Test
    fun garbageIsDroppedWithoutHarm() {
        val e = engine(jitter = 0)
        e.start(1, listOf(iface))
        assertTrue(waitFor { e.claimedHost != null })
        DatagramSocket().use { s ->
            for (junk in listOf(ByteArray(0), ByteArray(5), ByteArray(100) { 0xFF.toByte() }, ByteArray(12))) {
                s.send(DatagramPacket(junk, junk.size, InetAddress.getByName("127.0.0.1"), e.localPort))
            }
        }
        assertNotNull(ask(e.localPort, DnsMessage(7, 0, listOf(DnsQuestion("box1-surau.local", DnsType.A)))))
    }

    @Test
    fun noInterfaceMeansNoClaimAndAnInterfaceStartsIt() {
        val e = engine(jitter = 0)
        e.start(1, emptyList())
        assertTrue(waitFor { e.localPort > 0 })
        Thread.sleep(300)
        assertNull(e.claimedHost)
        e.updateInterfaces(listOf(iface))
        assertTrue(waitFor { e.claimedHost == "box1-surau.local" })
        e.updateInterfaces(emptyList())
        assertTrue(waitFor { e.claimedHost == null })
    }

    @Test
    fun oneSourceIsLimitedBeforeTheGlobalCap() {
        val e = MdnsEngine(port = 0, multicast = false, random = { 0 }, onAction = { actions.add(it) }, maxPerSource = 5).also { engine = it }
        e.start(1, listOf(iface))
        assertTrue(waitFor { e.claimedHost != null })
        var answers = 0
        DatagramSocket().use { s ->
            s.soTimeout = 400
            val b = DnsMessage(1, 0, listOf(DnsQuestion("box1-surau.local", DnsType.A))).encode()
            repeat(30) { s.send(DatagramPacket(b, b.size, InetAddress.getByName("127.0.0.1"), e.localPort)) }
            val buf = ByteArray(9000)
            try {
                while (true) { s.receive(DatagramPacket(buf, buf.size)); answers++ }
            } catch (_: java.net.SocketTimeoutException) {
            }
        }
        assertTrue("answers=$answers", answers in 1..10) // 5 per second from one source (a second boundary may add a few)
    }

    @Test
    fun aBindFailureIsReportedRetriedAndClearedWhenTheSocketWorks() {
        val blocker = DatagramSocket(null)
        blocker.reuseAddress = false
        blocker.bind(java.net.InetSocketAddress(0))
        val statuses = CopyOnWriteArrayList<String>()
        try {
            val e = MdnsEngine(
                port = blocker.localPort, multicast = false, random = { 0 }, onAction = { actions.add(it) },
                onStatus = { b, why -> statuses.add("$b:$why") }, backoffMs = listOf(50L),
            ).also { engine = it }
            e.start(1, listOf(iface))
            assertTrue("failure reported", waitFor { e.failure != null })
            assertFalse(e.bound)
            assertNull(e.claimedHost)
            assertTrue(statuses.first().startsWith("false:"))
            blocker.close()
            assertTrue("bound after retry", waitFor { e.bound })
            assertNull(e.failure)
            assertTrue(waitFor { e.claimedHost == "box1-surau.local" })
            assertTrue(statuses.contains("true:null"))
        } finally {
            blocker.close()
        }
    }

    @Test
    fun aChangedInterfaceIdentityWithTheSameAddressProbesAgain() {
        val e = engine(jitter = 0)
        e.start(1, listOf(IfaceAddr(null, ours, 8, ident = "wlan0#3")))
        assertTrue(waitFor { e.claimedHost != null })
        assertEquals(1, actions.count { it is ClaimAction.Claimed })
        e.updateInterfaces(listOf(IfaceAddr(null, ours, 8, ident = "wlan0#3"))) // identical: nothing happens
        Thread.sleep(300)
        assertEquals(1, actions.count { it is ClaimAction.Claimed })
        e.updateInterfaces(listOf(IfaceAddr(null, ours, 8, ident = "wlan0#7"))) // same address, a new interface
        assertTrue("claimed again", waitFor { actions.count { it is ClaimAction.Claimed } == 2 })
        assertTrue(actions.any { it is ClaimAction.Lost }) // the old claim was released first
    }

    @Test
    fun aDefenceAgainstAProbeFromTheMdnsPortIsNotUnicast() {
        DatagramSocket().use { peer ->
            peer.soTimeout = 700
            val e = engine(jitter = 0, peerPort = peer.localPort)
            e.start(1, listOf(iface))
            assertTrue(waitFor { e.claimedHost != null })
            val qu = DnsMessage(0, 0, listOf(DnsQuestion("box1-surau.local", DnsType.ANY, unicastResponse = true)),
                authorities = listOf(DnsRecord("box1-surau.local", DnsType.A, RData.A(byteArrayOf(127, 0, 0, 9)), 120))).encode()
            peer.send(DatagramPacket(qu, qu.size, InetAddress.getByName("127.0.0.1"), e.localPort))
            val p = DatagramPacket(ByteArray(9000), 9000)
            assertNull("no unicast answer to a probe", try { peer.receive(p); p } catch (_: java.net.SocketTimeoutException) { null })
            // a plain QU query from the same port still gets the unicast answer
            val q = DnsMessage(0, 0, listOf(DnsQuestion("box1-surau.local", DnsType.A, unicastResponse = true))).encode()
            peer.send(DatagramPacket(q, q.size, InetAddress.getByName("127.0.0.1"), e.localPort))
            peer.receive(p)
        }
    }

    @Test
    fun losingAllInterfacesReleasesTheClaimAndTellsTheOwner() {
        val e = engine(jitter = 0)
        e.start(1, listOf(iface))
        assertTrue(waitFor { e.claimedHost != null })
        e.updateInterfaces(emptyList())
        assertTrue(waitFor { e.claimedHost == null })
        assertTrue(waitFor { actions.contains(ClaimAction.Lost("box1-surau.local")) })
    }

    @Test
    fun theSubnetTestUsesThePrefixLength() {
        val i = IfaceAddr(null, byteArrayOf(192.toByte(), 168.toByte(), 1, 26), 24)
        assertTrue(i.contains(byteArrayOf(192.toByte(), 168.toByte(), 1, 200.toByte())))
        assertFalse(i.contains(byteArrayOf(192.toByte(), 168.toByte(), 2, 1)))
        assertFalse(i.contains(byteArrayOf(10, 0, 0, 1)))
        val wide = IfaceAddr(null, byteArrayOf(10, 1, 2, 3), 12)
        assertTrue(wide.contains(byteArrayOf(10, 15, 0, 1)))
        assertFalse(wide.contains(byteArrayOf(10, 16, 0, 1)))
        assertTrue(IfaceAddr(null, byteArrayOf(10, 1, 2, 3), 0).contains(byteArrayOf(8, 8, 8, 8)))
    }
}
