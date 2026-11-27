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
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import java.io.File
import java.util.concurrent.Executors
import my.maxcom.box.core.BoxCa
import my.maxcom.box.core.BoxPaths
import my.maxcom.box.core.CertLock
import my.maxcom.box.core.RootGeneration
import my.maxcom.box.core.RootKeys
import my.maxcom.box.core.RootRekey
import my.maxcom.box.core.DoctorLine
import my.maxcom.box.core.FollowerClient
import my.maxcom.box.core.FollowerInfo
import my.maxcom.box.core.LeaveSecret
import my.maxcom.box.core.LeaveAnswer
import my.maxcom.box.core.LeaveAnswerParser
import my.maxcom.box.core.LockState
import my.maxcom.box.core.Lockout
import my.maxcom.box.core.NioLinks
import my.maxcom.box.core.PinHash
import my.maxcom.box.core.RecoveryCodeInput
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
        logoHeader()
        text(getString(R.string.maint_pin_enter))
        val status = text("")
        val input = pinField()
        root.addView(input)
        val ok = button(getString(R.string.maint_pin_title)) {
            val now = lockNow()
            val st = lockState()
            if (Lockout.isLocked(st, now)) {
                status.text = getString(R.string.maint_pin_locked, (Lockout.remainingMs(st, now) / 1000 + 1).toInt())
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
                status.text = if (Lockout.isLocked(next, now)) getString(R.string.maint_pin_toomany)
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
        logoHeader()
        text(statusText())
        // Shown only when this box is a follower: the mode lines now, the unlink entry below.
        val followerBlock = text("").also { it.visibility = View.GONE }
        val first = button(getString(R.string.maint_check)) { runCheck() }
        button(getString(R.string.maint_restart)) { confirmRestart() }
        val unlink = button(inLang("ms", R.string.maint_unlink)) { showLeave() }
        unlink.visibility = View.GONE
        if (hasLegacyRoot()) button(getString(R.string.maint_rekey)) { confirmRekey() }
        button(getString(R.string.maint_exit_android)) { exitToAndroid() }
        button(getString(R.string.maint_android_settings)) { open(Intent(Settings.ACTION_SETTINGS)) }
        button(getString(R.string.maint_wifi)) { open(Intent(Settings.ACTION_WIFI_SETTINGS)) }
        button(getString(R.string.maint_change_home)) { open(Intent(Settings.ACTION_HOME_SETTINGS)) }
        button(getString(if (hasPin()) R.string.maint_pin_change else R.string.maint_pin_new)) { pinDialog() }
        button(getString(R.string.maint_licences)) { showLicences() }
        button(getString(R.string.maint_back)) { finish() }
        output = text("")
        first.requestFocus()
        loadFollower(followerBlock, unlink)
    }

    /** The text of one string in one language ("ms" is the default resources), whatever language the device is set to. */
    private fun inLang(tag: String, id: Int, vararg args: Any): String {
        val cfg = android.content.res.Configuration(resources.configuration)
        cfg.setLocale(java.util.Locale.forLanguageTag(tag))
        return createConfigurationContext(cfg).resources.getString(id, *args)
    }

    private fun followerLines(info: FollowerInfo): String {
        val term = getString(R.string.box_term)
        return FOLLOWER_LANGS.joinToString("\n") { tag ->
            val line = if (info.masterName.isEmpty()) inLang(tag, R.string.follower_line_no_name)
            else inLang(tag, R.string.follower_line, info.masterName)
            inLang(tag, R.string.maint_mode_follower, term) + "\n" + line
        }
    }

    /** Asks the box server whether this box is a follower; if so shows the mode lines and the unlink entry. */
    private fun loadFollower(block: TextView, unlink: Button) {
        worker.execute {
            val info = try { FollowerClient().read(BoxReducer.PORT) } catch (_: Exception) { null }
            if (info == null) return@execute
            ui.post {
                if (isFinishing || isDestroyed) return@post
                block.text = followerLines(info)
                block.visibility = View.VISIBLE
                unlink.visibility = View.VISIBLE
            }
        }
    }

    // ---- leave the surau (a follower leaves by itself) -----------------------------------------

    /** One string in the three languages of the screen, one under the other. */
    private fun tri(id: Int, vararg args: Any): String = FOLLOWER_LANGS.joinToString("\n") { inLang(it, id, *args) }

    private fun leaveStatusColour(tv: TextView) = tv.setTextColor(Color.parseColor("#FFB74D"))

    /**
     * The "Tanggalkan dari surau" entry: says what happens, asks for the recovery code from before the link (typed on
     * the remote) and goes back to that data. A box that was new has no code: it takes the second confirmation and is
     * emptied instead. The maintenance PIN gate in front of this screen stays; the server only answers this box itself.
     */
    private fun showLeave(message: String? = null) {
        root.removeAllViews()
        val term = getString(R.string.box_term)
        title(FOLLOWER_LANGS.joinToString(" / ") { inLang(it, R.string.maint_unlink) })
        text(tri(R.string.leave_intro, term))
        text(tri(R.string.leave_data, term))
        val status = text(message ?: "")
        leaveStatusColour(status)
        val input = EditText(this).apply {
            id = View.generateViewId()
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_CAP_CHARACTERS or
                InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS or InputType.TYPE_TEXT_VARIATION_VISIBLE_PASSWORD
            textSize = 30f
            setTextColor(Color.WHITE)
            hint = FOLLOWER_LANGS.joinToString(" / ") { inLang(it, R.string.leave_code_hint) }
            filters = arrayOf(android.text.InputFilter.LengthFilter(LEAVE_CODE_MAX_INPUT))
        }
        root.addView(input)
        lateinit var go: Button
        lateinit var none: Button
        lateinit var cancel: Button
        go = button(inLang("ms", R.string.leave_go)) {
            val typed = input.text.toString()
            if (!RecoveryCodeInput.isComplete(typed)) {
                status.text = tri(R.string.leave_code_short)
                return@button
            }
            input.setText("")
            status.text = tri(R.string.leave_working)
            listOf(go, none, cancel).forEach { it.isEnabled = false }
            worker.execute {
                val answer = try { FollowerClient().revert(BoxReducer.PORT, typed, LeaveSecret.get()) } catch (_: Exception) { LeaveAnswer.Unreachable }
                ui.post {
                    if (isFinishing || isDestroyed) return@post
                    when {
                        answer is LeaveAnswer.Refused && answer.code == "no_backup" -> showLeaveNew()
                        else -> leaveResult(answer)
                    }
                }
            }
        }
        none = button(inLang("ms", R.string.leave_no_code, term)) { showLeaveNew() }
        cancel = button(inLang("ms", R.string.leave_cancel)) { showMenu() }
        input.requestFocus()
    }

    /** The second confirmation for a box that was new: it is emptied and returns to first setup. */
    private fun showLeaveNew() {
        root.removeAllViews()
        val term = getString(R.string.box_term)
        title(FOLLOWER_LANGS.joinToString(" / ") { inLang(it, R.string.maint_unlink) })
        text(tri(R.string.leave_new_confirm, term))
        val status = text("")
        leaveStatusColour(status)
        lateinit var yes: Button
        lateinit var cancel: Button
        yes = button(inLang("ms", R.string.leave_new_yes)) {
            status.text = tri(R.string.leave_working)
            listOf(yes, cancel).forEach { it.isEnabled = false }
            worker.execute {
                val answer = try { FollowerClient().empty(BoxReducer.PORT, LeaveSecret.get()) } catch (_: Exception) { LeaveAnswer.Unreachable }
                ui.post {
                    if (isFinishing || isDestroyed) return@post
                    leaveResult(answer)
                }
            }
        }
        cancel = button(inLang("ms", R.string.leave_cancel)) { showMenu() }
        cancel.requestFocus()
    }

    /** One answer of either call: done (the box restarts by itself, nothing else to press) or a plain sentence per refusal. */
    private fun leaveResult(answer: LeaveAnswer) {
        val term = getString(R.string.box_term)
        when (answer) {
            LeaveAnswer.Done -> {
                // The box restarts by itself: the wordmark with the notice in the three languages under it.
                root.removeAllViews()
                logoHeader(withWord = false)
                title(tri(R.string.leave_done, term))
            }
            LeaveAnswer.Unreachable -> showLeave(tri(R.string.leave_err_network, term))
            is LeaveAnswer.Refused -> {
                val line = when (LeaveAnswerParser.textKey(answer.code)) {
                    "wrong_code" -> tri(R.string.leave_err_wrong_code)
                    "locked" -> tri(R.string.leave_err_locked, LeaveAnswerParser.minutes(answer.retryAfterSec))
                    "no_backup" -> tri(R.string.leave_err_no_backup, term)
                    "has_backup" -> tri(R.string.leave_err_has_backup, term)
                    "not_local" -> tri(R.string.leave_err_not_local, term)
                    else -> tri(R.string.leave_err_generic, answer.code)
                }
                showLeave(line)
            }
        }
    }

    private fun statusText(): String {
        val sb = StringBuilder()
        val snap = BoxState.get()
        sb.append("Keadaan: ").append(describe(snap.status)).append('\n')
        val ips = try { NetworkWatch(this) { }.current() } catch (_: Exception) { emptyList() }
        LocalName.host?.let { sb.append("Nama: https://").append(it).append(":8443/\n") }
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

    /** One line in the box log (the one this screen shows), so a restart that did nothing can be told from one never asked for. */
    private fun mlog(text: String) {
        try {
            my.maxcom.box.core.BoxLogs.forFile(paths.boxLog).appendLine("MAXCOM: $text")
        } catch (_: Exception) {
        }
    }

    private fun restartBox() {
        output?.text = "Memulakan semula MAXCOM..."
        val app = applicationContext
        worker.execute {
            try {
                mlog("Mula semula diminta dari Penyelenggaraan")
                val stopped = app.stopService(Intent(app, BoxService::class.java))
                mlog("Mula semula: stopService=$stopped")
                Thread.sleep(RESTART_GAP_MS)
                app.startForegroundService(Intent(app, BoxService::class.java))
                mlog("Mula semula: startForegroundService dihantar")
                ui.post { output?.text = "OK: MAXCOM dimulakan semula. Tunggu sebentar." }
            } catch (e: Exception) {
                mlog("Mula semula GAGAL: " + e.javaClass.simpleName)
                ui.post { output?.text = "GAGAL: tidak dapat memulakan semula (" + e.javaClass.simpleName + ")." }
            }
        }
    }

    /** True when the stored root is the legacy one (the name `boxN-surau.local` needs a new root). */
    private fun hasLegacyRoot(): Boolean = try {
        RootKeys.storedRoot(paths.caDir, paths.pki)?.let { BoxCa.rootGeneration(it) == RootGeneration.LEGACY } == true
    } catch (_: Exception) {
        false
    }

    private fun confirmRekey() {
        val d = AlertDialog.Builder(this)
            .setMessage(
                "Sijil akar baharu akan dibuat supaya MAXCOM Kiosk Box boleh dicapai dengan nama boxN-surau.local. " +
                    "SEMUA telefon, iPad dan komputer yang sudah disambungkan ke MAXCOM Kiosk Box ini mesti disediakan semula " +
                    "(imbas kod QR dan pasang sijil baharu). Sijil lama disimpan sebagai arkib. Teruskan?",
            )
            .setPositiveButton("Ya, tukar") { _, _ -> rekeyRoot() }
            .setNegativeButton("Tidak", null)
            .create()
        d.show()
        d.getButton(AlertDialog.BUTTON_NEGATIVE).requestFocus()
    }

    /** Stops the service, makes the new root under the certificate lock, starts the service (it issues the new leaf). */
    private fun rekeyRoot() {
        output?.text = "Membuat sijil akar baharu..."
        val app = applicationContext
        worker.execute {
            var message: String
            try {
                val built = packageManager.getPackageInfo(packageName, 0).lastUpdateTime
                if (System.currentTimeMillis() < built) {
                    ui.post { output?.text = "GAGAL: jam peranti belum betul. Tunggu masa Internet, kemudian cuba lagi." }
                    return@execute
                }
                app.stopService(Intent(app, BoxService::class.java))
                Thread.sleep(RESTART_GAP_MS * 2)
                message = try {
                    val r = CertLock.held {
                        RootRekey.run(
                            paths.caDir, paths.pki, java.time.Instant.now(),
                            newSigner = { label -> RootSignerProvider.createForRekey(paths.caDir, label) },
                        )
                    }
                    "OK: sijil akar baharu dibuat (${r.label}); yang lama diarkibkan di ${r.archivedAs}. Sediakan semula semua peranti."
                } catch (e: Exception) {
                    "GAGAL: sijil akar tidak ditukar (" + e.javaClass.simpleName + "). Sijil lama kekal."
                }
            } catch (e: Exception) {
                message = "GAGAL: tidak dapat menukar sijil akar (" + e.javaClass.simpleName + ")."
            }
            try {
                app.startForegroundService(Intent(app, BoxService::class.java))
            } catch (e: Exception) {
                message += " Mulakan semula MAXCOM secara manual."
            }
            ui.post { output?.text = message }
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

    /**
     * The screen header: the MAXCOM wordmark image and, beside it, "Penyelenggaraan" in the box language. Without the
     * word it is the wordmark alone (the restart notice sits under it). Read aloud as "Penyelenggaraan MAXCOM".
     */
    private fun logoHeader(withWord: Boolean = true) {
        val row = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding(0, 0, 0, dp(16))
            contentDescription = getString(R.string.maint_title)
        }
        val logo = ImageView(this).apply {
            setImageResource(R.drawable.maxcom_wordmark)
            adjustViewBounds = true
            scaleType = ImageView.ScaleType.FIT_CENTER
            importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO
        }
        // 56 dp tall, so the letters match the 34 sp word beside it.
        row.addView(logo, LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, dp(56)))
        if (withWord) {
            val word = TextView(this).apply {
                text = getString(R.string.maint_title_word)
                textSize = 34f
                setTextColor(Color.WHITE)
                setPaddingRelative(dp(24), 0, 0, 0)
                importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO
            }
            row.addView(word, LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT))
        }
        root.addView(row, LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT))
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
        /** Room for 16 characters and the dashes or spaces a person may type between them. */
        private const val LEAVE_CODE_MAX_INPUT = 32
        private val FOLLOWER_LANGS = listOf("ms", "en", "ar")
        private const val RESTART_GAP_MS = 1_500L
        private const val MAX_LICENCE = 256 * 1024
        private const val MAX_LICENCE_TOTAL = 512 * 1024
    }
}
