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
import my.maxcom.box.core.BoxIdentity
import my.maxcom.box.core.BoxName
import my.maxcom.box.core.CertLock
import my.maxcom.box.core.mdns.BoxNameStore
import my.maxcom.box.core.mdns.ClaimAction
import my.maxcom.box.core.BoxConfig
import my.maxcom.box.core.BoxConfigRead
import my.maxcom.box.core.BoxPaths
import my.maxcom.box.core.BoxRunState
import my.maxcom.box.core.BundledRelease
import my.maxcom.box.core.CaMeta
import my.maxcom.box.core.CertLog
import my.maxcom.box.core.ChildEnv
import my.maxcom.box.core.LeaveSecret
import my.maxcom.box.core.DbBackup
import my.maxcom.box.core.LeafDecision
import my.maxcom.box.core.LeafPolicy
import my.maxcom.box.core.BoxLogs
import my.maxcom.box.core.LogFile
import my.maxcom.box.core.StuckLogGate
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

    /** The box log (the one Maintenance shows); shared with the supervisor. Every start/stop/restart decision goes here. */
    private val boxLog: LogFile by lazy { BoxLogs.forFile(paths.boxLog) }

    /** Where the preparation is now, and when it got there (for the watchdog and the log). */
    @Volatile
    private var stage: String = "belum bermula"

    @Volatile
    private var stageSince: Long = 0L
    private var watchdog: ScheduledExecutorService? = null
    private var wakeLock: PowerManager.WakeLock? = null
    private var wifiLock: WifiManager.WifiLock? = null
    private val netWatch: NetworkWatch by lazy {
        NetworkWatch(this, onImmediate = { ips ->
            blog("rangkaian: alamat berubah (" + ips.size + " alamat), nama dikemas kini")
            responder?.updateNetwork(netWatch.currentIfaces())
        }) { ips ->
            blog("rangkaian: alamat tetap selepas penantian (" + ips.size + " alamat), semak sijil")
            responder?.updateNetwork(netWatch.currentIfaces())
            try {
                work.execute { safely { recertify(ips, logSkip = false) } }
            } catch (_: java.util.concurrent.RejectedExecutionException) {
                blog("rangkaian: kerja sijil ditolak (perkhidmatan sedang dimusnahkan)")
            }
        }
    }

    /** The local name node (`boxN-surau.local`); null until [startNameService] runs. */
    @Volatile
    private var responder: MdnsResponder? = null
    private var watchStarted = false
    private var rootSigner: RootSigner? = null

    @Volatile
    private var supervisor: Supervisor? = null

    /** Set first thing in onDestroy; prepare checks it so a stop during preparation leaves no server behind. */
    @Volatile
    private var destroyed = false

    /** Taken by onDestroy when it sets [destroyed] and by each watchdog tick, so a tick never restarts the server after destroy began. */
    private val lifeLock = Any()
    private val stuckGate = StuckLogGate()

    @Volatile
    private var token: String = ""

    /** The per-start secret for `/api/follow/revert` and `/api/follow/empty`; new at each start, memory only (O20). */
    @Volatile
    private var leaveSecret: String = ""

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
        blog("perkhidmatan: onCreate")
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
        blog("perkhidmatan: onStartCommand (startId=$startId, intent=" + (if (intent == null) "null, dimulakan semula oleh sistem" else "ada") + ", pelayan=" + serverDescription() + ")")
        // The intent that started us is not read: extras and data are ignored.
        try {
            work.execute { prepare() }
        } catch (_: java.util.concurrent.RejectedExecutionException) {
            blog("perkhidmatan: persediaan ditolak (perkhidmatan sedang dimusnahkan)")
        }
        startWatchdog()
        return START_STICKY
    }

    override fun onTaskRemoved(rootIntent: Intent?) {
        // The service stays: the box serves the surau without any screen open.
    }

    override fun onDestroy() {
        synchronized(lifeLock) {
            destroyed = true
            supervisor?.refuseStarts()
        }
        blog("perkhidmatan: onDestroy, pelayan akan dihentikan (pelayan=" + serverDescription() + ", peringkat=" + stage + ")")
        watchdog?.shutdownNow()
        watchdog = null
        BoxState.removeListener(stateListener)
        LeaveSecret.clear()
        if (watchStarted) netWatch.stop()
        try { responder?.stop() } catch (e: Exception) { Log.w(TAG, "name stop failed: " + e.javaClass.simpleName) }
        responder = null
        LocalName.host = null
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
                sup.shutdown()
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
        val existing = supervisor
        if (existing != null) {
            // Never a silent no-op: a second start (Mula semula, boot, kiosk relaunch) must leave the server running.
            val started = !destroyed && existing.ensureRunning()
            blog("persediaan: pelayan sudah wujud (" + serverDescription() + "), " + (if (started) "dimulakan semula" else "tiada tindakan"))
            return
        }
        if (!preparing.compareAndSet(false, true)) {
            blog("persediaan: sudah berjalan (peringkat " + stage + " sejak " + ageOfStage() + " s), permintaan baharu diabaikan")
            return
        }
        try {
            mark("persediaan bermula")
            // Step 6 (token) is replaced at every service start; a retry after a failure gets a new one too.
            token = newToken()
            leaveSecret = newToken()
            LeaveSecret.set(leaveSecret)
            BoxState.send(BoxEvent.ServiceStarted(token))
            step("Membuka keluaran", 1)
            prepareRelease()
            step("Menyusun pustaka", 2)
            prepareLayout()
            val config = readConfig()
            mark("pelayan akan dimulakan")
            // The server starts first, on loopback, with whatever leaf exists: the surau screen must not wait
            // for the clock or the root key. The certificate step runs after and restarts it when a leaf lands.
            step("Memulakan pelayan", 3)
            startSupervisor(config)
            if (destroyed) return
            step("Menyediakan sijil", 4)
            try {
                prepareCertificate()
            } catch (f: PrepareFailure) {
                blog("persediaan: sijil gagal: " + (f.message ?: ""))
                BoxState.send(BoxEvent.Failed(f.lines))
            }
            if (destroyed) return
            mark("latar belakang")
            startBackground()
            mark("siap")
        } catch (f: PrepareFailure) {
            blog("persediaan: GAGAL pada peringkat " + stage + ": " + (f.message ?: ""))
            BoxState.send(BoxEvent.Failed(f.lines))
        } catch (e: InterruptedException) {
            blog("persediaan: diganggu pada peringkat " + stage)
            Thread.currentThread().interrupt() // the service is stopping
        } catch (e: Throwable) {
            if (destroyed) return
            blog("persediaan: GAGAL pada peringkat " + stage + ": " + e.javaClass.simpleName)
            Log.w(TAG, "prepare failed: " + e.javaClass.simpleName)
            BoxState.send(BoxEvent.Failed(listOf("GAGAL: persediaan MAXCOM terhenti (" + e.javaClass.simpleName + ").")))
        } finally {
            preparing.set(false)
        }
    }

    private fun step(label: String, n: Int) {
        mark("langkah $n $label")
        BoxState.send(BoxEvent.Step(label, n, PREPARE_STEPS))
    }

    private fun mark(s: String) {
        stage = s
        stageSince = SystemClock.elapsedRealtime()
        blog("persediaan: $s")
    }

    private fun ageOfStage(): Long = if (stageSince == 0L) 0L else (SystemClock.elapsedRealtime() - stageSince) / 1000

    /** One line in the box log; never throws and never carries a token, key or path. */
    private fun blog(text: String) {
        try {
            boxLog.appendLine("MAXCOM: $text")
        } catch (_: Throwable) {
            // the log must never stop the box
        }
    }

    private fun serverDescription(): String {
        val s = supervisor ?: return "tiada"
        return if (s.isActive()) "aktif" else "tidak aktif"
    }

    /**
     * A watchdog on its own thread (the work thread may be blocked): when the supervisor exists but its loop is gone
     * while the service is alive, the server is started again. Also records a preparation that stays on one stage.
     */
    private fun startWatchdog() {
        if (watchdog != null || destroyed) return
        val w = Executors.newSingleThreadScheduledExecutor { r -> Thread(r, "box-watchdog").also { it.isDaemon = true } }
        watchdog = w
        w.scheduleWithFixedDelay({
            try {
                var restarted = false
                var sup: Supervisor? = null
                synchronized(lifeLock) {
                    if (destroyed) return@scheduleWithFixedDelay
                    sup = supervisor
                    restarted = sup?.ensureRunning() ?: false
                }
                if (sup != null) {
                    if (restarted) blog("pengawas: pelayan tidak berjalan, dimulakan semula")
                } else if (stageSince != 0L && ageOfStage() >= STAGE_WARN_S && stage != "siap" &&
                    stuckGate.shouldLog(stage, preparing.get(), SystemClock.elapsedRealtime())
                ) {
                    blog("pengawas: persediaan tersekat di peringkat " + stage + " sejak " + ageOfStage() + " s")
                }
            } catch (e: Throwable) {
                blog("pengawas: GAGAL " + e.javaClass.simpleName)
            }
        }, WATCHDOG_S, WATCHDOG_S, TimeUnit.SECONDS)
    }

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
            if (store.needsUnpack(store.bundled(bundled), sha) || !usable) {
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
        // The local name is claimed before the leaf is made, so the leaf can carry it (a late claim reissues the leaf).
        startNameService()
        try {
            var r = certify(currentIps(), logSkip = true)
            if (r == CertResult.WAIT_CLOCK) r = waitForClock()
            blog("sijil: keputusan awal " + r)
            if (r == CertResult.ISSUED) restartServer("sijil awal dikeluarkan")
        } catch (e: my.maxcom.box.core.CertLockBusy) {
            // The server already runs: no Failed event; the next network change or recertify trigger tries again.
            blog("sijil: kunci sijil sibuk, pelayan dikekalkan, dicuba semula pada pencetus seterusnya")
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

    private fun ensureSigner(freshLabel: String): RootSigner {
        rootSigner?.let { return it }
        return RootSignerProvider.open(paths.caDir, paths.pki, freshLabel).also { rootSigner = it }
    }

    // ---- local name (boxN-surau.local) -------------------------------------------------------------

    /** Starts the name node at the stored number and waits briefly for the claim (only when a network is up). */
    private fun startNameService() {
        if (responder != null || destroyed) return
        LocalName.failed = false
        LocalName.failReason = null
        var r: MdnsResponder? = null
        try {
            r = MdnsResponder(this, { a -> onNameAction(a) }, renumberGate = { allowRenumber() }, onStatus = { b, why -> onNameStatus(b, why) })
            responder = r
            val ifaces = netWatch.currentIfaces()
            r.start(BoxNameStore(paths.boxNameJson).read()?.n ?: 1, ifaces)
            if (ifaces.isEmpty()) return
            val deadline = SystemClock.elapsedRealtime() + NAME_WAIT_MS
            // the wait ends early when the node could not bind (it retries in the background)
            while (SystemClock.elapsedRealtime() < deadline && r.claimedHost() == null && !r.exhausted() && !LocalName.failed) {
                Thread.sleep(NAME_POLL_MS) // InterruptedException (service stopping) ends the preparation
                if (destroyed) throw InterruptedException("service destroyed")
            }
        } catch (e: InterruptedException) {
            throw e
        } catch (e: Exception) {
            // The name is a convenience; the box still works by IP. Release what was taken.
            Log.w(TAG, "local name failed: " + e.javaClass.simpleName)
            LocalName.failed = true
            LocalName.failReason = e.javaClass.simpleName
            LocalName.host = null
            try { r?.stop() } catch (_: Exception) { }
            responder = null
        }
    }

    /** Runs on the name node's thread: the node bound (true) or lost/failed its socket (false, with the reason). */
    private fun onNameStatus(bound: Boolean, reason: String?) {
        if (bound) {
            LocalName.failed = false
            LocalName.failReason = null
        } else {
            LocalName.failed = true
            LocalName.failReason = reason
            LocalName.host = null
            LocalName.exhausted = false
        }
    }

    private var memRenumbers = 0

    /**
     * The renumber cap: 3 per 24 hours, persisted in the box-name store and recorded at the moment the renumber is
     * allowed. With no stored name yet (first boot) an in-memory count of 3 applies. Any storage error denies.
     */
    private fun allowRenumber(): Boolean = try {
        val store = BoxNameStore(paths.boxNameJson)
        if (store.read() == null) memRenumbers++ < BoxNameStore.MAX_RENUMBERS_PER_DAY
        else store.tryRecordRenumber(Instant.now())
    } catch (e: Exception) {
        Log.w(TAG, "renumber record failed: " + e.javaClass.simpleName)
        false
    }

    /** Runs on the name node's thread: keep it short and hand the work to the service thread. */
    private fun onNameAction(a: ClaimAction) {
        when (a) {
            is ClaimAction.Claimed -> {
                LocalName.host = BoxName.hostFor(a.n)
                LocalName.exhausted = false
                submit { safely { persistName(a.n); recertify(currentIps(), logSkip = false) } }
            }
            is ClaimAction.Lost -> {
                LocalName.host = null
                LocalName.warning = null
            }
            is ClaimAction.RenumberDenied -> {
                Log.w(TAG, "local name renumber cap reached; keeping the name")
                LocalName.warning = "amaran: nama diganggu berulang kali; nama dikekalkan (had 3 pertukaran sehari)"
            }
            ClaimAction.Exhausted -> {
                LocalName.host = null
                LocalName.exhausted = true
                submit { safely { recertify(currentIps(), logSkip = false) } }
            }
            else -> Unit
        }
    }

    private fun submit(block: () -> Unit) {
        try { work.execute(block) } catch (_: java.util.concurrent.RejectedExecutionException) { }
    }

    /** The number is kept as claimed; `claimedAt` changes only when the number does. */
    private fun persistName(n: Int) {
        BoxNameStore(paths.boxNameJson).persistClaim(n, Instant.now())
    }

    /**
     * The name the leaf should carry: the claimed one; none when all 99 are taken; otherwise the stored number
     * unprobed (no network yet at boot); null when there is no name at all (the leaf's names are left alone).
     */
    private fun wantedName(): String? {
        val r = responder
        // not bound (no socket yet, or it failed): the persisted name stays in the leaf so clients can still fall back
        if (r != null && r.bound()) {
            r.claimedHost()?.let { return it }
            if (r.exhausted()) return LeafPolicy.NO_NAME
        }
        return BoxNameStore(paths.boxNameJson).read()?.let { BoxName.hostFor(it.n) }
    }

    /** The public hints in the DNS-SD TXT record: box id (from the master key) and the root's first 16 hex. */
    private fun refreshTxt() {
        try {
            responder?.setTxt(BoxIdentity.boxId(paths.boxKey), BoxIdentity.caShort(readSmall(paths.rootCa)))
        } catch (e: Exception) {
            Log.w(TAG, "txt refresh failed: " + e.javaClass.simpleName)
        }
    }

    private fun currentIps(): List<String> = netWatch.current()

    /** Runs on the work thread only. Never makes a root before the clock is trusted. */
    private fun certify(ips: List<String>, logSkip: Boolean): CertResult {
        val r = CertLock.held { certifyLocked(ips, logSkip) }
        refreshTxt()
        return r
    }

    private fun certifyLocked(ips: List<String>, logSkip: Boolean): CertResult {
        val now = Instant.now()
        val name = wantedName()
        val buildTime = Instant.ofEpochMilli(packageManager.getPackageInfo(packageName, 0).lastUpdateTime)
        val existingRoot = readSmall(paths.rootCaCopy) ?: readSmall(paths.rootCa)
        val leaf = readSmall(paths.leafCert)
        val keyPem = readSmall(paths.leafKeyPem)?.toString(Charsets.US_ASCII)
        var decision = LeafPolicy.decide(leaf, ips, now, buildTime, rootDer = existingRoot, leafKeyPem = keyPem, checkKey = true, wantedName = name)
        if (existingRoot == null && decision is LeafDecision.Skip) {
            decision = if (now.isBefore(buildTime)) LeafDecision.WaitForClock else LeafDecision.Issue("no root certificate")
        }
        if (decision is LeafDecision.WaitForClock) return CertResult.WAIT_CLOCK
        val freshLabel = BoxCa.newLabel()
        val rs = ensureSigner(freshLabel)
        val rootDer = BoxCa.ensureRoot(paths.caDir, paths.pki, rs.signer, freshLabel, now)
        if (decision is LeafDecision.Skip) {
            if (logSkip) CertLog.append(paths.certRenewLog, CertLog.Kind.SKIP, "certificate still good")
            return CertResult.SKIPPED
        }
        val reason = (decision as LeafDecision.Issue).reason
        val pair = BoxCa.newLeafKey()
        // A legacy root never gets the numbered name (its constraints do not permit it).
        val leafName = name?.takeIf { it != LeafPolicy.NO_NAME && BoxCa.rootPermitsSubtree(rootDer) }
        val leafDer = BoxCa.makeLeaf(rs.signer, rootDer, pair.public, ips, now, boxName = leafName)
        val meta = CaMeta(ips, rs.store, rootLabel(rootDer), BoxCa.DEFAULT_LEAF_DAYS, rs.secureHardware, leafName)
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
            ChildEnv.build(paths, config, token, tz, leaveSecret)
        } catch (e: IllegalArgumentException) {
            fail("GAGAL: persekitaran pelayan tidak sah.")
        }
        val log = boxLog
        log.addSecret(token)
        log.addSecret(leaveSecret)
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
                ChildEnv.build(paths, c, token, tz, leaveSecret)
            },
            onState = { s -> onSupervisorState(s) },
            cwdProvider = { paths.workDir },
        )
        if (destroyed) return
        supervisor = sup
        blog("pelayan: penyelia dicipta, dimulakan")
        sup.start()
        if (destroyed) {
            // onDestroy ran between the check and the assignment and did not see this supervisor.
            supervisor = null
            stopOffMainThread(sup)
        }
    }

    private fun onSupervisorState(s: BoxRunState) {
        blog("pelayan: keadaan " + s.javaClass.simpleName)
        when (s) {
            is BoxRunState.Starting, is BoxRunState.Waiting -> BoxState.send(BoxEvent.ServerStarting)
            is BoxRunState.Running -> {
                BoxState.send(BoxEvent.ServerRunning)
                submit { refreshTxt() } // the server has made its master key by now: the box id can be advertised
            }
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
        blog("sijil: semakan semula (" + ips.size + " alamat)")
        val r = certify(ips, logSkip)
        blog("sijil: keputusan " + r)
        if (r == CertResult.ISSUED) restartServer("sijil baharu dikeluarkan")
    }

    /**
     * Restarts the server after a new leaf. Never gives up quietly: a missing supervisor is logged, a failed restart is
     * followed by a plain start, and the result is checked and logged.
     */
    private fun restartServer(reason: String) {
        val sup = supervisor
        if (sup == null) {
            blog("pelayan: mula semula diminta ($reason) tetapi tiada penyelia; persediaan memulakannya")
            return
        }
        blog("pelayan: mula semula ($reason)")
        try {
            sup.restart()
        } catch (e: Throwable) {
            blog("pelayan: GAGAL mula semula: " + e.javaClass.simpleName)
        }
        if (!destroyed && sup.ensureRunning()) blog("pelayan: tidak berjalan selepas mula semula, dimulakan")
        blog("pelayan: selepas mula semula, " + serverDescription())
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
        private const val NAME_WAIT_MS = 3_000L
        private const val NAME_POLL_MS = 100L
        private const val WATCHDOG_S = 30L
        private const val STAGE_WARN_S = 120L
        private const val DAY_HOURS = 24L
        private const val DEFAULT_TZ = "Asia/Kuala_Lumpur"
        private val ARCHIVE = Regex("^maxcom-box-([0-9]{4}\\.[0-9]{1,2}\\.[0-9]{1,2})-android\\.tgz$") // .tgz: AGP gunzips and renames *.gz assets
    }
}
