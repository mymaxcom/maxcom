package my.maxcom.box.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class DoctorReportTest {
    @Test
    fun everyLineStartsWithOkOrGagal() {
        val r = DoctorReport(listOf(DoctorLine(true, "baik"), DoctorLine(false, "rosak")))
        for (l in r.render()) assertTrue(l, l.startsWith("OK: ") || l.startsWith("GAGAL: "))
        assertEquals("OK: baik", r.render()[0])
        assertEquals("GAGAL: rosak", r.render()[1])
    }

    @Test
    fun allOkFalseWhenAnyLineFailed() {
        assertTrue(DoctorReport(listOf(DoctorLine(true, "a"), DoctorLine(true, "b"))).allOk)
        assertFalse(DoctorReport(listOf(DoctorLine(true, "a"), DoctorLine(false, "b"))).allOk)
    }

    @Test
    fun noSecretPathOrPemInALine() {
        val l = DoctorLine(true, "baca /data/user/0/my.maxcom.box/files/data/secret/box.key gagal").render()
        assertFalse(l.contains("secret"))
        assertEquals("[dibuang]", DoctorLine.clean("-----BEGIN PRIVATE KEY-----\nabc"))
        assertFalse(DoctorLine.clean("a\nb\tc").contains('\n'))
        assertTrue(DoctorLine.clean("x".repeat(1000)).length <= 300)
    }

    @Test
    fun lastFiveProblemLines() {
        val log = (1..10).map { "line $it WARNING x" } + listOf("fine line", "x failed") 
        val p = DoctorReport.lastProblems(log)
        assertEquals(5, p.size)
        assertEquals("x failed", p.last())
        assertTrue(DoctorReport.lastProblems(listOf("all fine")).isEmpty())
    }

    @Test
    fun certDaysWarnsUnderSixty() {
        assertTrue(DoctorReport.certDays(60).ok)
        assertFalse(DoctorReport.certDays(59).ok)
        assertFalse(DoctorReport.certDays(-1).ok)
    }

    @Test
    fun freeSpaceNeedsOneGigabyte() {
        assertTrue(DoctorReport.freeSpace(1024L * 1024 * 1024).ok)
        assertFalse(DoctorReport.freeSpace(1024L * 1024 * 1024 - 1).ok)
    }
}
