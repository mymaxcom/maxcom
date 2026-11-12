package my.maxcom.app

import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

class LocalSealTest {
    private fun newKey(): SecretKey =
        KeyGenerator.getInstance("AES").apply { init(256) }.generateKey()

    private fun seal(key: SecretKey = newKey()) = LocalSeal { key }

    @Test
    fun sealThenOpenRoundTrips() {
        val s = seal()
        val plain = "{\"surau\":\"Surau Al-Hidayah\"}".toByteArray()
        val sealed = s.seal(plain)
        assertArrayEquals(plain, s.open(sealed))
    }

    @Test
    fun layoutIsIvThenCiphertextThenTag() {
        val s = seal()
        val plain = ByteArray(40) { it.toByte() }
        val sealed = s.seal(plain)
        assertEquals(12 + 40 + 16, sealed.size)
        // The plain text never appears in the sealed bytes.
        assertFalse(String(sealed, Charsets.ISO_8859_1).contains(String(plain, Charsets.ISO_8859_1)))
    }

    @Test
    fun emptyInputRoundTrips() {
        val s = seal()
        val sealed = s.seal(ByteArray(0))
        assertEquals(12 + 16, sealed.size)
        assertEquals(0, s.open(sealed).size)
    }

    @Test
    fun flippedTagByteThrows() {
        val s = seal()
        val sealed = s.seal("hello".toByteArray())
        sealed[sealed.size - 1] = (sealed[sealed.size - 1].toInt() xor 1).toByte()
        try {
            s.open(sealed)
            fail("a changed tag must not open")
        } catch (e: Exception) {
            // expected
        }
    }

    @Test
    fun flippedCiphertextAndIvBytesThrow() {
        val s = seal()
        val sealed = s.seal("hello world".toByteArray())
        for (i in listOf(0, 11, 12, 13)) {
            val bad = sealed.copyOf()
            bad[i] = (bad[i].toInt() xor 1).toByte()
            try {
                s.open(bad)
                fail("byte $i changed must not open")
            } catch (e: Exception) {
                // expected
            }
        }
    }

    @Test
    fun shortInputThrows() {
        val s = seal()
        for (n in listOf(0, 11, 27)) {
            try {
                s.open(ByteArray(n))
                fail("$n bytes must not open")
            } catch (e: Exception) {
                // expected
            }
        }
    }

    @Test
    fun wrongKeyThrows() {
        val sealed = seal().seal("hello".toByteArray())
        try {
            seal().open(sealed)
            fail("another key must not open")
        } catch (e: Exception) {
            // expected
        }
    }

    @Test
    fun ivDiffersBetweenTwoSealsOfTheSameBytes() {
        val s = seal()
        val plain = "same bytes".toByteArray()
        val ivs = (1..20).map { s.seal(plain).copyOfRange(0, 12).toList() }.toSet()
        assertEquals(20, ivs.size)
        val a = s.seal(plain)
        val b = s.seal(plain)
        assertFalse(a.contentEquals(b))
    }

    @Test
    fun boxIdIsRestrictedForAliases() {
        assertEquals("maxcom-local-abc_1-X", LocalSeal.aliasFor("abc_1-X"))
        assertTrue(LocalSeal.isBoxId("a"))
        assertFalse(LocalSeal.isBoxId(""))
        assertFalse(LocalSeal.isBoxId("../x"))
        assertFalse(LocalSeal.isBoxId("a".repeat(65)))
    }
}
