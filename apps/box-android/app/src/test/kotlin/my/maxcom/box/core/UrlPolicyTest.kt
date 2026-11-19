package my.maxcom.box.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class UrlPolicyTest {
    private val policy = UrlPolicy(8787)

    @Test
    fun allowsTheBoxPage() {
        assertTrue(policy.allows("http://localhost:8787/"))
        assertTrue(policy.allows("http://localhost:8787/api/x?y=1"))
        assertTrue(policy.allows("http://localhost:8787"))
        assertTrue(policy.allows("http://localhost:8787/#mxhost=x"))
        assertTrue(policy.allows("http://127.0.0.1:8787/"))
        assertTrue(policy.allows("http://127.0.0.1:8787/api/x?y=1"))
        assertTrue(policy.allows("http://127.0.0.1:8787"))
    }

    @Test
    fun refusesEverythingElse() {
        val refused = listOf(
            "https://127.0.0.1:8787/",
            "http://127.0.0.1:8788/",
            "http://127.0.0.1/",
            "http://127.0.0.1.evil.example:8787/",
            "http://user@127.0.0.1:8787/",
            "http://127.0.0.1:8787@evil.example/",
            "http://evil.example:8787@127.0.0.1:8787/",
            "http://[::1]:8787/",
            "https://localhost:8787/",
            "ws://localhost:8787/",
            "wss://localhost:8787/",
            "ws://127.0.0.1:8787/",
            "http://localhost:8788/",
            "http://localhost/",
            "http://localhost:80/",
            "http://localhost:08787/",
            "http://localhost.:8787/",
            "http://LOCALHOST:8787/",
            "http://LocalHost:8787/",
            "http://localhost.evil.example:8787/",
            "http://evil.localhost:8787/",
            "http://localhost.localdomain:8787/",
            "http://localhostevil.example:8787/",
            "http://local%68ost:8787/",
            "http://localhost%2Eevil.example:8787/",
            "http://user@localhost:8787/",
            "http://localhost:8787@evil.example/",
            "http://evil.example:8787@localhost:8787/",
            "http://localhost:8787\\@evil.example/",
            "//localhost:8787/",
            "http://127.1:8787/",
            "http://0x7f000001:8787/",
            "http://2130706433:8787/",
            "http://10.168.1.5:8787/",
            "HTTP2://127.0.0.1:8787/",
            "file:///data/x",
            "content://x",
            "javascript:alert(1)",
            "intent://x",
            "data:text/html,x",
            "about:blank",
            "http://127.0.0.1:8787\\@evil.example/",
            "http://127.0.0.1:8787 /",
            "//127.0.0.1:8787/",
            "",
        )
        for (u in refused) assertFalse("should refuse: $u", policy.allows(u))
    }

    @Test
    fun portIsTheConfiguredOne() {
        assertTrue(UrlPolicy(9000).allows("http://localhost:9000/a"))
        assertFalse(UrlPolicy(9000).allows("http://localhost:8787/"))
        assertTrue(UrlPolicy(9000).allows("http://127.0.0.1:9000/a"))
        assertFalse(UrlPolicy(9000).allows("http://127.0.0.1:8787/"))
    }

    @Test
    fun hugeInputIsRefused() {
        assertFalse(policy.allows("http://127.0.0.1:8787/" + "a".repeat(9000)))
        assertFalse(policy.allows("http://localhost:8787/" + "a".repeat(9000)))
    }

    @Test
    fun kioskUrlIsTheLocalhostOriginAndAllowed() {
        assertEquals("http://localhost:8787/", UrlPolicy.kioskUrl(8787))
        assertTrue(policy.allows(UrlPolicy.kioskUrl(8787)))
        assertFalse(UrlPolicy(9000).allows(UrlPolicy.kioskUrl(8787)))
    }
}
