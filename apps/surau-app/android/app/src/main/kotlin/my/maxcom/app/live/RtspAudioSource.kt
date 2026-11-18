package my.maxcom.app.live

import android.media.MediaCodec
import android.media.MediaCodecInfo
import android.media.MediaFormat
import java.nio.ByteBuffer
import kotlin.math.max
import kotlin.math.min

/* The camera's own sound on the phone (plan rev 4, 3.1 and 4.5): AAC or G.711 samples from the RTSP client are decoded
   to mono 16-bit PCM, resampled to the engine's rate and kept in a small jitter ring. [MixedAudioSource] pulls fixed
   chunks out of the ring on its own clock (the reference of the mix). "Released in step with the picture": the video
   decoder shows each frame as it is decoded, so the sound is held back by the same small constant (prebuffer plus
   [syncOffsetMs], the value T0 item 5 measures on the real camera) and both leave the phone together. Pure JVM except
   [AacMediaCodecDecoder]. */

enum class CameraAudioCodec { NONE, AAC, G711_ALAW, G711_ULAW, UNSUPPORTED }

/** G.711 (ITU-T) decode, both laws, as 16-bit linear PCM. */
object G711 {
    val ALAW = ShortArray(256) { alawToLinear(it) }
    val ULAW = ShortArray(256) { ulawToLinear(it) }

    private fun alawToLinear(code: Int): Short {
        val a = code xor 0x55
        var t = (a and 0x0F) shl 4
        val seg = (a and 0x70) shr 4
        when (seg) {
            0 -> t += 8
            1 -> t += 0x108
            else -> {
                t += 0x108
                t = t shl (seg - 1)
            }
        }
        return (if (a and 0x80 != 0) t else -t).toShort()
    }

    private fun ulawToLinear(code: Int): Short {
        val u = code.inv() and 0xFF
        var t = ((u and 0x0F) shl 3) + 0x84
        t = t shl ((u and 0x70) shr 4)
        return (if (u and 0x80 != 0) 0x84 - t else t - 0x84).toShort()
    }

    fun decodeAlaw(data: ByteArray, off: Int, len: Int): ShortArray = ShortArray(len) { ALAW[data[off + it].toInt() and 0xFF] }
    fun decodeUlaw(data: ByteArray, off: Int, len: Int): ShortArray = ShortArray(len) { ULAW[data[off + it].toInt() and 0xFF] }
}

/** Streaming linear-interpolation resampler for mono 16-bit PCM (speech; the camera rates are 8 to 48 kHz). */
class LinearResampler(private val srcRate: Int, private val dstRate: Int) {
    private val step = srcRate.toDouble() / dstRate
    private var pos = 0.0 // position of the next output sample, in input samples, relative to `last` at index -1
    private var last = 0.0
    private var primed = false

    fun process(input: ShortArray): ShortArray {
        if (input.isEmpty()) return input
        if (srcRate == dstRate) return input
        // Virtual input: index -1 is the last sample of the previous call (0 before the first call).
        val prev = if (primed) last else input[0].toDouble()
        primed = true
        val outMax = ((input.size - pos) / step).toInt() + 2
        val out = ShortArray(outMax)
        var n = 0
        var p = pos
        while (p < input.size - 1 && n < outMax) {
            val i = Math.floor(p).toInt()
            val frac = p - i
            val a = if (i < 0) prev else input[i].toDouble()
            val b = input[i + 1].toDouble()
            out[n++] = Math.round(a + (b - a) * frac).toInt().coerceIn(-32768, 32767).toShort()
            p += step
        }
        pos = p - input.size
        last = input[input.size - 1].toDouble()
        return if (n == out.size) out else out.copyOf(n)
    }
}

/** Bounded FIFO of PCM with a prebuffer: reads give silence until it holds [prebuffer] samples, and drop the oldest
 *  samples when it grows past [maxLatency] (clock drift between the camera and the phone). Thread-safe. */
class PcmRing(private val capacity: Int, @Volatile var prebuffer: Int, @Volatile var maxLatency: Int) {
    private val buf = ShortArray(capacity)
    private var head = 0
    private var size = 0
    private var primed = false

    @Volatile var underruns = 0
        private set
    @Volatile var dropped = 0L
        private set

    @Synchronized
    fun write(data: ShortArray) {
        for (s in data) {
            if (size == capacity) {
                head = (head + 1) % capacity
                size--
                dropped++
            }
            buf[(head + size) % capacity] = s
            size++
        }
        val over = size - max(maxLatency, prebuffer)
        if (over > 0) {
            head = (head + over) % capacity
            size -= over
            dropped += over
        }
    }

    /** Fills [out]; returns the number of real samples (the rest is zero). */
    @Synchronized
    fun read(out: ShortArray): Int {
        if (!primed) {
            if (size >= prebuffer) primed = true else {
                java.util.Arrays.fill(out, 0.toShort())
                return 0
            }
        }
        val n = min(out.size, size)
        for (i in 0 until n) out[i] = buf[(head + i) % capacity]
        head = (head + n) % capacity
        size -= n
        if (n < out.size) {
            java.util.Arrays.fill(out, n, out.size, 0.toShort())
            primed = false
            underruns++
        }
        return n
    }

    @Synchronized
    fun clear() {
        head = 0
        size = 0
        primed = false
    }

    @Synchronized
    fun available(): Int = size
}

/** AAC access units in, mono PCM out (at the stream's own rate). */
interface AacPcmDecoder {
    val sampleRate: Int
    fun decode(data: ByteArray, off: Int, len: Int): ShortArray
    fun release()
}

/** MediaCodec AAC decoder. Not unit-tested (needs a device); the interface above is. */
class AacMediaCodecDecoder(override val sampleRate: Int, private val channels: Int, config: ByteArray?) : AacPcmDecoder {
    private val codec: MediaCodec = MediaCodec.createDecoderByType(MediaFormat.MIMETYPE_AUDIO_AAC)
    private var outRate = sampleRate
    private var outChannels = channels

    init {
        try {
            val f = MediaFormat.createAudioFormat(MediaFormat.MIMETYPE_AUDIO_AAC, sampleRate, channels)
            f.setByteBuffer("csd-0", ByteBuffer.wrap(config ?: defaultConfig(sampleRate, channels)))
            f.setInteger(MediaFormat.KEY_AAC_PROFILE, MediaCodecInfo.CodecProfileLevel.AACObjectLC)
            codec.configure(f, null, null, 0)
            codec.start()
        } catch (e: Exception) {
            // The constructor never returns, so nobody else can release the codec.
            try { codec.release() } catch (_: Exception) {}
            throw e
        }
    }

    override fun decode(data: ByteArray, off: Int, len: Int): ShortArray {
        val out = ArrayList<ShortArray>()
        val inIdx = codec.dequeueInputBuffer(10_000)
        if (inIdx >= 0) {
            val b = codec.getInputBuffer(inIdx)!!
            b.clear()
            b.put(data, off, min(len, b.remaining()))
            codec.queueInputBuffer(inIdx, 0, min(len, b.capacity()), System.nanoTime() / 1000, 0)
        }
        val info = MediaCodec.BufferInfo()
        while (true) {
            val o = codec.dequeueOutputBuffer(info, 0)
            if (o >= 0) {
                val b = codec.getOutputBuffer(o)!!
                b.position(info.offset)
                b.limit(info.offset + info.size)
                val sb = b.order(java.nio.ByteOrder.LITTLE_ENDIAN).asShortBuffer()
                val inter = ShortArray(sb.remaining())
                sb.get(inter)
                out.add(downmix(inter, outChannels))
                codec.releaseOutputBuffer(o, false)
            } else if (o == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED) {
                val f = codec.outputFormat
                outRate = f.getInteger(MediaFormat.KEY_SAMPLE_RATE)
                outChannels = f.getInteger(MediaFormat.KEY_CHANNEL_COUNT)
            } else break
        }
        val total = out.sumOf { it.size }
        val all = ShortArray(total)
        var p = 0
        for (a in out) {
            System.arraycopy(a, 0, all, p, a.size)
            p += a.size
        }
        return all
    }

    /** The rate the decoder really outputs (HE-AAC may double the SDP rate). */
    val actualRate: Int get() = outRate

    override fun release() {
        try {
            codec.stop()
        } catch (_: Exception) {
        }
        try {
            codec.release()
        } catch (_: Exception) {
        }
    }

    companion object {
        private val RATES = intArrayOf(96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350)

        /** AudioSpecificConfig for AAC LC when the SDP carries none. */
        fun defaultConfig(rate: Int, channels: Int): ByteArray {
            val idx = max(0, RATES.indexOf(rate))
            val aot = 2
            val v = (aot shl 11) or (idx shl 7) or (channels shl 3)
            return byteArrayOf((v shr 8).toByte(), (v and 0xFF).toByte())
        }
    }
}

/** Mono downmix of interleaved PCM. */
fun downmix(interleaved: ShortArray, channels: Int): ShortArray {
    if (channels <= 1) return interleaved
    val n = interleaved.size / channels
    return ShortArray(n) {
        var s = 0
        for (c in 0 until channels) s += interleaved[it * channels + c]
        (s / channels).toShort()
    }
}

/**
 * The camera audio as the mixer's reference. Feed it from the RTSP client's listener thread with [onFormat] (once per
 * connection, with the SDP audio track or null) and [onSample]; read from the mixer thread with [read].
 *
 * [decoderFactory] builds the AAC decoder (a fake in tests). [nowMs] is injected for the silent/lost judgement.
 */
class RtspAudioSource(
    private val targetRate: Int,
    private val decoderFactory: (rate: Int, channels: Int, config: ByteArray?) -> AacPcmDecoder? = { r, c, cfg ->
        try {
            AacMediaCodecDecoder(r, c, cfg)
        } catch (_: Exception) {
            null
        }
    },
    private val nowMs: () -> Long = { System.nanoTime() / 1_000_000 },
    prebufferMs: Int = 100,
    syncOffsetMs: Int = 0,
    private val lostAfterMs: Long = 1500,
) {
    @Volatile var codec: CameraAudioCodec = CameraAudioCodec.NONE
        private set

    /** True when the camera announced an audio track we can decode (the mixer needs it to choose the manual fallback). */
    val hasAudio: Boolean get() = codec != CameraAudioCodec.NONE && codec != CameraAudioCodec.UNSUPPORTED

    /** The SDP of the current connection has been read (so [hasAudio] is a real answer, not a default). */
    @Volatile var formatKnown = false
        private set

    @Volatile private var lastSampleAt = 0L
    private var decoder: AacPcmDecoder? = null
    private var resampler: LinearResampler? = null
    private var srcRate = 0
    private var srcChannels = 1
    private val ring = PcmRing(targetRate * 3, msToSamples(prebufferMs + syncOffsetMs), msToSamples(prebufferMs + syncOffsetMs + 400))

    private fun msToSamples(ms: Int) = (ms.toLong() * targetRate / 1000).toInt()

    /** T0 item 5: the constant that keeps the sound level with the picture, in ms (held back by this much more). */
    fun setSyncOffsetMs(ms: Int, prebufferMs: Int = 100) {
        ring.prebuffer = msToSamples(prebufferMs + max(0, ms))
        ring.maxLatency = msToSamples(prebufferMs + max(0, ms) + 400)
    }

    /** A new connection: [codec] is the SDP audio codec (null = no audio track). */
    @Synchronized
    fun onFormat(codec: CameraAudioCodec, sampleRate: Int, channels: Int, config: ByteArray?) {
        closeDecoder()
        ring.clear()
        this.codec = codec
        formatKnown = true
        lastSampleAt = 0L
        srcChannels = max(1, channels)
        when (codec) {
            CameraAudioCodec.G711_ALAW, CameraAudioCodec.G711_ULAW -> {
                srcRate = if (sampleRate > 0) sampleRate else 8000
                resampler = LinearResampler(srcRate, targetRate)
            }
            CameraAudioCodec.AAC -> {
                srcRate = sampleRate
                decoder = decoderFactory(sampleRate, srcChannels, config)
                if (decoder == null) this.codec = CameraAudioCodec.UNSUPPORTED
                resampler = LinearResampler(sampleRate, targetRate)
            }
            else -> resampler = null
        }
    }

    @Synchronized
    fun onSample(data: ByteArray, off: Int, len: Int) {
        val pcm: ShortArray = when (codec) {
            CameraAudioCodec.G711_ALAW -> G711.decodeAlaw(data, off, len)
            CameraAudioCodec.G711_ULAW -> G711.decodeUlaw(data, off, len)
            CameraAudioCodec.AAC -> {
                val d = decoder ?: return
                val p = d.decode(data, off, len)
                val actual = (d as? AacMediaCodecDecoder)?.actualRate ?: srcRate
                if (actual != srcRate && actual > 0) {
                    srcRate = actual
                    resampler = LinearResampler(actual, targetRate)
                }
                p
            }
            else -> return
        }
        if (pcm.isEmpty()) return
        val r = resampler ?: return
        ring.write(r.process(pcm))
        lastSampleAt = nowMs()
    }

    /** Fills [out] with the next camera samples (zeros when there are none). Returns false when there is no live audio. */
    fun read(out: ShortArray): Boolean {
        ring.read(out)
        return isLive()
    }

    /** True while camera audio keeps arriving. */
    fun isLive(): Boolean = hasAudio && lastSampleAt != 0L && nowMs() - lastSampleAt <= lostAfterMs

    /** The connection ended: nothing more arrives, the ring drains to silence. */
    fun onLost() {
        lastSampleAt = 0L
    }

    @Synchronized
    fun release() {
        closeDecoder()
        ring.clear()
        codec = CameraAudioCodec.NONE
        formatKnown = false
    }

    private fun closeDecoder() {
        decoder?.release()
        decoder = null
    }

    val underruns: Int get() = ring.underruns

    companion object {
        /** Maps the RTSP client's SDP audio codec constants (0 AAC, 1 Opus, 2 G.711 u-law, 3 G.711 a-law). */
        fun codecFromSdp(sdpAudioCodec: Int): CameraAudioCodec = when (sdpAudioCodec) {
            0 -> CameraAudioCodec.AAC
            2 -> CameraAudioCodec.G711_ULAW
            3 -> CameraAudioCodec.G711_ALAW
            else -> CameraAudioCodec.UNSUPPORTED
        }
    }
}
