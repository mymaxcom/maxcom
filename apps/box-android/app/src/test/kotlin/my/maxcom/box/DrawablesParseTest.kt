package my.maxcom.box

import java.io.File
import javax.xml.parsers.DocumentBuilderFactory
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/** Every box drawable is well-formed XML with a vector or layer root, and the wordmark has real path data. */
class DrawablesParseTest {
    private val res = File("src/main/res")

    private fun drawables(): List<File> =
        res.listFiles { f -> f.isDirectory && f.name.startsWith("drawable") }.orEmpty()
            .flatMap { it.listFiles { x -> x.extension == "xml" }.orEmpty().toList() }

    @Test
    fun everyDrawableParses() {
        val files = drawables()
        assertTrue(files.size >= 3)
        for (f in files) {
            val doc = DocumentBuilderFactory.newInstance().newDocumentBuilder().parse(f)
            val root = doc.documentElement.tagName
            assertTrue("${f.name} root $root", root in setOf("vector", "layer-list", "shape", "bitmap", "selector"))
        }
    }

    @Test
    fun theWordmarkHasPaths() {
        val doc = DocumentBuilderFactory.newInstance().newDocumentBuilder().parse(File(res, "drawable/maxcom_wordmark.xml"))
        assertEquals("vector", doc.documentElement.tagName)
        assertTrue(doc.getElementsByTagName("path").length > 0)
    }
}
