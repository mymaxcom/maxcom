package my.maxcom.app.live

import kotlin.math.PI
import kotlin.math.abs
import kotlin.math.sin
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test

class RtspAudioSourceTest {
    @Test
    fun g711TablesMatchTheStandard() {
        assertEquals(8, G711.ALAW[0xD5].toInt())
        assertEquals(-8, G711.ALAW[0x55].toInt())
        assertEquals(32256, G711.ALAW[0xAA].toInt())
        assertEquals(-32256, G711.ALAW[0x2A].toInt())
        assertEquals(0, G711.ULAW[0xFF].toInt())
        assertEquals(-32124, G711.ULAW[0x00].toInt())
        assertEquals(32124, G711.ULAW[0x80].toInt())
        // Monotone in magnitude within each sign (a table typo would break this).
        for (t in listOf(G711.ALAW, G711.ULAW)) {
            val pos = (0 until 256).filter { t[it] > 0 }.map { t[it].toInt() }.sorted()
            assertEquals(pos.distinct().size, pos.size)
        }
        val d = G711.decodeAlaw(byteArrayOf(0xD5.toByte(), 0x55), 0, 2)
        assertArrayEquals(shortArrayOf(8, -8), d)
        assertArrayEquals(shortArrayOf(0), G711.decodeUlaw(byteArrayOf(0xFF.toByte(), 0x00), 0, 1))
    }

    private fun sine(n: Int, rate: Int, hz: Double, amp: Double = 8000.0) = ShortArray(n) { (amp * sin(2 * PI * hz * it / rate)).toInt().toShort() }

    @Test
    fun resamplerKeepsLengthRatioAndTone() {
        val src = sine(8000, 8000, 440.0)
        val out = LinearResampler(8000, 48000).process(src)
        assertTrue("len ${out.size}", abs(out.size - 48000) <= 8)
        // The interpolated tone stays close to the ideal 48 kHz sine (speech-grade accuracy).
        val ref = sine(out.size, 48000, 440.0)
        var err = 0.0
        for (i in 100 until out.size - 100) err = maxOf(err, abs(out[i] - ref[i]).toDouble())
        assertTrue("err $err", err < 700)
        assertSame(src, LinearResampler(48000, 48000).process(src))
    }

    @Test
    fun resamplerIsSeamlessAcrossChunks() {
        val src = sine(4410, 44100, 300.0)
        val whole = LinearResampler(44100, 48000).process(src)
        val r = LinearResampler(44100, 48000)
        val parts = ArrayList<Short>()
        var p = 0
        for (size in listOf(37, 1000, 1, 512, 2860)) {
            for (v in r.process(src.copyOfRange(p, p + size))) parts.add(v)
            p += size
        }
        assertEquals(4410, p)
        assertTrue(abs(parts.size - whole.size) <= 2)
        for (i in 0 until minOf(parts.size, whole.size) - 2) assertTrue("i=$i", abs(parts[i] - whole[i]) <= 2)
    }

    @Test
    fun ringPrebuffersUnderrunsAndDropsOldSamples() {
        val ring = PcmRing(capacity = 1000, prebuffer = 100, maxLatency = 300)
        val out = ShortArray(50)
        ring.write(ShortArray(60) { 1 })
        assertEquals(0, ring.read(out)) // not primed yet: silence
        assertTrue(out.all { it.toInt() == 0 })
        ring.write(ShortArray(60) { 2 })
        assertEquals(50, ring.read(out)) // primed at 120
        assertEquals(1, out[0].toInt())
        assertEquals(50, ring.read(ShortArray(50)))
        assertEquals(20, ring.read(ShortArray(50))) // under run: 20 real samples, then back to prebuffering
        assertEquals(1, ring.underruns)
        ring.write(ShortArray(900) { 3 }) // far over the latency cap: oldest dropped
        assertTrue(ring.available() <= 300)
        assertTrue(ring.dropped > 0)
    }

    private class FakeAac : AacPcmDecoder {
        override val sampleRate = 16000
        var released = false
        override fun decode(data: ByteArray, off: Int, len: Int) = ShortArray(len) { data[off + it].toShort() }
        override fun release() {
            released = true
        }
    }

    @Test
    fun g711CameraAudioReachesTheReaderAtTheEngineRate() {
        var now = 1000L
        val src = RtspAudioSource(48000, nowMs = { now }, prebufferMs = 20)
        assertFalse(src.hasAudio)
        assertFalse(src.formatKnown)
        src.onFormat(CameraAudioCodec.G711_ALAW, 8000, 1, null)
        assertTrue(src.hasAudio && src.formatKnown)
        val pkt = ByteArray(160) { 0xAA.toByte() } // 20 ms of a constant positive level
        for (i in 0 until 5) src.onSample(pkt, 0, pkt.size)
        val out = ShortArray(960)
        assertTrue(src.read(out))
        assertEquals(32256, out[500].toInt())
        now += 2000
        assertFalse(src.isLive()) // nothing arrived for more than 1.5 s
        src.onSample(pkt, 0, pkt.size)
        assertTrue(src.isLive())
        src.onLost()
        assertFalse(src.isLive())
    }

    @Test
    fun aacGoesThroughTheDecoderFactoryAndCameraWithoutAudioIsKnown() {
        val aac = FakeAac()
        var cfg: ByteArray? = null
        val src = RtspAudioSource(16000, decoderFactory = { _, _, c ->
            cfg = c
            aac
        }, prebufferMs = 0)
        src.onFormat(CameraAudioCodec.AAC, 16000, 1, byteArrayOf(0x14, 0x08))
        assertArrayEquals(byteArrayOf(0x14, 0x08), cfg)
        src.onSample(ByteArray(320) { 7 }, 0, 320)
        val out = ShortArray(160)
        src.read(out)
        assertEquals(7, out[10].toInt())
        src.onFormat(CameraAudioCodec.NONE, 0, 0, null) // a new connection with no audio track
        assertTrue(aac.released)
        assertTrue(src.formatKnown)
        assertFalse(src.hasAudio)
        val failing = RtspAudioSource(16000, decoderFactory = { _, _, _ -> null })
        failing.onFormat(CameraAudioCodec.AAC, 16000, 1, null)
        assertFalse(failing.hasAudio) // no decoder = treated as no usable camera audio
    }

    @Test
    fun codecMappingAndStereoDownmixAndAacConfig() {
        assertEquals(CameraAudioCodec.AAC, RtspAudioSource.codecFromSdp(0))
        assertEquals(CameraAudioCodec.G711_ULAW, RtspAudioSource.codecFromSdp(2))
        assertEquals(CameraAudioCodec.G711_ALAW, RtspAudioSource.codecFromSdp(3))
        assertEquals(CameraAudioCodec.UNSUPPORTED, RtspAudioSource.codecFromSdp(1))
        assertArrayEquals(shortArrayOf(5, -3), downmix(shortArrayOf(4, 6, -4, -2), 2))
        // AudioSpecificConfig AAC LC 16 kHz mono = 0x14 0x08 (the well known value).
        assertArrayEquals(byteArrayOf(0x14, 0x08), AacMediaCodecDecoder.defaultConfig(16000, 1))
        assertArrayEquals(byteArrayOf(0x11, 0x90.toByte()), AacMediaCodecDecoder.defaultConfig(48000, 2))
    }
}
