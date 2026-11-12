package my.maxcom.box

import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.PowerManager
import android.os.StatFs
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import java.security.KeyStore
import java.security.cert.CertificateFactory
import java.security.cert.X509Certificate
import java.time.Duration
import java.time.Instant
import javax.net.ssl.HttpsURLConnection
import javax.net.ssl.SSLContext
import javax.net.ssl.TrustManagerFactory
import my.maxcom.box.core.BoxPaths
import my.maxcom.box.core.DoctorLine
import my.maxcom.box.core.DoctorReport
import my.maxcom.box.core.NioLinks
import my.maxcom.box.core.ProcReaper
import my.maxcom.box.core.ReleaseStore

/**
 * On-box health check, the Android counterpart of `scripts/setup/doctor.ps1` for the checks that apply here.
 * Read-only: it changes nothing and prints no key, token or path under `secret`. Blocking (network and files):
 * call it off the main thread.
 */
class BoxDoctor(
    private val context: Context,
    private val paths: BoxPaths,
    private val lanIps: () -> List<String>,
    private val now: () -> Instant = Instant::now,
) {
    fun run(): DoctorReport {
        val lines = ArrayList<DoctorLine>()
        lines += safe("Kesihatan pelayan") { health() }
        val ips = try { lanIps() } catch (_: Exception) { emptyList() }
        lines += if (ips.isEmpty()) DoctorLine(false, "Tiada alamat rangkaian setempat (Ethernet atau Wi-Fi).")
        else DoctorLine(true, "Alamat rangkaian: " + ips.joinToString(", "))
        lines += safe("HTTPS pada rangkaian") { https(ips) }
        lines += safe("Versi dipasang") { release() }
        lines += safe("Tempoh pensijil") { certDays() }
        lines += safe("Kunci akar") { rootStore() }
        lines += safe("Proses Node") { processLine("libnode.so", "Node") }
        lines += safe("Proses MediaMTX") { processLine("libmediamtx.so", "MediaMTX") }
        lines += safe("Pengecualian bateri") { battery() }
        lines += safe("Skrin utama") { homeApp() }
        lines += safe("Ruang kosong") { DoctorReport.freeSpace(StatFs(paths.filesDir.path).availableBytes) }
        temperature()?.let { lines += it }
        val tail = DoctorReport.lastProblems(readTail(paths.boxLog, 64 * 1024), 5)
        return DoctorReport(lines, tail)
    }

    private fun safe(what: String, block: () -> DoctorLine): DoctorLine = try {
        block()
    } catch (e: Exception) {
        DoctorLine(false, "$what: semakan tidak dapat dijalankan (" + e.javaClass.simpleName + ").")
    }

    private fun health(): DoctorLine {
        val c = URL("http://127.0.0.1:${BoxReducer.PORT}/api/health").openConnection() as HttpURLConnection
        c.connectTimeout = TIMEOUT_MS
        c.readTimeout = TIMEOUT_MS
        return try {
            val code = c.responseCode
            if (code == 200) DoctorLine(true, "Pelayan menjawab pada 127.0.0.1:${BoxReducer.PORT}.")
            else DoctorLine(false, "Pelayan menjawab dengan kod $code.")
        } finally {
            c.disconnect()
        }
    }

    /** HTTPS on the first LAN address, trusting only the stored root: the leaf must chain to it and name the address. */
    private fun https(ips: List<String>): DoctorLine {
        val ip = ips.firstOrNull() ?: return DoctorLine(false, "HTTPS tidak disemak: tiada alamat rangkaian.")
        val rootBytes = paths.rootCa.takeIf { it.isFile && it.length() <= MAX_CERT }?.readBytes()
            ?: return DoctorLine(false, "Pensijil akar tiada.")
        val root = CertificateFactory.getInstance("X.509").generateCertificate(rootBytes.inputStream())
        val ks = KeyStore.getInstance(KeyStore.getDefaultType()).apply { load(null, null); setCertificateEntry("root", root) }
        val tmf = TrustManagerFactory.getInstance(TrustManagerFactory.getDefaultAlgorithm()).apply { init(ks) }
        val ctx = SSLContext.getInstance("TLS").apply { init(null, tmf.trustManagers, null) }
        val c = URL("https://$ip:8443/api/health").openConnection() as HttpsURLConnection
        c.sslSocketFactory = ctx.socketFactory
        c.connectTimeout = TIMEOUT_MS
        c.readTimeout = TIMEOUT_MS
        return try {
            val code = c.responseCode
            if (code == 200) DoctorLine(true, "HTTPS pada $ip:8443 sah dengan pensijil akar MAXCOM.")
            else DoctorLine(false, "HTTPS pada $ip:8443 menjawab kod $code.")
        } catch (e: javax.net.ssl.SSLException) {
            DoctorLine(false, "HTTPS pada $ip:8443: pensijil tidak sepadan dengan akar (" + e.javaClass.simpleName + ").")
        } finally {
            c.disconnect()
        }
    }

    private fun release(): DoctorLine {
        val store = ReleaseStore(paths.boxRoot, NioLinks())
        val v = store.installed() ?: return DoctorLine(false, "Tiada keluaran dipasang.")
        return if (store.isComplete(v)) DoctorLine(true, "Keluaran $v dipasang dan lengkap.")
        else DoctorLine(false, "Keluaran $v tidak lengkap (.ok tiada).")
    }

    private fun certDays(): DoctorLine {
        val f = paths.leafCert
        if (!f.isFile || f.length() > MAX_CERT) return DoctorLine(false, "Pensijil kotak tiada.")
        val cert = CertificateFactory.getInstance("X.509").generateCertificate(f.readBytes().inputStream()) as X509Certificate
        return DoctorReport.certDays(Duration.between(now(), cert.notAfter.toInstant()).toDays())
    }

    private fun rootStore(): DoctorLine {
        val f = paths.boxCaJson
        if (!f.isFile || f.length() > 16 * 1024) return DoctorLine(false, "Rekod pensijil akar tiada.")
        val store = Regex("\"store\"\\s*:\\s*\"([^\"]*)\"").find(f.readText())?.groupValues?.get(1)
        return when (store) {
            "AndroidKeyStore" -> DoctorLine(true, "Kunci akar: Keystore.")
            // The documented file fallback (decision 18) works, but the key is then a file of the app.
            "File", "file" -> DoctorLine(true, "Kunci akar: Fail (Keystore tidak tersedia pada peranti ini).")
            else -> DoctorLine(false, "Kunci akar: tidak dikenali.")
        }
    }

    private fun processLine(exeName: String, label: String): DoctorLine {
        val libDir = File(context.applicationInfo.nativeLibraryDir).canonicalFile
        val found = File("/proc").listFiles().orEmpty().any { d ->
            d.name.toIntOrNull() != null && try {
                val exe = ProcReaper.readExeLink(d)?.removeSuffix(" (deleted)")
                exe != null && File(exe).name == exeName && File(exe).parentFile?.canonicalFile == libDir
            } catch (_: Exception) {
                false
            }
        }
        return if (found) DoctorLine(true, "$label berjalan.") else DoctorLine(false, "$label tidak berjalan.")
    }

    private fun battery(): DoctorLine {
        val pm = context.getSystemService(PowerManager::class.java)
        return if (pm.isIgnoringBatteryOptimizations(context.packageName)) DoctorLine(true, "Pengecualian bateri aktif.")
        else DoctorLine(false, "Pengecualian bateri belum diberi.")
    }

    private fun homeApp(): DoctorLine {
        val i = Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_HOME)
        val info = context.packageManager.resolveActivity(i, PackageManager.MATCH_DEFAULT_ONLY)?.activityInfo
        return if (info?.packageName == context.packageName) DoctorLine(true, "MAXCOM ialah aplikasi utama.")
        else DoctorLine(false, "MAXCOM bukan aplikasi utama; kotak tidak akan membuka MAXCOM sendiri selepas dihidupkan.")
    }

    /** The warmest readable thermal zone, or null when none can be read. Over 85 C fails. */
    private fun temperature(): DoctorLine? {
        var best: Double? = null
        for (z in File("/sys/class/thermal").listFiles().orEmpty()) {
            if (!z.name.startsWith("thermal_zone")) continue
            val raw = try { File(z, "temp").readText().trim().toDoubleOrNull() } catch (_: Exception) { null } ?: continue
            val c = if (raw > 1000) raw / 1000.0 else raw
            if (c in 0.0..150.0 && (best == null || c > best)) best = c
        }
        val t = best ?: return null
        val text = "Suhu peranti %.0f C.".format(t)
        return DoctorLine(t < 85.0, text)
    }

    companion object {
        private const val TIMEOUT_MS = 3_000
        private const val MAX_CERT = 16 * 1024L

        /** The last [maxBytes] of [f] as lines; empty when missing. */
        fun readTail(f: File, maxBytes: Int): List<String> {
            if (!f.isFile) return emptyList()
            return try {
                java.io.RandomAccessFile(f, "r").use { r ->
                    val len = r.length()
                    val start = maxOf(0L, len - maxBytes)
                    r.seek(start)
                    val buf = ByteArray((len - start).toInt())
                    r.readFully(buf)
                    String(buf, Charsets.UTF_8).lines().let { if (start > 0) it.drop(1) else it }.filter { it.isNotBlank() }
                }
            } catch (_: Exception) {
                emptyList()
            }
        }
    }
}
