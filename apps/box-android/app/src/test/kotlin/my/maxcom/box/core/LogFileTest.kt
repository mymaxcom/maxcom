package my.maxcom.box.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File

class LogFileTest {
    @get:Rule
    val tmp = TemporaryFolder()

    private fun logIn(maxBytes: Long = 5L * 1024 * 1024, keep: Int = 3, now: () -> Long = { 1_700_000_000_123L }): Pair<LogFile, File> {
        val f = File(tmp.root, "logs/box.log")
        return LogFile(f, maxBytes, keep, now) to f
    }

    @Test
    fun stampsEveryLineWithIsoTime() {
        val (log, f) = logIn()
        log.appendLine("hello")
        log.appendLine("two\r\nthree")
        assertEquals(
            listOf(
                "2023-11-14T22:13:20.123Z hello",
                "2023-11-14T22:13:20.123Z two",
                "2023-11-14T22:13:20.123Z three",
            ),
            f.readLines(),
        )
    }

    @Test
    fun rotatesAtTheLimitAndKeepsThree() {
        val (log, f) = logIn(maxBytes = 200, keep = 3)
        repeat(60) { log.appendLine("line-%03d".format(it)) }
        val names = f.parentFile!!.list()!!.toSet()
        assertEquals(setOf("box.log", "box.log.1", "box.log.2", "box.log.3"), names)
        for (n in names) assertTrue(n, File(f.parentFile!!, n).length() <= 200)
        // newest lines in box.log, older ones in higher numbers, nothing out of order
        val all = (listOf(f.path + ".3", f.path + ".2", f.path + ".1", f.path)).flatMap { File(it).readLines() }
        val numbers = all.map { it.substringAfterLast("line-").toInt() }
        assertEquals(numbers.sorted(), numbers)
        assertEquals(59, numbers.last())
        assertTrue(numbers.first() > 0) // the oldest were dropped
    }

    @Test
    fun keepOneRotatesToOneFile() {
        val (log, f) = logIn(maxBytes = 100, keep = 1)
        repeat(30) { log.appendLine("line-%03d".format(it)) }
        assertEquals(setOf("box.log", "box.log.1"), f.parentFile!!.list()!!.toSet())
    }

    @Test
    fun secretsNeverReachTheFile() {
        val (log, f) = logIn()
        val token = "0123456789abcdef0123456789abcdef"
        log.addSecret(token)
        log.addSecret("short") // below the minimum length: ignored
        log.appendLine("token=$token and short")
        val text = f.readText()
        assertFalse(text.contains(token))
        assertTrue(text.contains("token=*** and short"))
        assertEquals("a *** b", log.redact("a $token b"))
    }
}
