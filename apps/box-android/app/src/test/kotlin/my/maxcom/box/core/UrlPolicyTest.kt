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
    fun playerFrameIsOnlyTheEmbedDocument() {
        assertTrue(policy.allowsPlayerFrame("https://www.youtube-nocookie.com/embed/abcDEF123_-"))
        assertTrue(policy.allowsPlayerFrame("https://www.youtube-nocookie.com/embed/abcDEF123_-?autoplay=1&mute=1"))
        val refused = listOf(
            "http://www.youtube-nocookie.com/embed/abcDEF123_-",
            "https://youtube-nocookie.com/embed/abcDEF123_-",
            "https://www.youtube.com/embed/abcDEF123_-",
            "https://www.youtube.com/watch?v=abcDEF123_-",
            "https://www.youtube-nocookie.com/",
            "https://www.youtube-nocookie.com/embed/",
            "https://www.youtube-nocookie.com/embed/short",
            "https://www.youtube-nocookie.com/embed/abcDEF123_-/x",
            "https://www.youtube-nocookie.com/embed/../watch",
            "https://www.youtube-nocookie.com:443/embed/abcDEF123_-",
            "https://www.youtube-nocookie.com:8443/embed/abcDEF123_-",
            "https://user@www.youtube-nocookie.com/embed/abcDEF123_-",
            "https://www.youtube-nocookie.com@evil.example/embed/abcDEF123_-",
            "https://www.youtube-nocookie.com.evil.example/embed/abcDEF123_-",
            "https://WWW.YOUTUBE-NOCOOKIE.COM/embed/abcDEF123_-",
            "https://www.youtube-nocookie.com./embed/abcDEF123_-",
            "//www.youtube-nocookie.com/embed/abcDEF123_-",
            "javascript:alert(1)",
            "",
        )
        for (u in refused) assertFalse("should refuse frame: $u", policy.allowsPlayerFrame(u))
        // The kiosk origin's own check does not open for the player.
        assertFalse(policy.allows("https://www.youtube-nocookie.com/embed/abcDEF123_-"))
    }

    @Test
    fun playerResourcesAreHttpsOnThePlayerHostsOnly() {
        val allowed = listOf(
            "https://www.youtube-nocookie.com/embed/abcDEF123_-",
            "https://www.youtube.com/s/player/abc/player_ias.vflset/en_US/base.js",
            "https://rr3---sn-abc.googlevideo.com/videoplayback?x=1",
            "https://i.ytimg.com/vi/abcDEF123_-/hqdefault.jpg",
            "https://yt3.ggpht.com/a/x=s68",
            "https://www.gstatic.com/x.js",
            "https://googlevideo.com/x",
        )
        for (u in allowed) assertTrue("should allow: $u", policy.allowsPlayerResource(u))
        val refused = listOf(
            "http://www.youtube.com/x",
            "https://evil.example/x",
            "https://youtube.com.evil.example/x",
            "https://evilyoutube.com/x",
            "https://notgooglevideo.com/x",
            "https://www.youtube.com:8443/x",
            "https://www.youtube.com:443/x",
            "https://user@www.youtube.com/x",
            "https://www.youtube.com@evil.example/x",
            "https://www.YouTube.com/x",
            "https://www.youtube.com./x",
            "https://10.168.1.5/x",
            "https://[::1]/x",
            "https://localhost/x",
            "https://com/x",
            "wss://www.youtube.com/x",
            "blob:https://www.youtube.com/x",
            "data:text/html,x",
            "file:///data/x",
            "intent://x",
            "",
            "https://www.youtube.com/" + "a".repeat(9000),
        )
        for (u in refused) assertFalse("should refuse: $u", policy.allowsPlayerResource(u))
    }

    @Test
    fun wwwGoogleComIsAPlayerResourceOnlyAndOnlyExactly() {
        assertTrue(policy.allowsPlayerResource("https://www.google.com/js/th/abc.js"))
        val refused = listOf(
            "http://www.google.com/x",
            "https://google.com/x",
            "https://accounts.google.com/x",
            "https://mail.google.com/x",
            "https://www.google.com.evil.example/x",
            "https://evilwww.google.com/x",
            "https://www.google.com:8443/x",
            "https://www.google.com:443/x",
            "https://user@www.google.com/x",
            "https://www.google.com./x",
            // The host-shape rule is lower case only, so upper case is refused (as for the other player hosts).
            "https://WWW.GOOGLE.COM/x",
        )
        for (u in refused) assertFalse("should refuse: $u", policy.allowsPlayerResource(u))
        // Never the page, never a frame document.
        assertFalse(policy.allows("https://www.google.com/"))
        assertFalse(policy.allowsPlayerFrame("https://www.google.com/"))
    }

    @Test
    fun kioskUrlIsTheLocalhostOriginAndAllowed() {
        assertEquals("http://localhost:8787/", UrlPolicy.kioskUrl(8787))
        assertTrue(policy.allows(UrlPolicy.kioskUrl(8787)))
        assertFalse(UrlPolicy(9000).allows(UrlPolicy.kioskUrl(8787)))
    }
}
