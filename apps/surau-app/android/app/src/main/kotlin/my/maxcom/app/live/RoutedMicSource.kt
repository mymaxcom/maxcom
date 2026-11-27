package my.maxcom.app.live

import android.media.AudioManager
import com.pedro.encoder.Frame
import com.pedro.encoder.input.audio.GetMicrophoneData
import com.pedro.encoder.input.sources.audio.AudioSource

/**
 * The phone live's microphone (phone camera): replaces RootEncoder's `MicrophoneSource`, which opens the default
 * microphone and gives no way to read which device the system routed. This one records through [AudioRecordCapture]
 * so the chosen microphone (a 3.5 mm wired headset, USB) is applied with `setPreferredDevice`, the routed device is
 * reported ([MicRouting]) and a plug or unplug re-opens the capture.
 *
 * Mute keeps the stream running and sends silence (as `MicrophoneSource.mute` did). While no capture could be opened
 * silence is sent too, so the audio track stays alive, and the opening is tried again every second.
 */
class RoutedMicSource(
    private val routing: MicRouting,
    private val am: AudioManager? = null,
    private val captureFactory: (rate: Int, echo: Boolean, ns: Boolean) -> PcmCapture = { r, e, n -> AudioRecordCapture(r, e, n, routing, am) },
    private val nowNanos: () -> Long = System::nanoTime,
    private val useAgc: Boolean = true,
) : AudioSource() {
    @Volatile private var muted = false
    @Volatile private var running = false
    private var rate = 44100
    private var stereo = false
    private var echo = false
    private var ns = false
    private var sink: GetMicrophoneData? = null
    private var thread: Thread? = null
    private var lastThread: Thread? = null
    @Volatile private var activeCap: PcmCapture? = null

    /** True while the recording thread is still running (a test reads it after [stop]). */
    val threadAlive: Boolean get() = lastThread?.isAlive == true

    fun mute() {
        muted = true
    }

    fun unMute() {
        muted = false
    }

    fun isMuted(): Boolean = muted

    override fun create(sampleRate: Int, isStereo: Boolean, echoCanceler: Boolean, noiseSuppressor: Boolean): Boolean {
        rate = sampleRate
        stereo = isStereo
        echo = echoCanceler
        ns = noiseSuppressor
        return true
    }

    override fun start(getMicrophoneData: GetMicrophoneData) {
        if (running) return
        sink = getMicrophoneData
        running = true
        thread = Thread({ loop() }, "maxcom-phone-mic").also {
            lastThread = it
            it.isDaemon = true
            it.priority = Thread.MAX_PRIORITY
            it.start()
        }
    }

    private fun loop() {
        val chunk = rate / 50
        val buf = ShortArray(chunk)
        val chunkNanos = chunk.toLong() * 1_000_000_000L / rate
        var cap: PcmCapture? = null
        // Phone / jack / USB microphone only: the speech AGC runs on the raw microphone, then the mute; the encoder
        // (box + local MP4) gets this. It is reset on start, on unmute and after a capture re-open (no stale gain).
        val agc = if (useAgc) SpeechAgc(rate) else null
        var wasMuted = true // the first unmuted chunk starts from a reset AGC
        var wasLift = true
        var seen = routing.version
        var retryAt = 0L
        var next = nowNanos()
        while (running) {
            val v = routing.version
            if (v != seen) {
                seen = v
                retryAt = 0L
                cap?.stop()
                cap = null
                activeCap = null
            }
            if (cap == null && nowNanos() >= retryAt) {
                val c = captureFactory(rate, echo, ns)
                val ok = c.start()
                if (!running) {
                    // stop() came while the open was blocking: never hand the recorder over, release it.
                    if (ok) c.stop()
                    break
                }
                if (ok) {
                    cap = c
                    activeCap = c
                    agc?.reset()
                } else retryAt = nowNanos() + 1_000_000_000L
            }
            var got = false
            val c = cap
            if (c != null) {
                val n = c.read(buf)
                if (n <= 0) {
                    c.stop()
                    cap = null
                    retryAt = nowNanos() + 1_000_000_000L
                } else {
                    if (n < chunk) java.util.Arrays.fill(buf, n, chunk, 0.toShort())
                    got = true
                    // the lift can be switched off by the person; switched on again it starts from a clean state
                    val lift = agc != null && routing.liftMic
                    if (lift && !wasLift) agc!!.reset()
                    wasLift = lift
                    if (agc != null) {
                        if (muted) {
                            wasMuted = true
                        } else {
                            if (wasMuted) {
                                agc.reset()
                                wasMuted = false
                            }
                            if (lift) agc.process(buf, 0, chunk)
                        }
                    }
                    val vol = routing.phoneVolume
                    if (vol < 100) {
                        val g = vol.coerceIn(0, 100) / 100f
                        for (k in 0 until chunk) buf[k] = (buf[k] * g).toInt().toShort()
                    }
                }
                next = nowNanos()
            }
            if (!got) {
                java.util.Arrays.fill(buf, 0.toShort())
            } else if (muted || routing.muteAll) {
                // the phone's mute: silence, whichever way it was asked for
                java.util.Arrays.fill(buf, 0.toShort())
            }
            deliver(buf, chunk)
            if (!got) {
                next += chunkNanos
                val wait = next - nowNanos()
                if (wait > 0) {
                    try {
                        Thread.sleep(wait / 1_000_000, (wait % 1_000_000).toInt())
                    } catch (_: InterruptedException) {
                        break
                    }
                } else if (wait < -200_000_000L) {
                    next = nowNanos()
                }
            }
        }
        cap?.stop()
        activeCap = null
    }

    private fun deliver(pcm: ShortArray, n: Int) {
        val ch = if (stereo) 2 else 1
        val bytes = ByteArray(n * 2 * ch)
        var p = 0
        for (i in 0 until n) {
            val v = pcm[i].toInt()
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
                // A blocking open (each source x a 300 ms routed() poll) can hold the thread for about 1.2 s.
                it.join(STOP_WAIT_MS)
                // A read that does not react to the interrupt: closing the recorder frees it, so the thread ends here.
                if (it.isAlive) {
                    try { activeCap?.stop() } catch (_: Exception) {}
                    it.join(500)
                }
            } catch (_: InterruptedException) {
            }
        }
        thread = null
    }

    override fun isRunning(): Boolean = running

    companion object {
        const val STOP_WAIT_MS = 2500L
    }

    override fun release() {
        stop()
    }
}
