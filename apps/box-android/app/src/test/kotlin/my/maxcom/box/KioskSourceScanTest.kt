package my.maxcom.box

import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class KioskSourceScanTest {
    private val dir = File("src/main/kotlin/my/maxcom/box")
    private val webView = File(dir, "KioskWebView.kt").readText()
    private val activity = File(dir, "KioskActivity.kt").readText()

    @Test
    fun noBridgeNoFileAccessNoMixedContent() {
        for (bad in listOf(
            "setAllowFileAccess(true)", "allowFileAccess = true",
            "setAllowUniversalAccessFromFileURLs", "allowUniversalAccessFromFileURLs", "MIXED_CONTENT_ALWAYS_ALLOW",
            "MIXED_CONTENT_COMPATIBILITY_MODE", "allowContentAccess = true", "setWebContentsDebuggingEnabled(true)",
            "onReceivedSslError(v: WebView, handler: SslErrorHandler, error: SslError) {\n                handler.proceed",
        )) {
            assertFalse("KioskWebView.kt contains $bad", webView.contains(bad))
        }
        assertTrue(webView.contains("MIXED_CONTENT_NEVER_ALLOW"))
        assertTrue(webView.contains("allowFileAccess = false"))
        assertTrue(webView.contains("setAcceptThirdPartyCookies(view, false)"))
        assertTrue(webView.contains("FLAG_DEBUGGABLE"))
    }

    @Test
    fun onlyTheMaxcomHostBridge() {
        // One JavaScript bridge, named MaxcomHost, whose only method is exit(), gated by the loopback URL policy.
        assertEquals(1, Regex("addJavascriptInterface").findAll(webView).count())
        assertTrue(webView.contains("HOST_BRIDGE_NAME)"))
        assertTrue(webView.contains("const val HOST_BRIDGE_NAME = \"MaxcomHost\""))
        assertEquals(1, Regex("@JavascriptInterface").findAll(webView).count())
        assertTrue(webView.contains("fun exit()"))
        assertTrue(webView.contains("view.post { gate.exit(view.url, onExit) }"))
    }

    @Test
    fun policyAppliedEverywhere() {
        assertTrue(webView.contains("shouldOverrideUrlLoading"))
        assertTrue(webView.contains("shouldInterceptRequest"))
        assertTrue(webView.contains("onCreateWindow"))
        assertTrue(webView.contains("request.deny()"))
        assertTrue(webView.contains("callback.invoke(origin, false, false)"))
        assertEquals(3, Regex("policy\\.allows").findAll(webView).count())
    }

    @Test
    fun tokenIsNeverLogged() {
        val logLines = (webView + activity).lines().filter { it.contains("Log.") }
        for (l in logLines) assertFalse("log line mentions the token: $l", l.contains("token", ignoreCase = true))
        assertTrue(webView.contains("\"mxk=\$token; Path=/; HttpOnly; SameSite=Strict\""))
        assertTrue(webView.contains("\"http://127.0.0.1:\$port\""))
    }

    @Test
    fun cookieSetBeforeFirstLoad() {
        val cookie = activity.indexOf("KioskWebView.setKioskCookie")
        val load = activity.indexOf("view.loadUrl(")
        assertTrue(cookie in 0 until load)
    }

    @Test
    fun kioskActivityDoesNotReadTheIntent() {
        assertFalse(activity.contains("intent.get"))
        assertFalse(activity.contains("getIntent"))
        assertFalse(activity.contains("intent.data"))
        assertFalse(activity.contains("extras"))
    }

    @Test
    fun startTexts() {
        assertEquals("Menyediakan MAXCOM (2 daripada 4)", StartTexts.forStatus(BoxStatus.Preparing("x", 2, 4)).title)
        assertEquals("Menunggu jam Internet", StartTexts.forStatus(BoxStatus.WaitingClock).title)
        assertEquals("Memulakan pelayan MAXCOM", StartTexts.forStatus(BoxStatus.Starting).title)
        val f = StartTexts.forStatus(BoxStatus.Failing((1..9).map { "baris $it" }))
        assertEquals("MAXCOM tidak dapat dimulakan", f.title)
        assertEquals(listOf("baris 5", "baris 6", "baris 7", "baris 8", "baris 9"), f.detail)
        assertEquals("Tekan OK untuk cuba lagi", f.hint)
    }
}
