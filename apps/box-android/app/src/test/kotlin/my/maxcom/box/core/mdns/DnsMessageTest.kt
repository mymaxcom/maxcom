package my.maxcom.box.core.mdns

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class DnsMessageTest {
    private val addr = byteArrayOf(192.toByte(), 168.toByte(), 1, 26)

    private fun hex(s: String): ByteArray = ByteArray(s.length / 2) { s.substring(2 * it, 2 * it + 2).toInt(16).toByte() }

    @Test
    fun aQuestionRoundTripsWithTheUnicastBit() {
        val m = DnsMessage(7, 0, listOf(DnsQuestion("box1-surau.local", DnsType.A, unicastResponse = true)))
        val back = DnsMessage.decode(m.encode())!!
        assertEquals(m, back)
        assertTrue(back.questions[0].unicastResponse)
        assertFalse(back.isResponse)
    }

    @Test
    fun everyRecordKindRoundTrips() {
        val records = listOf(
            DnsRecord("box1-surau.local", DnsType.A, RData.A(addr), 120, cacheFlush = true),
            DnsRecord("box1-surau.local", DnsType.NSEC, RData.Nsec("box1-surau.local", listOf(DnsType.A)), 120, cacheFlush = true),
            DnsRecord("_maxcom._tcp.local", DnsType.PTR, RData.Ptr("MAXCOM box1._maxcom._tcp.local"), 4500),
            DnsRecord("MAXCOM box1._maxcom._tcp.local", DnsType.SRV, RData.Srv(0, 0, 8443, "box1-surau.local"), 120, cacheFlush = true),
            DnsRecord("MAXCOM box1._maxcom._tcp.local", DnsType.TXT, RData.Txt(listOf("v=1", "id=0123456789abcdef", "ca=fedcba9876543210")), 4500, cacheFlush = true),
        )
        val m = DnsMessage.response(records)
        val back = DnsMessage.decode(m.encode())!!
        assertEquals(m.answers, back.answers)
        assertTrue(back.isResponse)
        assertEquals(0x8400, back.flags)
    }

    @Test
    fun theWireBytesOfAnARecordAreFixed() {
        // header: id 0, flags 8400, 0 questions, 1 answer; name box1-surau.local; type A; class IN|flush; ttl 120; rdlen 4
        val m = DnsMessage.response(listOf(DnsRecord("box1-surau.local", DnsType.A, RData.A(addr), 120, cacheFlush = true)))
        val label1 = "0a" + "626f78312d7375726175" // 10 octets: box1-surau
        val label2 = "05" + "6c6f63616c" // 5 octets: local
        val full = "000084000000000100000000" + label1 + label2 + "00" + "0001" + "8001" + "00000078" + "0004" + "c0a8011a"
        assertEquals(full, m.encode().joinToString("") { "%02x".format(it) })
    }

    @Test
    fun compressedNamesAreReadBackwardsPointersOnly() {
        // question "box1-surau.local" A; answer owner = pointer to offset 12; PTR rdata = "x" + pointer to 12
        val header = hex("000084000001000100000000")
        val name = hex("0a626f78312d7375726175056c6f63616c00") // starts at offset 12
        val question = name + hex("00010001")
        val answer = hex("c00c") + hex("000c0001") + hex("00000078") + hex("0004") + hex("0178c00c")
        val m = DnsMessage.decode(header + question + answer)
        assertNotNull(m)
        assertEquals("box1-surau.local", m!!.questions[0].name)
        assertEquals("box1-surau.local", m.answers[0].name)
        assertEquals(RData.Ptr("x.box1-surau.local"), m.answers[0].data)
    }

    @Test
    fun aPointerLoopOrAForwardPointerIsRefused() {
        val header = hex("000000000001000000000000")
        // name at offset 12 is a pointer to itself
        assertNull(DnsMessage.decode(header + hex("c00c00010001")))
        // pointer to a later offset
        assertNull(DnsMessage.decode(header + hex("c0100001000100")))
    }

    @Test
    fun truncatedAndOversizedPacketsGiveNullNotAnException() {
        val good = DnsMessage.response(listOf(DnsRecord("box1-surau.local", DnsType.A, RData.A(addr), 120))).encode()
        for (cut in 0 until good.size) assertNull("cut at $cut", DnsMessage.decode(good.copyOf(cut)))
        assertNull(DnsMessage.decode(ByteArray(DnsMessage.MAX_PACKET + 1)))
        // claims 65535 records
        assertNull(DnsMessage.decode(hex("0000000000010000ffff0000") + ByteArray(40)))
    }

    @Test
    fun aLabelWithADotOrALongNameIsRefusedOnRead() {
        val header = hex("000000000001000000000000")
        // label "a.b" (3 octets, one of them a dot)
        assertNull(DnsMessage.decode(header + hex("03612e6200") + hex("00010001")))
        // a 64-octet label uses the reserved 0x40 type bits
        assertNull(DnsMessage.decode(header + hex("40") + ByteArray(64) { 0x61 } + hex("0000010001")))
    }

    @Test
    fun nsecBitmapSetsTheTypeBits() {
        val m = DnsMessage.response(listOf(DnsRecord("h.local", DnsType.NSEC, RData.Nsec("h.local", listOf(DnsType.A, DnsType.AAAA)), 120)))
        val back = DnsMessage.decode(m.encode())!!
        assertEquals(listOf(1, 28), (back.answers[0].data as RData.Nsec).types)
    }

    @Test
    fun txtWithNoStringsEncodesOneEmptyString() {
        val m = DnsMessage.response(listOf(DnsRecord("a.local", DnsType.TXT, RData.Txt(emptyList()), 10)))
        val back = DnsMessage.decode(m.encode())!!
        assertEquals(listOf(""), (back.answers[0].data as RData.Txt).strings)
    }

    @Test
    fun unknownTypesKeepTheirBytes() {
        val raw = byteArrayOf(1, 2, 3, 4, 5)
        val m = DnsMessage.response(listOf(DnsRecord("a.local", 99, RData.Raw(raw), 10)))
        val back = DnsMessage.decode(m.encode())!!
        assertArrayEquals(raw, (back.answers[0].data as RData.Raw).bytes)
    }

    @Test
    fun dnsKeyLowerCasesAsciiOnly() {
        assertEquals("box1-surau.local", dnsKey("BOX1-Surau.LOCAL"))
    }
}
