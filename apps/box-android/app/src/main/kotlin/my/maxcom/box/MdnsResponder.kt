package my.maxcom.box

import android.content.Context
import android.net.wifi.WifiManager
import android.util.Log
import java.net.NetworkInterface
import my.maxcom.box.core.Ipv4
import my.maxcom.box.core.mdns.ClaimAction
import my.maxcom.box.core.mdns.IfaceAddr
import my.maxcom.box.core.mdns.MdnsEngine

/**
 * The Android side of the local name `boxN-surau.local`: holds the Wi-Fi multicast lock while the node runs
 * (without it the radio drops multicast frames) and turns the network watch's addresses into interfaces for
 * [MdnsEngine]. IPv4 only. Everything protocol-related lives in `core/mdns`, tested on the JVM.
 */
class MdnsResponder(
    context: Context,
    private val onAction: (ClaimAction) -> Unit,
    renumberGate: () -> Boolean = { true },
    onStatus: (bound: Boolean, reason: String?) -> Unit = { _, _ -> },
) {
    private val appContext = context.applicationContext
    private var lock: WifiManager.MulticastLock? = null
    private val engine = MdnsEngine(onAction = onAction, log = { Log.i(TAG, it) }, renumberGate = renumberGate, onStatus = onStatus)

    @Volatile
    private var started = false

    /** True while the socket is bound and the group joined (false after a bind failure, until a retry works). */
    fun bound(): Boolean = engine.bound

    /** The claimed host name now, or null while probing or when stopped. */
    fun claimedHost(): String? = engine.claimedHost

    fun exhausted(): Boolean = engine.exhausted

    fun start(startN: Int, ifaces: List<NetworkWatch.IfaceInfo>) {
        if (started) return
        started = true
        acquire()
        engine.start(startN, toIfaces(ifaces))
    }

    fun updateNetwork(ifaces: List<NetworkWatch.IfaceInfo>) {
        if (started) engine.updateInterfaces(toIfaces(ifaces))
    }

    fun setTxt(boxId: String?, caShort: String?) {
        if (started) engine.setTxt(boxId, caShort)
    }

    fun stop() {
        // always release: a start that failed half way may hold the lock without being "started"
        started = false
        engine.stop()
        release()
    }

    @Suppress("DEPRECATION")
    private fun acquire() {
        if (lock != null) return
        try {
            val wm = appContext.getSystemService(Context.WIFI_SERVICE) as WifiManager
            lock = wm.createMulticastLock("maxcom:mdns").also {
                it.setReferenceCounted(false)
                it.acquire()
            }
        } catch (e: Exception) {
            Log.w(TAG, "multicast lock failed: " + e.javaClass.simpleName)
        }
    }

    private fun release() {
        try {
            lock?.let { if (it.isHeld) it.release() }
        } catch (e: Exception) {
            Log.w(TAG, "multicast lock release failed: " + e.javaClass.simpleName)
        }
        lock = null
    }

    private fun toIfaces(list: List<NetworkWatch.IfaceInfo>): List<IfaceAddr> = list.mapNotNull { i ->
        val addr = Ipv4.parse(i.ip) ?: return@mapNotNull null
        val ni = try { i.name?.let { NetworkInterface.getByName(it) } } catch (_: Exception) { null }
        IfaceAddr(ni, addr, i.prefix.coerceIn(0, 32))
    }

    private companion object {
        const val TAG = "MAXCOM"
    }
}

/** What the service tells the rest of the app (doctor, maintenance screen) about the local name. */
object LocalName {
    @Volatile
    var host: String? = null

    @Volatile
    var exhausted: Boolean = false

    /** The node could not bind or lost its socket; cleared when it is bound again. */
    @Volatile
    var failed: Boolean = false

    /** Short reason for [failed] (an exception class name), or null. */
    @Volatile
    var failReason: String? = null

    /** A warning shown next to a claimed name (for example: the renumber cap was reached), or null. */
    @Volatile
    var warning: String? = null
}
