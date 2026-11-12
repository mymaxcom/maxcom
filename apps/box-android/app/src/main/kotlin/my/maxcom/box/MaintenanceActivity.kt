package my.maxcom.box

import android.app.Activity
import android.app.AlertDialog
import android.content.Context
import android.content.Intent
import android.graphics.Color
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import android.text.InputType
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import java.io.File
import java.util.concurrent.Executors
import my.maxcom.box.core.BoxPaths
import my.maxcom.box.core.DoctorLine
import my.maxcom.box.core.LockState
import my.maxcom.box.core.Lockout
import my.maxcom.box.core.NioLinks
import my.maxcom.box.core.PinHash
import my.maxcom.box.core.ReleaseStore

/**
 * The way out of the kiosk and the on-box health check. D-pad only, large text, not exported: KioskActivity
 * opens it with an explicit intent. With a maintenance PIN set it asks for it first; five wrong tries lock the
 * screen for five minutes. The PIN hash lives in its own preferences file ([PREFS]) and nothing else is stored there.
 */
class MaintenanceActivity : Activity() {
    private val ui = Handler(Looper.getMainLooper())
    private val worker = Executors.newSingleThreadExecutor { r -> Thread(r, "maint").also { it.isDaemon = true } }
    private lateinit var paths: BoxPaths
    private lateinit var root: LinearLayout
    private var output: TextView? = null
    private var unlocked = false

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        paths = BoxPaths(filesDir, File(applicationInfo.nativeLibraryDir))
        val scroll = ScrollView(this)
        scroll.setBackgroundColor(Color.parseColor("#101418"))
        root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(48), dp(32), dp(48), dp(32))
        }
        scroll.addView(root, ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
        setContentView(scroll)
        if (hasPin()) showPinGate() else showMenu()
    }

    override fun onStop() {
        // Leaving the screen locks it again.
        unlocked = false
        super.onStop()
    }

    override fun onStart() {
        super.onStart()
        if (!unlocked && hasPin()) showPinGate()
    }

    override fun onDestroy() {
        worker.shutdownNow()
        super.onDestroy()
    }

    // ---- PIN gate -------------------------------------------------------------------------------

    private fun prefs() = getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    private fun hasPin(): Boolean = prefs().getString(KEY_HASH, null) != null

    /** Boot counter of the system (changes on every reboot); -1 when the platform does not give it. */
    private fun bootId(): Long = try {
        android.provider.Settings.Global.getInt(contentResolver, android.provider.Settings.Global.BOOT_COUNT, -1).toLong()
    } catch (_: Exception) {
        -1L
    }

    private fun lockNow(): Long = android.os.SystemClock.elapsedRealtime()

    private fun lockState(): LockState {
        val raw = LockState(prefs().getInt(KEY_FAILS, 0), prefs().getLong(KEY_LOCKED_UNTIL, 0L), prefs().getLong(KEY_BOOT, 0L))
        val s = Lockout.rebase(raw, lockNow(), bootId())
        if (s != raw) saveLock(s)
        return s
    }

    private fun saveLock(s: LockState) {
        prefs().edit().putInt(KEY_FAILS, s.failures).putLong(KEY_LOCKED_UNTIL, s.lockedUntilMs).putLong(KEY_BOOT, s.bootId).apply()
    }

    private fun showPinGate() {
        root.removeAllViews()
        title(getString(R.string.maint_title))
        text(getString(R.string.maint_pin_enter))
        val status = text("")
        val input = pinField()
        root.addView(input)
        val ok = button(getString(R.string.maint_pin_title)) {
            val now = lockNow()
            val st = lockState()
            if (Lockout.isLocked(st, now)) {
                status.text = "GAGAL: dikunci ${Lockout.remainingMs(st, now) / 1000 + 1} saat lagi."
                return@button
            }
            val stored = prefs().getString(KEY_HASH, "") ?: ""
            val pin = input.text.toString()
            input.setText("")
            if (PinHash.verify(pin, stored)) {
                saveLock(Lockout.onSuccess())
                unlocked = true
                showMenu()
            } else {
                val next = Lockout.onWrong(st, now, bootId())
                saveLock(next)
                status.text = if (Lockout.isLocked(next, now)) "GAGAL: terlalu banyak cubaan. Cuba lagi selepas 5 minit."
                else getString(R.string.maint_pin_wrong)
            }
        }
        button(getString(R.string.maint_back)) { finish() }
        input.requestFocus()
        ok.nextFocusUpId = input.id
    }

    // ---- menu -----------------------------------------------------------------------------------

    private fun showMenu() {
        root.removeAllViews()
        title(getString(R.string.maint_title))
        text(statusText())
        val first = button(getString(R.string.maint_check)) { runCheck() }
        button(getString(R.string.maint_restart)) { confirmRestart() }
        button(getString(R.string.maint_exit_android)) { exitToAndroid() }
        button(getString(R.string.maint_android_settings)) { open(Intent(Settings.ACTION_SETTINGS)) }
        button("Tetapan Wi-Fi") { open(Intent(Settings.ACTION_WIFI_SETTINGS)) }
        button(getString(R.string.maint_change_home)) { open(Intent(Settings.ACTION_HOME_SETTINGS)) }
        button(if (hasPin()) "Tukar atau buang PIN penyelenggaraan" else "Tetapkan PIN penyelenggaraan") { pinDialog() }
        button(getString(R.string.maint_licences)) { showLicences() }
        button(getString(R.string.maint_back)) { finish() }
        output = text("")
        first.requestFocus()
    }

    private fun statusText(): String {
        val sb = StringBuilder()
        val snap = BoxState.get()
        sb.append("Keadaan: ").append(describe(snap.status)).append('\n')
        val ips = try { NetworkWatch(this) { }.current() } catch (_: Exception) { emptyList() }
        if (ips.isEmpty()) sb.append("Alamat: tiada rangkaian\n")
        else for (ip in ips) sb.append("Alamat: https://").append(ip).append(":8443/\n")
        val release = try { ReleaseStore(paths.boxRoot, NioLinks()).installed() } catch (_: Exception) { null }
        sb.append("Keluaran MAXCOM: ").append(release ?: "tiada").append('\n')
        sb.append("Aplikasi: ").append(appVersion()).append(", Android ").append(Build.VERSION.RELEASE)
            .append(" (SDK ").append(Build.VERSION.SDK_INT).append("), WebView ").append(webViewVersion()).append('\n')
        val tail = BoxDoctor.readTail(paths.boxLog, 8 * 1024).takeLast(LOG_LINES).map { DoctorLine.clean(it) }
        sb.append("\nLog terakhir:\n")
        if (tail.isEmpty()) sb.append("(kosong)\n") else tail.forEach { sb.append(it).append('\n') }
        return sb.toString()
    }

    private fun describe(s: BoxStatus): String = when (s) {
        BoxStatus.Idle -> "tidak berjalan"
        is BoxStatus.Preparing -> "menyediakan (${s.step})"
        BoxStatus.WaitingClock -> "menunggu jam Internet"
        BoxStatus.Starting -> "sedang bermula"
        BoxStatus.Running -> "berjalan"
        is BoxStatus.Failing -> "GAGAL: " + (s.lines.firstOrNull()?.let { DoctorLine.clean(it) } ?: "tidak dapat dimulakan")
    }

    private fun appVersion(): String = try {
        packageManager.getPackageInfo(packageName, 0).versionName ?: "?"
    } catch (_: Exception) {
        "?"
    }

    private fun webViewVersion(): String = try {
        android.webkit.WebView.getCurrentWebViewPackage()?.versionName ?: "?"
    } catch (_: Exception) {
        "?"
    }

    private fun open(i: Intent) {
        try {
            startActivity(i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        } catch (_: Exception) {
            output?.text = "GAGAL: skrin ini tiada pada peranti ini."
        }
    }

    /** Puts the kiosk task in the background and opens the system Settings (or the HOME chooser) so the admin reaches the OS. */
    private fun exitToAndroid() {
        val target = listOf(Intent(Settings.ACTION_SETTINGS), Intent(Settings.ACTION_HOME_SETTINGS))
            .firstOrNull { it.resolveActivity(packageManager) != null }
        if (target == null) {
            output?.text = "GAGAL: skrin ini tiada pada peranti ini."
            return
        }
        open(target)
        moveTaskToBack(true)
    }

    // ---- actions --------------------------------------------------------------------------------

    private fun runCheck() {
        output?.text = "Sedang menyemak..."
        worker.execute {
            val text = try {
                val ips = { NetworkWatch(this) { }.current() }
                val report = BoxDoctor(this, paths, ips).run()
                val sb = StringBuilder()
                report.render().forEach { sb.append(it).append('\n') }
                sb.append('\n').append(getString(if (report.allOk) R.string.maint_check_ok else R.string.maint_check_fail))
                if (report.logTail.isNotEmpty()) {
                    sb.append("\n\nAmaran log terakhir:\n")
                    report.logTail.forEach { sb.append(it).append('\n') }
                }
                sb.toString()
            } catch (e: Exception) {
                "GAGAL: semakan tidak dapat dijalankan (" + e.javaClass.simpleName + ")."
            }
            ui.post { output?.text = text }
        }
    }

    private fun confirmRestart() {
        val d = AlertDialog.Builder(this)
            .setMessage("Mula semula sekarang? Paparan akan terhenti seketika.")
            .setPositiveButton("Ya") { _, _ -> restartBox() }
            .setNegativeButton("Tidak", null)
            .create()
        d.show()
        d.getButton(AlertDialog.BUTTON_NEGATIVE).requestFocus()
    }

    private fun restartBox() {
        output?.text = "Memulakan semula MAXCOM..."
        val app = applicationContext
        worker.execute {
            try {
                app.stopService(Intent(app, BoxService::class.java))
                Thread.sleep(RESTART_GAP_MS)
                app.startForegroundService(Intent(app, BoxService::class.java))
                ui.post { output?.text = "OK: MAXCOM dimulakan semula. Tunggu sebentar." }
            } catch (e: Exception) {
                ui.post { output?.text = "GAGAL: tidak dapat memulakan semula (" + e.javaClass.simpleName + ")." }
            }
        }
    }

    private fun pinDialog() {
        val box = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(dp(24), dp(16), dp(24), dp(8)) }
        val warn = TextView(this).apply {
            text = "Simpan PIN ini. Jika terlupa, hubungi Pentadbir MAXCOM."
            textSize = 20f
        }
        val field = pinField()
        box.addView(warn)
        box.addView(field)
        val b = AlertDialog.Builder(this)
            .setTitle(getString(R.string.maint_pin_title))
            .setMessage(getString(R.string.maint_pin_hint))
            .setView(box)
            .setPositiveButton(getString(R.string.maint_pin_set)) { _, _ ->
                val pin = field.text.toString()
                if (!PinHash.isValidPin(pin)) {
                    output?.text = getString(R.string.maint_pin_invalid)
                } else {
                    prefs().edit().putString(KEY_HASH, PinHash.make(pin)).putInt(KEY_FAILS, 0).putLong(KEY_LOCKED_UNTIL, 0L).putLong(KEY_BOOT, bootId()).apply()
                    showMenu()
                    output?.text = "OK: PIN disimpan."
                }
            }
            .setNegativeButton("Batal", null)
        if (hasPin()) {
            b.setNeutralButton(getString(R.string.maint_pin_clear)) { _, _ ->
                prefs().edit().clear().apply()
                showMenu()
                output?.text = "OK: PIN dibuang."
            }
        }
        b.show()
        field.requestFocus()
    }

    private fun showLicences() {
        worker.execute {
            val sb = StringBuilder()
            try {
                val names = assets.list("licences").orEmpty().sorted()
                for (n in names) {
                    val body = assets.open("licences/$n").use { it.readBytes(MAX_LICENCE) }
                    sb.append("== ").append(n).append(" ==\n").append(String(body, Charsets.UTF_8)).append("\n\n")
                    if (sb.length > MAX_LICENCE_TOTAL) break
                }
            } catch (_: Exception) {
                // none bundled
            }
            if (sb.isEmpty()) sb.append("Tiada fail lesen dalam aplikasi ini.")
            ui.post { output?.text = sb.toString() }
        }
    }

    private fun java.io.InputStream.readBytes(max: Int): ByteArray {
        val out = java.io.ByteArrayOutputStream()
        val buf = ByteArray(8192)
        while (out.size() < max) {
            val n = read(buf)
            if (n < 0) break
            out.write(buf, 0, n)
        }
        return out.toByteArray()
    }

    // ---- views ----------------------------------------------------------------------------------

    private fun dp(v: Int): Int = (v * resources.displayMetrics.density).toInt()

    private fun title(s: String) {
        root.addView(TextView(this).apply { text = s; textSize = 34f; setTextColor(Color.WHITE); setPadding(0, 0, 0, dp(16)) })
    }

    private fun text(s: String): TextView {
        val t = TextView(this).apply { text = s; textSize = 22f; setTextColor(Color.parseColor("#DDE3EA")); setPadding(0, dp(8), 0, dp(8)) }
        root.addView(t)
        return t
    }

    private fun button(label: String, onClick: () -> Unit): Button {
        val b = Button(this).apply {
            text = label
            textSize = 26f
            isAllCaps = false
            isFocusable = true
            gravity = Gravity.CENTER_VERTICAL or Gravity.START
            setOnClickListener { onClick() }
            setOnFocusChangeListener { v, has -> v.setBackgroundColor(if (has) Color.parseColor("#2E7D32") else Color.parseColor("#37474F")); (v as Button).setTextColor(Color.WHITE) }
            setBackgroundColor(Color.parseColor("#37474F"))
            setTextColor(Color.WHITE)
        }
        val lp = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(64)).apply { topMargin = dp(8) }
        root.addView(b, lp)
        return b
    }

    private fun pinField(): EditText = EditText(this).apply {
        id = View.generateViewId()
        inputType = InputType.TYPE_CLASS_NUMBER or InputType.TYPE_NUMBER_VARIATION_PASSWORD
        textSize = 30f
        setTextColor(Color.WHITE)
        hint = getString(R.string.maint_pin_hint)
        filters = arrayOf(android.text.InputFilter.LengthFilter(8))
    }

    companion object {
        /** Preferences file holding only the PIN hash and its wrong-try counter. */
        const val PREFS = "maint_pin"
        private const val KEY_HASH = "hash"
        private const val KEY_FAILS = "fails"
        private const val KEY_LOCKED_UNTIL = "locked_until"
        private const val KEY_BOOT = "lock_boot"
        private const val LOG_LINES = 8
        private const val RESTART_GAP_MS = 1_500L
        private const val MAX_LICENCE = 256 * 1024
        private const val MAX_LICENCE_TOTAL = 512 * 1024
    }
}
