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
        // One JavaScript bridge, named MaxcomHost, whose only methods are exit() and videoStuck(), gated by the loopback URL policy.
        assertEquals(1, Regex("addJavascriptInterface").findAll(webView).count())
        assertTrue(webView.contains("HOST_BRIDGE_NAME)"))
        assertTrue(webView.contains("const val HOST_BRIDGE_NAME = \"MaxcomHost\""))
        assertEquals(2, Regex("@JavascriptInterface").findAll(webView).count())
        // exit needs the key: there is no way to call it without one.
        assertFalse(webView.contains("fun exit()"))
        assertTrue(webView.contains("fun exit(key: String?)"))
        assertTrue(webView.contains("view.post { gate.exit(view.url, key, onExit) }"))
        // videoStuck goes through the same gate (same key, same URL rule), on the main thread, and has no key-less form.
        assertFalse(webView.contains("fun videoStuck()"))
        assertTrue(webView.contains("fun videoStuck(key: String?)"))
        assertTrue(webView.contains("view.post { gate.run(view.url, key, onVideoStuck) }"))
        assertEquals(2, Regex("gate\\.(exit|run)\\(").findAll(webView).count())
        // The key is random per view, given to the kiosk origin's main frame only, and never logged.
        assertTrue(webView.contains("java.security.SecureRandom().nextBytes(bytes)"))
        assertTrue(webView.contains("if (url != null && policy.allows(url)) v.evaluateJavascript("))
        assertEquals(1, Regex("evaluateJavascript").findAll(webView).count())
        for (l in webView.lines().filter { it.contains("Log.") }) assertFalse(l.contains("hostKey", ignoreCase = true))
    }

    @Test
    fun videoRecoveryWiredAndBounded() {
        val code = activity.lines().joinToString("\n") { it.substringBefore("//") }
        assertTrue(code.contains("onVideoStuck = { main.post { onVideoStuck() } }"))
        assertTrue(code.contains("VideoRecovery("))
        assertTrue(code.contains("recovery.onStuck(System.currentTimeMillis())"))
        // The renderer restart ends in the existing restartPage path; the server (BoxService) is not stopped for it.
        assertTrue(code.contains("webViewRenderProcess?.terminate()"))
        // The app restart: stop the service the same way Maintenance does, relaunch by an immutable explicit PendingIntent.
        assertTrue(code.contains("PendingIntent.FLAG_IMMUTABLE"))
        assertTrue(code.contains("Intent(this, KioskActivity::class.java)"))
        assertTrue(code.contains("stopService(Intent(this, BoxService::class.java))"))
        assertEquals(1, Regex("killProcess").findAll(code).count())
        // Ending the process comes only after the Home check, the armed alarm and the combined decision.
        val fn = code.substring(code.indexOf("private fun restartApp()"))
        val kill = fn.indexOf("killProcess")
        assertTrue(fn.indexOf("isDefaultHome()") in 0 until kill)
        assertTrue(fn.indexOf("armRelaunch()") in 0 until kill)
        assertTrue(fn.indexOf("VideoRecovery.mayRestartApp(isHome, armed)") in 0 until kill)
        assertTrue(fn.indexOf("recovery.appRestarted(") in 0 until kill)
        assertTrue(fn.indexOf("stopService(") in 0 until kill)
        // A declined restart returns before the stamp is stored and before the service is stopped.
        assertTrue(fn.indexOf("return") in 0 until fn.indexOf("recovery.appRestarted("))
        assertTrue(code.contains("EXIT_AFTER_MS = 11_000L"))
        // The log lines carry no URL and no token.
        for (l in activity.lines().filter { it.contains("Log.w") && it.contains("video") }) {
            assertFalse(l.contains("http", ignoreCase = true))
        }
    }

    @Test
    fun policyAppliedEverywhere() {
        assertTrue(webView.contains("shouldOverrideUrlLoading"))
        assertTrue(webView.contains("shouldInterceptRequest"))
        assertTrue(webView.contains("onCreateWindow"))
        assertTrue(webView.contains("request.deny()"))
        assertTrue(webView.contains("callback.invoke(origin, false, false)"))
        // navigation, request, page start, and the bridge key (given to the kiosk origin only)
        assertEquals(4, Regex("policy\\.allows\\(").findAll(webView).count())
        // The video player's exception: one frame check and one resource check, both closed to the main frame.
        assertEquals(1, Regex("policy\\.allowsPlayerFrame\\(").findAll(webView).count())
        assertEquals(1, Regex("policy\\.allowsPlayerResource\\(").findAll(webView).count())
        assertTrue(webView.contains("return request.isForMainFrame || !policy.allowsPlayerFrame(url)"))
        assertTrue(webView.contains("if (!request.isForMainFrame && policy.allowsPlayerResource(url)) return null"))
    }

    @Test
    fun tokenIsNeverLogged() {
        val logLines = (webView + activity).lines().filter { it.contains("Log.") }
        for (l in logLines) assertFalse("log line mentions the token: $l", l.contains("token", ignoreCase = true))
        assertTrue(webView.contains("\"mxk=\$token; Path=/; HttpOnly; SameSite=Strict\""))
        assertTrue(webView.contains("\"http://\${UrlPolicy.KIOSK_HOST}:\$port\""))
        assertFalse(webView.contains("127.0.0.1"))
        assertTrue(activity.contains("view.loadUrl(UrlPolicy.kioskUrl(port))"))
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
