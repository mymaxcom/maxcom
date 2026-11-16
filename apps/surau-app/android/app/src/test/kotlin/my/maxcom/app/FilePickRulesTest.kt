package my.maxcom.app

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class FilePickRulesTest {
    @Test
    fun acceptsATheme() {
        assertNull(FilePickRules.accept("hijau-siti.maxtheme", 100, 15728640))
        assertNull(FilePickRules.accept("HIJAU.MAXTHEME", 100, 15728640))
        assertNull(FilePickRules.accept("a.maxtheme", 15728640, 15728640))
    }

    @Test
    fun refusesTheWrongTypeAndTheTooBig() {
        assertEquals("type", FilePickRules.accept("a.zip", 100, 15728640))
        assertEquals("type", FilePickRules.accept("maxtheme", 100, 15728640))
        assertEquals("type", FilePickRules.accept("a.maxtheme.exe", 100, 15728640))
        assertEquals("size", FilePickRules.accept("a.maxtheme", 15728641, 15728640))
        assertEquals("type", FilePickRules.accept("a.zip", 99999999999, 15728640))
    }
}
