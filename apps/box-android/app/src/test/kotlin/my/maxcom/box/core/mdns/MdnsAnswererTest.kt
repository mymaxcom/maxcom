package my.maxcom.box.core.mdns

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class MdnsAnswererTest {
    private val addr = byteArrayOf(192.toByte(), 168.toByte(), 1, 26)
    private val id = MdnsIdentity(1, "0123456789abcdef", "fedcba9876543210")

    private fun query(vararg q: DnsQuestion, known: List<DnsRecord> = emptyList(), msgId: Int = 0) =
        DnsMessage(msgId, 0, q.toList(), known)

    @Test
    fun anAQuestionGetsTheAddressAndTheNsecThatDeniesAaaa() {
        val r = MdnsAnswerer.reply(id, addr, query(DnsQuestion("BOX1-surau.local", DnsType.A)), legacy = false)!!
        assertFalse(r.unicast)
        assertEquals(listOf(DnsType.A), r.message.answers.map { it.type })
        assertTrue(r.message.answers[0].cacheFlush)
        assertEquals(120L, r.message.answers[0].ttl)
        assertEquals(RData.A(addr), r.message.answers[0].data)
        assertEquals(listOf(DnsType.NSEC), r.message.additionals.map { it.type })
        assertEquals(listOf(DnsType.A), (r.message.additionals[0].data as RData.Nsec).types)
        assertTrue(r.message.isResponse)
    }

    @Test
    fun anAaaaQuestionGetsOnlyTheNsec() {
        val r = MdnsAnswerer.reply(id, addr, query(DnsQuestion("box1-surau.local", DnsType.AAAA)), legacy = false)!!
        assertEquals(listOf(DnsType.NSEC), r.message.answers.map { it.type })
    }

    @Test
    fun theServiceQuestionGetsThePtrWithSrvTxtAndAddressAsExtras() {
        val r = MdnsAnswerer.reply(id, addr, query(DnsQuestion("_maxcom._tcp.local", DnsType.PTR)), legacy = false)!!
        val ptr = r.message.answers.single()
        assertEquals(RData.Ptr("MAXCOM box1._maxcom._tcp.local"), ptr.data)
        assertFalse(ptr.cacheFlush)
        assertEquals(setOf(DnsType.SRV, DnsType.TXT, DnsType.A, DnsType.NSEC), r.message.additionals.map { it.type }.toSet())
        val srv = r.message.additionals.first { it.type == DnsType.SRV }.data as RData.Srv
        assertEquals(RData.Srv(0, 0, 8443, "box1-surau.local"), srv)
        val txt = r.message.additionals.first { it.type == DnsType.TXT }.data as RData.Txt
        assertEquals(listOf("v=1", "id=0123456789abcdef", "ca=fedcba9876543210"), txt.strings)
    }

    @Test
    fun theTxtLeavesOutHintsThatAreNotKnownOrNotHex() {
        assertEquals(listOf("v=1"), MdnsIdentity(2, null, null).txt().strings)
        assertEquals(listOf("v=1", "id=0123456789abcdef"), MdnsIdentity(2, "0123456789abcdef", "nothex").txt().strings)
    }

    @Test
    fun theInstanceQuestionsAndTheEnumerationAreAnswered() {
        val inst = "MAXCOM box1._maxcom._tcp.local"
        assertEquals(DnsType.SRV, MdnsAnswerer.reply(id, addr, query(DnsQuestion(inst, DnsType.SRV)), false)!!.message.answers.single().type)
        assertEquals(DnsType.TXT, MdnsAnswerer.reply(id, addr, query(DnsQuestion(inst, DnsType.TXT)), false)!!.message.answers.single().type)
        val e = MdnsAnswerer.reply(id, addr, query(DnsQuestion("_services._dns-sd._udp.local", DnsType.PTR)), false)!!
        assertEquals(RData.Ptr("_maxcom._tcp.local"), e.message.answers.single().data)
    }

    @Test
    fun otherNamesAndOtherNumbersGetNoAnswer() {
        for (n in listOf("box2-surau.local", "box.surau.local", "example.local", "_http._tcp.local")) {
            assertNull(n, MdnsAnswerer.reply(id, addr, query(DnsQuestion(n, DnsType.ANY)), false))
        }
        assertNull(MdnsAnswerer.reply(id, addr, query(DnsQuestion("_maxcom._tcp.local", DnsType.A)), false))
        assertNull(MdnsAnswerer.reply(id, addr, DnsMessage.response(emptyList()), false))
    }

    @Test
    fun aQuAskerGetsAUnicastReplyButAMixedQuestionStaysMulticast() {
        val qu = MdnsAnswerer.reply(id, addr, query(DnsQuestion("box1-surau.local", DnsType.A, unicastResponse = true)), false)!!
        assertTrue(qu.unicast)
        val mixed = MdnsAnswerer.reply(
            id, addr,
            query(DnsQuestion("box1-surau.local", DnsType.A, unicastResponse = true), DnsQuestion("_maxcom._tcp.local", DnsType.PTR)),
            false,
        )!!
        assertFalse(mixed.unicast)
    }

    @Test
    fun aLegacyUnicastQueryGetsAnEchoWithShortTtlAndNoCacheFlush() {
        val r = MdnsAnswerer.reply(id, addr, query(DnsQuestion("box1-surau.local", DnsType.A), msgId = 0x1234), legacy = true)!!
        assertTrue(r.unicast)
        assertEquals(0x1234, r.message.id)
        assertEquals(1, r.message.questions.size)
        assertTrue(r.message.answers.all { it.ttl <= 10 && !it.cacheFlush })
    }

    @Test
    fun knownAnswerSuppressionDropsARecordTheAskerHoldsWithEnoughTtl() {
        val ptr = MdnsAnswerer.ptr(id)
        val q = DnsQuestion("_maxcom._tcp.local", DnsType.PTR)
        assertNull(MdnsAnswerer.reply(id, addr, query(q, known = listOf(ptr.copy(ttl = 3000))), false))
        // less than half of 4500 left: answer anyway
        assertNotNull(MdnsAnswerer.reply(id, addr, query(q, known = listOf(ptr.copy(ttl = 2000))), false))
        // a known answer for another instance does not suppress
        assertNotNull(MdnsAnswerer.reply(id, addr, query(q, known = listOf(ptr.copy(data = RData.Ptr("MAXCOM box2._maxcom._tcp.local")))), false))
    }

    @Test
    fun goodbyeAndAnnouncementCarryTheSameRecordsWithTtlZeroOrNot() {
        val a = MdnsAnswerer.announcement(id, addr).answers
        val g = MdnsAnswerer.goodbye(id, addr).answers
        assertEquals(a.size, g.size)
        assertTrue(g.all { it.ttl == 0L })
        assertTrue(a.none { it.ttl == 0L })
        assertEquals(a.map { it.type }, g.map { it.type })
    }

    @Test
    fun theProbeAsksAnyWithTheUnicastBitAndProposesOurAddressInTheAuthoritySection() {
        val p = MdnsAnswerer.probe("box1-surau.local", addr)
        assertEquals(DnsType.ANY, p.questions.single().type)
        assertFalse(p.questions.single().unicastResponse) // QM: answers to our probe come by multicast
        assertEquals(RData.A(addr), p.authorities.single().data)
        assertFalse(p.isResponse)
        assertEquals(p, DnsMessage.decode(p.encode()))
    }
}
