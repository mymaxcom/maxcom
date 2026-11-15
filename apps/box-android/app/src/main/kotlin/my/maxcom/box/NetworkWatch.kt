package my.maxcom.box

import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.net.NetworkRequest
import java.net.Inet4Address
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.TimeUnit
import my.maxcom.box.core.LanAddresses

/**
 * Watches the LAN addresses of the box (every network, so an Ethernet cable and Wi-Fi both count). A changed
 * list that stays the same for [settleMs] is passed to [onChanged]; the first list is not reported (the
 * service reads [current] itself).
 */
class NetworkWatch(
    context: Context,
    private val settleMs: Long = 20_000,
    /** Called at once (no settle wait) with the new list whenever the list of LAN addresses changes; for the name responder. */
    private val onImmediate: ((List<String>) -> Unit)? = null,
    private val onChanged: (List<String>) -> Unit,
) {
    private val cm = context.applicationContext.getSystemService(ConnectivityManager::class.java)
    private val timer = Executors.newSingleThreadScheduledExecutor { r -> Thread(r, "box-netwatch").also { it.isDaemon = true } }
    private val lock = Any()
    private var applied: List<String> = emptyList()
    private var pending: ScheduledFuture<*>? = null
    private var registered = false
    private var lastImmediate: List<String>? = null

    private val callback = object : ConnectivityManager.NetworkCallback() {
        override fun onAvailable(network: Network) = changed()
        override fun onLost(network: Network) = changed()
        override fun onLinkPropertiesChanged(network: Network, linkProperties: android.net.LinkProperties) = changed()
        override fun onCapabilitiesChanged(network: Network, networkCapabilities: NetworkCapabilities) = changed()
    }

    /** One LAN address with the interface it is on and its prefix length. */
    class IfaceInfo(val name: String?, val ip: String, val prefix: Int)

    /** The addresses now, for the leaf: private IPv4 on Ethernet and Wi-Fi. */
    fun current(): List<String> = LanAddresses.pick(scan().map { it.first })

    /** [current] with interface name and prefix length, for the mDNS responder (same addresses, same order). */
    fun currentIfaces(): List<IfaceInfo> {
        val all = scan()
        val ips = LanAddresses.pick(all.map { it.first })
        return ips.mapNotNull { ip -> all.firstOrNull { it.first.address == ip }?.second }
    }

    @Suppress("DEPRECATION")
    private fun scan(): List<Pair<LanAddresses.Candidate, IfaceInfo>> {
        val out = ArrayList<Pair<LanAddresses.Candidate, IfaceInfo>>()
        val nets = try { cm.allNetworks } catch (e: Exception) { return emptyList() }
        for (n in nets) {
            val caps = cm.getNetworkCapabilities(n) ?: continue
            val type = when {
                caps.hasTransport(NetworkCapabilities.TRANSPORT_VPN) -> LanAddresses.IfaceType.OTHER
                caps.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET) -> LanAddresses.IfaceType.ETHERNET
                caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) -> LanAddresses.IfaceType.WIFI
                else -> LanAddresses.IfaceType.OTHER
            }
            val lp = cm.getLinkProperties(n) ?: continue
            for (la in lp.linkAddresses) {
                val a = la.address
                if (a is Inet4Address) {
                    val ip = a.hostAddress ?: continue
                    out.add(LanAddresses.Candidate(type, ip) to IfaceInfo(lp.interfaceName, ip, la.prefixLength))
                }
            }
        }
        return out
    }

    /** The service tells the watch which list its certificate already has. */
    fun markApplied(ips: List<String>) {
        synchronized(lock) { applied = ips }
    }

    fun start() {
        synchronized(lock) {
            if (registered) return
            registered = true
            lastImmediate = current()
        }
        cm.registerNetworkCallback(NetworkRequest.Builder().build(), callback)
    }

    fun stop() {
        val wasRegistered: Boolean
        synchronized(lock) {
            wasRegistered = registered
            registered = false
            pending?.cancel(false)
        }
        if (wasRegistered) {
            try {
                cm.unregisterNetworkCallback(callback)
            } catch (_: IllegalArgumentException) {
                // already gone
            }
        }
        timer.shutdownNow()
    }

    private fun changed() {
        val now = current()
        val fire = synchronized(lock) {
            if (registered && now != lastImmediate) { lastImmediate = now; true } else false
        }
        if (fire) {
            try {
                onImmediate?.invoke(now)
            } catch (_: Exception) {
                // the service logs its own failures
            }
        }
        synchronized(lock) {
            if (!registered) return
            pending?.cancel(false)
            if (now == applied) return
            pending = timer.schedule({ settle(now) }, settleMs, TimeUnit.MILLISECONDS)
        }
    }

    private fun settle(seen: List<String>) {
        val again = current()
        synchronized(lock) {
            if (!registered || again != seen || seen == applied) return
            applied = seen
        }
        try {
            onChanged(seen)
        } catch (_: Exception) {
            // the service logs its own failures
        }
    }
}
