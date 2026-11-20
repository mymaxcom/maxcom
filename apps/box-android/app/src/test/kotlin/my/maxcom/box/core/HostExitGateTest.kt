package my.maxcom.box.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class HostExitGateTest {
    private val key = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
    private val gate = HostExitGate(UrlPolicy(8787), key)

    @Test
    fun runsTheActionOnTheKioskOriginWithTheKey() {
        var calls = 0
        assertTrue(gate.exit("http://localhost:8787/", key) { calls++ })
        assertTrue(gate.exit("http://localhost:8787/?x=1#y", key) { calls++ })
        // The same loopback server under its old origin (kept while a page loaded before the switch is still shown).
        assertTrue(gate.exit("http://127.0.0.1:8787/", key) { calls++ })
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
        for (u in refused) assertFalse("should refuse: $u", gate.exit(u, key) { calls++ })
        assertEquals(0, calls)
    }

    // A frame from another origin sees the bridge object but not the key: the top page URL alone is not enough.
    @Test
    fun refusesWithoutTheKeyEvenOnTheKioskOrigin() {
        var calls = 0
        val wrong = listOf(
            null, "", "undefined", "null", key.dropLast(1), key + "0", key.uppercase(), key.replaceFirst('0', '1'),
            "f".repeat(64), " $key", "$key ",
        )
        for (k in wrong) assertFalse("should refuse key: $k", gate.exit("http://localhost:8787/", k) { calls++ })
        assertEquals(0, calls)
    }

    @Test
    fun aShortKeyIsNotAccepted() {
        assertThrows(IllegalArgumentException::class.java) { HostExitGate(UrlPolicy(8787), "abc") }
        assertThrows(IllegalArgumentException::class.java) { HostExitGate(UrlPolicy(8787), "") }
    }
}
