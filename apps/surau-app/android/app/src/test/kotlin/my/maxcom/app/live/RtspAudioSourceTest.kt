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

    // ---- 2026.11.15, D4: the sync offset is wired (A1), AAC is decoded off the receive thread (A6) ----

    @Test
    fun theSavedOffsetHoldsTheCameraSoundBack() {
        // A1: until now nothing called setSyncOffsetMs, so the offset was always 0
        val a = RtspAudioSource(48_000)
        assertEquals(0, a.syncOffsetMs)
        val base = a.holdSamples // the 100 ms prebuffer
        assertEquals(4800, base)
        a.setSyncOffsetMs(SourceLogic.cameraSyncMs(250))
        assertEquals(250, a.syncOffsetMs)
        assertEquals(4800 + 12_000, a.holdSamples)
        // the sound can only be delayed, and not without limit
        assertEquals(0, SourceLogic.cameraSyncMs(-300))
        assertEquals(2000, SourceLogic.cameraSyncMs(9000))
        a.setSyncOffsetMs(SourceLogic.cameraSyncMs(-300))
        assertEquals(base, a.holdSamples)
    }

    @Test
    fun withAnOffsetTheSoundComesOutThatMuchLater() {
        fun firstSoundAfterMs(offsetMs: Int): Int {
            val a = RtspAudioSource(8000, nowMs = { 7L })
            a.setSyncOffsetMs(offsetMs)
            a.onFormat(CameraAudioCodec.G711_ULAW, 8000, 1, null)
            val out = ShortArray(80) // 10 ms
            var ms = 0
            while (ms < 3000) {
                a.onSample(ByteArray(80) { 0x10 }, 0, 80) // 10 ms of a loud constant
                a.read(out)
                ms += 10
                if (out.any { it.toInt() != 0 }) return ms
            }
            return -1
        }
        val plain = firstSoundAfterMs(0)
        val held = firstSoundAfterMs(300)
        assertTrue("plain=$plain", plain in 1..300)
        assertEquals(300, held - plain)
    }

    @Test
    fun theEngineSetsTheOffsetFromTheSavedValue() {
        val e = listOf("src/main/kotlin/my/maxcom/app/live/LiveEngine.kt", "app/src/main/kotlin/my/maxcom/app/live/LiveEngine.kt")
            .map { java.io.File(it) }.first { it.exists() }.readText()
        assertTrue(e.contains("audio.setSyncOffsetMs(SourceLogic.cameraSyncMs(spec.avOffsetMs))"))
        assertTrue(e.contains("rtspAudio?.setSyncOffsetMs(SourceLogic.cameraSyncMs(v))"))
        assertTrue(e.contains("RtspAudioSource(AUDIO_RATE, decodeOn = camAudioExec)"))
    }

    private class CountingDecoder : AacPcmDecoder {
        override val sampleRate = 48_000
        @Volatile var thread: String? = null
        @Volatile var calls = 0
        override fun decode(data: ByteArray, off: Int, len: Int): ShortArray {
            thread = Thread.currentThread().name
            calls++
            return ShortArray(1024) { 1000 }
        }

        override fun release() {}
    }

    @Test
    fun aacIsDecodedOnTheWorkerNotOnTheReceiveThread() {
        // A6: a slow decode used to hold back the camera's video packets on the same thread
        val worker = java.util.concurrent.Executors.newSingleThreadExecutor { r -> Thread(r, "decode-worker") }
        try {
            val dec = CountingDecoder()
            val a = RtspAudioSource(48_000, decoderFactory = { _, _, _ -> dec }, decodeOn = worker)
            a.onFormat(CameraAudioCodec.AAC, 48_000, 1, null)
            val packet = ByteArray(16) { 7 }
            for (i in 0 until 10) a.onSample(packet, 0, packet.size)
            worker.submit {}.get(5, java.util.concurrent.TimeUnit.SECONDS)
            assertEquals(10, dec.calls)
            assertEquals("decode-worker", dec.thread)
            assertTrue(a.isLive()) // success path: the sound still arrives
            assertEquals(0L, a.decodeDropped)
        } finally {
            worker.shutdownNow()
        }
    }

    @Test
    fun aDecodeWorkerThatFallsBehindDropsPacketsInsteadOfGrowingAQueue() {
        val gate = java.util.concurrent.CountDownLatch(1)
        val worker = java.util.concurrent.Executors.newSingleThreadExecutor()
        try {
            worker.execute { gate.await() } // the worker is stuck
            val dec = CountingDecoder()
            val a = RtspAudioSource(48_000, decoderFactory = { _, _, _ -> dec }, decodeOn = worker)
            a.onFormat(CameraAudioCodec.AAC, 48_000, 1, null)
            for (i in 0 until RtspAudioSource.MAX_BACKLOG + 25) a.onSample(ByteArray(8), 0, 8)
            assertEquals(25L, a.decodeDropped)
            gate.countDown()
            worker.submit {}.get(5, java.util.concurrent.TimeUnit.SECONDS)
            assertEquals(RtspAudioSource.MAX_BACKLOG, dec.calls)
        } finally {
            gate.countDown()
            worker.shutdownNow()
        }
    }

    @Test
    fun withoutAWorkerAndForG711TheDecodeStaysInline() {
        val dec = CountingDecoder()
        val a = RtspAudioSource(48_000, decoderFactory = { _, _, _ -> dec })
        a.onFormat(CameraAudioCodec.AAC, 48_000, 1, null)
        a.onSample(ByteArray(8), 0, 8)
        assertEquals(Thread.currentThread().name, dec.thread)
        // G.711 is a table look-up: never queued, whatever the worker does
        val worker = java.util.concurrent.Executors.newSingleThreadExecutor()
        try {
            val g = RtspAudioSource(8000, decodeOn = worker, nowMs = { 5L })
            g.onFormat(CameraAudioCodec.G711_ALAW, 8000, 1, null)
            g.onSample(ByteArray(80), 0, 80)
            assertTrue(g.isLive())
        } finally {
            worker.shutdownNow()
        }
    }
}
