package my.maxcom.box

import java.io.File
import my.maxcom.box.core.LeaveAnswerParser
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** The follower texts: three languages, one product term, no dashes, and the Kotlin copy equals strings.xml. */
class FollowerTextsTest {
    private val arabic = Regex("[؀-ۿ]")
    private val bad = Regex("[—–≈→←٠-٩]|->|=>")
    private val res = File("src/main/res")

    private fun xml(dir: String): Map<String, String> {
        val text = File(res, "$dir/strings.xml").readText(Charsets.UTF_8)
        return Regex("""<string name="([a-z_]+)"[^>]*>(.*?)</string>""").findAll(text).associate { it.groupValues[1] to it.groupValues[2] }
    }

    private val ms get() = xml("values")
    private val en get() = xml("values-en")
    private val ar get() = xml("values-ar")
    private val leaveKeys = listOf(
        "leave_intro", "leave_data", "leave_code_hint", "leave_go", "leave_no_code", "leave_new_confirm", "leave_new_yes",
        "leave_cancel", "leave_working", "leave_code_short", "leave_done", "leave_err_wrong_code", "leave_err_locked",
        "leave_err_no_backup", "leave_err_has_backup", "leave_err_not_local", "leave_err_generic", "leave_err_network",
    )
    private val newKeys = listOf("follower_line", "follower_line_no_name", "maint_mode_follower", "maint_unlink") + leaveKeys

    @Test
    fun theThreeFilesHaveTheSameNewKeys() {
        for (k in newKeys) {
            assertTrue("ms $k", ms.containsKey(k))
            assertTrue("en $k", en.containsKey(k))
            assertTrue("ar $k", ar.containsKey(k))
        }
        // the English and Arabic files hold nothing the default file lacks (the full parity is StringsParityTest)
        assertTrue(ms.keys.containsAll(en.keys))
        assertTrue(ms.keys.containsAll(ar.keys))
    }

    @Test
    fun placeholdersMatchInEveryLanguage() {
        val ph = Regex("%\\d\\\$s")
        for (k in newKeys) {
            val want = ph.findAll(ms.getValue(k)).map { it.value }.toList()
            assertEquals("en $k", want, ph.findAll(en.getValue(k)).map { it.value }.toList())
            assertEquals("ar $k", want, ph.findAll(ar.getValue(k)).map { it.value }.toList())
        }
    }

    @Test
    fun arabicIsArabicAndEnglishAndBmAreNot() {
        for (k in newKeys) {
            assertTrue("ar $k", arabic.containsMatchIn(ar.getValue(k)))
            assertFalse("en $k", arabic.containsMatchIn(en.getValue(k)))
            assertFalse("ms $k", arabic.containsMatchIn(ms.getValue(k)))
        }
    }

    @Test
    fun theBoxTermIsOneResourceThatTheKotlinConstantMatches() {
        assertEquals("MAXCOM Kiosk Box", ms.getValue("box_term"))
        assertEquals(FollowerTexts.BOX_TERM, ms.getValue("box_term"))
        // it is not translated: the English and Arabic files do not repeat it
        assertFalse(en.containsKey("box_term"))
        assertFalse(ar.containsKey("box_term"))
    }

    @Test
    fun noBareKotakInAnyNewTextAndNoDashOrArrow() {
        val kotak = Regex("kotak", RegexOption.IGNORE_CASE)
        val all = newKeys.flatMap { listOf(ms.getValue(it), en.getValue(it), ar.getValue(it)) } +
            FollowerTexts.line("Dewan Utama").all() + FollowerTexts.line("").all() + FollowerTexts.mode().all() +
            FollowerTexts.UNLINK_ENTRY.all()
        for (s in all) {
            assertFalse(s, kotak.containsMatchIn(s))
            assertFalse(s, bad.containsMatchIn(s))
        }
    }

    @Test
    fun theKotlinTextsEqualTheXmlOnes() {
        val term = FollowerTexts.BOX_TERM
        val name = "Surau Al-Hidayah"
        val line = FollowerTexts.line(name)
        assertEquals(ms.getValue("follower_line").replace("%1\$s", name), line.ms)
        assertEquals(en.getValue("follower_line").replace("%1\$s", name), line.en)
        assertEquals(ar.getValue("follower_line").replace("%1\$s", name), line.ar)
        val none = FollowerTexts.line("  ")
        assertEquals(ms.getValue("follower_line_no_name"), none.ms)
        assertEquals(en.getValue("follower_line_no_name"), none.en)
        assertEquals(ar.getValue("follower_line_no_name"), none.ar)
        val mode = FollowerTexts.mode()
        assertEquals(ms.getValue("maint_mode_follower").replace("%1\$s", term), mode.ms)
        assertEquals(en.getValue("maint_mode_follower").replace("%1\$s", term), mode.en)
        assertEquals(ar.getValue("maint_mode_follower").replace("%1\$s", term), mode.ar)
        assertEquals(Triple(ms.getValue("maint_unlink"), en.getValue("maint_unlink"), ar.getValue("maint_unlink")),
            Triple(FollowerTexts.UNLINK_ENTRY.ms, FollowerTexts.UNLINK_ENTRY.en, FollowerTexts.UNLINK_ENTRY.ar))
    }

    @Test
    fun theAgreedWords() {
        assertEquals("TV tambahan kepada Dewan Utama", FollowerTexts.line("Dewan Utama").ms)
        assertEquals("Extra TV for Dewan Utama", FollowerTexts.line("Dewan Utama").en)
        assertEquals("Tanggalkan dari surau", FollowerTexts.UNLINK_ENTRY.ms)
        assertEquals("Mod: MAXCOM Kiosk Box pengikut", FollowerTexts.mode().ms)
    }

    @Test
    fun everyRefusalCodeHasASentenceInThreeLanguages() {
        val keys = listOf("wrong_code", "locked", "no_backup", "has_backup", "not_local", "who_knows").map { LeaveAnswerParser.textKey(it) }.toSet() + "network"
        for (k in keys) {
            val name = "leave_err_$k"
            assertTrue("ms $name", ms.containsKey(name))
            assertTrue("en $name", en.containsKey(name))
            assertTrue("ar $name", ar.containsKey(name))
        }
        // the generic line takes the server's code, the locked line the minutes
        assertTrue(ms.getValue("leave_err_generic").contains("%1\$s"))
        assertTrue(ms.getValue("leave_err_locked").contains("%1\$d"))
    }

    @Test
    fun theUnlinkEntryIsOnlyShownForAFollowerAndCallsTheServer() {
        val m = File("src/main/kotlin/my/maxcom/box/MaintenanceActivity.kt").readText()
        // hidden when the menu is built, shown only after the server said follower
        assertTrue(m.contains("unlink.visibility = View.GONE"))
        val load = m.substringAfter("private fun loadFollower")
        assertTrue(load.contains("if (info == null) return@execute"))
        assertTrue(load.indexOf("unlink.visibility = View.VISIBLE") > load.indexOf("if (info == null)"))
        // the entry opens the leave screen; the calls run on the worker thread, and the typed code is never printed
        assertTrue(m.contains("button(inLang(\"ms\", R.string.maint_unlink)) { showLeave() }"))
        assertFalse(m.contains("unlinkFromSurauStub"))
        val leave = m.substringAfter("private fun showLeave(").substringBefore("private fun leaveResult")
        assertTrue(leave.contains("worker.execute"))
        assertTrue(leave.contains("FollowerClient().revert("))
        assertTrue(leave.contains("FollowerClient().empty("))
        assertTrue(leave.contains("input.setText(\"\")"))
        assertFalse(leave.contains("mlog("))
        assertFalse(leave.contains("println"))
    }
}
