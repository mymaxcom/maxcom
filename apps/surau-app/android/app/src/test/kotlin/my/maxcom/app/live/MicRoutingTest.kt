package my.maxcom.app.live

import com.pedro.encoder.Frame
import com.pedro.encoder.input.audio.GetMicrophoneData
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.atomic.AtomicInteger
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** The wired microphone is really used: the chosen device is applied, the routed one is read back, fallbacks say so. */
class MicRoutingTest {
    private val builtin = MicRoute("15:", "", MicRoute.KIND_BUILTIN)
    private val wired = MicRoute("3:Headset Mic", "Headset Mic", MicRoute.KIND_EXTERNAL)
    private val usb = MicRoute("11:USB Audio", "USB Audio", MicRoute.KIND_EXTERNAL)

    /** A fake recorder: [routeBySource] says which device the system routes to for each AudioSource it was opened on. */
    private class FakePort(
        private val log: MutableList<String>,
        private val devices: List<MicRoute>,
        private val routeBySource: (Int, String?) -> MicRoute?,
    ) : RecordPort {
        var source = -1
        var preferred: String? = null
        var started = false
        var closed = false
        var listener: ((MicRoute?) -> Unit)? = null

        override fun setOnRoutedChanged(cb: ((MicRoute?) -> Unit)?) {
            listener = cb
        }

        override fun open(source: Int, sampleRate: Int): Boolean {
            this.source = source
            log.add("open:$source")
            return true
        }

        override val sessionId: Int = 0

        override fun setPreferred(id: String): Boolean {
            log.add("preferred:$id")
            if (devices.none { it.id == id }) return false
            preferred = id
            return true
        }

        override fun start(): Boolean {
            started = true
            log.add("start")
            return true
        }

        override fun routed(): MicRoute? = routeBySource(source, preferred)
        override fun read(out: ShortArray, off: Int, len: Int): Int {
            Thread.sleep(5)
            java.util.Arrays.fill(out, off, off + len, 1000.toShort())
            return len
        }

        override fun close() {
            closed = true
            log.add("close:$source")
        }
    }

    private fun open(devices: List<MicRoute>, wanted: String?, log: MutableList<String>, ports: MutableList<FakePort>, route: (Int, String?) -> MicRoute?): MicOpenResult =
        MicOpener.open(
            newPort = { FakePort(log, devices, route).also { ports.add(it) } },
            inputs = { devices },
            sampleRate = 16000,
            wanted = wanted,
        )

    @Test
    fun theChosenDeviceIsAppliedBeforeStartAndReported() {
        val log = mutableListOf<String>()
        val ports = mutableListOf<FakePort>()
        val r = open(listOf(builtin, wired), wired.id, log, ports) { _, pref -> if (pref == wired.id) wired else builtin }
        assertNotNull(r.port)
        assertEquals(wired, r.routed)
        assertNull(r.unavailableName)
        // the preferred device is set between open and start
        assertEquals(listOf("open:0", "preferred:3:Headset Mic", "start"), log)
        assertEquals(1, ports.size)
    }

    @Test
    fun aMismatchRetriesWithMicThenVoiceRecognitionAndTakesTheFirstThatRoutes() {
        val log = mutableListOf<String>()
        val ports = mutableListOf<FakePort>()
        // only AudioSource.VOICE_RECOGNITION (6) honours the wish
        val r = open(listOf(builtin, wired), wired.id, log, ports) { src, pref -> if (src == 6 && pref == wired.id) wired else builtin }
        assertEquals(wired, r.routed)
        assertNull(r.unavailableName)
        assertEquals(listOf(0, 1, 6), ports.map { it.source })
        assertTrue(ports[0].closed && ports[1].closed)
        assertFalse(ports[2].closed)
    }

    @Test
    fun whenNothingRoutesTheRecordingRunsOnTheDefaultAndTheNameIsReported() {
        val log = mutableListOf<String>()
        val ports = mutableListOf<FakePort>()
        val r = open(listOf(builtin, wired), wired.id, log, ports) { _, _ -> builtin }
        assertNotNull(r.port)
        assertEquals(builtin, r.routed)
        // never silent: the app is told which microphone could not be used
        assertEquals("Headset Mic", r.unavailableName)
        // three tries with the wish, then one default recorder
        assertEquals(4, ports.size)
        assertEquals(3, ports.count { it.closed })
    }

    @Test
    fun aMicrophoneThatIsNotAttachedAnyMoreIsNotCalledUnavailable() {
        val log = mutableListOf<String>()
        val ports = mutableListOf<FakePort>()
        val r = open(listOf(builtin), wired.id, log, ports) { _, _ -> builtin }
        assertEquals(builtin, r.routed)
        assertNull(r.unavailableName)
        assertEquals(1, ports.size)
        assertTrue(log.none { it.startsWith("preferred:") })
    }

    @Test
    fun automaticTakesAnAttachedExternalMicrophoneAndOwnTakesTheBuiltInOne() {
        assertEquals(usb.id, MicOpener.target(null, listOf(builtin, usb, wired)))
        assertEquals(builtin.id, MicOpener.target(MicRouting.OWN, listOf(builtin, usb)))
        assertNull(MicOpener.target(null, listOf(builtin)))
        assertEquals("3:x", MicOpener.target("3:x", listOf(builtin)))
        val log = mutableListOf<String>()
        val ports = mutableListOf<FakePort>()
        val r = open(listOf(builtin, wired), null, log, ports) { _, pref -> if (pref == wired.id) wired else builtin }
        assertEquals(wired, r.routed)
        val own = open(listOf(builtin, wired), MicRouting.OWN, log, ports) { _, pref -> if (pref == builtin.id) builtin else wired }
        assertEquals(builtin, own.routed)
    }

    // ---- AQ5: a routed device that is not named yet is "unknown", never a failure ----

    @Test
    fun aRoutedDeviceThatIsNullKeepsTheRecorderAndGivesNoNotice() {
        val log = mutableListOf<String>()
        val ports = mutableListOf<FakePort>()
        val r = open(listOf(builtin, wired), wired.id, log, ports) { _, _ -> null }
        assertNotNull(r.port)
        assertNull(r.routed)
        assertNull("no false 'could not be used' notice", r.unavailableName)
        assertTrue(r.pending)
        assertEquals(wired.id, r.target)
        assertEquals(1, ports.size)
        assertFalse(ports[0].closed)
        assertEquals(listOf("open:0", "preferred:3:Headset Mic", "start"), log)
    }

    @Test
    fun theDeviceReportedLaterIsJudgedWhenItArrives() {
        val routing = MicRouting()
        routing.prefer(wired.id)
        val reports = CopyOnWriteArrayList<Pair<MicRoute?, String?>>()
        routing.onRouted = { r, u -> reports.add(r to u) }
        val ports = mutableListOf<FakePort>()
        val cap = AudioRecordCapture(
            16000, false, false, routing, null,
            portFactory = { FakePort(mutableListOf(), listOf(builtin, wired)) { _, _ -> null }.also { ports.add(it) } },
            inputs = { listOf(builtin, wired) },
        )
        assertTrue(cap.start())
        // at the start: nothing known, nothing claimed
        assertEquals(listOf<Pair<MicRoute?, String?>>(null to null), reports.toList())
        assertNull(routing.unavailableName)
        // the system names the wired microphone a moment later: the app is told, still no notice
        ports.single().listener!!.invoke(wired)
        assertEquals(wired, routing.routed)
        assertNull(routing.unavailableName)
        cap.stop()
    }

    @Test
    fun aDifferentDeviceReportedLaterIsTheOnlyCaseThatSaysUnavailable() {
        val routing = MicRouting()
        routing.prefer(wired.id)
        val ports = mutableListOf<FakePort>()
        val cap = AudioRecordCapture(
            16000, false, false, routing, null,
            portFactory = { FakePort(mutableListOf(), listOf(builtin, wired)) { _, _ -> null }.also { ports.add(it) } },
            inputs = { listOf(builtin, wired) },
        )
        assertTrue(cap.start())
        ports.single().listener!!.invoke(builtin)
        assertEquals(builtin, routing.routed)
        assertEquals("Headset Mic", routing.unavailableName)
        cap.stop()
    }

    @Test
    fun judgingALateDeviceOnlyFailsOnADifferentOne() {
        assertNull(MicOpener.unavailableFor(wired.id, "Headset Mic", null))
        assertNull(MicOpener.unavailableFor(wired.id, "Headset Mic", wired))
        assertEquals("Headset Mic", MicOpener.unavailableFor(wired.id, "Headset Mic", builtin))
        assertNull(MicOpener.unavailableFor(null, "", builtin))
    }

    @Test
    fun aRecorderThatCannotOpenGivesNoPort() {
        val bad = object : RecordPort {
            override fun open(source: Int, sampleRate: Int) = false
            override val sessionId = 0
            override fun setPreferred(id: String) = false
            override fun start() = false
            override fun routed(): MicRoute? = null
            override fun read(out: ShortArray, off: Int, len: Int) = -1
            override fun close() {}
        }
        val r = MicOpener.open({ bad }, { listOf(builtin, wired) }, 16000, wired.id)
        assertNull(r.port)
    }

    @Test
    fun theNameOfAnIdIsItsProductPart() {
        assertEquals("Headset Mic", MicRoute.nameOfId("3:Headset Mic"))
        assertEquals("", MicRoute.nameOfId("15:"))
        assertEquals("", MicRoute.nameOfId("nonsense"))
    }

    @Test
    fun theCaptureReportsTheRoutedDeviceToTheApp() {
        val routing = MicRouting()
        routing.prefer(wired.id)
        val reports = CopyOnWriteArrayList<Pair<MicRoute?, String?>>()
        routing.onRouted = { r, u -> reports.add(r to u) }
        val log = mutableListOf<String>()
        val cap = AudioRecordCapture(
            16000, false, false, routing, null,
            portFactory = { FakePort(log, listOf(builtin, wired)) { _, pref -> if (pref == wired.id) wired else builtin } },
            inputs = { listOf(builtin, wired) },
        )
        assertTrue(cap.start())
        assertEquals(listOf<Pair<MicRoute?, String?>>(wired to null), reports.toList())
        assertEquals(wired, routing.routed)
        val buf = ShortArray(160)
        assertEquals(160, cap.read(buf))
        assertEquals(1000, buf[0].toInt())
        cap.stop()
    }

    @Test
    fun theCaptureReportsAnUnavailableMicrophone() {
        val routing = MicRouting()
        routing.prefer(wired.id)
        val log = mutableListOf<String>()
        val cap = AudioRecordCapture(
            16000, false, false, routing, null,
            portFactory = { FakePort(log, listOf(builtin, wired)) { _, _ -> builtin } },
            inputs = { listOf(builtin, wired) },
        )
        assertTrue(cap.start())
        assertEquals("Headset Mic", routing.unavailableName)
        assertEquals(builtin, routing.routed)
        cap.stop()
    }

    @Test
    fun routingVersionOnlyMovesWhenSomethingChanged() {
        val r = MicRouting()
        val v0 = r.version
        r.prefer(null)
        assertEquals(v0, r.version)
        r.prefer(wired.id)
        assertEquals(v0 + 1, r.version)
        r.prefer(wired.id)
        assertEquals(v0 + 1, r.version)
        r.devicesChanged()
        assertEquals(v0 + 2, r.version)
    }

    // ---- the sources re-open the capture when a microphone is plugged or unplugged ----

    private class CountingCapture(val opened: AtomicInteger, val stopped: AtomicInteger) : PcmCapture {
        override fun start(): Boolean {
            opened.incrementAndGet()
            return true
        }

        override fun read(out: ShortArray): Int {
            Thread.sleep(10)
            java.util.Arrays.fill(out, 500.toShort())
            return out.size
        }

        override fun stop() {
            stopped.incrementAndGet()
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
    fun thePhoneMicrophoneIsOpenedAgainWhenADeviceIsPluggedOrUnplugged() {
        val routing = MicRouting()
        val opened = AtomicInteger()
        val stopped = AtomicInteger()
        val src = RoutedMicSource(routing, captureFactory = { _, _, _ -> CountingCapture(opened, stopped) })
        assertTrue(src.init(16000, false, false, false))
        val sink = Sink()
        src.start(sink)
        try {
            assertTrue(waitFor { opened.get() == 1 && sink.frames.get() > 3 })
            assertTrue(waitFor { sink.lastNonZero })
            routing.devicesChanged() // a headset microphone was plugged in
            assertTrue(waitFor { opened.get() == 2 })
            assertEquals(1, stopped.get())
            routing.prefer(wired.id) // the app chose it
            assertTrue(waitFor { opened.get() == 3 })
            routing.devicesChanged() // unplugged
            assertTrue(waitFor { opened.get() == 4 })
            // mute sends silence and keeps the stream running
            src.mute()
            val n = sink.frames.get()
            assertTrue(waitFor { sink.frames.get() > n + 3 && !sink.lastNonZero })
            src.unMute()
            assertTrue(waitFor { sink.lastNonZero })
        } finally {
            src.stop()
            src.release()
        }
    }

    @Test
    fun theAddedMicrophoneOfTheMixedSourceIsOpenedAgainOnAPlug() {
        val routing = MicRouting()
        val opened = AtomicInteger()
        val stopped = AtomicInteger()
        val src = MixedAudioSource(null, null, 16000, routing = routing, captureFactory = { _, _, _ -> CountingCapture(opened, stopped) })
        src.setMicEnabled(true)
        assertTrue(src.init(16000, false, false, false))
        val sink = Sink()
        src.start(sink)
        try {
            assertTrue(waitFor { opened.get() == 1 })
            routing.devicesChanged()
            assertTrue(waitFor { opened.get() == 2 })
            assertTrue(stopped.get() >= 1)
            assertFalse(src.micFailed)
        } finally {
            src.release()
        }
    }

    // ---- AQ4: only a real change of the microphone set re-opens the capture ----

    @Test
    fun aDeviceThatIsNotAMicrophoneDoesNotReopenTheCapture() {
        val r = MicRouting()
        r.seedMics(setOf(builtin.id))
        val v0 = r.version
        // a Bluetooth link or a remote submix came: the microphone set is the same
        assertFalse(r.micsChanged(setOf(builtin.id)))
        assertEquals(v0, r.version)
        // a headset microphone was plugged in
        assertTrue(r.micsChanged(setOf(builtin.id, wired.id)))
        assertEquals(v0 + 1, r.version)
        // told again with the same set: nothing
        assertFalse(r.micsChanged(setOf(builtin.id, wired.id)))
        assertEquals(v0 + 1, r.version)
        // unplugged
        assertTrue(r.micsChanged(setOf(builtin.id)))
        assertEquals(v0 + 2, r.version)
    }

    @Test
    fun theFirstLookOnlyRecordsTheSet() {
        val r = MicRouting()
        val v0 = r.version
        assertFalse(r.micsChanged(setOf(builtin.id)))
        assertEquals(v0, r.version)
    }

    // ---- item 9: stop() waits for a blocking open and the recorder is never handed over after it ----

    private class SlowOpenCapture(val openMs: Long, val stopped: AtomicInteger) : PcmCapture {
        override fun start(): Boolean {
            // a blocking open that does not react to an interrupt (AudioRecord does not)
            val end = System.currentTimeMillis() + openMs
            while (System.currentTimeMillis() < end) {
                try { Thread.sleep(20) } catch (_: InterruptedException) {}
            }
            return true
        }

        override fun read(out: ShortArray): Int {
            Thread.sleep(10)
            return out.size
        }

        override fun stop() {
            stopped.incrementAndGet()
        }
    }

    @Test
    fun stopWaitsForABlockingOpenAndReleasesTheRecorder() {
        val stopped = AtomicInteger()
        val src = RoutedMicSource(MicRouting(), captureFactory = { _, _, _ -> SlowOpenCapture(1300, stopped) })
        assertTrue(src.init(16000, false, false, false))
        val sink = Sink()
        src.start(sink)
        Thread.sleep(150) // the open is in progress
        src.stop()
        // stop() returned only after the open finished and the recorder was released
        assertEquals(1, stopped.get())
        assertFalse(src.isRunning())
        src.release()
        assertEquals(1, stopped.get())
    }
}
