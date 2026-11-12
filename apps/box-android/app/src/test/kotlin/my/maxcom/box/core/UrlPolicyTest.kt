package my.maxcom.box.core

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class UrlPolicyTest {
    private val policy = UrlPolicy(8787)

    @Test
    fun allowsTheBoxPage() {
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
            "http://localhost:8787/",
            "http://[::1]:8787/",
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
        assertTrue(UrlPolicy(9000).allows("http://127.0.0.1:9000/a"))
        assertFalse(UrlPolicy(9000).allows("http://127.0.0.1:8787/"))
    }

    @Test
    fun hugeInputIsRefused() {
        assertFalse(policy.allows("http://127.0.0.1:8787/" + "a".repeat(9000)))
    }
}
