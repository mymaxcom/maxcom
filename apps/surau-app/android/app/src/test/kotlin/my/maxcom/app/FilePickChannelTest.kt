package my.maxcom.app

import java.io.ByteArrayInputStream
import java.io.InputStream
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class FilePickChannelTest {
    /** A stream of [size] bytes that counts what was read from it. */
    private class Counting(private val size: Int) : InputStream() {
        var served = 0
        override fun read(): Int = if (served >= size) -1 else { served++; 7 }
        override fun read(b: ByteArray, off: Int, len: Int): Int {
            if (served >= size) return -1
            val n = minOf(len, size - served)
            for (i in 0 until n) b[off + i] = 7
            served += n
            return n
        }
    }

    @Test
    fun smallStreamIsReadWhole() {
        val data = ByteArray(1000) { (it % 251).toByte() }
        val r = FilePick.readCapped(ByteArrayInputStream(data), 2 * 1024 * 1024)
        assertFalse(r.tooBig)
        assertArrayEquals(data, r.bytes)
    }

    @Test
    fun streamExactlyAtTheCapIsAccepted() {
        val r = FilePick.readCapped(ByteArrayInputStream(ByteArray(5000)), 5000)
        assertFalse(r.tooBig)
        assertEquals(5000, r.bytes!!.size)
    }

    @Test
    fun threeMegabyteStreamIsCappedAndNotReadToTheEnd() {
        val three = 3 * 1024 * 1024
        val cap = 2 * 1024 * 1024
        val s = Counting(three)
        val r = FilePick.readCapped(s, cap)
        assertTrue(r.tooBig)
        assertNull(r.bytes)
        assertTrue("read ${s.served} bytes, more than cap plus one buffer", s.served <= cap + 8192)
    }

    @Test
    fun emptyStreamIsEmptyNotTooBig() {
        val r = FilePick.readCapped(ByteArrayInputStream(ByteArray(0)), 10)
        assertFalse(r.tooBig)
        assertEquals(0, r.bytes!!.size)
    }

    @Test
    fun namesAreCleaned() {
        assertEquals("a.csv", FilePick.cleanName("primary:Download/a.csv"))
        assertEquals("file", FilePick.cleanName(null))
        assertEquals("file", FilePick.cleanName("   "))
        assertEquals("ab.csv", FilePick.cleanName("a\u0000b.csv"))
        assertEquals(200, FilePick.cleanName("x".repeat(500)).length)
    }
}
