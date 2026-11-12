package my.maxcom.box

import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/** Regression: addView(view, 0, MATCH_PARENT) resolved to (view, width=0, height) and made the kiosk WebView 0px wide. */
class AddViewOverloadScanTest {
    private val dir = File("src/main/kotlin/my/maxcom/box")

    private fun code(f: File): String = f.readLines().joinToString("\n") { it.substringBefore("//") }

    @Test
    fun noAddViewWithAnIntegerIndexOrZeroWidthFollowedByASizeConstant() {
        val bad = Regex("""addView\(\s*[\w.]+\s*,\s*(\d+|-?\d+[a-z]*)\s*,\s*[\w.]*(MATCH_PARENT|WRAP_CONTENT)\s*\)""")
        val hits = dir.walkTopDown().filter { it.isFile && it.extension == "kt" }
            .filter { bad.containsMatchIn(code(it)) }.map { it.name }.toList()
        assertEquals(emptyList<String>(), hits)
    }

    @Test
    fun kioskActivityInsertsTheWebViewWithALayoutParamsObject() {
        val c = code(File(dir, "KioskActivity.kt"))
        assertTrue(Regex("""root\.addView\(\s*view\s*,\s*0\s*,\s*(FrameLayout|ViewGroup)\.LayoutParams\(""").containsMatchIn(c))
    }
}
