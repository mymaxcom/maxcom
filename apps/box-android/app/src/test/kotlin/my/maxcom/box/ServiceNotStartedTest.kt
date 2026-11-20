package my.maxcom.box

import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** The silent-service message and the retry wiring of the kiosk screen. */
class ServiceNotStartedTest {
    @Test
    fun neverReportedIsOnlyTheInitialValue() {
        assertTrue(BoxReducer.neverReported(BoxReducer.INITIAL))
        val started = BoxReducer.reduce(BoxReducer.INITIAL, BoxEvent.ServiceStarted("a".repeat(64)))
        assertFalse(BoxReducer.neverReported(started))
        val stopped = BoxReducer.reduce(started, BoxEvent.ServiceStopped)
        assertEquals(BoxStatus.Idle, stopped.status)
        assertFalse("a stopped service is not 'never reported'", BoxReducer.neverReported(stopped))
        assertFalse(BoxReducer.neverReported(BoxReducer.reduce(BoxReducer.INITIAL, BoxEvent.Failed(listOf("x")))))
    }

    @Test
    fun messageIsAgreedInThreeLanguages() {
        val t = StartTexts.serviceNotStarted()
        assertEquals("Perkhidmatan MAXCOM belum dapat dimulakan.", t.title)
        assertEquals(
            "Peranti ini mungkin menyekat aplikasi latar belakang. Sila jalankan semula skrip pemasangan dari komputer riba.",
            t.hint,
        )
        assertEquals("The MAXCOM service could not be started.", t.titleEn)
        assertEquals(
            "This device may be blocking background apps. Please run the install script again from the laptop.",
            t.hintEn,
        )
        assertTrue(t.titleAr.any { it in '؀'..'ۿ' })
        assertTrue(t.hintAr!!.any { it in '؀'..'ۿ' })
        assertTrue(t.titleAr.contains("MAXCOM"))
    }

    @Test
    fun messageHasNoDashArrowOrArabicIndicDigit() {
        val bad = Regex("[—–≈→←٠-٩]|->|=>")
        val t = StartTexts.serviceNotStarted()
        for (x in listOfNotNull(t.title, t.titleEn, t.titleAr, t.hint, t.hintEn, t.hintAr)) assertFalse(x, bad.containsMatchIn(x))
    }

    @Test
    fun kioskActivityRetriesAndAsksFromOnResume() {
        val src = File("src/main/kotlin/my/maxcom/box/KioskActivity.kt").readText()
        assertTrue(src.contains("ServiceStartWatch"))
        assertTrue(src.contains("BoxReducer.neverReported"))
        assertTrue(src.contains("override fun onResume()"))
        val resume = src.substringAfter("override fun onResume()").substringBefore("override fun onStop()")
        assertTrue(resume.contains("startBox()"))
        assertTrue(src.contains("Log.i(TAG, \"service start retry \""))
        assertTrue(src.contains("StartTexts.serviceNotStarted()"))
    }
}
