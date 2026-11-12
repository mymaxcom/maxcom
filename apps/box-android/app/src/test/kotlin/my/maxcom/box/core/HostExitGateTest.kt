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
        assertTrue(gate.exit("http://127.0.0.1:8787/") { calls++ })
        assertTrue(gate.exit("http://127.0.0.1:8787/?x=1#y") { calls++ })
        assertEquals(2, calls)
    }

    @Test
    fun refusesAnyOtherUrl() {
        var calls = 0
        val refused = listOf(
            null, "", "about:blank", "https://127.0.0.1:8787/", "http://127.0.0.1:8788/", "http://localhost:8787/",
            "http://evil.example/", "http://127.0.0.1:8787@evil.example/", "file:///x", "javascript:alert(1)",
        )
        for (u in refused) assertFalse("should refuse: $u", gate.exit(u) { calls++ })
        assertEquals(0, calls)
    }
}
