package my.maxcom.box

import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** The start screen and the maintenance screen show the MAXCOM wordmark image, not the word typed as text. */
class BrandScreensTest {
    private val dir = File("src/main/kotlin/my/maxcom/box")
    private val start = File(dir, "StartScreen.kt").readText()
    private val maint = File(dir, "MaintenanceActivity.kt").readText()
    private val wordmark = File("src/main/res/drawable/maxcom_wordmark.xml").readText()

    @Test
    fun theWordmarkDrawableIsTheLightVariant() {
        assertTrue(wordmark.contains("<vector"))
        assertTrue(wordmark.contains("android:viewportWidth=\"464\""))
        assertTrue(wordmark.contains("android:viewportHeight=\"118.8\""))
        // light letters, red X, green dome gradient
        assertEquals(4, Regex("android:fillColor=\"#F5F3EE\"").findAll(wordmark).count())
        assertEquals(1, Regex("android:fillColor=\"#EB400C\"").findAll(wordmark).count())
        assertTrue(wordmark.contains("android:color=\"#C2D559\""))
        assertTrue(wordmark.contains("android:color=\"#00924C\""))
        assertFalse(wordmark.contains("#000000"))
        assertEquals(6, Regex("android:pathData=").findAll(wordmark).count())
    }

    @Test
    fun theStartScreenShowsTheWordmarkImageOnTheBoxBackground() {
        assertTrue(start.contains("ImageView(context)"))
        assertTrue(start.contains("setImageResource(R.drawable.maxcom_wordmark)"))
        assertTrue(start.contains("contentDescription = \"MAXCOM\""))
        assertTrue(start.contains("setBackgroundColor(context.getColor(R.color.maxcom_bg))"))
        // the big typed word is gone
        assertFalse(start.contains("text = \"MAXCOM\""))
        assertFalse(start.contains("textSize = 64f"))
        // the wordmark comes first, the three state lines under it
        val adds = Regex("addView\\((\\w+)[,)]").findAll(start).map { it.groupValues[1] }.toList()
        assertEquals(listOf("mark", "title", "titleEn", "titleAr"), adds.take(4))
    }

    @Test
    fun theMaintenanceHeaderIsTheWordmarkAndTheWord() {
        val header = maint.substringAfter("private fun logoHeader(").substringBefore("\n    private fun ")
        assertTrue(header.contains("setImageResource(R.drawable.maxcom_wordmark)"))
        assertTrue(header.contains("getString(R.string.maint_title_word)"))
        assertTrue(header.contains("contentDescription = getString(R.string.maint_title)"))
        // the PIN gate and the menu use it; the plain title with the typed word is no longer used there
        assertFalse(maint.contains("title(getString(R.string.maint_title))"))
        val gate = maint.substringAfter("private fun showPinGate()").substringBefore("private fun showMenu()")
        val menu = maint.substringAfter("private fun showMenu()").substringBefore("private fun inLang(")
        assertTrue(gate.contains("logoHeader()"))
        assertTrue(menu.contains("logoHeader()"))
    }

    @Test
    fun theRestartNoticeIsUnderTheWordmark() {
        val done = maint.substringAfter("LeaveAnswer.Done -> {").substringBefore("LeaveAnswer.Unreachable ->")
        assertTrue(done.contains("logoHeader(withWord = false)"))
        assertTrue(done.indexOf("logoHeader(") < done.indexOf("tri(R.string.leave_done, term)"))
    }

    @Test
    fun theMaintenanceScreenShowsTheLogoOncePerScreen() {
        // one header call per screen builder, and only logoHeader adds the wordmark image
        assertEquals(1, Regex("setImageResource\\(R\\.drawable\\.maxcom_wordmark\\)").findAll(maint).count())
        val done = maint.substringAfter("LeaveAnswer.Done -> {").substringBefore("LeaveAnswer.Unreachable ->")
        assertEquals(1, Regex("logoHeader\\(").findAll(done).count())
    }

    @Test
    fun noBmSentenceIsHardCodedInTheMaintenanceScreen() {
        for (lit in listOf("GAGAL: dikunci", "GAGAL: terlalu banyak cubaan", "\"Tetapan Wi-Fi\"", "Tukar atau buang PIN", "Tetapkan PIN penyelenggaraan", "Tukar ke nama boxN")) {
            assertFalse(lit, maint.contains(lit))
        }
        for (k in listOf("maint_pin_locked", "maint_pin_toomany", "maint_wifi", "maint_pin_change", "maint_pin_new", "maint_rekey")) {
            for (dir in listOf("values", "values-en", "values-ar")) {
                assertTrue("$dir $k", File("src/main/res/$dir/strings.xml").readText().contains("name=\"$k\""))
            }
        }
    }
}
