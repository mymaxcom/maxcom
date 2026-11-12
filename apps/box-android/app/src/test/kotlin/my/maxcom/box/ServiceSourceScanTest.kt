package my.maxcom.box

import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** Source scans for the security-sensitive service classes (Review Focus 9, Global Constraints). */
class ServiceSourceScanTest {
    private val dir = File("src/main/kotlin/my/maxcom/box")

    private fun code(name: String): String =
        File(dir, name).readLines().joinToString("\n") { it.substringBefore("//") }

    @Test
    fun serviceAndReceiverStartNoShellsAndNoRawExec() {
        for (name in listOf("BoxService.kt", "BootReceiver.kt")) {
            val c = code(name)
            assertFalse("$name exec", Regex("""Runtime\s*\.\s*getRuntime\s*\(\s*\)\s*\.\s*exec""").containsMatchIn(c))
            assertFalse("$name sh", c.contains("\"sh\""))
            assertFalse("$name su", c.contains("\"su\""))
            assertFalse("$name ProcessBuilder", c.contains("ProcessBuilder"))
        }
    }

    @Test
    fun processBuilderLivesOnlyInTheOneStarterAndClearsTheEnvironmentFirst() {
        val users = dir.walkTopDown().filter { it.isFile && it.extension == "kt" }
            .filter { code(it.relativeTo(dir).path.replace('\\', '/')).contains("ProcessBuilder") }
            .map { it.name }.toList()
        assertEquals(listOf("AndroidProcessStarter.kt"), users)
        val c = code("AndroidProcessStarter.kt")
        val clear = c.indexOf("environment().clear()")
        val put = c.indexOf("environment().putAll")
        assertTrue(clear > 0)
        assertTrue("clear must come before the map is set", put > clear)
        assertTrue(c.contains("checkExecutable"))
    }

    @Test
    fun nothingLogsTheTokenOrSecretPaths() {
        for (name in listOf("BoxService.kt", "BootReceiver.kt", "KeystoreSigner.kt", "NetworkWatch.kt")) {
            val c = code(name)
            for (line in c.lines().filter { Regex("""(?<![A-Za-z])Log\.""").containsMatchIn(it) }) {
                assertFalse("$name logs token: $line", Regex("token", RegexOption.IGNORE_CASE).containsMatchIn(line))
                assertFalse("$name logs a path: $line", line.contains("paths.") || line.contains("secret"))
            }
        }
    }

    @Test
    fun theLeafIsWrittenBeforeItsKeyAndTheServerStartsBeforeTheClockWait() {
        val ca = File("src/main/kotlin/my/maxcom/box/core/BoxCa.kt").readText()
        val leafAt = ca.indexOf("writeAtomic(File(pki, \"box-leaf.cer\")")
        val keyAt = ca.indexOf("writeAtomic(File(secret, \"box-key.pem\")")
        assertTrue(leafAt > 0 && keyAt > leafAt)
        val svc = code("BoxService.kt")
        val prepare = svc.substring(svc.indexOf("private fun prepare()"))
        assertTrue(prepare.indexOf("startSupervisor(config)") in 1 until prepare.indexOf("prepareCertificate()"))
        assertTrue(Regex("""@Volatile\s+private var destroyed""").containsMatchIn(svc))
    }

    @Test
    fun bootReceiverActsOnBootCompletedOnly() {
        val c = code("BootReceiver.kt")
        assertTrue(c.contains("Intent.ACTION_BOOT_COMPLETED"))
        assertFalse(c.contains("getStringExtra") || c.contains("getParcelableExtra") || c.contains(".data"))
    }
}
