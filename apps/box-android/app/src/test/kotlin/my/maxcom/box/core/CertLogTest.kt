package my.maxcom.box.core

import java.io.File
import java.nio.file.Files
import java.time.Instant
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class CertLogTest {
    private val at = Instant.parse("2026-11-11T08:09:10.123Z")

    private fun tmp(): File = Files.createTempDirectory("certlog").toFile().also { it.deleteOnExit() }

    @Test
    fun lineFormatMatchesWhatTlsTsReads() {
        val f = File(tmp(), "logs/cert-renew.log")
        CertLog.append(f, CertLog.Kind.RENEWED, "issued for 10.168.1.20", at)
        CertLog.append(f, CertLog.Kind.SKIP, "60 days left", at)
        CertLog.append(f, CertLog.Kind.FAIL, "signer refused", at)
        val lines = f.readLines()
        assertEquals("2026-11-11T08:09:10Z RENEWED issued for 10.168.1.20", lines[0])
        assertEquals("2026-11-11T08:09:10Z SKIP 60 days left", lines[1])
        // the regular expression of pkiStatus() in tls.ts
        val re = Regex("^(\\S+) (RENEWED|FAIL)\\b")
        assertTrue(re.containsMatchIn(lines[0]) && !re.containsMatchIn(lines[1]) && re.containsMatchIn(lines[2]))
        Instant.parse(re.find(lines[2])!!.groupValues[1])
    }

    @Test
    fun oneLineNoControlCharactersBounded() {
        val f = File(tmp(), "c.log")
        CertLog.append(f, CertLog.Kind.FAIL, "a\r\nb\u0000c\td" + "x".repeat(500), at)
        val lines = f.readLines()
        assertEquals(1, lines.size)
        assertTrue(lines[0].startsWith("2026-11-11T08:09:10Z FAIL a  b c d"))
        assertTrue(lines[0].length <= 21 + 5 + CertLog.MAX_MESSAGE)
        assertTrue(lines[0].none { it < ' ' })
    }

    @Test
    fun pemMaterialNeverReachesTheLog() {
        val f = File(tmp(), "c.log")
        CertLog.append(f, CertLog.Kind.FAIL, "bad -----BEGIN PRIVATE KEY-----\nMIGH...", at)
        val text = f.readText()
        assertTrue("BEGIN" !in text && "MIGH" !in text)
    }

    @Test
    fun theFileIsCutBackWhenItGrowsTooLarge() {
        val f = File(tmp(), "c.log")
        val msg = "m".repeat(250)
        repeat(700) { CertLog.append(f, CertLog.Kind.SKIP, "$it $msg", at) }
        assertTrue(f.length() < 128 * 1024)
        val lines = f.readLines()
        assertTrue(lines.size in 1..700)
        assertTrue(lines.last().contains("699 "))
    }
}
