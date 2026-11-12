package my.maxcom.box.core

import java.math.BigInteger
import java.time.Instant
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test

class DerTest {
    private fun hex(b: ByteArray) = BoxCa.bytesToHex(b)

    @Test
    fun lengthEncodingAtTheEdges() {
        assertEquals("00", hex(Der.length(0)))
        assertEquals("7f", hex(Der.length(127)))
        assertEquals("8180", hex(Der.length(128)))
        assertEquals("81ff", hex(Der.length(255)))
        assertEquals("820100", hex(Der.length(256)))
        assertEquals("82ffff", hex(Der.length(65535)))
        assertEquals("83010000", hex(Der.length(65536)))
        assertThrows(IllegalArgumentException::class.java) { Der.length(-1) }
    }

    @Test
    fun tlvUsesTheLengthForm() {
        assertEquals("0400", hex(Der.octetString(ByteArray(0))))
        assertEquals("0481" + "80" + "00".repeat(128), hex(Der.octetString(ByteArray(128))))
        assertEquals(1 + 4 + 65536, Der.octetString(ByteArray(65536)).size)
    }

    @Test
    fun integersGetALeadingZeroWhenTheHighBitIsSet() {
        assertEquals("020100", hex(Der.integer(BigInteger.ZERO)))
        assertEquals("02017f", hex(Der.integer(BigInteger.valueOf(127))))
        assertEquals("02020080", hex(Der.integer(BigInteger.valueOf(128))))
        assertEquals("020200ff", hex(Der.integer(BigInteger.valueOf(255))))
        assertEquals("02020100", hex(Der.integer(BigInteger.valueOf(256))))
        assertEquals("02020080", hex(Der.integerUnsigned(byteArrayOf(0x80.toByte()))))
        // leading zero bytes of the unsigned input are not kept
        assertEquals("02017f", hex(Der.integerUnsigned(byteArrayOf(0, 0, 0x7f))))
    }

    @Test
    fun oids() {
        assertEquals("06072a8648ce3d0201", hex(Der.oid("1.2.840.10045.2.1")))
        assertEquals("06082a8648ce3d040302", hex(Der.oid("1.2.840.10045.4.3.2")))
        assertEquals("0603551d13", hex(Der.oid("2.5.29.19")))
        assertEquals("06082b06010505070301", hex(Der.oid("1.3.6.1.5.5.7.3.1")))
        assertThrows(IllegalArgumentException::class.java) { Der.oid("1") }
        assertThrows(IllegalArgumentException::class.java) { Der.oid("3.1") }
        assertThrows(IllegalArgumentException::class.java) { Der.oid("1.40") }
        assertThrows(IllegalArgumentException::class.java) { Der.oid("1.2.x") }
    }

    @Test
    fun booleansAndBitStrings() {
        assertEquals("0101ff", hex(Der.boolean(true)))
        assertEquals("010100", hex(Der.boolean(false)))
        assertEquals("03020106", hex(Der.bitString(byteArrayOf(0x06), 1)))
        assertEquals("03020780", hex(Der.bitString(byteArrayOf(0x80.toByte()), 7)))
    }

    @Test
    fun timesUseUtcTimeUntil2049AndGeneralizedAfter() {
        val a = Der.time(Instant.parse("2026-11-10T23:59:58.900Z"))
        assertEquals("170d" + hex("261110235958Z".toByteArray()), hex(a))
        val b = Der.time(Instant.parse("2049-12-31T23:59:59Z"))
        assertEquals("170d" + hex("491231235959Z".toByteArray()), hex(b))
        val c = Der.time(Instant.parse("2050-01-01T00:00:00Z"))
        assertEquals("180f" + hex("20500101000000Z".toByteArray()), hex(c))
    }

    @Test
    fun contextTags() {
        assertEquals("a003020102", hex(Der.contextConstructed(0, Der.integer(BigInteger.valueOf(2)))))
        assertEquals("82026869", hex(Der.contextPrimitive(2, "hi".toByteArray())))
    }

    @Test
    fun readFindsTheContentBounds() {
        val inner = Der.octetString(ByteArray(300))
        val outer = Der.sequence(inner, Der.boolean(true))
        val o = Der.read(outer, 0)
        assertEquals(0x30, o.tag)
        assertEquals(outer.size, o.end)
        val first = Der.read(outer, o.contentStart)
        assertEquals(0x04, first.tag)
        assertEquals(300, first.end - first.contentStart)
        assertArrayEquals(inner, outer.copyOfRange(first.start, first.end))
        assertThrows(IllegalArgumentException::class.java) { Der.read(outer.copyOf(10), 0) }
        assertThrows(IllegalArgumentException::class.java) { Der.read(byteArrayOf(0x30, 0x85.toByte(), 1, 2, 3, 4, 5), 0) }
    }
}
