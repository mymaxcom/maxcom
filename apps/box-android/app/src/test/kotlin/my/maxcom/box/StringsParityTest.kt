package my.maxcom.box

import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** Every box text the screens read from strings.xml exists in Bahasa Malaysia (default), English and Arabic. */
class StringsParityTest {
    private val res = File("src/main/res")
    private val entry = Regex("""<string name="([a-z_]+)"([^>]*)>(.*?)</string>""")

    private fun read(dir: String) = File(res, "$dir/strings.xml").readText(Charsets.UTF_8)

    private fun xml(dir: String): Map<String, String> =
        entry.findAll(read(dir)).associate { it.groupValues[1] to it.groupValues[3] }

    /** The keys that are translated: everything in values/ except the ones marked translatable="false". */
    private fun translatable(): Set<String> =
        entry.findAll(read("values")).filter { !it.groupValues[2].contains("translatable=\"false\"") }.map { it.groupValues[1] }.toSet()

    private val arabic = Regex("[؀-ۿ]")
    private val bad = Regex("[—–≈→←٠-٩]|->|=>")

    @Test
    fun valuesEnAndArHaveExactlyTheTranslatableKeys() {
        val want = translatable()
        assertTrue(want.size > 40)
        assertEquals((want - xml("values-en").keys).toString(), want, xml("values-en").keys)
        assertEquals((want - xml("values-ar").keys).toString(), want, xml("values-ar").keys)
    }

    @Test
    fun theProductNamesAreNotTranslated() {
        val ms = read("values")
        for (k in listOf("app_name", "box_term")) {
            assertTrue(k, Regex("""<string name="$k" translatable="false">""").containsMatchIn(ms))
        }
    }

    @Test
    fun placeholdersMatchInEveryLanguage() {
        val ph = Regex("%\\d\\$[sd]")
        val ms = xml("values")
        val en = xml("values-en")
        val ar = xml("values-ar")
        for (k in translatable()) {
            val want = ph.findAll(ms.getValue(k)).map { it.value }.sorted().toList()
            assertEquals("en $k", want, ph.findAll(en.getValue(k)).map { it.value }.sorted().toList())
            assertEquals("ar $k", want, ph.findAll(ar.getValue(k)).map { it.value }.sorted().toList())
        }
    }

    @Test
    fun eachFileIsInItsOwnLanguage() {
        val ms = xml("values")
        val en = xml("values-en")
        val ar = xml("values-ar")
        for (k in translatable()) {
            assertTrue("ar $k", arabic.containsMatchIn(ar.getValue(k)))
            assertFalse("en $k", arabic.containsMatchIn(en.getValue(k)))
            assertFalse("ms $k", arabic.containsMatchIn(ms.getValue(k)))
        }
    }

    @Test
    fun noKotakNoDashNoArrowAnywhere() {
        val kotak = Regex("kotak", RegexOption.IGNORE_CASE)
        for (dir in listOf("values", "values-en", "values-ar")) {
            for ((k, v) in xml(dir)) {
                assertFalse("$dir $k", kotak.containsMatchIn(v))
                assertFalse("$dir $k", bad.containsMatchIn(v))
            }
        }
    }

    @Test
    fun theMaintenanceWordAndTheRestartNotice() {
        assertEquals("Penyelenggaraan", xml("values").getValue("maint_title_word"))
        assertEquals("Maintenance", xml("values-en").getValue("maint_title_word"))
        assertEquals("الصيانة", xml("values-ar").getValue("maint_title_word"))
        assertEquals("%1\$s akan dimulakan semula. Tunggu sebentar.", xml("values").getValue("leave_done"))
        assertEquals("%1\$s will restart. Please wait.", xml("values-en").getValue("leave_done"))
    }

    @Test
    fun theUnusedNotYetAvailableTextIsGone() {
        for (dir in listOf("values", "values-en", "values-ar")) assertFalse(dir, xml(dir).containsKey("maint_unlink_soon"))
        val src = File("src/main/kotlin/my/maxcom/box").walk().filter { it.isFile }.joinToString("\n") { it.readText() }
        assertFalse(src.contains("UNLINK_SOON"))
        assertFalse(src.contains("maint_unlink_soon"))
    }
}
