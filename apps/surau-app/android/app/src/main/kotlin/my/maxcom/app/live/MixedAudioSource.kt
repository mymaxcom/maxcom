package my.maxcom.app.live

import android.media.AudioManager
import android.media.audiofx.AcousticEchoCanceler
import android.media.audiofx.NoiseSuppressor
import com.pedro.encoder.Frame
import com.pedro.encoder.input.audio.GetMicrophoneData
import com.pedro.encoder.input.sources.audio.AudioSource
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit
import kotlin.math.abs
import kotlin.math.max
import kotlin.math.min

/* The phone's mixed sound for a live with an external camera (plan rev 4, 3.2, 4.3a, 4.5).

   reference = the camera's own audio (RtspAudioSource, decoded PCM at the engine rate), never delayed;
   added      = the phone microphone, through a delay line whose length AudioAligner sets (closed loop: the aligner is
                fed the reference and the added source AFTER its delay, from a worker thread, so a tick of analysis
                never runs on the mixing thread);
   gains      = one per source (0..100), applied after the delay, changed with a short ramp (no click);
   hold-out   = while the camera sound is audible (volume above 0) the added source is silent in the mix until the
                aligner first reports LOCKED (or MANUAL); it then fades in over about half a second. With the camera
                volume at 0 ("mic only", "Guna <sumber> sahaja") the added source plays at once;
   camera back = after a camera loss the added microphone keeps playing at its last delay and the camera sound rejoins
                after the NEW lock (the aligner is reset);
   no camera audio = the aligner is put in MANUAL with the fixed offset ("Imbangan masa audio"); the microphone plays
                alone through that delay.
   MixerCore is JVM-pure (no Android); MixedAudioSource is the RootEncoder AudioSource around it. */

/** A circular delay on 16-bit PCM; the delay can change while running (the aligner moves it in small steps). */
class DelayLine(private val maxDelaySamples: Int) {
    private val buf = ShortArray(maxDelaySamples + 1)
    private var w = 0

    @Volatile var delaySamples = 0
        set(v) {
            field = v.coerceIn(0, maxDelaySamples)
        }

    /** Writes [input] and fills [out] (same length) with the samples [delaySamples] earlier. */
    fun process(input: ShortArray, out: ShortArray) {
        val d = delaySamples
        val n = buf.size
        for (i in input.indices) {
            buf[w] = input[i]
            out[i] = buf[((w - d) % n + n) % n]
            w = (w + 1) % n
        }
    }

    fun clear() {
        java.util.Arrays.fill(buf, 0.toShort())
    }
}

/** Linear gain ramp: moves to a new target over [rampMs]. */
class GainRamp(private val sampleRate: Int, initial: Float = 0f) {
    var current = initial
        private set
    private var target = initial
    private var step = 0f

    fun setTarget(t: Float, rampMs: Int) {
        if (t == target) return
        target = t
        val samples = max(1, (rampMs.toLong() * sampleRate / 1000).toInt())
        step = (t - current) / samples
    }

    fun next(): Float {
        if (current != target) {
            current += step
            if ((step > 0 && current >= target) || (step < 0 && current <= target) || step == 0f) current = target
        }
        return current
    }

    val targetValue: Float get() = target
}

/** Box-average decimation by an integer factor (the aligner works at a lower rate). Carries a partial group. */
class Decimator(private val factor: Int) {
    private var acc = 0
    private var cnt = 0

    fun process(input: ShortArray): ShortArray {
        if (factor <= 1) return input
        val out = ShortArray((input.size + cnt) / factor)
        var o = 0
        for (s in input) {
            acc += s
            if (++cnt == factor) {
                out[o++] = (acc / factor).toShort()
                acc = 0
                cnt = 0
            }
        }
        return out
    }
}

class MixLevels(@Volatile var camera: Float = 0f, @Volatile var mic: Float = 0f, @Volatile var mixed: Float = 0f)

/** The mix. One call per chunk; no allocation inside. */
class MixerCore(
    val sampleRate: Int,
    maxDelayMs: Int = AudioAligner.MAX_DELAY_MS,
    initialDelayMs: Int = AudioAligner.DEFAULT_INITIAL_DELAY_MS,
) {
    private val delayLine = DelayLine((maxDelayMs.toLong() * sampleRate / 1000).toInt())
    private val camGain = GainRamp(sampleRate, 1f)
    private val micGain = GainRamp(sampleRate, 0f)
    private var delayedBuf = ShortArray(0)

    /**
     * Speech AGC on the RAW microphone (after the delay, before the user's volume, so the slider still works and 0%
     * stays exact silence). Null = off (tests).
     */
    @Volatile var micAgc: SpeechAgc? = null

    /** Peak limiter (-1 dBFS) on the SUM of camera and microphone. Null = off (tests): the sum is only clamped. */
    @Volatile var sumLimiter: PeakLimiter? = null

    @Volatile var cameraVolume = 100
        set(v) {
            field = v.coerceIn(0, 100)
        }
    @Volatile var micVolume = 100
        set(v) {
            field = v.coerceIn(0, 100)
        }
    @Volatile var micEnabled = false
        set(v) {
            // A source added again starts a new search and stays out of the mix until it is aligned (the old delay stays
            // as the starting point); the manual offset applies as it is.
            if (v && !field && alignState != AlignState.MANUAL) {
                micAligned = false
                alignState = AlignState.SEARCHING
            }
            field = v
        }

    /** The camera announced an audio track we decode. False with [cameraKnown] true = a camera with no audio (manual). */
    @Volatile var cameraHasAudio = false
    /** The camera's format is known (its SDP was read). Before that the camera is assumed to have audio (no early leak). */
    @Volatile var cameraKnown = false
    /** The unit has no camera at all (phone camera with its own mic): nothing to hold the microphone out against. */
    @Volatile var hasCamera = true

    @Volatile var alignState = AlignState.SEARCHING
        private set
    /** The microphone has been locked (or manual) at least once: it is let into the mix. */
    @Volatile var micAligned = false
        private set
    /** The camera sound waits for a new lock after a loss. */
    @Volatile var cameraRejoinPending = false
        private set

    private var lastCameraLive = false
    private var cameraWasLost = false
    private var lastMicHeld = true
    private var lastMicOn = false
    private var lastCamHeld = false

    init {
        setDelayMs(initialDelayMs)
    }

    fun setDelayMs(ms: Int) {
        delayLine.delaySamples = (ms.toLong() * sampleRate / 1000).toInt()
    }

    val delayMs: Int get() = (delayLine.delaySamples.toLong() * 1000 / sampleRate).toInt()

    fun onAlignState(st: AlignState) {
        alignState = st
        if (st == AlignState.LOCKED || st == AlignState.MANUAL) {
            micAligned = true
            cameraRejoinPending = false
        }
    }

    /** True while the added source must be silent: camera sound audible, not yet aligned. */
    fun micHeldOut(): Boolean {
        if (!micEnabled || !hasCamera) return false
        val cameraAudible = (!cameraKnown || cameraHasAudio) && cameraVolume > 0
        return cameraAudible && !micAligned
    }

    /** The camera audio stopped or came back (transition seen by the mixer thread). */
    private fun cameraTransition(live: Boolean) {
        if (!live && lastCameraLive) cameraWasLost = true
        if (live && !lastCameraLive && cameraWasLost) {
            cameraWasLost = false
            if (micEnabled && micAligned && cameraKnown && cameraHasAudio && cameraVolume > 0) {
                cameraRejoinPending = true
                onCameraReturned?.invoke()
            }
        }
        lastCameraLive = live
    }

    /** Called (mixer thread) when the camera sound returned after a loss and a new search starts. */
    var onCameraReturned: (() -> Unit)? = null

    /**
     * Mixes one chunk. [ref] = camera PCM (zeros when none), [mic] = microphone PCM or null when it is off.
     * [out] = the mix, [delayedOut] = the microphone after its delay (what the aligner compares with [ref]).
     * Returns false when the added source is off (nothing to align).
     */
    fun mix(ref: ShortArray, cameraLive: Boolean, mic: ShortArray?, out: ShortArray, delayedOut: ShortArray, levels: MixLevels?): Boolean {
        val n = out.size
        cameraTransition(cameraLive)
        val micOn = mic != null && micEnabled
        // A microphone coming back must not play the stale tail of the delay line first.
        if (micOn && !lastMicOn) {
            delayLine.clear()
            micAgc?.reset()
        }
        lastMicOn = micOn
        if (mic != null && micOn) delayLine.process(mic, delayedOut) else java.util.Arrays.fill(delayedOut, 0, n, 0.toShort())

        val micHeld = micHeldOut()
        val camHeld = cameraRejoinPending
        val camTarget = if (camHeld) 0f else cameraVolume / 100f
        val micTarget = if (micOn && !micHeld) micVolume / 100f else 0f
        camGain.setTarget(camTarget, if (lastCamHeld != camHeld) FADE_IN_MS else GAIN_RAMP_MS)
        micGain.setTarget(micTarget, if (lastMicHeld != micHeld) FADE_IN_MS else GAIN_RAMP_MS)
        lastCamHeld = camHeld
        lastMicHeld = micHeld

        var pc = 0
        var pm = 0
        var po = 0
        val agc = micAgc
        val lim = sumLimiter
        for (i in 0 until n) {
            val r = ref[i].toInt()
            val d = delayedOut[i].toInt()
            // delay -> AGC on the raw microphone -> user volume / hold-out ramp -> sum with the camera -> limiter on the sum
            val leveled = if (agc != null) agc.processSample(d.toFloat()) else d.toFloat()
            val m = leveled * micGain.next()
            var mix = r * camGain.next() + m
            if (lim != null) mix = lim.process(mix)
            val s = Math.round(mix).coerceIn(-32768, 32767)
            out[i] = s.toShort()
            pc = max(pc, abs(r))
            pm = max(pm, abs(d))
            po = max(po, abs(s))
        }
        if (levels != null) {
            levels.camera = pc / 32768f
            levels.mic = pm / 32768f
            levels.mixed = po / 32768f
        }
        return micOn
    }

    companion object {
        const val FADE_IN_MS = 500
        const val GAIN_RAMP_MS = 40
    }
}

/** A blocking microphone reader. The real one is [AudioRecordCapture]; tests use a fake. */
interface PcmCapture {
    fun start(): Boolean
    /** Fills [out] completely (blocks for the audio clock). Returns the number of samples read, or <= 0 on error. */
    fun read(out: ShortArray): Int
    fun stop()
}

class AudioRecordCapture(
    private val sampleRate: Int,
    private val echo: Boolean,
    private val ns: Boolean,
    private val routing: MicRouting? = null,
    private val am: AudioManager? = null,
    private val portFactory: () -> RecordPort = { AudioRecordPort(am) },
    private val inputs: () -> List<MicRoute> = { AudioRecordPort.inputs(am) },
) : PcmCapture {
    private var port: RecordPort? = null
    private var aec: AcousticEchoCanceler? = null
    private var nsEff: NoiseSuppressor? = null

    override fun start(): Boolean {
        var opened: RecordPort? = null
        return try {
            val res = MicOpener.open(portFactory, inputs, sampleRate, routing?.wantedId)
            val p = res.port ?: return false
            opened = p
            try {
                if (echo && AcousticEchoCanceler.isAvailable()) aec = AcousticEchoCanceler.create(p.sessionId)?.also { it.enabled = true }
                if (ns && NoiseSuppressor.isAvailable()) nsEff = NoiseSuppressor.create(p.sessionId)?.also { it.enabled = true }
            } catch (_: Exception) {
            }
            port = p
            routing?.report(res.routed, res.unavailableName)
            if (res.pending && routing != null) {
                // The system has not named the device yet: judge it when it does (null is "unknown", never a failure).
                var last: String? = null
                p.setOnRoutedChanged { r ->
                    if (r != null && r.id != last) {
                        last = r.id
                        routing.report(r, MicOpener.unavailableFor(res.target, res.targetName, r))
                    }
                }
            }
            true
        } catch (_: Exception) {
            // Opened but not finished: release the recorder and effects so nothing leaks.
            if (port != null) {
                stop()
            } else {
                try {
                    opened?.close()
                } catch (_: Exception) {
                }
                stop() // the effects, if any were created
            }
            false
        }
    }

    override fun read(out: ShortArray): Int {
        val r = port ?: return -1
        var got = 0
        while (got < out.size) {
            val n = r.read(out, got, out.size - got)
            if (n <= 0) return if (got > 0) got else n
            got += n
        }
        return got
    }

    override fun stop() {
        try {
            port?.close()
        } catch (_: Exception) {
        }
        try {
            aec?.release()
        } catch (_: Exception) {
        }
        try {
            nsEff?.release()
        } catch (_: Exception) {
        }
        port = null
        aec = null
        nsEff = null
    }
}

/**
 * RootEncoder AudioSource (2.8.1: create / start(GetMicrophoneData) / stop / isRunning / release) that delivers the mix.
 *
 * [camera] is null for a phone-camera live that only needs the microphone path (no hold-out then). [aligner] is built by
 * the caller with the engine's rate or a divisor of it ([alignerRate], default 16 kHz: the mix is box-averaged down for
 * the aligner). Its onChange is taken over here: the new delay goes to the delay line and the state to the mix, and
 * [onAlignChange] is called for the screen (aligner thread).
 */
class MixedAudioSource(
    private val camera: RtspAudioSource?,
    private val aligner: AudioAligner?,
    private val alignerRate: Int = 16000,
    private val routing: MicRouting? = null,
    private val am: AudioManager? = null,
    private val captureFactory: (rate: Int, echo: Boolean, ns: Boolean) -> PcmCapture = { r, e, n -> AudioRecordCapture(r, e, n, routing, am) },
    private val nowNanos: () -> Long = System::nanoTime,
    private val useAgc: Boolean = true,
) : AudioSource() {
    @Volatile var onAlignChange: ((AlignState, Int) -> Unit)? = null
    /** The fixed offset ("Imbangan masa audio") used when the camera has no audio track. */
    @Volatile var manualOffsetMs: Int = 0
        private set

    val levels = MixLevels()
    @Volatile var micFailed = false
        private set
    @Volatile var droppedAlignChunks = 0
        private set

    private class AlignChunk(val ref: ShortArray, val added: ShortArray)
    private class AlignCommand(val manualOffsetMs: Int?, val reset: Boolean)

    /** Everything that touches the aligner goes through this queue to ONE worker thread (AudioAligner is single-caller). */
    private val alignQueue = LinkedBlockingQueue<Any>()

    private var core: MixerCore? = null
    private var thread: Thread? = null
    private var alignThread: Thread? = null
    @Volatile private var running = false
    private var sink: GetMicrophoneData? = null
    private var capture: PcmCapture? = null
    private var rate = 48000
    private var stereo = false
    @Volatile private var manualApplied = false

    /** The mixing core (read-only use: the screen reads states and levels). */
    val mixer: MixerCore? get() = core

    fun setCameraVolume(percent: Int) {
        core?.cameraVolume = percent
        pendingCamVol = percent
    }

    fun setMicVolume(percent: Int) {
        core?.micVolume = percent
        pendingMicVol = percent
    }

    /** Adds or removes the phone microphone during the live. An added one starts a new search. */
    fun setMicEnabled(on: Boolean) {
        pendingMicOn = on
        core?.micEnabled = on
        if (on) {
            micFailed = false
            alignQueue.offer(AlignCommand(null, true))
        }
    }

    /** Moves the fixed offset while it applies (a camera with no audio track): "Imbangan masa audio". */
    fun setManualOffsetMs(ms: Int) {
        manualOffsetMs = ms
        if (manualApplied) alignQueue.offer(AlignCommand(ms, false)) else core?.let { if (it.cameraKnown && !it.cameraHasAudio) it.setDelayMs(ms) }
    }

    @Volatile private var pendingCamVol = 100
    @Volatile private var pendingMicVol = 100
    @Volatile private var pendingMicOn = false

    override fun create(sampleRate: Int, isStereo: Boolean, echoCanceler: Boolean, noiseSuppressor: Boolean): Boolean {
        rate = sampleRate
        stereo = isStereo
        val c = MixerCore(sampleRate, initialDelayMs = if (camera == null) 0 else (aligner?.delayMs ?: AudioAligner.DEFAULT_INITIAL_DELAY_MS))
        c.cameraVolume = pendingCamVol
        c.micVolume = pendingMicVol
        c.micEnabled = pendingMicOn
        c.hasCamera = camera != null
        c.micAgc = if (useAgc) SpeechAgc(sampleRate) else null
        c.sumLimiter = if (useAgc) PeakLimiter(sampleRate) else null
        core = c
        aligner?.onChange = { st, d ->
            c.setDelayMs(d)
            c.onAlignState(st)
            onAlignChange?.invoke(st, d)
        }
        c.onCameraReturned = { alignQueue.offer(AlignCommand(null, true)) }
        return true
    }

    override fun start(getMicrophoneData: GetMicrophoneData) {
        if (running) return
        val c = core ?: return
        sink = getMicrophoneData
        running = true
        val factor = if (alignerRate > 0 && rate % alignerRate == 0) rate / alignerRate else 1
        val al = aligner
        if (al != null) {
            alignThread = Thread({
                try {
                    while (running) {
                        when (val p = alignQueue.poll(200, TimeUnit.MILLISECONDS) ?: continue) {
                            is AlignChunk -> al.push(p.ref, p.added)
                            is AlignCommand -> if (p.manualOffsetMs != null) al.setManual(p.manualOffsetMs) else if (p.reset) al.reset()
                        }
                    }
                } catch (_: InterruptedException) {
                }
            }, "maxcom-align").also {
                it.isDaemon = true
                it.start()
            }
        }
        thread = Thread({ loop(c, factor) }, "maxcom-mix").also {
            it.isDaemon = true
            it.priority = Thread.MAX_PRIORITY
            it.start()
        }
    }

    private fun loop(c: MixerCore, factor: Int) {
        val chunk = max(factor, rate / 50 / factor * factor)
        val ref = ShortArray(chunk)
        val micBuf = ShortArray(chunk)
        val out = ShortArray(chunk)
        val delayed = ShortArray(chunk)
        val refDec = Decimator(factor)
        val micDec = Decimator(factor)
        val chunkNanos = chunk.toLong() * 1_000_000_000L / rate
        var next = nowNanos()
        var micOn = false
        var routeSeen = routing?.version ?: 0
        while (running) {
            // A microphone plugged or unplugged, or another one chosen: open the capture again on the right device.
            val rv = routing?.version ?: 0
            if (rv != routeSeen) {
                routeSeen = rv
                micFailed = false
                if (micOn) {
                    capture?.stop()
                    capture = null
                    micOn = false
                }
            }
            // The microphone follows the switch: opened when added, released when removed.
            if (c.micEnabled && !micOn && !micFailed) {
                val cap = captureFactory(rate, echoCanceler, noiseSuppressor)
                if (cap.start()) {
                    capture = cap
                    micOn = true
                } else {
                    micFailed = true
                }
            } else if (!c.micEnabled && micOn) {
                capture?.stop()
                capture = null
                micOn = false
            }

            var mic: ShortArray? = null
            if (micOn) {
                val n = capture!!.read(micBuf)
                if (n == chunk) mic = micBuf else if (n <= 0) {
                    capture?.stop()
                    capture = null
                    micOn = false
                    micFailed = true
                    continue
                } else {
                    java.util.Arrays.fill(micBuf, n, chunk, 0.toShort())
                    mic = micBuf
                }
                next = nowNanos()
            }

            val cam = camera
            val live = cam?.read(ref) ?: false
            if (cam == null) java.util.Arrays.fill(ref, 0.toShort())
            if (cam != null) {
                c.cameraKnown = cam.formatKnown
                c.cameraHasAudio = cam.hasAudio
                if (cam.formatKnown && cam.hasAudio && manualApplied) {
                    // The camera came back with a sound track: leave the fixed offset and search again.
                    manualApplied = false
                    alignQueue.offer(AlignCommand(null, true))
                }
                if (cam.formatKnown && !cam.hasAudio && !manualApplied) {
                    manualApplied = true
                    if (aligner != null) {
                        alignQueue.offer(AlignCommand(manualOffsetMs, false))
                    } else {
                        c.setDelayMs(manualOffsetMs)
                        c.onAlignState(AlignState.MANUAL)
                    }
                }
            }

            val aligning = c.mix(ref, live, mic, out, delayed, levels)
            if (aligning && aligner != null && c.cameraHasAudio && !manualApplied) {
                val a = refDec.process(ref.copyOf())
                val b = micDec.process(delayed.copyOf())
                if (alignQueue.size < 60) alignQueue.offer(AlignChunk(a, b)) else droppedAlignChunks++
            }
            deliver(out, chunk)

            if (!micOn) {
                next += chunkNanos
                val wait = next - nowNanos()
                if (wait > 0) {
                    try {
                        Thread.sleep(wait / 1_000_000, (wait % 1_000_000).toInt())
                    } catch (_: InterruptedException) {
                        return
                    }
                } else if (wait < -200_000_000L) {
                    next = nowNanos()
                }
            }
        }
        capture?.stop()
        capture = null
    }

    private fun deliver(mixed: ShortArray, n: Int) {
        val ch = if (stereo) 2 else 1
        val bytes = ByteArray(n * 2 * ch)
        var p = 0
        for (i in 0 until n) {
            val v = mixed[i].toInt()
            for (k in 0 until ch) {
                bytes[p++] = (v and 0xFF).toByte()
                bytes[p++] = ((v shr 8) and 0xFF).toByte()
            }
        }
        sink?.inputPCMData(Frame(bytes, 0, bytes.size, nowNanos() / 1000))
    }

    override fun stop() {
        running = false
        thread?.let {
            it.interrupt()
            try {
                it.join(1000)
            } catch (_: InterruptedException) {
            }
        }
        alignThread?.let {
            it.interrupt()
            try {
                it.join(1000)
            } catch (_: InterruptedException) {
            }
        }
        thread = null
        alignThread = null
    }

    override fun isRunning(): Boolean = running

    override fun release() {
        stop()
        aligner?.onChange = null
        alignQueue.clear()
        core = null
    }
}
