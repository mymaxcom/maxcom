package my.maxcom.box.core.mdns

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class NameClaimTest {
    private val mine = byteArrayOf(10, 0, 0, 5)
    private val higher = byteArrayOf(10, 0, 0, 9)
    private val lower = byteArrayOf(10, 0, 0, 2)

    /** A claim with no random wait and the clock under the test's control. */
    private fun claim(startN: Int = 1): NameClaim = NameClaim(startN) { 0 }.also { it.setAddresses(listOf(mine)) }

    private fun response(host: String, addr: ByteArray) =
        DnsMessage.response(listOf(DnsRecord(host, DnsType.A, RData.A(addr), 120, cacheFlush = true)))

    private fun probe(host: String, addr: ByteArray) = MdnsAnswerer.probe(host, addr)

    /** Runs the clock forward until the claim leaves PROBING; returns the actions and the final time. */
    private fun settle(c: NameClaim, from: Long): Pair<List<ClaimAction>, Long> {
        val all = ArrayList<ClaimAction>()
        var t = from
        while (c.state == NameClaim.State.PROBING || c.state == NameClaim.State.WAITING) {
            val due = c.nextDeadline() ?: break
            t = maxOf(t, due)
            all += c.tick(t)
        }
        return all to t
    }

    @Test
    fun noConflictThreeProbesThenClaimThenTwoAnnouncements() {
        val c = claim()
        c.start(0)
        val (actions, t) = settle(c, 0)
        assertEquals(3, actions.count { it is ClaimAction.Probe })
        assertEquals(ClaimAction.Claimed(1), actions.filterIsInstance<ClaimAction.Claimed>().single())
        assertTrue(c.claimed)
        assertEquals("box1-surau.local", c.host)
        // probes 250 ms apart, claim 250 ms after the third
        assertEquals(750L, t)
        // second announcement one second later, then nothing is pending
        assertEquals(1, actions.count { it is ClaimAction.Announce })
        assertEquals(t + 1000, c.nextDeadline())
        assertEquals(listOf(ClaimAction.Announce("box1-surau.local")), c.tick(t + 1000))
        assertNull(c.nextDeadline())
    }

    @Test
    fun theFirstProbeWaitsTheRandomJitter() {
        val c = NameClaim(1) { bound -> bound - 1 }.also { it.setAddresses(listOf(mine)) }
        c.start(100)
        assertEquals(100L + 250, c.nextDeadline())
        assertTrue(c.tick(349).isEmpty())
        assertEquals(1, c.tick(350).size)
    }

    @Test
    fun aResponseForTheNameMovesToTheNextNumber() {
        val c = claim()
        c.start(0)
        c.tick(0) // probe 1
        val actions = c.onMessage(response("box1-surau.local", higher), 100)
        assertTrue(actions.isEmpty()) // never claimed: nothing to say goodbye to
        assertEquals("box2-surau.local", c.host)
        val (a, _) = settle(c, 100)
        assertEquals(ClaimAction.Claimed(2), a.filterIsInstance<ClaimAction.Claimed>().single())
    }

    @Test
    fun ourOwnAddressInAResponseIsNotAConflict() {
        val c = claim()
        c.start(0)
        c.tick(0)
        assertTrue(c.onMessage(response("box1-surau.local", mine), 10).isEmpty())
        assertEquals("box1-surau.local", c.host)
    }

    @Test
    fun aResponseForAnotherNameIsIgnored() {
        val c = claim()
        c.start(0)
        c.tick(0)
        c.onMessage(response("box2-surau.local", higher), 10)
        c.onMessage(response("BOX1-SURAU.LOCAL.x", higher), 10)
        assertEquals(1, c.n)
    }

    @Test
    fun theHostNameMatchIsCaseInsensitive() {
        val c = claim()
        c.start(0)
        c.tick(0)
        c.onMessage(response("BOX1-Surau.Local", higher), 10)
        assertEquals(2, c.n)
    }

    @Test
    fun simultaneousProbeWithLaterDataWinsAndWeMoveOn() {
        val c = claim()
        c.start(0)
        c.tick(0)
        c.onMessage(probe("box1-surau.local", higher), 10)
        assertEquals(2, c.n)
    }

    @Test
    fun simultaneousProbeWithEarlierDataLosesToUs() {
        val c = claim()
        c.start(0)
        c.tick(0)
        c.onMessage(probe("box1-surau.local", lower), 10)
        assertEquals(1, c.n)
        val (a, _) = settle(c, 10)
        assertEquals(ClaimAction.Claimed(1), a.filterIsInstance<ClaimAction.Claimed>().single())
    }

    @Test
    fun aProbeWithOurOwnAddressIsNotAConflict() {
        val c = claim()
        c.start(0)
        c.tick(0)
        c.onMessage(probe("box1-surau.local", mine), 10)
        assertEquals(1, c.n)
    }

    @Test
    fun theStoredNumberIsTheStartAndAClaimNeverGoesBackDown() {
        val c = claim(startN = 4)
        c.start(0)
        assertEquals("box4-surau.local", c.host)
        c.tick(0)
        c.onMessage(response("box4-surau.local", higher), 10)
        assertEquals(5, c.n)
        val (_, t) = settle(c, 10)
        assertTrue(c.claimed)
        // the box4 holder goes away: the claim stays at 5
        c.restart(t + 5000)
        assertEquals(5, c.n)
    }

    @Test
    fun aConflictAfterTheClaimReprobesFirstAndKeepsTheNameWhenTheReprobeIsQuiet() {
        val c = claim()
        c.start(0)
        val (_, t) = settle(c, 0)
        assertTrue(c.claimed)
        c.onMessage(response("box1-surau.local", higher), t + 5000)
        assertFalse(c.claimed) // probing again
        assertEquals(1, c.n)
        val (a, _) = settle(c, t + 5000)
        assertEquals(ClaimAction.Claimed(1), a.filterIsInstance<ClaimAction.Claimed>().single())
        assertEquals(1, c.n)
    }

    @Test
    fun aConflictDuringTheReprobeMovesTheNameAndSaysGoodbye() {
        val c = claim()
        c.start(0)
        val (_, t) = settle(c, 0)
        c.onMessage(response("box1-surau.local", higher), t + 5000)
        c.tick(t + 5000) // first probe of the re-probe
        val actions = c.onMessage(response("box1-surau.local", higher), t + 5100)
        assertEquals(listOf(ClaimAction.Lost("box1-surau.local")), actions)
        assertEquals(2, c.n)
    }

    @Test
    fun atMostOneRenumberPerMinuteAfterTheFirstClaim() {
        val c = claim()
        c.start(0)
        val (_, t0) = settle(c, 0)
        // first post-claim renumber: box1 -> box2, no delay
        c.onMessage(response("box1-surau.local", higher), t0 + 1000)
        c.tick(t0 + 1000)
        c.onMessage(response("box1-surau.local", higher), t0 + 1100)
        assertEquals(2, c.n)
        val (_, t1) = settle(c, t0 + 1100)
        assertTrue(c.claimed)
        // box2 is contested soon after (past the re-probe gap): the move to box3 waits until 60 s after the first renumber
        c.onMessage(response("box2-surau.local", higher), t1 + 11_000)
        c.tick(t1 + 11_000)
        val lost = c.onMessage(response("box2-surau.local", higher), t1 + 11_020)
        assertTrue(lost.any { it is ClaimAction.Lost })
        assertEquals(3, c.n)
        assertEquals(NameClaim.State.WAITING, c.state)
        assertEquals(t0 + 1100 + NameClaim.RENUMBER_GAP_MS, c.nextDeadline())
    }

    @Test
    fun fifteenConflictsInTenSecondsPauseFiveSeconds() {
        val c = claim()
        c.start(0)
        var t = 0L
        c.tick(t)
        for (i in 1..14) {
            c.onMessage(response(c.host, higher), t)
            t += 100
            c.tick(t)
        }
        // 14 conflicts so far: the 15th triggers the pause
        c.onMessage(response(c.host, higher), t)
        assertEquals(NameClaim.State.WAITING, c.state)
        assertEquals(t + NameClaim.STORM_PAUSE_MS, c.nextDeadline())
    }

    @Test
    fun at99WithNoFreeNameTheStateIsExhausted() {
        val c = claim(startN = 99)
        c.start(0)
        c.tick(0)
        val actions = c.onMessage(response("box99-surau.local", higher), 10)
        assertEquals(listOf(ClaimAction.Exhausted), actions)
        assertEquals(NameClaim.State.EXHAUSTED, c.state)
        assertFalse(c.claimed)
        assertNull(c.nextDeadline())
        // a later network change tries again from the stored start number
        c.restart(1000)
        assertEquals(NameClaim.State.PROBING, c.state)
    }

    @Test
    fun messagesAreIgnoredWhenNotProbingOrClaimed() {
        val c = claim()
        assertTrue(c.onMessage(response("box1-surau.local", higher), 0).isEmpty())
        assertEquals(NameClaim.State.IDLE, c.state)
        c.start(0)
        c.stop()
        assertTrue(c.onMessage(response("box1-surau.local", higher), 0).isEmpty())
        assertEquals(1, c.n)
    }

    private fun goodbye(host: String, addr: ByteArray) =
        DnsMessage.response(listOf(DnsRecord(host, DnsType.A, RData.A(addr), 0, cacheFlush = true)))

    @Test
    fun aGoodbyeNeverRenumbers() {
        // while probing
        val p = claim()
        p.start(0)
        p.tick(0)
        assertTrue(p.onMessage(goodbye("box1-surau.local", higher), 10).isEmpty())
        assertEquals(1, p.n)
        assertEquals(NameClaim.State.PROBING, p.state)
        // while claimed: not even a re-probe
        val c = claim()
        c.start(0)
        val (_, t) = settle(c, 0)
        assertTrue(c.onMessage(goodbye("box1-surau.local", higher), t + 5000).isEmpty())
        assertTrue(c.claimed)
        assertEquals(1, c.n)
    }

    @Test
    fun aSpoofedResponseWhileClaimedOnlyReprobesAndTheNameStays() {
        val c = claim()
        c.start(0)
        val (_, t) = settle(c, 0)
        val spoof = t + 5000
        assertTrue(c.onMessage(response("box1-surau.local", higher), spoof).isEmpty())
        assertEquals(NameClaim.State.PROBING, c.state)
        // a burst of further spoofed responses before our first re-probe is out confirms nothing
        for (i in 1..5) assertTrue(c.onMessage(response("box1-surau.local", higher), spoof + i).isEmpty())
        assertEquals(1, c.n)
        val (a, _) = settle(c, spoof)
        assertEquals(ClaimAction.Claimed(1), a.filterIsInstance<ClaimAction.Claimed>().single())
        assertTrue(a.none { it is ClaimAction.Lost })
        assertEquals(1, c.n)
        // and the flood does not keep it re-probing: another one right after is ignored (gap), the name stays claimed
        assertTrue(c.onMessage(response("box1-surau.local", higher), spoof + 2000).isEmpty())
        assertTrue(c.claimed)
    }

    @Test
    fun aConflictThatAnswersOurReprobeMovesToTheNextNumber() {
        val c = claim()
        c.start(0)
        val (_, t) = settle(c, 0)
        c.onMessage(response("box1-surau.local", higher), t + 5000)
        c.tick(t + 5000) // our first re-probe is out
        val actions = c.onMessage(response("box1-surau.local", higher), t + 5050)
        assertEquals(listOf(ClaimAction.Lost("box1-surau.local")), actions)
        assertEquals(2, c.n)
        val (a, _) = settle(c, t + 5050)
        assertEquals(ClaimAction.Claimed(2), a.filterIsInstance<ClaimAction.Claimed>().single())
    }

    @Test
    fun theRenumberGateCapsRenumbersAndKeepsTheName() {
        var allowed = 3
        val c = claim()
        c.renumberGate = { if (allowed > 0) { allowed--; true } else false }
        c.start(0)
        var t = 0L
        // three confirmed conflicts during probing: 1 -> 2 -> 3 -> 4
        for (i in 1..3) {
            c.tick(t)
            c.onMessage(response(c.host, higher), t + 1)
            t += 100
        }
        assertEquals(4, c.n)
        c.tick(t)
        val denied = c.onMessage(response(c.host, higher), t + 1)
        assertEquals(ClaimAction.RenumberDenied("box4-surau.local"), denied.first())
        assertTrue(denied.contains(ClaimAction.Claimed(4)))
        assertTrue(denied.none { it is ClaimAction.Lost || it == ClaimAction.Exhausted })
        assertEquals(4, c.n)
        assertTrue(c.claimed)
        // conflicts are ignored for a while: no probing, no more renumbering
        assertTrue(c.onMessage(response(c.host, higher), t + 1000).isEmpty())
        assertTrue(c.claimed)
        assertEquals(4, c.n)
    }

    @Test
    fun aProbeFromAnotherHostDuringAReprobeDoesNotMoveTheName() {
        val c = claim()
        c.start(0)
        val (_, t) = settle(c, 0)
        c.onMessage(response("box1-surau.local", higher), t + 5000)
        c.tick(t + 5000)
        assertTrue(c.onMessage(probe("box1-surau.local", higher), t + 5010).isEmpty())
        assertEquals(1, c.n)
    }

    @Test
    fun aProbeForOurNameWhileClaimedDoesNotMoveTheName() {
        val c = claim()
        c.start(0)
        settle(c, 0)
        assertTrue(c.onMessage(probe("box1-surau.local", higher), 5000).isEmpty())
        assertTrue(c.claimed)
    }
}
