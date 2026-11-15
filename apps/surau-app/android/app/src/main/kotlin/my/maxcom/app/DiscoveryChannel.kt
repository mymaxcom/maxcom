package my.maxcom.app

import android.content.Context
import android.net.nsd.NsdManager
import android.net.nsd.NsdServiceInfo
import android.os.Handler
import android.os.Looper
import io.flutter.embedding.engine.FlutterEngine
import io.flutter.plugin.common.MethodCall
import io.flutter.plugin.common.MethodChannel

/**
 * Finds MAXCOM boxes on the Wi-Fi: DNS-SD `_maxcom._tcp` through the system NsdManager (no multicast lock, no extra
 * permission). It only REPORTS what it saw (instance name, an IPv4, the port, the TXT `id` and `ca`): every
 * answer is a hint, since anyone on the network can advertise a service. The Dart side opens a TLS connection to the
 * pinned CA and compares the box id before it trusts anything.
 */
object DiscoveryChannel : MethodChannel.MethodCallHandler {
    private const val NAME = "my.maxcom.app/discovery"
    private const val SERVICE_TYPE = "_maxcom._tcp."
    private const val MAX_RESULTS = 8
    private val IPV4 = Regex("""^\d{1,3}(\.\d{1,3}){3}$""")
    private val main = Handler(Looper.getMainLooper())
    private lateinit var appContext: Context

    fun register(engine: FlutterEngine, context: Context) {
        appContext = context.applicationContext
        MethodChannel(engine.dartExecutor.binaryMessenger, NAME).setMethodCallHandler(this)
    }

    override fun onMethodCall(call: MethodCall, result: MethodChannel.Result) {
        if (call.method != "discover") {
            result.notImplemented()
            return
        }
        val ms = (call.argument<Int>("timeoutMs") ?: 2000).coerceIn(300, 5000)
        discover(ms.toLong(), result)
    }

    private fun txt(info: NsdServiceInfo, key: String): String? {
        val b = info.attributes[key] ?: return null
        return if (b.size > 64) null else String(b, Charsets.UTF_8)
    }

    private fun discover(timeoutMs: Long, result: MethodChannel.Result) {
        val nsd = appContext.getSystemService(Context.NSD_SERVICE) as? NsdManager
        if (nsd == null) {
            result.success(emptyList<Map<String, Any?>>())
            return
        }
        val lock = Any()
        val pending = ArrayDeque<NsdServiceInfo>()
        val seen = HashSet<String>()
        val out = ArrayList<Map<String, Any?>>()
        var resolving = false
        var done = false

        var timer: Runnable? = null

        // Every reply goes through here: one `done` guard, one timer removal, one stopServiceDiscovery.
        fun finish(l: NsdManager.DiscoveryListener?) {
            val list = synchronized(lock) {
                if (done) return
                done = true
                ArrayList(out)
            }
            timer?.let { main.removeCallbacks(it) }
            if (l != null) {
                try {
                    nsd.stopServiceDiscovery(l)
                } catch (_: Exception) {
                    // never started or already stopped
                }
            }
            main.post { result.success(list) }
        }

        fun next() {
            val info = synchronized(lock) {
                if (done || resolving || pending.isEmpty()) return
                resolving = true
                pending.removeFirst()
            }
            @Suppress("DEPRECATION")
            nsd.resolveService(info, object : NsdManager.ResolveListener {
                override fun onResolveFailed(si: NsdServiceInfo, errorCode: Int) {
                    synchronized(lock) { resolving = false }
                    next()
                }

                override fun onServiceResolved(si: NsdServiceInfo) {
                    synchronized(lock) {
                        resolving = false
                        val ip = si.host?.hostAddress
                        // IPv4 only: the box does not advertise AAAA.
                        if (!done && ip != null && IPV4.matches(ip) && out.size < MAX_RESULTS) {
                            out.add(
                                mapOf(
                                    "instance" to si.serviceName,
                                    "ip" to ip,
                                    "port" to si.port,
                                    "id" to txt(si, "id"),
                                    "ca" to txt(si, "ca"),
                                ),
                            )
                        }
                    }
                    next()
                }
            })
        }


        val listener = object : NsdManager.DiscoveryListener {
            override fun onDiscoveryStarted(serviceType: String) {}
            override fun onStartDiscoveryFailed(serviceType: String, errorCode: Int) = finish(this)
            override fun onStopDiscoveryFailed(serviceType: String, errorCode: Int) {}
            override fun onDiscoveryStopped(serviceType: String) {}
            override fun onServiceLost(serviceInfo: NsdServiceInfo) {}
            override fun onServiceFound(serviceInfo: NsdServiceInfo) {
                synchronized(lock) {
                    if (done || !seen.add(serviceInfo.serviceName) || seen.size > 16) return
                    pending.addLast(serviceInfo)
                }
                next()
            }
        }
        val t = Runnable { finish(listener) }
        timer = t
        try {
            nsd.discoverServices(SERVICE_TYPE, NsdManager.PROTOCOL_DNS_SD, listener)
            main.postDelayed(t, timeoutMs)
        } catch (_: Exception) {
            finish(listener)
        }
    }
}
