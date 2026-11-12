package my.maxcom.box

import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.net.wifi.WifiManager
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import android.os.SystemClock
import android.util.Log
import java.io.File
import java.io.IOException
import java.security.SecureRandom
import java.time.Instant
import java.time.ZoneOffset
import java.time.format.DateTimeFormatter
import java.util.TimeZone
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledExecutorService
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import my.maxcom.box.core.BoxCa
import my.maxcom.box.core.BoxConfig
import my.maxcom.box.core.BoxConfigRead
import my.maxcom.box.core.BoxPaths
import my.maxcom.box.core.BoxRunState
import my.maxcom.box.core.BundledRelease
import my.maxcom.box.core.CaMeta
import my.maxcom.box.core.CertLog
import my.maxcom.box.core.ChildEnv
import my.maxcom.box.core.DbBackup
import my.maxcom.box.core.LeafDecision
import my.maxcom.box.core.LeafPolicy
import my.maxcom.box.core.LogFile
import my.maxcom.box.core.NioLinks
import my.maxcom.box.core.ProcReaper
import my.maxcom.box.core.ReleaseStore
import my.maxcom.box.core.RootKeyUnavailable
import my.maxcom.box.core.RootMismatch
import my.maxcom.box.core.RootSigner
import my.maxcom.box.core.RuntimeLayout
import my.maxcom.box.core.RuntimeLayoutException
import my.maxcom.box.core.Sleeper
import my.maxcom.box.core.Supervisor
import my.maxcom.box.core.Clock

/**
 * Foreground service that prepares, certifies and supervises the box server. All work runs on one background
 * thread in the order of the plan; each step is reported to [BoxState]. Nothing here logs the kiosk token, a key
 * or a path under `secret`: only sizes, states and exception class names.
 */
class BoxService : Service() {

    private class PrepareFailure(val lines: List<String>) : Exception(lines.firstOrNull())

    private enum class CertResult { SKIPPED, ISSUED, WAIT_CLOCK }

    private lateinit var paths: BoxPaths
    private lateinit var work: ScheduledExecutorService
    private val preparing = AtomicBoolean(false)
    private var wakeLock: PowerManager.WakeLock? = null
    private var wifiLock: WifiManager.WifiLock? = null
    private val netWatch: NetworkWatch by lazy {
        NetworkWatch(this) { ips ->
            try { work.execute { safely { recertify(ips, logSkip = false) } } } catch (_: java.util.concurrent.RejectedExecutionException) { }
        }
    }
    private var watchStarted = false
    private var rootSigner: RootSigner? = null

    @Volatile
    private var supervisor: Supervisor? = null

    /** Set first thing in onDestroy; prepare checks it so a stop during preparation leaves no server behind. */
    @Volatile
    private var destroyed = false

    @Volatile
    private var token: String = ""

    private val stateListener: (BoxSnapshot) -> Unit = { s ->
        try {
            ServiceNotification.update(this, ServiceNotification.textFor(s.status))
        } catch (_: Exception) {
            // the notification is cosmetic
        }
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        paths = BoxPaths(filesDir, File(applicationInfo.nativeLibraryDir))
        work = Executors.newSingleThreadScheduledExecutor { r -> Thread(r, "box-service").also { it.isDaemon = true } }
    }

    // Step 1 happens here, on the main thread, before anything else: the notification with the specialUse type.
    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        ServiceNotification.ensureChannel(this)
        val n = ServiceNotification.build(this, R.string.notif_text_starting)
        when {
            Build.VERSION.SDK_INT >= 34 -> startForeground(ServiceNotification.ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE)
            Build.VERSION.SDK_INT >= 29 -> startForeground(ServiceNotification.ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_MANIFEST)
            else -> startForeground(ServiceNotification.ID, n)
        }
        acquireLocks()
        BoxState.addListener(stateListener)
        // The intent that started us is not read: extras and data are ignored.
        try {
            work.execute { prepare() }
        } catch (_: java.util.concurrent.RejectedExecutionException) {
            // service is being destroyed
        }
        return START_STICKY
    }

    override fun onTaskRemoved(rootIntent: Intent?) {
        // The service stays: the box serves the surau without any screen open.
    }

    override fun onDestroy() {
        destroyed = true
        BoxState.removeListener(stateListener)
        if (watchStarted) netWatch.stop()
        work.shutdownNow()
        // Supervisor.stop sends terminate and then joins (up to two grace periods): never on the main thread.
        val sup = supervisor
        supervisor = null
        if (sup != null) stopOffMainThread(sup)
        releaseLocks()
        BoxState.send(BoxEvent.ServiceStopped)
        super.onDestroy()
    }

    private fun stopOffMainThread(sup: Supervisor) {
        Thread({
            try {
                sup.stop()
            } catch (e: Exception) {
                Log.w(TAG, "stop failed: " + e.javaClass.simpleName)
            }
        }, "box-stop").also { it.isDaemon = true }.start()
    }

    // ---- locks (step 2) -------------------------------------------------------------------------

    @Suppress("DEPRECATION")
    private fun acquireLocks() {
        if (wakeLock == null) {
            val pm = getSystemService(Context.POWER_SERVICE) as PowerManager
            wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "maxcom:box").also {
                it.setReferenceCounted(false)
                it.acquire()
            }
        }
        if (wifiLock == null) {
            val wm = applicationContext.getSystemService(Context.WIFI_SERVICE) as WifiManager
            wifiLock = wm.createWifiLock(WifiManager.WIFI_MODE_FULL_HIGH_PERF, "maxcom:box").also {
                it.setReferenceCounted(false)
                it.acquire()
            }
        }
    }

    private fun releaseLocks() {
        try {
            wakeLock?.let { if (it.isHeld) it.release() }
            wifiLock?.let { if (it.isHeld) it.release() }
        } catch (e: Exception) {
            Log.w(TAG, "lock release failed: " + e.javaClass.simpleName)
        }
        wakeLock = null
        wifiLock = null
    }

    // ---- preparation (steps 3 to 7), on the work thread ----------------------------------------

    private fun prepare() {
        if (supervisor != null || !preparing.compareAndSet(false, true)) return
        try {
            // Step 6 (token) is replaced at every service start; a retry after a failure gets a new one too.
            token = newToken()
            BoxState.send(BoxEvent.ServiceStarted(token))
            step("Membuka keluaran", 1)
            prepareRelease()
            step("Menyusun pustaka", 2)
            prepareLayout()
            val config = readConfig()
            // The server starts first, on loopback, with whatever leaf exists: the surau screen must not wait
            // for the clock or the root key. The certificate step runs after and restarts it when a leaf lands.
            step("Memulakan pelayan", 3)
            startSupervisor(config)
            if (destroyed) return
            step("Menyediakan sijil", 4)
            try {
                prepareCertificate()
            } catch (f: PrepareFailure) {
                BoxState.send(BoxEvent.Failed(f.lines))
            }
            if (destroyed) return
            startBackground()
        } catch (f: PrepareFailure) {
            BoxState.send(BoxEvent.Failed(f.lines))
        } catch (e: InterruptedException) {
            Thread.currentThread().interrupt() // the service is stopping
        } catch (e: Throwable) {
            if (destroyed) return
            Log.w(TAG, "prepare failed: " + e.javaClass.simpleName)
            BoxState.send(BoxEvent.Failed(listOf("GAGAL: persediaan MAXCOM terhenti (" + e.javaClass.simpleName + ").")))
        } finally {
            preparing.set(false)
        }
    }

    private fun step(label: String, n: Int) = BoxState.send(BoxEvent.Step(label, n, PREPARE_STEPS))

    private fun fail(message: String): Nothing = throw PrepareFailure(listOf(message))

    /** Step 3: clean parts, unpack and switch when needed, database copy before a switch. */
    private fun prepareRelease() {
        paths.boxRoot.mkdirs()
        paths.data.mkdirs()
        paths.logs.mkdirs()
        val store = ReleaseStore(paths.boxRoot, NioLinks())
        try {
            store.cleanParts()
            val archiveName = (assets.list("box") ?: emptyArray()).firstOrNull { ARCHIVE.matches(it) }
                ?: fail("GAGAL: keluaran MAXCOM tiada dalam APK.")
            val version = ARCHIVE.matchEntire(archiveName)!!.groupValues[1]
            val sha = readAsset("box/release.sha256", 4096).toString(Charsets.US_ASCII).trim()
                .split(Regex("\\s+")).firstOrNull()?.lowercase() ?: ""
            if (!Regex("[0-9a-f]{64}").matches(sha)) fail("GAGAL: release.sha256 tidak sah.")
            val bundled = BundledRelease(version, sha) { assets.open("box/$archiveName", android.content.res.AssetManager.ACCESS_STREAMING) }

            val have = store.installed()
            val usable = have != null && store.isComplete(have)
            if (store.needsUnpack(store.bundled(bundled)) || !usable) {
                if (have != null && usable) {
                    val stamp = DateTimeFormatter.ofPattern("yyyyMMdd-HHmmss").withZone(ZoneOffset.UTC).format(Instant.now())
                    DbBackup.make(paths.db, File(paths.data, "backups"), have, stamp)
                }
                store.unpack(bundled.open(), sha, version) { done ->
                    if (done % 200 == 0) BoxState.send(BoxEvent.Step("Membuka keluaran", 1, PREPARE_STEPS))
                }
                store.switchTo(version)
                val previous = try { paths.previousTxt.readText().trim() } catch (_: IOException) { "" }
                store.prune(setOfNotNull(version, previous.ifEmpty { null }))
            }
        } catch (f: PrepareFailure) {
            throw f
        } catch (e: IOException) {
            Log.w(TAG, "release step failed: " + e.javaClass.simpleName)
            fail("GAGAL: keluaran MAXCOM tidak dapat dibuka atau gagal disemak.")
        }
    }

    /** Step 4. */
    private fun prepareLayout() {
        val abi = Build.SUPPORTED_ABIS.firstOrNull { assetExists("runtime/$it/libmap.json") }
            ?: fail("GAGAL: peta pustaka untuk peranti ini tiada dalam APK.")
        val libmap = readAsset("runtime/$abi/libmap.json", 256 * 1024).toString(Charsets.UTF_8)
        val versions = readAsset("runtime/VERSIONS.md", 64 * 1024).toString(Charsets.UTF_8)
        try {
            assets.open("runtime/cert.pem").use { RuntimeLayout(paths, NioLinks()).rebuild(libmap, versions, it) }
        } catch (e: RuntimeLayoutException) {
            fail(e.message ?: "GAGAL: susun atur masa jalan tidak sah.")
        }
    }

    private fun readConfig(): BoxConfig = when (val r = BoxConfig.read(paths.boxConfig)) {
        is BoxConfigRead.Ok -> r.config
        is BoxConfigRead.Invalid -> fail("GAGAL: box-config.json: " + r.message)
    }

    // ---- certificate (step 5) --------------------------------------------------------------------

    private fun prepareCertificate() {
        try {
            var r = certify(currentIps(), logSkip = true)
            if (r == CertResult.WAIT_CLOCK) r = waitForClock()
            if (r == CertResult.ISSUED) supervisor?.restart()
        } catch (e: RootKeyUnavailable) {
            CertLog.append(paths.certRenewLog, CertLog.Kind.FAIL, "root key unavailable; no key file written")
            fail("GAGAL: kunci akar MAXCOM tidak dapat dibuka buat masa ini. Pelayan berjalan di peranti ini sahaja; sijil akan dicuba semula.")
        } catch (e: RootMismatch) {
            CertLog.append(paths.certRenewLog, CertLog.Kind.FAIL, "root certificate does not match the root key")
            fail("GAGAL: sijil akar tidak sepadan dengan kunci akar. Hubungi Pentadbir MAXCOM.")
        } catch (e: IOException) {
            CertLog.append(paths.certRenewLog, CertLog.Kind.FAIL, "certificate files: " + e.javaClass.simpleName)
            fail("GAGAL: sijil MAXCOM tidak dapat disediakan.")
        } catch (e: java.security.GeneralSecurityException) {
            CertLog.append(paths.certRenewLog, CertLog.Kind.FAIL, "certificate: " + e.javaClass.simpleName)
            fail("GAGAL: sijil MAXCOM tidak dapat disediakan.")
        }
    }

    /** A TV box has no clock battery: wait for network time, but not forever (the server serves loopback anyway). */
    private fun waitForClock(): CertResult {
        BoxState.send(BoxEvent.ClockWait)
        val deadline = SystemClock.elapsedRealtime() + CLOCK_WAIT_MS
        while (SystemClock.elapsedRealtime() < deadline) {
            Thread.sleep(CLOCK_POLL_MS) // InterruptedException (service stopping) ends the preparation
            if (destroyed) throw InterruptedException("service destroyed")
            val r = certify(currentIps(), logSkip = false)
            if (r != CertResult.WAIT_CLOCK) return r
        }
        CertLog.append(paths.certRenewLog, CertLog.Kind.FAIL, "clock still before build time, running without a new certificate")
        return CertResult.WAIT_CLOCK
    }

    private fun ensureSigner(): RootSigner {
        rootSigner?.let { return it }
        return RootSignerProvider.open(paths.caDir, paths.pki).also { rootSigner = it }
    }

    private fun currentIps(): List<String> = netWatch.current()

    /** Runs on the work thread only. Never makes a root before the clock is trusted. */
    private fun certify(ips: List<String>, logSkip: Boolean): CertResult {
        val now = Instant.now()
        val buildTime = Instant.ofEpochMilli(packageManager.getPackageInfo(packageName, 0).lastUpdateTime)
        val existingRoot = readSmall(paths.rootCaCopy) ?: readSmall(paths.rootCa)
        val leaf = readSmall(paths.leafCert)
        val keyPem = readSmall(paths.leafKeyPem)?.toString(Charsets.US_ASCII)
        var decision = LeafPolicy.decide(leaf, ips, now, buildTime, rootDer = existingRoot, leafKeyPem = keyPem, checkKey = true)
        if (existingRoot == null && decision is LeafDecision.Skip) {
            decision = if (now.isBefore(buildTime)) LeafDecision.WaitForClock else LeafDecision.Issue("no root certificate")
        }
        if (decision is LeafDecision.WaitForClock) return CertResult.WAIT_CLOCK
        val rs = ensureSigner()
        val rootDer = BoxCa.ensureRoot(paths.caDir, paths.pki, rs.signer, BoxCa.newLabel(), now)
        if (decision is LeafDecision.Skip) {
            if (logSkip) CertLog.append(paths.certRenewLog, CertLog.Kind.SKIP, "certificate still good")
            return CertResult.SKIPPED
        }
        val reason = (decision as LeafDecision.Issue).reason
        val pair = BoxCa.newLeafKey()
        val leafDer = BoxCa.makeLeaf(rs.signer, rootDer, pair.public, ips, now)
        val meta = CaMeta(ips, rs.store, rootLabel(rootDer), BoxCa.DEFAULT_LEAF_DAYS, rs.secureHardware)
        BoxCa.writeFiles(paths.data, rootDer, leafDer, BoxCa.pkcs8Pem(pair.private), meta)
        CertLog.append(paths.certRenewLog, CertLog.Kind.RENEWED, "$reason; ${ips.size} LAN address(es)")
        Log.i(TAG, "certificate issued, ${ips.size} address(es)")
        return CertResult.ISSUED
    }

    private fun rootLabel(rootDer: ByteArray): String = try {
        val cert = java.security.cert.CertificateFactory.getInstance("X.509")
            .generateCertificate(rootDer.inputStream()) as java.security.cert.X509Certificate
        val cn = Regex("CN=([^,]+)").find(cert.subjectX500Principal.getName("RFC2253"))?.groupValues?.get(1) ?: ""
        cn.removePrefix(BoxCa.ROOT_CN_PREFIX).ifBlank { "Box" }
    } catch (e: Exception) {
        "Box"
    }

    private fun readSmall(f: File): ByteArray? =
        try { if (f.isFile && f.length() <= 16 * 1024) f.readBytes() else null } catch (_: IOException) { null }

    // ---- supervisor (step 7) ---------------------------------------------------------------------

    private fun startSupervisor(config: BoxConfig) {
        val tz = TimeZone.getDefault().id.takeIf { Regex("^[A-Za-z0-9_+\\-]+(/[A-Za-z0-9_+\\-]+){0,2}$").matches(it) } ?: DEFAULT_TZ
        // Fail early, before the supervisor thread exists, when the child environment would be refused.
        try {
            ChildEnv.build(paths, config, token, tz)
        } catch (e: IllegalArgumentException) {
            fail("GAGAL: persekitaran pelayan tidak sah.")
        }
        val log = LogFile(paths.boxLog)
        log.addSecret(token)
        val reaper = ProcReaper(
            exeNames = setOf("libnode.so", "libmediamtx.so", "libffmpeg.so"),
            nativeLibDir = paths.nativeLibDir,
            ownPid = android.os.Process.myPid(),
            signal = { pid, sig -> android.os.Process.sendSignal(pid, sig) },
        )
        val sup = Supervisor(
            starter = AndroidProcessStarter(paths.nativeLibDir),
            clock = Clock { SystemClock.elapsedRealtime() },
            sleeper = Sleeper { ms -> Thread.sleep(ms) },
            log = log,
            reaper = reaper,
            commandProvider = {
                // The check the plan requires before any process starts: libnode.so resolves inside nativeLibraryDir.
                AndroidProcessStarter.checkExecutable(paths.nativeLibDir, paths.nodeBinary.path)
                listOf(paths.nodeBinary.path, paths.entryScript.path)
            },
            envProvider = {
                val c = (BoxConfig.read(paths.boxConfig) as? BoxConfigRead.Ok)?.config
                    ?: error("box-config.json is invalid")
                ChildEnv.build(paths, c, token, tz)
            },
            onState = { s -> onSupervisorState(s) },
            cwdProvider = { paths.workDir },
        )
        if (destroyed) return
        supervisor = sup
        sup.start()
        if (destroyed) {
            // onDestroy ran between the check and the assignment and did not see this supervisor.
            supervisor = null
            stopOffMainThread(sup)
        }
    }

    private fun onSupervisorState(s: BoxRunState) {
        when (s) {
            is BoxRunState.Starting, is BoxRunState.Waiting -> BoxState.send(BoxEvent.ServerStarting)
            is BoxRunState.Running -> BoxState.send(BoxEvent.ServerRunning)
            is BoxRunState.Failing -> BoxState.send(BoxEvent.Failed(s.lastLines))
            BoxRunState.Stopped -> Unit
        }
    }

    // ---- later work: daily tick, clock retry, address change ------------------------------------

    /** Each part on its own: a throw while scheduling or watching must not report Failed while the server runs. */
    private fun startBackground() {
        try {
            schedulePeriodic()
        } catch (e: Exception) {
            Log.w(TAG, "schedule failed: " + e.javaClass.simpleName)
        }
        try {
            startWatch()
        } catch (e: Exception) {
            Log.w(TAG, "network watch failed: " + e.javaClass.simpleName)
        }
    }

    private fun schedulePeriodic() {
        work.scheduleWithFixedDelay({ safely { recertify(currentIps(), logSkip = true) } }, DAY_HOURS, DAY_HOURS, TimeUnit.HOURS)
        // Also a short tick that only acts while the first certificate waited for the clock.
        work.scheduleWithFixedDelay({ safely { if (!File(paths.pki, "box-leaf.cer").isFile) recertify(currentIps(), logSkip = false) } }, 5, 5, TimeUnit.MINUTES)
    }

    private fun startWatch() {
        netWatch.markApplied(currentIps())
        netWatch.start()
        watchStarted = true
    }

    /** Step 5 again; when a leaf was issued the server restarts so it loads the new files. */
    private fun recertify(ips: List<String>, logSkip: Boolean) {
        if (certify(ips, logSkip) == CertResult.ISSUED) supervisor?.restart()
    }

    private inline fun safely(block: () -> Unit) {
        try {
            block()
        } catch (e: Exception) {
            Log.w(TAG, "background step failed: " + e.javaClass.simpleName)
            try { CertLog.append(paths.certRenewLog, CertLog.Kind.FAIL, "background renewal: " + e.javaClass.simpleName) } catch (_: Exception) { }
        }
    }

    // ---- helpers -------------------------------------------------------------------------------

    private fun assetExists(path: String): Boolean = try {
        assets.open(path).close()
        true
    } catch (_: IOException) {
        false
    }

    private fun readAsset(path: String, max: Int): ByteArray {
        assets.open(path).use { input ->
            val out = java.io.ByteArrayOutputStream()
            val buf = ByteArray(8192)
            while (true) {
                val n = input.read(buf)
                if (n < 0) break
                out.write(buf, 0, n)
                if (out.size() > max) throw IOException("asset too large: $path")
            }
            return out.toByteArray()
        }
    }

    private fun newToken(): String {
        val b = ByteArray(32)
        SecureRandom().nextBytes(b)
        return b.joinToString("") { "%02x".format(it) }
    }

    companion object {
        private const val TAG = "MAXCOM"
        private const val PREPARE_STEPS = 4
        private const val CLOCK_WAIT_MS = 2 * 60 * 1000L
        private const val CLOCK_POLL_MS = 5_000L
        private const val DAY_HOURS = 24L
        private const val DEFAULT_TZ = "Asia/Kuala_Lumpur"
        private val ARCHIVE = Regex("^maxcom-box-([0-9]{4}\\.[0-9]{1,2}\\.[0-9]{1,2})-android\\.tgz$") // .tgz: AGP gunzips and renames *.gz assets
    }
}
