package my.maxcom.app.live

import com.pedro.encoder.Frame
import com.pedro.encoder.input.audio.GetMicrophoneData
import java.util.concurrent.CountDownLatch
import java.util.concurrent.atomic.AtomicInteger
import kotlin.math.PI
import kotlin.math.log10
import kotlin.math.sin
import kotlin.math.sqrt
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** 2026.11.15 lane P1: phone inputs (Bluetooth), the capture that is not reopened for another device, mute, lift. */
class PhoneAudioInputsTest {
    private val builtin = MicRoute("15:", "", MicRoute.KIND_BUILTIN)
    private val wired = MicRoute("3:Headset Mic", "Headset Mic", MicRoute.KIND_EXTERNAL)
    private val usb = MicRoute("11:USB Audio", "USB Audio", MicRoute.KIND_EXTERNAL)
    private val bt = MicRoute("7:Headset Contoh", "Headset Contoh", MicRoute.KIND_BLUETOOTH)
    private val ble = MicRoute("26:Headset LE", "Headset LE", MicRoute.KIND_BLUETOOTH)

    // ---- ids and kinds ----

    @Test
    fun theKindComesFromTheDeviceTypeInTheId() {
        assertEquals(MicRoute.KIND_BUILTIN, MicRoute.kindOfId(builtin.id))
        assertEquals(MicRoute.KIND_EXTERNAL, MicRoute.kindOfId(wired.id))
        assertEquals(MicRoute.KIND_EXTERNAL, MicRoute.kindOfId(usb.id))
        assertEquals(MicRoute.KIND_BLUETOOTH, MicRoute.kindOfId(bt.id))
        assertEquals(MicRoute.KIND_BLUETOOTH, MicRoute.kindOfId(ble.id))
        assertTrue(bt.bluetooth)
        assertFalse(wired.bluetooth)
        assertFalse(MicRoute.isBluetoothId(null))
        assertFalse(MicRoute.isBluetoothId("own"))
    }

    @Test
    fun bluetoothPermissionIsOnlyAskedFromAndroid12ForABluetoothMicrophone() {
        assertTrue(MicRouting.needsBluetoothPermission(bt.id, 31))
        assertTrue(MicRouting.needsBluetoothPermission(ble.id, 34))
        assertFalse(MicRouting.needsBluetoothPermission(bt.id, 30))
        assertFalse(MicRouting.needsBluetoothPermission(wired.id, 34))
        assertFalse(MicRouting.needsBluetoothPermission(usb.id, 34))
        assertFalse(MicRouting.needsBluetoothPermission(null, 34))
        assertFalse(MicRouting.needsBluetoothPermission(MicRouting.OWN, 34))
    }

    @Test
    fun automaticNeverPicksABluetoothMicrophone() {
        assertNull(MicOpener.target(null, listOf(builtin, bt)))
        assertEquals(wired.id, MicOpener.target(null, listOf(builtin, bt, wired)))
        // a Bluetooth microphone the person chose is used
        assertEquals(bt.id, MicOpener.target(bt.id, listOf(builtin, bt)))
        assertEquals(builtin.id, MicOpener.target(MicRouting.OWN, listOf(builtin, bt)))
    }

    // ---- O3: another device does not reopen the capture ----

    @Test
    fun aDeviceThatIsNotInUseDoesNotReopenTheCapture() {
        val before = setOf(builtin.id, wired.id)
        // the wired microphone is in use, a Bluetooth headset comes: nothing to do
        assertFalse(MicRouting.capturePathChanged(before, before + bt.id, wired.id, wired.id))
        // and goes again
        assertFalse(MicRouting.capturePathChanged(before + bt.id, before, wired.id, wired.id))
        // a second USB microphone while the wired one is in use
        assertFalse(MicRouting.capturePathChanged(before, before + usb.id, wired.id, null))
        // the device's own microphone chosen: a plug never matters
        assertFalse(MicRouting.capturePathChanged(setOf(builtin.id), setOf(builtin.id, usb.id), builtin.id, MicRouting.OWN))
    }

    @Test
    fun theDeviceInUseGoingAwayReopensTheCapture() {
        assertTrue(MicRouting.capturePathChanged(setOf(builtin.id, wired.id), setOf(builtin.id), wired.id, wired.id))
        assertTrue(MicRouting.capturePathChanged(setOf(builtin.id, bt.id), setOf(builtin.id), bt.id, bt.id))
    }

    @Test
    fun theWantedDeviceComingBackReopensTheCapture() {
        // the wired one was chosen, is away (the live runs on the own microphone), and comes back
        assertTrue(MicRouting.capturePathChanged(setOf(builtin.id), setOf(builtin.id, wired.id), builtin.id, wired.id))
    }

    @Test
    fun automaticTakesAWiredMicrophoneWhenTheOwnOneIsInUse() {
        assertTrue(MicRouting.capturePathChanged(setOf(builtin.id), setOf(builtin.id, wired.id), builtin.id, null))
        // a Bluetooth headset is not taken by automatic
        assertFalse(MicRouting.capturePathChanged(setOf(builtin.id), setOf(builtin.id, bt.id), builtin.id, null))
    }

    @Test
    fun theRoutedDeviceNotKnownYetReopensOnAnyChange() {
        assertTrue(MicRouting.capturePathChanged(setOf(builtin.id), setOf(builtin.id, bt.id), null, null))
    }

    @Test
    fun micsChangedUsesTheRoutedDeviceAndMovesTheVersionOnlyWhenNeeded() {
        val r = MicRouting()
        r.seedMics(setOf(builtin.id, wired.id))
        r.prefer(wired.id)
        r.report(wired, null)
        val v0 = r.version
        assertFalse(r.micsChanged(setOf(builtin.id, wired.id, bt.id)))
        assertEquals(v0, r.version)
        assertTrue(r.micsChanged(setOf(builtin.id, bt.id)))
        assertEquals(v0 + 1, r.version)
    }

    // ---- Bluetooth open: the call link, the rate, the fallback ----

    private class FakePort(
        private val log: MutableList<String>,
        private val devices: List<MicRoute>,
        private val openOk: (Int) -> Boolean = { true },
    ) : RecordPort {
        var rate = 0
        var preferred: String? = null
        override fun open(source: Int, sampleRate: Int): Boolean {
            rate = sampleRate
            log.add("open:$source:$sampleRate")
            return openOk(sampleRate)
        }
        override val sessionId: Int = 0
        override fun setPreferred(id: String): Boolean {
            if (devices.none { it.id == id }) return false
            preferred = id
            return true
        }
        override fun start(): Boolean = true
        override fun routed(): MicRoute? = devices.firstOrNull { it.id == preferred } ?: devices.firstOrNull()
        override fun read(out: ShortArray, off: Int, len: Int): Int = len
        override fun close() {
            log.add("close")
        }
    }

    private class FakeSco(val ok: Boolean, val log: MutableList<String>) : ScoLink {
        override fun connect(id: String): Boolean {
            log.add("sco:connect:$id")
            return ok
        }
        override fun disconnect() {
            log.add("sco:disconnect")
        }
    }

    @Test
    fun aBluetoothMicrophoneOpensAfterItsLinkAtTheCallRate() {
        val log = mutableListOf<String>()
        val devices = listOf(builtin, bt)
        val res = MicOpener.open({ FakePort(log, devices) }, { devices }, 48000, bt.id, sco = FakeSco(true, log))
        assertEquals(bt, res.routed)
        assertNull(res.unavailableName)
        assertEquals(16000, res.captureRate)
        assertEquals("sco:connect:${bt.id}", log.first())
        // the call source (VOICE_COMMUNICATION) is tried first, at the wide band rate
        assertEquals("open:${android.media.MediaRecorder.AudioSource.VOICE_COMMUNICATION}:16000", log[1])
    }

    @Test
    fun aBluetoothMicrophoneFallsBackToNarrowBandWhenTheWideRateIsRefused() {
        val log = mutableListOf<String>()
        val devices = listOf(builtin, bt)
        val res = MicOpener.open({ FakePort(log, devices, openOk = { it == 8000 }) }, { devices }, 48000, bt.id, sco = FakeSco(true, log))
        assertEquals(bt, res.routed)
        assertEquals(8000, res.captureRate)
    }

    @Test
    fun withoutTheLinkTheLiveGoesOnWithTheDefaultMicrophoneAndNamesTheOneThatFailed() {
        val log = mutableListOf<String>()
        val devices = listOf(builtin, bt)
        val res = MicOpener.open({ FakePort(log, devices) }, { devices }, 48000, bt.id, sco = FakeSco(false, log))
        assertTrue(res.port != null)
        assertEquals("Headset Contoh", res.unavailableName)
        assertEquals(48000, res.captureRate)
        // no Bluetooth recorder was tried, and the request that did not come up is given back (F9)
        assertFalse(log.any { it.endsWith(":16000") })
        assertTrue(log.contains("sco:disconnect"))
    }

    @Test
    fun aLinkThatCameUpButCouldNotRecordIsGivenBack() {
        val log = mutableListOf<String>()
        val devices = listOf(builtin, bt)
        // every Bluetooth rate refused, the default open at the engine rate works
        val res = MicOpener.open({ FakePort(log, devices, openOk = { it == 48000 }) }, { devices }, 48000, bt.id, sco = FakeSco(true, log))
        assertEquals("Headset Contoh", res.unavailableName)
        assertTrue(log.contains("sco:disconnect"))
    }

    @Test
    fun aWiredMicrophoneNeverTouchesTheBluetoothLink() {
        val log = mutableListOf<String>()
        val devices = listOf(builtin, wired)
        val res = MicOpener.open({ FakePort(log, devices) }, { devices }, 48000, wired.id, sco = FakeSco(true, log))
        assertEquals(wired, res.routed)
        assertEquals(48000, res.captureRate)
        assertFalse(log.any { it.startsWith("sco:") })
    }

    // ---- the resampler ----

    @Test
    fun theResamplerGivesTheEngineRateAndKeepsASlowRampSmooth() {
        // 8 kHz ramp read through a 48 kHz view: 6 output samples per input sample
        var next = 0
        val r = ResampledReader(8000, 48000) { b, n ->
            for (i in 0 until n) b[i] = (next++ * 10).toShort()
            n
        }
        val out = ShortArray(480)
        assertEquals(480, r.read(out))
        var maxStep = 0
        for (i in 1 until out.size) maxStep = maxOf(maxStep, Math.abs(out[i] - out[i - 1]))
        // a ramp of +10 per input sample is about +1.67 per output sample: never a jump
        assertTrue("step $maxStep", maxStep <= 3)
        // the values really climb
        assertTrue(out[479] > out[0] + 600)
    }

    @Test
    fun theResamplerKeepsItsPositionAcrossCallsAndDropsNothing() {
        var produced = 0
        val r = ResampledReader(16000, 48000) { b, n ->
            for (i in 0 until n) b[i] = (produced++).toShort()
            n
        }
        val a = ShortArray(300)
        val b = ShortArray(300)
        r.read(a)
        r.read(b)
        // 600 output samples at a third of the rate are about 200 input samples (plus the read-ahead)
        assertTrue("produced $produced", produced in 200..215)
        // continuous across the two calls
        assertTrue(Math.abs(b[0] - a[299]) <= 2)
    }

    @Test
    fun theResamplerPassesAnErrorAndAShortReadOnce() {
        val r = ResampledReader(16000, 48000) { _, _ -> -1 }
        assertEquals(-1, r.read(ShortArray(10)))
        var calls = 0
        val r2 = ResampledReader(16000, 48000) { b, n ->
            if (calls++ == 0) { val half = n / 2; for (i in 0 until half) b[i] = 5; half } else -1
        }
        // the first call fills what it can from one block, then the source fails: the short count is returned
        val got = r2.read(ShortArray(3000))
        assertTrue("got $got", got in 1..2999)
    }

    // ---- the capture releases the link at stop ----

    private class CountingPort(val log: MutableList<String>) : RecordPort {
        override fun open(source: Int, sampleRate: Int): Boolean = true
        override val sessionId: Int = 0
        override fun setPreferred(id: String): Boolean = true
        override fun start(): Boolean = true
        override fun routed(): MicRoute? = MicRoute("7:Headset Contoh", "Headset Contoh", MicRoute.KIND_BLUETOOTH)
        override fun read(out: ShortArray, off: Int, len: Int): Int {
            java.util.Arrays.fill(out, off, off + len, 100.toShort())
            return len
        }
        override fun close() {
            log.add("port:close")
        }
    }

    @Test
    fun theBluetoothCaptureResamplesAndGivesTheLinkBackAtStop() {
        val log = mutableListOf<String>()
        val routing = MicRouting()
        routing.prefer(bt.id)
        val cap = AudioRecordCapture(
            48000, false, false, routing, null,
            portFactory = { CountingPort(log) },
            inputs = { listOf(builtin, bt) },
            sco = FakeSco(true, log),
        )
        assertTrue(cap.start())
        val out = ShortArray(960)
        assertEquals(960, cap.read(out))
        assertTrue(out.all { it.toInt() == 100 })
        cap.stop()
        assertTrue(log.contains("sco:disconnect"))
        assertTrue(log.contains("port:close"))
    }

    // ---- the mic thread ends at stop (O3) ----

    /** A read that waits for the recorder to be closed, like an AudioRecord waiting for sound. */
    private class HangingCapture : PcmCapture {
        private val closed = CountDownLatch(1)
        val stopped = AtomicInteger()
        override fun start(): Boolean = true
        override fun read(out: ShortArray): Int {
            try {
                closed.await()
            } catch (_: InterruptedException) {
                // an AudioRecord read does not react to an interrupt: keep waiting
                closed.await()
            }
            return -1
        }
        override fun stop() {
            stopped.incrementAndGet()
            closed.countDown()
        }
    }

    private class Sink : GetMicrophoneData {
        val frames = AtomicInteger()
        @Volatile var lastNonZero = false
        override fun inputPCMData(frame: Frame) {
            frames.incrementAndGet()
            lastNonZero = (0 until frame.size).any { frame.buffer[frame.offset + it].toInt() != 0 }
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
    fun thePhoneMicThreadEndsAtStopEvenWhenAReadIsWaiting() {
        val cap = HangingCapture()
        val src = RoutedMicSource(MicRouting(), captureFactory = { _, _, _ -> cap })
        assertTrue(src.init(16000, false, false, false))
        src.start(Sink())
        assertTrue(waitFor { src.threadAlive })
        Thread.sleep(100) // the thread is inside the read
        src.stop()
        assertFalse(src.isRunning())
        assertTrue("the mic thread must end at stop", waitFor(3000) { !src.threadAlive })
        assertTrue(cap.stopped.get() >= 1)
        src.release()
    }

    @Test
    fun theMixedMicThreadEndsAtStopEvenWhenAReadIsWaiting() {
        val cap = HangingCapture()
        val src = MixedAudioSource(null, null, 16000, routing = MicRouting(), captureFactory = { _, _, _ -> cap })
        src.setMicEnabled(true)
        assertTrue(src.init(16000, false, false, false))
        src.start(Sink())
        assertTrue(waitFor { src.threadAlive })
        Thread.sleep(100)
        src.stop()
        assertTrue("the mix thread must end at stop", waitFor(3000) { !src.threadAlive })
        assertTrue(cap.stopped.get() >= 1)
        src.release()
    }

    // ---- A4: the phone's mute silences everything ----

    private class LoudCapture : PcmCapture {
        override fun start(): Boolean = true
        override fun read(out: ShortArray): Int {
            Thread.sleep(10)
            java.util.Arrays.fill(out, 3000.toShort())
            return out.size
        }
        override fun stop() {}
    }

    @Test
    fun phoneMuteSilencesThePhoneMicWhateverTheEngineSaid() {
        val routing = MicRouting()
        val src = RoutedMicSource(routing, captureFactory = { _, _, _ -> LoudCapture() }, useAgc = false)
        assertTrue(src.init(16000, false, false, false))
        val sink = Sink()
        src.start(sink)
        try {
            assertTrue(waitFor { sink.lastNonZero })
            routing.muteAll = true // the engine's own mute() was not called (Mic-in added): still silent
            val n = sink.frames.get()
            assertTrue(waitFor { sink.frames.get() > n + 3 && !sink.lastNonZero })
            routing.muteAll = false
            assertTrue(waitFor { sink.lastNonZero })
        } finally {
            src.stop()
            src.release()
        }
    }

    @Test
    fun phoneMuteSilencesTheMixedSoundToo() {
        val routing = MicRouting()
        val src = MixedAudioSource(null, null, 16000, routing = routing, captureFactory = { _, _, _ -> LoudCapture() }, useAgc = false)
        src.setMicEnabled(true)
        assertTrue(src.init(16000, false, false, false))
        val sink = Sink()
        src.start(sink)
        try {
            assertTrue(waitFor { sink.lastNonZero })
            routing.muteAll = true
            val n = sink.frames.get()
            assertTrue(waitFor { sink.frames.get() > n + 3 && !sink.lastNonZero })
            routing.muteAll = false
            assertTrue(waitFor { sink.lastNonZero })
        } finally {
            src.stop()
            src.release()
        }
    }

    @Test
    fun phoneMicVolumeScalesTheSoundOfThePhoneCamera() {
        val routing = MicRouting()
        routing.phoneVolume = 50
        val peak = AtomicInteger()
        val src = RoutedMicSource(routing, captureFactory = { _, _, _ -> LoudCapture() }, useAgc = false)
        assertTrue(src.init(16000, false, false, false))
        val sink = object : GetMicrophoneData {
            override fun inputPCMData(frame: Frame) {
                if (frame.size >= 2) peak.accumulateAndGet((frame.buffer[frame.offset].toInt() and 0xFF) or (frame.buffer[frame.offset + 1].toInt() shl 8)) { a, b -> maxOf(a, b) }
            }
        }
        src.start(sink)
        try {
            assertTrue(waitFor { peak.get() == 1500 })
        } finally {
            src.stop()
            src.release()
        }
    }

    // ---- O1: the lift is on the camera sound too, with a switch per source ----

    private val rate = 16000

    private fun tone(dbfsRms: Double, n: Int): ShortArray {
        val a = 32768.0 * Math.pow(10.0, dbfsRms / 20.0) * sqrt(2.0)
        return ShortArray(n) { Math.round(a * sin(2 * PI * 1000.0 * it / rate)).toInt().coerceIn(-32768, 32767).toShort() }
    }

    private fun rmsDb(b: ShortArray): Double {
        var s = 0.0
        for (x in b) s += x.toDouble() * x
        return 20 * log10(sqrt(s / b.size).coerceAtLeast(1e-9) / 32768.0)
    }

    /** Mixes 4 s of a quiet camera tone through a core and returns the last second of the output. */
    private fun cameraThrough(core: MixerCore): ShortArray {
        val src = tone(-32.0, rate * 4)
        val out = ShortArray(rate * 4)
        val chunk = 320
        val o = ShortArray(chunk)
        val d = ShortArray(chunk)
        val ref = ShortArray(chunk)
        var p = 0
        while (p + chunk <= src.size) {
            System.arraycopy(src, p, ref, 0, chunk)
            core.mix(ref, true, null, o, d, null)
            System.arraycopy(o, 0, out, p, chunk)
            p += chunk
        }
        return out.copyOfRange(rate * 3, rate * 4)
    }

    private fun cameraCore(lift: Boolean): MixerCore = MixerCore(rate, maxDelayMs = 100, initialDelayMs = 0).also {
        it.camAgc = SpeechAgc(rate)
        it.camLift = lift
        it.cameraKnown = true
        it.cameraHasAudio = true
    }

    @Test
    fun theLiftRaisesAQuietCameraSoundAndTheSwitchTurnsItOff() {
        val on = rmsDb(cameraThrough(cameraCore(true)))
        val off = rmsDb(cameraThrough(cameraCore(false)))
        assertEquals(-32.0, off, 0.5) // untouched
        assertTrue("lifted $on vs $off", on > off + 6.0)
    }

    @Test
    fun withoutALiftObjectTheCameraSoundIsUnchanged() {
        val core = MixerCore(rate, maxDelayMs = 100, initialDelayMs = 0)
        assertEquals(-32.0, rmsDb(cameraThrough(core)), 0.5)
    }

    @Test
    fun theLiftIsOnByDefaultForBothSources() {
        val c = MixerCore(rate)
        assertTrue(c.camLift)
        assertTrue(c.micLift)
        val r = MicRouting()
        assertTrue(r.liftCamera)
        assertTrue(r.liftMic)
    }

    @Test
    fun awaitConditionReturnsAtOnceWhenTrueAndTimesOutWhenNever() {
        var t = 0L
        var slept = 0
        assertTrue(awaitCondition(1000, 50, now = { t }, sleep = { t += it; slept++ }) { true })
        assertEquals(0, slept)
        var n = 0
        assertTrue(awaitCondition(1000, 50, now = { t }, sleep = { t += it }) { ++n >= 4 })
        t = 0
        assertFalse(awaitCondition(200, 50, now = { t }, sleep = { t += it }) { false })
        assertTrue(t >= 200)
    }
}
