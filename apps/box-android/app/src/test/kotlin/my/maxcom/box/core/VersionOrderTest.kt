package my.maxcom.box.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class VersionOrderTest {
    @Test
    fun comparesNumericallyPerPart() {
        assertTrue(VersionOrder.compare("2026.11.2", "2026.11.10") < 0)
        assertTrue(VersionOrder.compare("2026.11.10", "2026.11.2") > 0)
        assertTrue(VersionOrder.compare("2026.9.5", "2026.11.1") < 0)
        assertTrue(VersionOrder.compare("2027.1.1", "2026.12.9999") > 0)
        assertEquals(0, VersionOrder.compare("2026.11.2", "2026.11.2"))
        assertEquals(0, VersionOrder.compare("2026.11.02", "2026.11.2"))
    }

    @Test
    fun acceptsOnlyTheFormat() {
        for (v in listOf("2026.11.1", "2026.1.1", "2026.12.9999")) assertTrue(v, VersionOrder.isValid(v))
        for (v in listOf("", "1.2.3", "2026.11", "2026.11.1.1", "2026.111.1", "2026.11.12345", "v2026.11.1", "2026.11.1\n",
            " 2026.11.1", "2026.11.x", "2026-11-1", "../2026.11.1", "2026.11.1/", "\u0662026.11.1")) {
            assertFalse("<$v>", VersionOrder.isValid(v))
            assertThrows(IllegalArgumentException::class.java) { VersionOrder.compare(v, "2026.11.1") }
        }
    }
}
