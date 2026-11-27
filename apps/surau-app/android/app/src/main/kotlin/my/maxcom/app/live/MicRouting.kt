package my.maxcom.app.live

import android.annotation.SuppressLint
import android.content.Context
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

/** A microphone as the app names it: the id is `type:product`, [kind] is `builtin`, `external` or `bluetooth`, [name] the product name. */
data class MicRoute(val id: String, val name: String, val kind: String) {
    val builtin: Boolean get() = kind == KIND_BUILTIN
    val bluetooth: Boolean get() = kind == KIND_BLUETOOTH

    companion object {
        const val KIND_BUILTIN = "builtin"
        const val KIND_EXTERNAL = "external"
        /** A Bluetooth headset microphone (SCO or LE): telephone quality, never picked by "automatic". */
        const val KIND_BLUETOOTH = "bluetooth"

        // AudioDeviceInfo.TYPE_* numbers, kept here so the id rules need no Android class.
        const val TYPE_BUILTIN_MIC = 15
        const val TYPE_BLUETOOTH_SCO = 7
        const val TYPE_BLE_HEADSET = 26

        /** The system's device type inside an id, or null when the id has none. */
        fun typeOfId(id: String): Int? = id.substringBefore(':').toIntOrNull()

        /** The kind an id stands for, from its device type alone. */
        fun kindOfId(id: String): String = when (typeOfId(id)) {
            TYPE_BUILTIN_MIC -> KIND_BUILTIN
            TYPE_BLUETOOTH_SCO, TYPE_BLE_HEADSET -> KIND_BLUETOOTH
            else -> KIND_EXTERNAL
        }

        fun isBluetoothId(id: String?): Boolean = id != null && kindOfId(id) == KIND_BLUETOOTH

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

    // Audio choices the sources read on their own thread (set by the channel; all safe from any thread).

    /** The loudness lift ("Naikkan suara perlahan") of the phone microphone. On by default. */
    @Volatile var liftMic = true
    /** The loudness lift of the camera's own sound. On by default. */
    @Volatile var liftCamera = true
    /** The phone's mute: everything the phone sends is silence (the microphone, the camera sound, Mic-in's reference). */
    @Volatile var muteAll = false

    /** A new live starts unmuted: the phone's mute of an earlier live does not carry over (the engine outlives lives). */
    fun resetForNewLive() {
        muteAll = false
    }
    /** The phone microphone's own volume 0..100 with the phone camera (the external camera mixes it in the mixer). */
    @Volatile var phoneVolume = 100
    /** The application context, for the Bluetooth link below Android 12 (the SCO broadcast). Set by the channel. */
    @Volatile var context: Context? = null

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
     * A device was added or removed: [ids] are the microphones attached now. Re-opens the capture only when that
     * change touches the sound that is running (O3): the microphone in use went away, the wanted one came back, or
     * the device's own microphone is in use and "automatic" now has a wired or USB one to take. Another microphone
     * coming or going (a Bluetooth headset, a second USB one) changes nothing, so the camera sound never stalls. While
     * the routed device is not known yet any change re-opens. The first look only records the set. Main thread.
     */
    fun micsChanged(ids: Set<String>): Boolean {
        val before = micIds
        micIds = ids
        if (before == null || before == ids) return false
        val need = capturePathChanged(before, ids, routed?.id, wantedId)
        if (need) version++
        return need
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

        /** Android 12 and later asks the Bluetooth permission before a Bluetooth microphone is used. */
        fun needsBluetoothPermission(id: String?, sdk: Int): Boolean = sdk >= 31 && MicRoute.isBluetoothId(id)

        /** Pure rule behind [micsChanged]. */
        fun capturePathChanged(before: Set<String>, now: Set<String>, inUse: String?, wanted: String?): Boolean {
            if (inUse == null) return true
            val removed = before - now
            val added = now - before
            if (inUse in removed) return true
            return when (wanted) {
                OWN -> false
                null -> MicRoute.kindOfId(inUse) == MicRoute.KIND_BUILTIN &&
                    added.any { MicRoute.kindOfId(it) == MicRoute.KIND_EXTERNAL }
                else -> wanted != inUse && wanted in added
            }
        }
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
    /** The rate the recorder was opened at: below the engine rate for a Bluetooth microphone (it is resampled). */
    val captureRate: Int = 0,
)

/** Brings the audio link of a Bluetooth microphone up and down. The real one is [AndroidScoLink]; tests use a fake. */
interface ScoLink {
    /** Routes the call audio to the device with [id] and waits for it. False when it could not be brought up. */
    fun connect(id: String): Boolean
    /** Gives the route back. Safe to call when nothing was connected. */
    fun disconnect()
}

object MicOpener {
    /** AudioSource.DEFAULT, MIC, VOICE_RECOGNITION: the order the router tries when the first does not route. */
    val SOURCES = intArrayOf(MediaRecorder.AudioSource.DEFAULT, MediaRecorder.AudioSource.MIC, MediaRecorder.AudioSource.VOICE_RECOGNITION)

    /** AudioSource.VOICE_COMMUNICATION first for a Bluetooth microphone (the system routes the call link for it). */
    val BLUETOOTH_SOURCES = intArrayOf(MediaRecorder.AudioSource.VOICE_COMMUNICATION, MediaRecorder.AudioSource.DEFAULT, MediaRecorder.AudioSource.MIC)

    /** A Bluetooth call link records at 16 kHz (wide band) or 8 kHz (narrow band); the app resamples to the engine rate. */
    val BLUETOOTH_RATES = intArrayOf(16000, 8000)

    /** The microphone to ask for: the chosen one, the device's own, or (automatic) the first wired or USB one attached (never Bluetooth). */
    fun target(wanted: String?, available: List<MicRoute>): String? = when (wanted) {
        null -> available.firstOrNull { !it.builtin && !it.bluetooth }?.id
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

    fun open(
        newPort: () -> RecordPort,
        inputs: () -> List<MicRoute>,
        sampleRate: Int,
        wanted: String?,
        sources: IntArray = SOURCES,
        sco: ScoLink? = null,
    ): MicOpenResult {
        val avail = try { inputs() } catch (_: Exception) { emptyList() }
        val target = target(wanted, avail)
        val attached = target != null && avail.any { it.id == target }
        if (target != null && attached) {
            val bt = MicRoute.isBluetoothId(target)
            // A Bluetooth microphone needs its call link first; without it the recording runs on the default microphone.
            val linked = !bt || (try { sco?.connect(target) } catch (_: Exception) { false } ?: false)
            // A link that did not come up is given back at once (a pending request must not hold the headset).
            if (bt && !linked) {
                try { sco?.disconnect() } catch (_: Exception) {}
            }
            if (linked) {
                val trySources = if (bt) BLUETOOTH_SOURCES else sources
                val rates = if (bt) BLUETOOTH_RATES else intArrayOf(sampleRate)
                for (src in trySources) {
                    for (rate in rates) {
                        val p = newPort()
                        try {
                            if (p.open(src, rate) && p.setPreferred(target) && p.start()) {
                                val r = p.routed()
                                if (r != null && r.id == target) return MicOpenResult(p, r, null, captureRate = rate)
                                // Not said yet is "unknown", not failure: keep the recorder and learn the device later.
                                if (r == null) return MicOpenResult(p, null, null, target, nameOf(target, avail), pending = true, captureRate = rate)
                            }
                        } catch (_: Exception) {
                        }
                        p.close()
                    }
                }
                if (bt) {
                    try { sco?.disconnect() } catch (_: Exception) {}
                }
            }
        }
        val p = newPort()
        val ok = try { p.open(sources[0], sampleRate) && p.start() } catch (_: Exception) { false }
        if (!ok) {
            p.close()
            return MicOpenResult(null, null, null)
        }
        val unavailable = if (target != null && attached) nameOf(target, avail) else null
        return MicOpenResult(p, p.routed(), unavailable, captureRate = sampleRate)
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
        /** The real microphones (built-in, wired, USB, Bluetooth) as `audioInputs` lists them. */
        val MIC_TYPES = setOf(
            AudioDeviceInfo.TYPE_BUILTIN_MIC,
            AudioDeviceInfo.TYPE_WIRED_HEADSET,
            AudioDeviceInfo.TYPE_USB_DEVICE,
            AudioDeviceInfo.TYPE_USB_HEADSET,
            // Bluetooth headsets: the call link (SCO) and, from Android 12, LE Audio headsets
            AudioDeviceInfo.TYPE_BLUETOOTH_SCO,
            AudioDeviceInfo.TYPE_BLE_HEADSET,
        )

        fun routeOf(d: AudioDeviceInfo): MicRoute {
            val builtin = d.type == AudioDeviceInfo.TYPE_BUILTIN_MIC
            val product = d.productName?.toString()?.trim().orEmpty()
            val id = MicRoute.idOf(d.type, product)
            return MicRoute(id, if (builtin) "" else product, MicRoute.kindOfId(id))
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
