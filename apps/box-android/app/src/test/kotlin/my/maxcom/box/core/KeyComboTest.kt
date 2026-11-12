package my.maxcom.box.core

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class KeyComboTest {
    private val seq = listOf(1, 1, 2, 2, 3)

    private fun feed(c: KeyCombo, keys: List<Int>, t0: Long, step: Long): List<Boolean> =
        keys.mapIndexed { i, k -> c.onKey(k, t0 + i * step) }

    @Test
    fun rightSequenceInsideWindowIsTrueOnce() {
        val c = KeyCombo(seq, 10_000)
        assertTrue(feed(c, seq, 0, 500) == listOf(false, false, false, false, true))
        // After success it starts over: the same keys fire again, not before.
        assertFalse(c.onKey(1, 6000))
        assertFalse(c.onKey(3, 6100))
    }

    @Test
    fun wrongKeyResets() {
        val c = KeyCombo(seq, 10_000)
        assertFalse(c.onKey(1, 0))
        assertFalse(c.onKey(1, 10))
        assertFalse(c.onKey(9, 20))
        assertFalse(c.onKey(2, 30))
        assertFalse(c.onKey(2, 40))
        assertFalse(c.onKey(3, 50))
    }

    @Test
    fun wrongKeyThatStartsTheSequenceCountsAsFirst() {
        val c = KeyCombo(seq, 10_000)
        assertFalse(c.onKey(1, 0))
        assertFalse(c.onKey(2, 10))
        assertTrue(feed(c, seq, 20, 10).last())
    }

    @Test
    fun slowSequenceFails() {
        val c = KeyCombo(seq, 10_000)
        assertTrue(feed(c, seq.take(4), 0, 4000).none { it })
        assertFalse(c.onKey(3, 16_000))
    }

    @Test
    fun windowCountsFromTheFirstKey() {
        val c = KeyCombo(seq, 10_000)
        assertTrue(feed(c, seq, 0, 2500).last())
    }
}
