package my.maxcom.box.core

import java.net.InetAddress
import java.net.ServerSocket
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test

class FollowerLeaveTest {
    private var server: ServerSocket? = null

    @After
    fun stop() {
        server?.close()
    }

    // ---- the input normaliser ----

    @Test
    fun theCodeIsCleanedLikeTheServerDoesIt() {
        assertEquals("ABCD2345EFGH6789", RecoveryCodeInput.normalise("abcd-2345-efgh-6789"))
        assertEquals("ABCD2345EFGH6789", RecoveryCodeInput.normalise(" abcd 2345  efgh-6789 \n"))
        assertEquals("ABCD2345EFGH6789", RecoveryCodeInput.normalise("ABCD2345EFGH6789"))
        assertEquals("", RecoveryCodeInput.normalise(" - - "))
    }

    @Test
    fun onlySixteenLettersOrDigitsAreComplete() {
        assertTrue(RecoveryCodeInput.isComplete("abcd-2345-efgh-6789"))
        assertTrue(RecoveryCodeInput.isComplete("ABCD2345EFGH6789"))
        assertFalse(RecoveryCodeInput.isComplete(""))
        assertFalse(RecoveryCodeInput.isComplete("ABCD-2345-EFGH"))
        assertFalse(RecoveryCodeInput.isComplete("ABCD-2345-EFGH-6789-A"))
        assertFalse(RecoveryCodeInput.isComplete("ABCD-2345-EFGH-678!"))
    }

    // ---- the request bodies ----

    @Test
    fun theRevertBodyCarriesOnlyTheCleanedCode() {
        val j = JSONObject(LeaveAnswerParser.revertBody("abcd-2345-efgh-6789"))
        assertEquals(setOf("recoveryCode"), j.keys().asSequence().toSet())
        assertEquals("ABCD2345EFGH6789", j.getString("recoveryCode"))
        // a quote or a backslash cannot break out of the string
        val odd = JSONObject(LeaveAnswerParser.revertBody("a\"b\\c"))
        assertEquals("A\"B\\C", odd.getString("recoveryCode"))
    }

    // ---- the answers ----

    @Test
    fun a200WithOkIsDone() {
        assertSame(LeaveAnswer.Done, LeaveAnswerParser.parse(200, """{"ok":true,"restarting":true}"""))
        assertSame(LeaveAnswer.Done, LeaveAnswerParser.parse(200, """{"ok":true,"restarting":false}"""))
    }

    private fun refused(status: Int, body: String): LeaveAnswer.Refused = LeaveAnswerParser.parse(status, body) as LeaveAnswer.Refused

    @Test
    fun everyRefusalCodeIsRead() {
        assertEquals("wrong_code", refused(401, """{"code":"wrong_code","errors":["wrong_code"]}""").code)
        val locked = refused(429, """{"code":"locked","errors":["locked"],"retryAfterSec":1500}""")
        assertEquals("locked", locked.code)
        assertEquals(1500, locked.retryAfterSec)
        assertEquals("no_backup", refused(409, """{"code":"no_backup","errors":["no_backup"]}""").code)
        assertEquals("has_backup", refused(409, """{"code":"has_backup","errors":["has_backup"]}""").code)
        assertEquals("not_local", refused(400, """{"code":"not_local","errors":["not_local"]}""").code)
        assertEquals("not_found", refused(404, """{"code":"not_found","errors":["not_found"]}""").code)
        assertEquals("linking", refused(409, """{"code":"linking","errors":["linking"]}""").code)
    }

    @Test
    fun theFirstErrorIsUsedWhenThereIsNoCodeAndNoiseBecomesUnknown() {
        assertEquals("wrong_code", refused(401, """{"errors":["wrong_code"]}""").code)
        assertEquals("unknown", refused(500, "not json").code)
        assertEquals("unknown", refused(502, "").code)
        assertEquals("unknown", refused(400, """{"code":"A sentence with spaces!"}""").code)
        assertEquals("unknown", refused(400, """{"code":"${"x".repeat(80)}"}""").code)
        // a 200 without ok is not a success
        assertEquals("unknown", refused(200, """{"ok":false}""").code)
        assertEquals("unknown", refused(200, "{}").code)
    }

    @Test
    fun theWaitIsInWholeMinutesAndBounded() {
        assertEquals(1, LeaveAnswerParser.minutes(0))
        assertEquals(1, LeaveAnswerParser.minutes(60))
        assertEquals(2, LeaveAnswerParser.minutes(61))
        assertEquals(25, LeaveAnswerParser.minutes(1500))
        assertEquals(120, refused(429, """{"code":"locked","retryAfterSec":999999}""").retryAfterSec / 60)
    }

    // ---- the code-to-text mapping ----

    @Test
    fun theKnownCodesHaveTheirOwnSentenceAndAnythingElseTheGenericOne() {
        for (c in listOf("wrong_code", "locked", "no_backup", "has_backup", "not_local")) assertEquals(c, LeaveAnswerParser.textKey(c))
        for (c in listOf("not_found", "linking", "unknown", "", "follower")) assertEquals("generic", LeaveAnswerParser.textKey(c))
    }

    // ---- the client against a local stand-in for the box server ----

    private class Seen(var request: String = "", var body: String = "", var type: String = "", var leave: String? = null)

    private fun serve(status: Int, body: String, seen: Seen): Int {
        val s = ServerSocket(0, 5, InetAddress.getByName("127.0.0.1"))
        server = s
        Thread {
            try {
                while (true) {
                    val c = s.accept()
                    c.use {
                        val r = it.getInputStream().bufferedReader()
                        seen.request = r.readLine() ?: ""
                        var len = 0
                        while (true) {
                            val l = r.readLine() ?: break
                            if (l.isEmpty()) break
                            if (l.startsWith("Content-Length:", ignoreCase = true)) len = l.substringAfter(':').trim().toInt()
                            if (l.startsWith("X-Maxcom-Leave:", ignoreCase = true)) seen.leave = l.substringAfter(':').trim()
                            if (l.startsWith("Content-Type:", ignoreCase = true)) seen.type = l.substringAfter(':').trim()
                        }
                        val buf = CharArray(len)
                        var got = 0
                        while (got < len) { val n = r.read(buf, got, len - got); if (n < 0) break; got += n }
                        seen.body = String(buf, 0, got)
                        val b = body.toByteArray()
                        val crlf = "\r\n"
                        val head = "HTTP/1.1 $status X" + crlf + "Content-Type: application/json" + crlf +
                            "Content-Length: " + b.size + crlf + "Connection: close" + crlf + crlf
                        it.getOutputStream().write(head.toByteArray() + b)
                        it.getOutputStream().flush()
                    }
                }
            } catch (_: Exception) {
            }
        }.also { it.isDaemon = true }.start()
        return s.localPort
    }

    @Test
    fun revertPostsTheCleanedCodeAsJson() {
        val seen = Seen()
        val port = serve(200, """{"ok":true,"restarting":true}""", seen)
        assertSame(LeaveAnswer.Done, FollowerClient().revert(port, "abcd-2345-efgh-6789"))
        assertEquals("POST /api/follow/revert HTTP/1.1", seen.request)
        assertTrue(seen.type.startsWith("application/json"))
        assertEquals("ABCD2345EFGH6789", JSONObject(seen.body).getString("recoveryCode"))
    }

    @Test
    fun bothCallsSendTheLeaveSecretAsHeaderAndNeverInTheBody() {
        val secret = "ef".repeat(32)
        val a = Seen()
        assertSame(LeaveAnswer.Done, FollowerClient().revert(serve(200, """{"ok":true}""", a), "abcd-2345-efgh-6789", secret))
        assertEquals(secret, a.leave)
        assertFalse(a.body.contains(secret))
        server?.close()
        val b = Seen()
        assertSame(LeaveAnswer.Done, FollowerClient().empty(serve(200, """{"ok":true}""", b), secret))
        assertEquals(secret, b.leave)
        assertFalse(b.body.contains(secret))
    }

    @Test
    fun theHeldSecretIsTheDefaultAndNoSecretMeansNoHeader() {
        val held = "12".repeat(32)
        LeaveSecret.set(held)
        try {
            val a = Seen()
            FollowerClient().empty(serve(200, """{"ok":true}""", a))
            assertEquals(held, a.leave)
            server?.close()
            LeaveSecret.clear()
            assertNull(LeaveSecret.get())
            val b = Seen()
            val answer = FollowerClient().empty(serve(400, """{"code":"not_local","errors":["not_local"]}""", b))
            assertNull(b.leave)
            assertEquals("not_local", (answer as LeaveAnswer.Refused).code)
        } finally {
            LeaveSecret.clear()
        }
    }

    @Test
    fun emptyPostsAnEmptyObject() {
        val seen = Seen()
        val port = serve(200, """{"ok":true,"restarting":true}""", seen)
        assertSame(LeaveAnswer.Done, FollowerClient().empty(port))
        assertEquals("POST /api/follow/empty HTTP/1.1", seen.request)
        assertEquals("{}", seen.body)
    }

    @Test
    fun aRefusalWithAnErrorStatusIsReadFromTheErrorStream() {
        val port = serve(401, """{"code":"wrong_code","errors":["wrong_code"]}""", Seen())
        val a = FollowerClient().revert(port, "ABCD2345EFGH6789") as LeaveAnswer.Refused
        assertEquals("wrong_code", a.code)
        server?.close()
        val port2 = serve(429, """{"code":"locked","errors":["locked"],"retryAfterSec":600}""", Seen())
        val b = FollowerClient().revert(port2, "ABCD2345EFGH6789") as LeaveAnswer.Refused
        assertEquals("locked", b.code)
        assertEquals(600, b.retryAfterSec)
        server?.close()
        val port3 = serve(409, """{"code":"has_backup","errors":["has_backup"]}""", Seen())
        assertEquals("has_backup", (FollowerClient().empty(port3) as LeaveAnswer.Refused).code)
    }

    @Test
    fun noServerIsUnreachable() {
        val s = ServerSocket(0, 1, InetAddress.getByName("127.0.0.1"))
        val port = s.localPort
        s.close()
        assertSame(LeaveAnswer.Unreachable, FollowerClient().empty(port))
        assertSame(LeaveAnswer.Unreachable, FollowerClient().revert(port, "ABCD2345EFGH6789"))
    }
}
