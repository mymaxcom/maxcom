package my.maxcom.app.live

import com.pedro.encoder.Frame
import com.pedro.encoder.input.audio.GetMicrophoneData
import java.util.concurrent.CopyOnWriteArrayList
import kotlin.math.abs
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class MixedAudioSourceTest {
    private val rate = 8000
    private val chunk = 160 // 20 ms

    private fun core(initialDelayMs: Int = 0) = MixerCore(rate, maxDelayMs = 2000, initialDelayMs = initialDelayMs)

    private class Run(val core: MixerCore) {
        val out = ShortArray(160)
        val delayed = ShortArray(160)
        val ref = ShortArray(160)
        val mic = ShortArray(160)
        val levels = MixLevels()

        /** Mixes [n] chunks of constant camera [r] and microphone [m] (null = off); returns the last mixed sample. */
        fun go(n: Int, r: Int, m: Int?, live: Boolean = true): Int {
            java.util.Arrays.fill(ref, r.toShort())
            if (m != null) java.util.Arrays.fill(mic, m.toShort())
            repeat(n) { core.mix(ref, live, if (m != null) mic else null, out, delayed, levels) }
            return out[out.size - 1].toInt()
        }
    }

    private fun audibleCamera(c: MixerCore) {
        c.cameraKnown = true
        c.cameraHasAudio = true
    }

    @Test
    fun delayLineDelaysByExactlyTheSetSamples() {
        val d = DelayLine(100)
        d.delaySamples = 5
        val inp = ShortArray(20)
        inp[0] = 100
        inp[3] = 7
        val out = ShortArray(20)
        d.process(inp, out)
        assertEquals(0, out[4].toInt())
        assertEquals(100, out[5].toInt())
        assertEquals(7, out[8].toInt())
        // across a chunk boundary
        val out2 = ShortArray(20)
        d.process(ShortArray(20), out2)
        d.delaySamples = 0
        d.delaySamples = 500 // clamped to the maximum
        assertEquals(100, d.delaySamples)
    }

    @Test
    fun gainsAreAppliedPerSourceAndTheMixIsClamped() {
        val c = core()
        audibleCamera(c)
        c.micEnabled = true
        c.onAlignState(AlignState.LOCKED)
        val r = Run(c)
        assertEquals(1000 + 500, r.go(40, 1000, 500))
        c.cameraVolume = 50
        c.micVolume = 20
        assertEquals(500 + 100, r.go(40, 1000, 500))
        c.cameraVolume = 0
        assertEquals(100, r.go(40, 1000, 500))
        c.cameraVolume = 100
        c.micVolume = 100
        assertEquals(32767, r.go(40, 30000, 30000))
        assertEquals(-32768, r.go(40, -30000, -30000))
        assertEquals(30000f / 32768f, r.levels.camera, 0.001f)
    }

    @Test
    fun microphoneIsHeldOutUntilTheFirstLockThenFadesIn() {
        val c = core()
        audibleCamera(c)
        c.micEnabled = true
        val r = Run(c)
        assertTrue(c.micHeldOut())
        assertEquals(1000, r.go(60, 1000, 500)) // searching: camera only
        c.onAlignState(AlignState.FAILED)
        assertEquals(1000, r.go(5, 1000, 500)) // failed: still held out (the screen offers "guna sahaja")
        c.onAlignState(AlignState.LOCKED)
        assertFalse(c.micHeldOut())
        val mid = r.go(10, 1000, 500) // 200 ms into the 500 ms fade
        assertTrue("mid $mid", mid in 1100..1400)
        assertEquals(1500, r.go(30, 1000, 500))
        c.onAlignState(AlignState.HOLDING)
        assertEquals(1500, r.go(5, 1000, 500)) // holding keeps everything
        c.onAlignState(AlignState.SEARCHING) // a later search never throws the mic out again
        assertEquals(1500, r.go(5, 1000, 500))
    }

    @Test
    fun cameraAtVolumeZeroLetsTheMicrophonePlayAtOnce() {
        val c = core()
        audibleCamera(c)
        c.micEnabled = true
        c.cameraVolume = 0
        assertFalse(c.micHeldOut())
        assertEquals(500, Run(c).go(40, 1000, 500))
    }

    @Test
    fun manualModeAndCameraWithoutAudioNeverHoldTheMicrophoneOut() {
        val c = core()
        c.micEnabled = true
        c.cameraKnown = true
        c.cameraHasAudio = false
        assertFalse(c.micHeldOut())
        assertEquals(500, Run(c).go(40, 0, 500))
        val c2 = core()
        c2.micEnabled = true
        audibleCamera(c2)
        assertTrue(c2.micHeldOut())
        c2.onAlignState(AlignState.MANUAL)
        assertFalse(c2.micHeldOut())
        // Before the camera's format is known the camera is assumed audible: no early leak.
        val c3 = core()
        c3.micEnabled = true
        assertTrue(c3.micHeldOut())
        // No camera at all (phone camera with its own mic): never held.
        val c4 = core()
        c4.micEnabled = true
        c4.hasCamera = false
        assertFalse(c4.micHeldOut())
        assertEquals(500, Run(c4).go(40, 0, 500))
    }

    @Test
    fun microphoneOffMixesTheCameraAloneAndDoesNotFeedTheAligner() {
        val c = core()
        audibleCamera(c)
        val r = Run(c)
        val aligning = c.mix(r.ref.also { java.util.Arrays.fill(it, 700.toShort()) }, true, null, r.out, r.delayed, null)
        assertFalse(aligning)
        assertEquals(700, r.out[0].toInt())
    }

    @Test
    fun delayedOutputIsTheMicrophoneAfterItsDelay() {
        val c = core(initialDelayMs = 10) // 80 samples at 8 kHz
        assertEquals(10, c.delayMs)
        audibleCamera(c)
        c.micEnabled = true
        val r = Run(c)
        java.util.Arrays.fill(r.mic, 0.toShort())
        r.mic[0] = 1234
        c.mix(r.ref, true, r.mic, r.out, r.delayed, null)
        assertEquals(0, r.delayed[79].toInt())
        assertEquals(1234, r.delayed[80].toInt())
        c.setDelayMs(25)
        assertEquals(25, c.delayMs)
    }

    @Test
    fun cameraRejoinsOnlyAfterANewLockWhenItReturns() {
        val c = core()
        audibleCamera(c)
        c.micEnabled = true
        c.onAlignState(AlignState.LOCKED)
        var returned = 0
        c.onCameraReturned = { returned++ }
        val r = Run(c)
        assertEquals(1500, r.go(40, 1000, 500, live = true))
        assertEquals(500, r.go(40, 0, 500, live = false)) // camera lost: the microphone keeps playing
        assertEquals(0, returned)
        assertEquals(500, r.go(40, 1000, 500, live = true)) // back: the camera waits for a new lock
        assertEquals(1, returned)
        assertTrue(c.cameraRejoinPending)
        c.onAlignState(AlignState.LOCKED)
        assertFalse(c.cameraRejoinPending)
        assertEquals(1500, r.go(60, 1000, 500, live = true))
    }

    @Test
    fun decimatorAveragesAndCarriesPartialGroups() {
        val d = Decimator(3)
        assertArrayEquals(shortArrayOf(2, 5), d.process(shortArrayOf(1, 2, 3, 4, 5, 6)))
        assertArrayEquals(shortArrayOf(), d.process(shortArrayOf(7, 8)))
        assertArrayEquals(shortArrayOf(8, 11), d.process(shortArrayOf(9, 10, 11, 12)))
        val one = shortArrayOf(1, 2)
        assertTrue(Decimator(1).process(one) === one)
    }

    // ---- the RootEncoder AudioSource around the core, with a fake microphone and a fake sink ----

    private class FakeCapture(val value: Int) : PcmCapture {
        @Volatile var started = false
        @Volatile var stopped = false
        override fun start(): Boolean {
            started = true
            return true
        }

        override fun read(out: ShortArray): Int {
            Thread.sleep(20)
            java.util.Arrays.fill(out, value.toShort())
            return out.size
        }

        override fun stop() {
            stopped = true
        }
    }

    private class Collect : GetMicrophoneData {
        val last = CopyOnWriteArrayList<Int>()
        override fun inputPCMData(frame: Frame) {
            last.add(((frame.buffer[frame.offset + frame.size - 1].toInt() shl 8) or (frame.buffer[frame.offset + frame.size - 2].toInt() and 0xFF)))
            if (last.size > 400) last.removeAt(0)
        }
    }

    private fun waitFor(ms: Long = 4000, cond: () -> Boolean): Boolean {
        val end = System.currentTimeMillis() + ms
        while (System.currentTimeMillis() < end) {
            if (cond()) return true
            Thread.sleep(10)
        }
        return cond()
    }

    @Test
    fun theSourceMixesDeliversAndHoldsTheMicrophoneUntilTheAlignerLocks() {
        val rate16 = 16000
        val cam = RtspAudioSource(rate16, prebufferMs = 20)
        cam.onFormat(CameraAudioCodec.G711_ALAW, 8000, 1, null)
        val code = (0 until 256).first { G711.ALAW[it] in 900..1100 }
        val camValue = G711.ALAW[code].toInt()
        val pkt = ByteArray(800) { code.toByte() } // 100 ms at 8 kHz
        var feeding = true
        val feeder = Thread {
            while (feeding) {
                cam.onSample(pkt, 0, pkt.size) // the camera keeps sending, in real time
                Thread.sleep(100)
            }
        }
        feeder.start()
        val aligner = AudioAligner(rate16, 2000)
        val mic = FakeCapture(2000)
        val src = MixedAudioSource(cam, aligner, 16000, captureFactory = { _, _, _ -> mic }, useAgc = false)
        src.setMicEnabled(true)
        assertTrue(src.init(rate16, false, false, false))
        val sink = Collect()
        src.start(sink)
        try {
            assertTrue(src.isRunning())
            assertTrue(waitFor { sink.last.size > 20 && mic.started })
            // before the first lock the microphone is not in the mix
            assertTrue(waitFor { sink.last.isNotEmpty() && abs(sink.last.last() - camValue) <= 2 })
            // the aligner reports a lock (what its onChange does from its own thread): the microphone fades in
            aligner.onChange!!.invoke(AlignState.LOCKED, 400)
            val locked = waitFor { abs(sink.last.last() - (camValue + 2000)) <= 3 }
            val m = src.mixer!!
            assertTrue(
                "last=${sink.last.lastOrNull()} cam=$camValue held=${m.micHeldOut()} aligned=${m.micAligned} " +
                    "rejoin=${m.cameraRejoinPending} delay=${m.delayMs} lv=${src.levels.camera}/${src.levels.mic}/${src.levels.mixed} " +
                    "micFailed=${src.micFailed} alive=${cam.isLive()}",
                locked,
            )
            assertEquals(400, src.mixer!!.delayMs)
            assertTrue(src.levels.mixed > 0f)
            // removing the microphone releases it and the mix returns to the camera alone
            src.setMicEnabled(false)
            assertTrue(waitFor { mic.stopped })
            assertTrue(waitFor { abs(sink.last.last() - camValue) <= 3 })
        } finally {
            feeding = false
            feeder.join()
            src.stop()
            src.release()
        }
        assertFalse(src.isRunning())
    }

    @Test
    fun aRemovedAndReAddedMicrophoneIsHeldOutAgainUntilItLocksAgain() {
        val c = core(initialDelayMs = 120)
        audibleCamera(c)
        c.micEnabled = true
        c.onAlignState(AlignState.LOCKED)
        assertFalse(c.micHeldOut())
        c.micEnabled = false
        c.micEnabled = true
        assertTrue(c.micHeldOut())
        assertEquals(120, c.delayMs) // the old delay is the starting point of the new search
        c.onAlignState(AlignState.LOCKED)
        assertFalse(c.micHeldOut())
    }

    @Test
    fun aReAddedMicrophoneDoesNotPlayTheStaleDelayTail() {
        val c = core(initialDelayMs = 100)
        audibleCamera(c)
        c.micEnabled = true
        c.onAlignState(AlignState.LOCKED)
        val r = Run(c)
        r.go(40, 1000, 500)
        c.micEnabled = false
        r.go(2, 1000, null)
        c.micEnabled = true
        c.onAlignState(AlignState.LOCKED)
        r.go(1, 1000, 0)
        assertTrue(r.delayed.all { it.toInt() == 0 })
    }
}
