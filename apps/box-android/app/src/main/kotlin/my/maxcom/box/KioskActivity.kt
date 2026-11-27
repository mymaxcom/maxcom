package my.maxcom.box

import android.app.Activity
import android.app.AlarmManager
import android.app.PendingIntent
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.Process
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
import my.maxcom.box.core.ServiceStartWatch
import my.maxcom.box.core.UrlPolicy
import my.maxcom.box.core.VideoRecovery

/**
 * HOME and launcher entry, the only exported component. It reads nothing from the intent that
 * started it. Shows [StartScreen] until the box server answers, then the page in [KioskWebView].
 */
class KioskActivity : Activity() {
    private val main = Handler(Looper.getMainLooper())
    private val io = Executors.newSingleThreadExecutor()
    private val health = HealthClient()
    private val combo = KeyCombo(COMBO)
    private lateinit var recovery: VideoRecovery
    private lateinit var root: FrameLayout
    private lateinit var start: StartScreen
    private var web: WebView? = null
    private var loadedToken: String? = null
    @Volatile
    private var polling = false
    private var healthPending = true
    private var active = false

    private val watch = ServiceStartWatch()
    private var messageShown = false

    private val listener: (BoxSnapshot) -> Unit = { snap -> main.post { if (active) render(snap) } }

    // While the service has never reported, ask for it again now and then and show a message after a minute.
    private val tick = object : Runnable {
        override fun run() {
            if (!active) return
            val snap = BoxState.get()
            if (!BoxReducer.neverReported(snap)) {
                watch.disarm()
                return
            }
            val now = SystemClock.elapsedRealtime()
            if (watch.retryDue(now)) {
                watch.tried(now)
                Log.i(TAG, "service start retry " + watch.retryCount)
                startBox()
            }
            if (watch.messageDue(now) && !messageShown) render(snap)
            main.removeCallbacks(this) // render() re-arms the tick itself; never keep two queued
            main.postDelayed(this, TICK_MS)
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(null)
        recovery = VideoRecovery(getSharedPreferences(PREFS, MODE_PRIVATE).getLong(KEY_APP_RESTART, 0L))
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

    override fun onResume() {
        super.onResume()
        // The first request in onStart may have been dropped by the system: ask again while nothing has reported.
        if (BoxReducer.neverReported(BoxState.get())) startBox()
    }

    override fun onStop() {
        active = false
        main.removeCallbacks(tick)
        watch.disarm()
        messageShown = false
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
            val silent = BoxReducer.neverReported(snap) && watch.messageDue(SystemClock.elapsedRealtime())
            messageShown = silent
            start.show(if (silent) StartTexts.serviceNotStarted() else StartTexts.forStatus(snap.status, healthPending))
            if (running) pollHealth(snap.port, token!!)
        }
        watchService(snap)
    }

    // Arms the retry timer while the service has never reported; stops it as soon as it has.
    private fun watchService(snap: BoxSnapshot) {
        main.removeCallbacks(tick)
        if (BoxReducer.neverReported(snap)) {
            watch.arm(SystemClock.elapsedRealtime())
            main.postDelayed(tick, TICK_MS)
        } else {
            watch.disarm()
            messageShown = false
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
            onVideoStuck = { main.post { onVideoStuck() } },
        )
        KioskWebView.setKioskCookie(port, token)
        installedVersion()?.let { KioskWebView.clearCacheIfVersionChanged(this, view, it) }
        // A LayoutParams object is required: addView(view, 0, MATCH_PARENT) binds to (view, width, height) and gives a 0px-wide WebView.
        root.addView(view, 0, FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT))
        web = view
        loadedToken = token
        start.visibility = View.GONE
        view.requestFocus()
        view.loadUrl(UrlPolicy.kioskUrl(port))
    }

    // Destroys the page and goes back through the start screen (health check) to a fresh WebView.
    private fun restartPage() {
        if (!active) return
        dropPage()
        render(BoxState.get())
    }

    // The page reports that the WebView cannot decode video. The policy decides; see VideoRecovery for the limits.
    private fun onVideoStuck() {
        if (!active || web == null) return
        when (recovery.onStuck(System.currentTimeMillis())) {
            VideoRecovery.Action.Ignore -> Unit
            VideoRecovery.Action.RestartRenderer -> {
                Log.w(TAG, "video decoder stuck, restarting the WebView renderer")
                restartRenderer()
            }
            VideoRecovery.Action.RestartApp -> {
                Log.w(TAG, "video decoder still stuck, restarting the app")
                restartApp()
            }
        }
    }

    // Ending the renderer process makes onRenderProcessGone run, which runs restartPage(). The box server keeps running.
    private fun restartRenderer() {
        val ended = try {
            Build.VERSION.SDK_INT >= 29 && web?.webViewRenderProcess?.terminate() == true
        } catch (e: Exception) {
            Log.w(TAG, "renderer terminate: " + e.javaClass.simpleName)
            false
        }
        if (!ended) restartPage()
    }

    // New process, new WebView graphics state. The whole box server restarts with the app: phones lose the box for the
    // restart and a live that is running ends. The process is ended only when the system will bring it back by itself:
    // MAXCOM is the default Home app, and the relaunch alarm was armed. Otherwise nothing is stopped, nothing is stored,
    // and the page is rebuilt instead. Order: arm the relaunch, stop the service (its onDestroy stops the server child;
    // Supervisor.stop may wait two 5 s grace periods, hence the 11 s before the process ends), end the process. A server
    // child still alive then is reaped by the next start (ProcReaper). The relaunched activity starts the service again.
    private fun restartApp() {
        val isHome = isDefaultHome()
        val armed = isHome && armRelaunch()
        if (!VideoRecovery.mayRestartApp(isHome, armed)) {
            Log.w(TAG, "app restart declined (default home=$isHome, relaunch armed=$armed), rebuilding the page")
            restartPage()
            return
        }
        recovery.appRestarted(System.currentTimeMillis())
        getSharedPreferences(PREFS, MODE_PRIVATE).edit().putLong(KEY_APP_RESTART, recovery.lastAppRestartMs).commit()
        try {
            stopService(Intent(this, BoxService::class.java))
        } catch (e: Exception) {
            Log.w(TAG, "stop service: " + e.javaClass.simpleName)
        }
        main.postDelayed({ Process.killProcess(Process.myPid()) }, EXIT_AFTER_MS)
    }

    private fun isDefaultHome(): Boolean = try {
        val home = Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_HOME)
        packageManager.resolveActivity(home, PackageManager.MATCH_DEFAULT_ONLY)?.activityInfo?.packageName == packageName
    } catch (_: Exception) {
        false
    }

    private fun armRelaunch(): Boolean = try {
        val launch = PendingIntent.getActivity(
            this, 0, Intent(this, KioskActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        val alarms = getSystemService(ALARM_SERVICE) as AlarmManager
        alarms.setAndAllowWhileIdle(AlarmManager.ELAPSED_REALTIME_WAKEUP, SystemClock.elapsedRealtime() + RELAUNCH_MS, launch)
        true
    } catch (e: Exception) {
        Log.w(TAG, "relaunch not armed: " + e.javaClass.simpleName)
        false
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
        const val TICK_MS = 1000L
        const val PREFS = "kiosk"
        const val KEY_APP_RESTART = "video_app_restart_ms"
        const val EXIT_AFTER_MS = 11_000L
        const val RELAUNCH_MS = 13_000L
        val COMBO = listOf(
            KeyEvent.KEYCODE_DPAD_UP, KeyEvent.KEYCODE_DPAD_UP,
            KeyEvent.KEYCODE_DPAD_DOWN, KeyEvent.KEYCODE_DPAD_DOWN,
            KeyEvent.KEYCODE_DPAD_LEFT, KeyEvent.KEYCODE_DPAD_RIGHT,
        )
    }
}
