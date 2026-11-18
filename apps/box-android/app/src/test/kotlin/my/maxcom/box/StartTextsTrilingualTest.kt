package my.maxcom.box

import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** The start screen is BM at normal size with a small English and a small Arabic line (nobody can act on it). */
class StartTextsTrilingualTest {
    private val all = listOf(
        BoxStatus.Idle, BoxStatus.Preparing("x", 3, 7), BoxStatus.WaitingClock, BoxStatus.Starting,
        BoxStatus.Running, BoxStatus.Failing(listOf("baris 1")),
    )

    @Test
    fun everyStateHasBmEnglishAndArabic() {
        for (s in all) {
            val t = StartTexts.forStatus(s)
            assertTrue("$s title", t.title.isNotBlank())
            assertTrue("$s english", t.titleEn.isNotBlank())
            assertTrue("$s arabic", t.titleAr.isNotBlank())
            assertTrue("$s arabic has Arabic letters", t.titleAr.any { it in '\u0600'..'\u06FF' })
        }
    }

    @Test
    fun theTextsAreAsAgreed() {
        val w = StartTexts.forStatus(BoxStatus.WaitingClock)
        assertEquals("Menunggu jam Internet", w.title)
        assertEquals("Waiting for the Internet clock", w.titleEn)
        assertEquals("\u0641\u064A \u0627\u0646\u062A\u0638\u0627\u0631 \u0633\u0627\u0639\u0629 \u0627\u0644\u0625\u0646\u062A\u0631\u0646\u062A", w.titleAr)
        assertEquals("Starting the MAXCOM server", StartTexts.forStatus(BoxStatus.Starting).titleEn)
        assertEquals("Loading the MAXCOM screen", StartTexts.forStatus(BoxStatus.Running).titleEn)
        assertEquals("Starting the MAXCOM server", StartTexts.forStatus(BoxStatus.Running, healthPending = true).titleEn)
        assertEquals("Preparing MAXCOM", StartTexts.forStatus(BoxStatus.Idle).titleEn)
    }

    @Test
    fun progressKeepsThePlaceInAllThreeLanguages() {
        val t = StartTexts.forStatus(BoxStatus.Preparing("x", 3, 7))
        assertEquals("Menyediakan MAXCOM (3 daripada 7)", t.title)
        assertEquals("Preparing MAXCOM (3 of 7)", t.titleEn)
        assertTrue(t.titleAr.endsWith("(3 \u0645\u0646 7)"))
        assertNull(StartTexts.forStatus(BoxStatus.Idle).hint)
    }

    @Test
    fun theFailureHintIsInAllThreeLanguages() {
        val f = StartTexts.forStatus(BoxStatus.Failing(listOf("a")))
        assertEquals("MAXCOM could not start", f.titleEn)
        assertEquals("Tekan OK untuk cuba lagi", f.hint)
        assertEquals("Press OK to try again", f.hintEn)
        assertTrue(f.hintAr!!.startsWith("\u0627\u0636\u063A\u0637 OK"))
        assertEquals(listOf("a"), f.detail)
    }

    @Test
    fun noDashArrowOrArabicIndicDigit() {
        val bad = Regex("[\u2014\u2013\u2248\u2192\u2190\u0660-\u0669]|->|=>")
        for (s in all) {
            val t = StartTexts.forStatus(s)
            for (x in listOfNotNull(t.title, t.titleEn, t.titleAr, t.hint, t.hintEn, t.hintAr)) assertFalse(x, bad.containsMatchIn(x))
        }
    }

    @Test
    fun theNotificationIsBmSlashEnglishOnOneLine() {
        val xml = File("src/main/res/values/strings.xml").readText()
        val names = listOf("notif_title", "notif_text_running", "notif_text_starting", "notif_text_waiting_clock", "notif_text_failed")
        for (n in names) {
            val v = Regex("""<string name="$n">(.*?)</string>""").find(xml)!!.groupValues[1]
            assertTrue("$n has ' / '", v.contains(" / "))
            assertFalse("$n has no Arabic", v.any { it in '\u0600'..'\u06FF' })
            assertFalse("$n is one line", v.contains("\n"))
            assertFalse("$n has no dash", Regex("[\u2014\u2013]").containsMatchIn(v))
        }
    }
}
