package my.maxcom.box

import android.annotation.SuppressLint
import android.content.Context
import android.content.pm.ApplicationInfo
import android.graphics.Bitmap
import android.net.http.SslError
import android.os.Message
import android.util.Log
import android.webkit.CookieManager
import android.webkit.GeolocationPermissions
import android.webkit.PermissionRequest
import android.webkit.RenderProcessGoneDetail
import android.webkit.SslErrorHandler
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.JavascriptInterface
import android.webkit.WebViewClient
import java.io.ByteArrayInputStream
import my.maxcom.box.core.HostExitGate
import my.maxcom.box.core.UrlPolicy

/**
 * The kiosk WebView: loopback page only, one bridge ([HostBridge], `MaxcomHost.exit()`) and nothing else, no file
 * or content access, no mixed content, no permissions. Every navigation, sub-resource request and new window is checked by
 * [UrlPolicy]. The kiosk token is handled only as a cookie value and never logged.
 */
object KioskWebView {
    private const val TAG = "MAXCOM"
    private const val PREFS = "kiosk"
    private const val KEY_VERSION = "cache_version"

    @SuppressLint("SetJavaScriptEnabled")
    fun create(
        context: Context,
        policy: UrlPolicy,
        onRendererGone: () -> Unit,
        onLoadError: () -> Unit,
        onExitToHost: () -> Unit = {},
    ): WebView {
        val debuggable = (context.applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE) != 0
        WebView.setWebContentsDebuggingEnabled(debuggable)
        val view = WebView(context)
        view.setBackgroundColor(context.getColor(R.color.maxcom_bg))
        view.isFocusable = true
        view.isFocusableInTouchMode = true
        view.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            allowFileAccess = false
            allowContentAccess = false
            allowFileAccessFromFileURLs = false
            mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
            setGeolocationEnabled(false)
            @Suppress("DEPRECATION")
            saveFormData = false
            setSupportMultipleWindows(false)
            javaScriptCanOpenWindowsAutomatically = false
            mediaPlaybackRequiresUserGesture = false
            // The page is on loopback only; Safe Browsing lookups would leave the device for nothing.
            safeBrowsingEnabled = false
            cacheMode = WebSettings.LOAD_DEFAULT
        }
        CookieManager.getInstance().apply {
            setAcceptCookie(true)
            setAcceptThirdPartyCookies(view, false)
        }
        view.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(v: WebView, request: WebResourceRequest): Boolean =
                !policy.allows(request.url.toString())

            override fun shouldInterceptRequest(v: WebView, request: WebResourceRequest): WebResourceResponse? =
                if (policy.allows(request.url.toString())) null else refused()

            override fun onReceivedSslError(v: WebView, handler: SslErrorHandler, error: SslError) {
                handler.cancel()
            }

            override fun onPageStarted(v: WebView, url: String?, favicon: Bitmap?) {
                // A page that got past the checks above to somewhere else is stopped, not shown.
                if (url != null && url != "about:blank" && !policy.allows(url)) v.stopLoading()
            }

            override fun onReceivedError(v: WebView, request: WebResourceRequest, error: WebResourceError) {
                if (request.isForMainFrame) onLoadError()
            }

            override fun onRenderProcessGone(v: WebView, detail: RenderProcessGoneDetail): Boolean {
                Log.w(TAG, "WebView renderer gone, crash=" + detail.didCrash())
                onRendererGone()
                return true
            }
        }
        view.webChromeClient = object : WebChromeClient() {
            override fun onCreateWindow(v: WebView, isDialog: Boolean, isUserGesture: Boolean, resultMsg: Message?): Boolean = false

            override fun onPermissionRequest(request: PermissionRequest) {
                request.deny()
            }

            override fun onGeolocationPermissionsShowPrompt(origin: String, callback: GeolocationPermissions.Callback) {
                callback.invoke(origin, false, false)
            }
        }
        view.addJavascriptInterface(HostBridge(view, HostExitGate(policy), onExitToHost), HOST_BRIDGE_NAME)
        return view
    }

    /** The one name the page can call: `window.MaxcomHost.exit()`. */
    const val HOST_BRIDGE_NAME = "MaxcomHost"

    /**
     * What the kiosk page may ask of the app: leave the kiosk for the maintenance screen (the admin's way to the
     * Android settings). It runs on the main thread and re-checks the page's current URL against [UrlPolicy].
     */
    class HostBridge(private val view: WebView, private val gate: HostExitGate, private val onExit: () -> Unit) {
        @JavascriptInterface
        fun exit() {
            view.post { gate.exit(view.url, onExit) }
        }
    }

    private fun refused() = WebResourceResponse("text/plain", "utf-8", 403, "Forbidden", emptyMap(), ByteArrayInputStream(ByteArray(0)))

    /** Sets the `mxk` cookie for the loopback origin only. Call before the first load and after a token change. */
    fun setKioskCookie(port: Int, token: String) {
        require(token.isNotEmpty() && token.none { it == ';' || it == ',' || it == '"' || it == '\\' || it.code <= 32 || it.code > 126 }) { "bad token" }
        val cm = CookieManager.getInstance()
        cm.setCookie("http://127.0.0.1:$port", "mxk=$token; Path=/; HttpOnly; SameSite=Strict")
        cm.flush()
    }

    /** Drops the page cache when the installed release differs from the one the cache was filled under. */
    fun clearCacheIfVersionChanged(context: Context, view: WebView, installedVersion: String) {
        val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        if (prefs.getString(KEY_VERSION, null) != installedVersion) {
            view.clearCache(true)
            prefs.edit().putString(KEY_VERSION, installedVersion).apply()
        }
    }

    fun destroy(view: WebView) {
        try {
            view.stopLoading()
            view.loadUrl("about:blank")
            view.destroy()
        } catch (e: Exception) {
            Log.w(TAG, "webview destroy: " + e.javaClass.simpleName)
        }
    }
}
