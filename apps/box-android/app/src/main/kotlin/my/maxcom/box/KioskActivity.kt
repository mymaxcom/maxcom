package my.maxcom.box

import android.app.Activity
import android.content.Intent
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.util.Log
import android.view.KeyEvent
import android.view.View
import android.view.ViewGroup
import android.view.WindowInsets
import android.view.WindowInsetsController
import android.view.WindowManager
import android.webkit.WebView
import android.widget.FrameLayout
import java.util.concurrent.Executors
import my.maxcom.box.core.HealthClient
import my.maxcom.box.core.KeyCombo
import my.maxcom.box.core.UrlPolicy

/**
 * HOME and launcher entry, the only exported component. It reads nothing from the intent that
 * started it. Shows [StartScreen] until the box server answers, then the page in [KioskWebView].
 */
class KioskActivity : Activity() {
    private val main = Handler(Looper.getMainLooper())
    private val io = Executors.newSingleThreadExecutor()
    private val health = HealthClient()
    private val combo = KeyCombo(COMBO)
    private lateinit var root: FrameLayout
    private lateinit var start: StartScreen
    private var web: WebView? = null
    private var loadedToken: String? = null
    @Volatile
    private var polling = false
    private var healthPending = true
    private var active = false

    private val listener: (BoxSnapshot) -> Unit = { snap -> main.post { if (active) render(snap) } }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(null)
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        root = FrameLayout(this)
        start = StartScreen(this)
        root.addView(start, ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT)
        setContentView(root)
        startBox()
    }

    override fun onStart() {
        super.onStart()
        active = true
        startBox()
        BoxState.addListener(listener)
        render(BoxState.get())
    }

    override fun onStop() {
        active = false
        BoxState.removeListener(listener)
        polling = false
        super.onStop()
    }

    override fun onDestroy() {
        web?.let { KioskWebView.destroy(it) }
        web = null
        io.shutdownNow()
        super.onDestroy()
    }

    // The intent is never read: a new one only brings the activity to the front.
    override fun onNewIntent(intent: Intent?) {
        super.onNewIntent(intent)
    }

    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        if (hasFocus) applyImmersive()
    }

    private fun applyImmersive() {
        if (Build.VERSION.SDK_INT >= 30) {
            window.setDecorFitsSystemWindows(false)
            window.insetsController?.let {
                it.hide(WindowInsets.Type.systemBars())
                it.systemBarsBehavior = WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
            }
        } else {
            @Suppress("DEPRECATION")
            window.decorView.systemUiVisibility = View.SYSTEM_UI_FLAG_LAYOUT_STABLE or
                View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION or View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN or
                View.SYSTEM_UI_FLAG_HIDE_NAVIGATION or View.SYSTEM_UI_FLAG_FULLSCREEN or View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
        }
    }

    private fun startBox() {
        try {
            startForegroundService(Intent(this, BoxService::class.java))
        } catch (e: Exception) {
            Log.w(TAG, "start service: " + e.javaClass.simpleName)
        }
    }

    private fun render(snap: BoxSnapshot) {
        val token = snap.kioskToken
        val running = snap.status == BoxStatus.Running && token != null
        if (web != null && (!running || token != loadedToken)) {
            // The server went away or restarted with a new token: back to the start screen.
            dropPage()
        }
        if (web == null) {
            start.show(StartTexts.forStatus(snap.status, healthPending))
            if (running) pollHealth(snap.port, token!!)
        }
    }

    private fun dropPage() {
        web?.let { root.removeView(it); KioskWebView.destroy(it) }
        web = null
        loadedToken = null
        healthPending = true
        start.visibility = View.VISIBLE
    }

    private fun pollHealth(port: Int, token: String) {
        if (polling) return
        polling = true
        try {
            io.execute {
                while (polling) {
                    if (health.check(port)) {
                        main.post { polling = false; showPage(port, token) }
                        return@execute
                    }
                    try {
                        Thread.sleep(POLL_MS)
                    } catch (_: InterruptedException) {
                        return@execute
                    }
                }
            }
        } catch (_: Exception) {
            polling = false
        }
    }

    private fun showPage(port: Int, token: String) {
        val snap = BoxState.get()
        if (!active || snap.status != BoxStatus.Running || snap.kioskToken != token || web != null) {
            if (active) render(snap)
            return
        }
        healthPending = false
        val view = KioskWebView.create(
            this, UrlPolicy(port),
            onRendererGone = { main.post { restartPage() } },
            onLoadError = { main.post { restartPage() } },
            onExitToHost = { startActivity(Intent(this, MaintenanceActivity::class.java)) },
        )
        KioskWebView.setKioskCookie(port, token)
        installedVersion()?.let { KioskWebView.clearCacheIfVersionChanged(this, view, it) }
        // A LayoutParams object is required: addView(view, 0, MATCH_PARENT) binds to (view, width, height) and gives a 0px-wide WebView.
        root.addView(view, 0, FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT))
        web = view
        loadedToken = token
        start.visibility = View.GONE
        view.requestFocus()
        view.loadUrl("http://127.0.0.1:$port/")
    }

    // Destroys the page and goes back through the start screen (health check) to a fresh WebView.
    private fun restartPage() {
        if (!active) return
        dropPage()
        render(BoxState.get())
    }

    private fun installedVersion(): String? = try {
        packageManager.getPackageInfo(packageName, 0).versionName
    } catch (_: Exception) {
        null
    }

    override fun dispatchKeyEvent(event: KeyEvent): Boolean {
        val code = event.keyCode
        if (code == KeyEvent.KEYCODE_BACK) return true
        if (event.action == KeyEvent.ACTION_DOWN && event.repeatCount == 0) {
            if (combo.onKey(code, SystemClock.elapsedRealtime())) {
                startActivity(Intent(this, MaintenanceActivity::class.java))
                return true
            }
            if (web == null && BoxState.get().status is BoxStatus.Failing &&
                (code == KeyEvent.KEYCODE_DPAD_CENTER || code == KeyEvent.KEYCODE_ENTER)
            ) {
                startBox()
                return true
            }
        }
        return super.dispatchKeyEvent(event)
    }

    private companion object {
        const val TAG = "MAXCOM"
        const val POLL_MS = 1500L
        val COMBO = listOf(
            KeyEvent.KEYCODE_DPAD_UP, KeyEvent.KEYCODE_DPAD_UP,
            KeyEvent.KEYCODE_DPAD_DOWN, KeyEvent.KEYCODE_DPAD_DOWN,
            KeyEvent.KEYCODE_DPAD_LEFT, KeyEvent.KEYCODE_DPAD_RIGHT,
        )
    }
}
