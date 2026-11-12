package my.maxcom.app

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class ShareChannelTest {
    @Test
    fun plainNamesPass() {
        assertTrue(ShareArgs.nameOk("Laporan-2026-10.pdf"))
        assertTrue(ShareArgs.nameOk("a"))
        assertTrue(ShareArgs.nameOk("x".repeat(100)))
    }

    @Test
    fun pathsTraversalAndOddNamesAreRefused() {
        assertFalse(ShareArgs.nameOk(null))
        assertFalse(ShareArgs.nameOk(""))
        assertFalse(ShareArgs.nameOk("a/b.pdf"))
        assertFalse(ShareArgs.nameOk("a\\b.pdf"))
        assertFalse(ShareArgs.nameOk("..pdf"))
        assertFalse(ShareArgs.nameOk("a..b.pdf"))
        assertFalse(ShareArgs.nameOk("../x.pdf"))
        assertFalse(ShareArgs.nameOk("x".repeat(101)))
        assertFalse(ShareArgs.nameOk("a\u0000b.pdf"))
        assertFalse(ShareArgs.nameOk("a\nb.pdf"))
    }

    @Test
    fun onlyTheThreeTypesPass() {
        assertTrue(ShareArgs.mimeOk("application/pdf"))
        assertTrue(ShareArgs.mimeOk("text/csv"))
        assertTrue(ShareArgs.mimeOk("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"))
        assertFalse(ShareArgs.mimeOk(null))
        assertFalse(ShareArgs.mimeOk("text/html"))
        assertFalse(ShareArgs.mimeOk("application/zip"))
        assertFalse(ShareArgs.mimeOk("application/pdf; charset=x"))
    }

    @Test
    fun theChosenPackageIsClassed() {
        assertEquals("whatsapp", ShareArgs.classOf("com.whatsapp"))
        assertEquals("whatsapp", ShareArgs.classOf("com.whatsapp.w4b"))
        assertEquals("email", ShareArgs.classOf("com.google.android.gm"))
        assertEquals("email", ShareArgs.classOf("com.microsoft.office.outlook"))
        assertEquals("other", ShareArgs.classOf("org.telegram.messenger"))
        assertEquals("other", ShareArgs.classOf(null))
    }
}
