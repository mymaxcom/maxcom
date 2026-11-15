package my.maxcom.box.core

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class DoctorReportNameTest {
    @Test
    fun aLegacyRootIsFineAndSaysIpOnly() {
        val l = DoctorReport.localName(newRoot = false, host = null, exhausted = false, failed = false)
        assertTrue(l.ok)
        assertTrue(l.text.contains("alamat IP"))
    }

    @Test
    fun aClaimedNameIsShownAsTheUrl() {
        val l = DoctorReport.localName(true, "box2-surau.local", false, false)
        assertTrue(l.ok)
        assertTrue(l.render().contains("https://box2-surau.local:8443"))
    }

    @Test
    fun exhaustedFailedAndWaitingAreProblems() {
        assertFalse(DoctorReport.localName(true, null, true, false).ok)
        assertFalse(DoctorReport.localName(true, null, false, true).ok)
        assertFalse(DoctorReport.localName(true, null, false, false).ok)
        assertTrue(DoctorReport.localName(true, null, true, false).text.contains("box99"))
    }

    @Test
    fun aNameThatIsNotAnnouncedShowsTheReasonAndAWarningIsShownNextToTheName() {
        val l = DoctorReport.localName(true, null, false, true, reason = "bind: BindException")
        assertFalse(l.ok)
        assertTrue(l.text.contains("nama setempat tidak diumumkan"))
        assertTrue(l.text.contains("BindException"))
        val w = DoctorReport.localName(true, "box2-surau.local", false, false, warning = "amaran: had")
        assertFalse(w.ok)
        assertTrue(w.text.contains("box2-surau.local") && w.text.contains("amaran"))
    }

    @Test
    fun theLineHasNoPathOrKey() {
        for (l in listOf(
            DoctorReport.localName(false, null, false, false), DoctorReport.localName(true, "box1-surau.local", false, false),
            DoctorReport.localName(true, null, true, false), DoctorReport.localName(true, null, false, true),
        )) {
            assertTrue(DoctorLine.clean(l.text) == l.text.trim())
        }
    }
}
