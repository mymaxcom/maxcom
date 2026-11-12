package my.maxcom.box

import java.io.File
import org.junit.Assert.assertTrue
import org.junit.Test

/** core/ is pure Kotlin so it runs in JVM unit tests: no android.* or androidx.* imports. */
class CorePurityTest {
    private val dirs = listOf(
        File("src/main/kotlin/my/maxcom/box/core"),
        File("src/main/java/my/maxcom/box/core"),
    )

    private val forbidden = Regex("""(?m)^\s*import\s+(android|androidx)\.|\b(android|androidx)\.[a-z]+\.[A-Za-z]""")

    @Test
    fun coreHasNoAndroidImports() {
        val offenders = mutableListOf<String>()
        for (dir in dirs.filter { it.isDirectory }) {
            dir.walkTopDown().filter { it.isFile && (it.extension == "kt" || it.extension == "java") }.forEach { f ->
                f.readLines().forEachIndexed { i, line ->
                    val code = line.substringBefore("//")
                    if (Regex("""^\s*import\s+(android|androidx)\.""").containsMatchIn(code)) {
                        offenders += "${f.path}:${i + 1}"
                    }
                }
            }
        }
        assertTrue("android imports in core/: $offenders", offenders.isEmpty())
    }

    @Test
    fun coreHasNoFullyQualifiedAndroidUse() {
        val offenders = mutableListOf<String>()
        for (dir in dirs.filter { it.isDirectory }) {
            dir.walkTopDown().filter { it.isFile && (it.extension == "kt" || it.extension == "java") }.forEach { f ->
                f.readLines().forEachIndexed { i, line ->
                    val code = line.substringBefore("//")
                    if (Regex("""\b(android|androidx)\.[a-z]+\.[A-Z]""").containsMatchIn(code)) {
                        offenders += "${f.path}:${i + 1}"
                    }
                }
            }
        }
        assertTrue("fully qualified android use in core/: $offenders", offenders.isEmpty())
    }

    @Test
    fun detectorCatchesAnImport() {
        assertTrue(forbidden.containsMatchIn("import android.util.Log"))
        assertTrue(forbidden.containsMatchIn("import androidx.core.app.X"))
    }
}
