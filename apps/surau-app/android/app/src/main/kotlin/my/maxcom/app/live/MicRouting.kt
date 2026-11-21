package my.maxcom.app.live

import android.annotation.SuppressLint
import android.media.AudioDeviceInfo
import android.media.AudioFormat
import android.media.AudioManager
import android.media.AudioRecord
import android.media.AudioRouting
import android.media.MediaRecorder
import android.os.Handler
import android.os.Looper

/* Which microphone the live really records from (CRITICAL fix, 21 Nov 2026).

   Before: AudioRecord(AudioSource.DEFAULT) with no device chosen. Android routes a USB microphone by itself but usually
   keeps the built-in one for a 3.5 mm wired headset microphone, so the person's microphone was never used.

   Now: the wanted microphone (its `type:product` id, the same id `audioInputs` lists) is set with
   `AudioRecord.setPreferredDevice` before `startRecording()`, the device the system really routed is read back
   (`routedDevice`) and reported, a refusal is retried with `AudioSource.MIC` then `VOICE_RECOGNITION`, and when none
   routes the app is told so (it says so in words); the recording then runs on the default microphone and the app is told
   which one. Plugging or unplugging a microphone during the live re-opens the capture (`MicRouting.devicesChanged`).
   Everything below `AudioRecordPort` is JVM-pure so it is unit tested with a fake port. */

/** A microphone as the app names it: the id is `type:product`, [kind] is `builtin` or `external`, [name] the product name. */
data class MicRoute(val id: String, val name: String, val kind: String) {
    val builtin: Boolean get() = kind == KIND_BUILTIN

    companion object {
        const val KIND_BUILTIN = "builtin"
        const val KIND_EXTERNAL = "external"

        fun idOf(type: Int, product: String) = "$type:$product"

        /** The product name part of an id, for a message; empty when the id has none. */
        fun nameOfId(id: String): String = id.substringAfter(':', "").trim()
    }
}

/** One `AudioRecord` as the router needs it. The real one is [AudioRecordPort]; tests use a fake. */
interface RecordPort {
    /** Creates the recorder on [source]. False when it could not be initialised. */
    fun open(source: Int, sampleRate: Int): Boolean
    val sessionId: Int
    /** Asks the system to record from the device with [id]. False when it has no such device or refused. */
    fun setPreferred(id: String): Boolean
    fun start(): Boolean
    /** The device the system routes the recording to now; null when it has not said (yet). */
    fun routed(): MicRoute?
    fun read(out: ShortArray, off: Int, len: Int): Int
    fun close()

    /**
     * Calls [cb] (any thread) with the device the system routes to, now and whenever it changes. Some phones answer
     * [routed] with null for a while after the start; this is how the app learns the device later. Default: never.
     */
    fun setOnRoutedChanged(cb: ((MicRoute?) -> Unit)?) {}
}

/** What the person (the app) wants, shared by the sources and the engine. All members are safe from any thread. */
class MicRouting {
    @Volatile var wantedId: String? = null
        private set
    /** Goes up on every change that needs the capture opened again (a new choice, a plugged or unplugged device). */
    @Volatile var version = 0
        private set
    @Volatile var routed: MicRoute? = null
        private set
    /** The name of the microphone that was wanted but could not be routed; null when all is as wanted. */
    @Volatile var unavailableName: String? = null
        private set

    /** Called (capture thread) after every open with the device really routed and the one that could not be used. */
    @Volatile var onRouted: ((routed: MicRoute?, unavailableName: String?) -> Unit)? = null

    /** [id] = a `type:product` id, [OWN] = the device's own microphone, null = the best attached one (automatic). */
    fun prefer(id: String?) {
        if (id != wantedId) {
            wantedId = id
            version++
        }
    }

    fun devicesChanged() {
        version++
    }

    /** The microphone ids attached at the last look (main thread only); null until the first look. */
    private var micIds: Set<String>? = null

    /**
     * A device was added or removed: [ids] are the microphones attached now. Re-opens the capture only when that set
     * really changed (a Bluetooth SCO link or a remote submix coming and going is not a microphone). The first look
     * only records the set. Main thread.
     */
    fun micsChanged(ids: Set<String>): Boolean {
        val before = micIds
        micIds = ids
        if (before == null || before == ids) return false
        version++
        return true
    }

    /** Records the microphones attached at start-up, so the first plug is compared with them. Main thread. */
    fun seedMics(ids: Set<String>) {
        micIds = ids
    }

    fun report(r: MicRoute?, unavailable: String?) {
        routed = r
        unavailableName = unavailable
        onRouted?.invoke(r, unavailable)
    }

    companion object {
        const val OWN = "own"
    }
}

/**
 * [routed] is null when the system has not said yet (not a failure): [pending] is then true and [target] / [targetName]
 * say what was asked, so the late answer can be judged with [MicOpener.unavailableFor].
 */
class MicOpenResult(
    val port: RecordPort?,
    val routed: MicRoute?,
    val unavailableName: String?,
    val target: String? = null,
    val targetName: String = "",
    val pending: Boolean = false,
)

object MicOpener {
    /** AudioSource.DEFAULT, MIC, VOICE_RECOGNITION: the order the router tries when the first does not route. */
    val SOURCES = intArrayOf(MediaRecorder.AudioSource.DEFAULT, MediaRecorder.AudioSource.MIC, MediaRecorder.AudioSource.VOICE_RECOGNITION)

    /** The microphone to ask for: the chosen one, the device's own, or (automatic) the first external one attached. */
    fun target(wanted: String?, available: List<MicRoute>): String? = when (wanted) {
        null -> available.firstOrNull { !it.builtin }?.id
        MicRouting.OWN -> available.firstOrNull { it.builtin }?.id
        else -> wanted
    }

    /**
     * Opens a recorder on the wanted microphone. [inputs] lists the microphones attached now. Never throws.
     * The result's [MicOpenResult.unavailableName] is set when a microphone that IS attached could not be routed to
     * (the recording then runs on the default one); a wanted microphone that is simply not attached any more is not
     * "unavailable": the app already tells the person it was unplugged.
     */
    /** The name to report when the system routed [routed] although [target] was asked for; null when it is the one asked (or unknown). */
    fun unavailableFor(target: String?, targetName: String, routed: MicRoute?): String? =
        if (target != null && routed != null && routed.id != target) targetName else null

    fun open(newPort: () -> RecordPort, inputs: () -> List<MicRoute>, sampleRate: Int, wanted: String?, sources: IntArray = SOURCES): MicOpenResult {
        val avail = try { inputs() } catch (_: Exception) { emptyList() }
        val target = target(wanted, avail)
        val attached = target != null && avail.any { it.id == target }
        if (target != null && attached) {
            for (src in sources) {
                val p = newPort()
                try {
                    if (p.open(src, sampleRate) && p.setPreferred(target) && p.start()) {
                        val r = p.routed()
                        if (r != null && r.id == target) return MicOpenResult(p, r, null)
                        // Not said yet is "unknown", not failure: keep the recorder and learn the device later.
                        if (r == null) return MicOpenResult(p, null, null, target, nameOf(target, avail), pending = true)
                    }
                } catch (_: Exception) {
                }
                p.close()
            }
        }
        val p = newPort()
        val ok = try { p.open(sources[0], sampleRate) && p.start() } catch (_: Exception) { false }
        if (!ok) {
            p.close()
            return MicOpenResult(null, null, null)
        }
        val unavailable = if (target != null && attached) nameOf(target, avail) else null
        return MicOpenResult(p, p.routed(), unavailable)
    }

    private fun nameOf(target: String, avail: List<MicRoute>): String =
        MicRoute.nameOfId(target).ifEmpty { avail.firstOrNull { it.id == target }?.name.orEmpty() }
}

/** The real recorder. [am] lists and resolves the devices. */
class AudioRecordPort(private val am: AudioManager?) : RecordPort {
    private var rec: AudioRecord? = null

    @SuppressLint("MissingPermission")
    override fun open(source: Int, sampleRate: Int): Boolean {
        val minBuf = AudioRecord.getMinBufferSize(sampleRate, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT)
        if (minBuf <= 0) return false
        val r = AudioRecord(source, sampleRate, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT, minBuf * 4)
        if (r.state != AudioRecord.STATE_INITIALIZED) {
            r.release()
            return false
        }
        rec = r
        return true
    }

    override val sessionId: Int get() = rec?.audioSessionId ?: 0

    override fun setPreferred(id: String): Boolean {
        val r = rec ?: return false
        val d = inputDevices(am).firstOrNull { routeOf(it).id == id } ?: return false
        return r.setPreferredDevice(d)
    }

    override fun start(): Boolean {
        val r = rec ?: return false
        r.startRecording()
        return r.recordingState == AudioRecord.RECORDSTATE_RECORDING
    }

    override fun routed(): MicRoute? {
        val r = rec ?: return null
        // The system names the device a moment after the start.
        for (i in 0 until 12) {
            r.routedDevice?.let { return routeOf(it) }
            try { Thread.sleep(25) } catch (_: InterruptedException) { return null }
        }
        return null
    }

    override fun read(out: ShortArray, off: Int, len: Int): Int = rec?.read(out, off, len) ?: -1

    private var routingListener: AudioRouting.OnRoutingChangedListener? = null

    override fun setOnRoutedChanged(cb: ((MicRoute?) -> Unit)?) {
        val r = rec ?: return
        routingListener?.let { try { r.removeOnRoutingChangedListener(it) } catch (_: Exception) {} }
        routingListener = null
        if (cb == null) return
        val l = AudioRouting.OnRoutingChangedListener { rr -> cb(rr.routedDevice?.let { routeOf(it) }) }
        routingListener = l
        try {
            r.addOnRoutingChangedListener(l, Handler(Looper.getMainLooper()))
            // it may already be known: tell once now without waiting
            r.routedDevice?.let { cb(routeOf(it)) }
        } catch (_: Exception) {
        }
    }

    override fun close() {
        routingListener?.let { try { rec?.removeOnRoutingChangedListener(it) } catch (_: Exception) {} }
        routingListener = null
        try { rec?.stop() } catch (_: Exception) {}
        try { rec?.release() } catch (_: Exception) {}
        rec = null
    }

    companion object {
        /** The real microphones (built-in, wired, USB) as `audioInputs` lists them. */
        val MIC_TYPES = setOf(
            AudioDeviceInfo.TYPE_BUILTIN_MIC,
            AudioDeviceInfo.TYPE_WIRED_HEADSET,
            AudioDeviceInfo.TYPE_USB_DEVICE,
            AudioDeviceInfo.TYPE_USB_HEADSET,
        )

        fun routeOf(d: AudioDeviceInfo): MicRoute {
            val builtin = d.type == AudioDeviceInfo.TYPE_BUILTIN_MIC
            val product = d.productName?.toString()?.trim().orEmpty()
            return MicRoute(MicRoute.idOf(d.type, product), if (builtin) "" else product, if (builtin) MicRoute.KIND_BUILTIN else MicRoute.KIND_EXTERNAL)
        }

        fun inputDevices(am: AudioManager?): List<AudioDeviceInfo> =
            am?.getDevices(AudioManager.GET_DEVICES_INPUTS)?.filter { it.isSource && it.type in MIC_TYPES } ?: emptyList()

        fun inputs(am: AudioManager?): List<MicRoute> = inputDevices(am).map { routeOf(it) }.distinctBy { it.id }

        /** A plain 3-pole plug in a 4-pole jack shows as headphones with no microphone: the person needs a TRRS plug. */
        fun headphonesWithoutMic(am: AudioManager?): Boolean {
            if (am == null) return false
            val out = am.getDevices(AudioManager.GET_DEVICES_OUTPUTS).any { it.type == AudioDeviceInfo.TYPE_WIRED_HEADPHONES }
            val mic = am.getDevices(AudioManager.GET_DEVICES_INPUTS).any { it.type == AudioDeviceInfo.TYPE_WIRED_HEADSET }
            return out && !mic
        }
    }
}
