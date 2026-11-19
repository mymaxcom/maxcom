package my.maxcom.box.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class HostExitGateTest {
    private val gate = HostExitGate(UrlPolicy(8787))

    @Test
    fun runsTheActionOnTheKioskOrigin() {
        var calls = 0
        assertTrue(gate.exit("http://localhost:8787/") { calls++ })
        assertTrue(gate.exit("http://localhost:8787/?x=1#y") { calls++ })
        // The same loopback server under its old origin (kept while a page loaded before the switch is still shown).
        assertTrue(gate.exit("http://127.0.0.1:8787/") { calls++ })
        assertEquals(3, calls)
    }

    @Test
    fun refusesAnyOtherUrl() {
        var calls = 0
        val refused = listOf(
            null, "", "about:blank", "https://127.0.0.1:8787/", "http://127.0.0.1:8788/",
            "https://localhost:8787/", "ws://localhost:8787/", "http://localhost:8788/", "http://localhost/",
            "http://LOCALHOST:8787/", "http://localhost.:8787/", "http://localhost.evil.example:8787/",
            "http://evil.localhost:8787/", "http://user@localhost:8787/", "http://localhost:8787@evil.example/",
            "http://evil.example/", "http://127.0.0.1:8787@evil.example/", "file:///x", "javascript:alert(1)",
        )
        for (u in refused) assertFalse("should refuse: $u", gate.exit(u) { calls++ })
        assertEquals(0, calls)
    }
}
