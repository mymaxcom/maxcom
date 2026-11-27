package my.maxcom.app.live

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class RtspVideoSourceTest {
    private val info = CameraStreamInfo("video/avc", null, null, null, CameraAudioCodec.NONE, 0, 0, null)

    /** A scripted connector: each call runs the next step with the transport asked for. */
    private class Script(val steps: List<(RtspTransport, RtspEvents) -> ConnectEnd>) : RtspConnector {
        val transports = ArrayList<RtspTransport>()
        var stopped = false
        override fun run(transport: RtspTransport, events: RtspEvents): ConnectEnd {
            transports.add(transport)
            val i = transports.size - 1
            return if (i < steps.size) steps[i](transport, events) else ConnectEnd.FAILED
        }

        override fun stop() {
            stopped = true
        }
    }

    private class Sink : RtspEvents {
        var connected = 0
        var video = 0
        var audio = 0
        override fun onConnected(info: CameraStreamInfo) {
            connected++
        }

        override fun onVideo(data: ByteArray, off: Int, len: Int, tsMs: Long) {
            video++
        }

        override fun onAudio(data: ByteArray, off: Int, len: Int, tsMs: Long) {
            audio++
        }
    }

    private val fail: (RtspTransport, RtspEvents) -> ConnectEnd = { _, _ -> ConnectEnd.FAILED }
    private fun plays(end: ConnectEnd = ConnectEnd.DISCONNECTED): (RtspTransport, RtspEvents) -> ConnectEnd = { _, e ->
        e.onConnected(info)
        e.onVideo(ByteArray(4), 0, 4, 0)
        e.onAudio(ByteArray(4), 0, 4, 0)
        end
    }

    /** Runs the supervisor until [rounds] sleeps have happened; returns the sleeps. */
    private fun run(sup: RtspSupervisor, waits: ArrayList<Long>, rounds: Int) {
        sup.runLoop()
        assertEquals(rounds, waits.size)
    }

    private fun supervisor(script: Script, mode: TransportMode, sink: RtspEvents, waits: ArrayList<Long>, rounds: Int, clock: () -> Long = { 5000 }) =
        RtspSupervisor(script, mode, sink, nowMs = clock, sleep = { ms ->
            waits.add(ms)
            waits.size < rounds
        }, log = {})

    @Test
    fun modesGiveTheSpecifiedOrderAndRememberTheLastGood() {
        assertEquals(listOf(RtspTransport.TCP, RtspTransport.UDP), TransportMode.AUTO.order())
        assertEquals(listOf(RtspTransport.TCP), TransportMode.TCP.order())
        assertEquals(listOf(RtspTransport.UDP), TransportMode.UDP.order())
        assertEquals(listOf(RtspTransport.UDP, RtspTransport.TCP), TransportMode.AUTO.order(RtspTransport.UDP))
        assertEquals(listOf(RtspTransport.TCP), TransportMode.TCP.order(RtspTransport.UDP))
        assertEquals(TransportMode.AUTO, TransportMode.parse(null))
        assertEquals(TransportMode.AUTO, TransportMode.parse("auto"))
        assertEquals(TransportMode.UDP, TransportMode.parse("UDP"))
        assertEquals(TransportMode.TCP, TransportMode.parse("tcp"))
    }

    @Test
    fun autoFallsFromTcpToUdpAndPrefersUdpAfterwards() {
        val script = Script(listOf(fail, plays(), plays()))
        val sink = Sink()
        val waits = ArrayList<Long>()
        val sup = supervisor(script, TransportMode.AUTO, sink, waits, rounds = 2)
        run(sup, waits, 2)
        // round 1: tcp fails, udp plays and drops; round 2 starts with udp (the one that worked)
        assertEquals(listOf(RtspTransport.TCP, RtspTransport.UDP, RtspTransport.UDP), script.transports)
        assertEquals(RtspTransport.UDP, sup.transport)
        assertEquals(2, sink.connected)
        assertEquals(2, sink.video)
        assertEquals(2, sink.audio)
    }

    @Test
    fun wrongPasswordDoesNotTryTheOtherTransport() {
        val script = Script(listOf({ _, _ -> ConnectEnd.UNAUTHORIZED }))
        val waits = ArrayList<Long>()
        val sup = supervisor(script, TransportMode.AUTO, Sink(), waits, rounds = 1)
        run(sup, waits, 1)
        assertEquals(listOf(RtspTransport.TCP), script.transports)
        assertEquals(ProbeFailure.LOGIN, sup.lastFailure)
        assertEquals(CameraLinkState.STOPPED, sup.state)
    }

    @Test
    fun fixedModesTryOnlyTheirTransport() {
        val script = Script(listOf(fail, fail))
        val waits = ArrayList<Long>()
        run(supervisor(script, TransportMode.UDP, Sink(), waits, 2), waits, 2)
        assertEquals(listOf(RtspTransport.UDP, RtspTransport.UDP), script.transports)
    }

    @Test
    fun backoffGrowsAndResetsAfterAPlayingConnection() {
        val script = Script(listOf(fail, fail, fail, fail, fail, plays(), fail))
        val waits = ArrayList<Long>()
        val sup = supervisor(script, TransportMode.TCP, Sink(), waits, rounds = 8)
        run(sup, waits, 8)
        assertEquals(listOf(2000L, 3000L, 5000L, 8000L, 8000L, 2000L, 3000L, 5000L), waits)
    }

    @Test
    fun lostStateKeepsTheFirstLossTimeUntilPictureReturns() {
        var now = 1000L
        val states = ArrayList<CameraLinkState>()
        val script = Script(listOf(plays(), fail, fail, plays()))
        val lostAt = ArrayList<Long>()
        val lostWhenPictureCame = ArrayList<Long>()
        lateinit var sup: RtspSupervisor
        val events = object : RtspEvents {
            override fun onConnected(info: CameraStreamInfo) {}
            override fun onVideo(data: ByteArray, off: Int, len: Int, tsMs: Long) {
                lostWhenPictureCame.add(sup.lostSinceMs)
            }

            override fun onAudio(data: ByteArray, off: Int, len: Int, tsMs: Long) {}
        }
        var sleeps = 0
        sup = RtspSupervisor(script, TransportMode.TCP, events, nowMs = { now }, sleep = { ms ->
            lostAt.add(sup.lostSinceMs)
            now += ms
            ++sleeps < 5
        }, log = {})
        sup.onState = { states.add(it) }
        sup.runLoop()
        // Lost at t=1000 (the first drop); the failed retries keep that time; the picture returning clears it; the next
        // drop (round 4 plays, then ends) starts a new loss at the then current time.
        assertEquals(listOf(1000L, 1000L, 1000L, 11000L, 11000L), lostAt)
        assertEquals(listOf(0L, 0L), lostWhenPictureCame)
        assertEquals(
            listOf(CameraLinkState.CONNECTING, CameraLinkState.PLAYING, CameraLinkState.LOST, CameraLinkState.CONNECTING,
                CameraLinkState.PLAYING, CameraLinkState.LOST, CameraLinkState.STOPPED).filter { it != CameraLinkState.CONNECTING },
            states.filter { it != CameraLinkState.CONNECTING },
        )
    }

    @Test
    fun stopStopsTheConnector() {
        val script = Script(emptyList())
        val sup = RtspSupervisor(script, TransportMode.TCP, Sink(), sleep = { true }, log = {})
        sup.stop()
        assertTrue(script.stopped)
        sup.runLoop() // already stopped: returns at once
        assertNull(script.transports.firstOrNull())
        assertEquals(CameraLinkState.STOPPED, sup.state)
    }

    @Test
    fun stopBeforeRunStands() {
        val c = LibRtspConnector("rtsp://127.0.0.1:1/x", null, null)
        c.stop()
        val ev = object : RtspEvents {
            override fun onConnected(info: CameraStreamInfo) {}
            override fun onVideo(data: ByteArray, off: Int, len: Int, tsMs: Long) {}
            override fun onAudio(data: ByteArray, off: Int, len: Int, tsMs: Long) {}
        }
        assertEquals(ConnectEnd.STOPPED, c.run(RtspTransport.TCP, ev))
        assertEquals(ConnectEnd.STOPPED, c.run(RtspTransport.UDP, ev))
    }

    @Test
    fun aRunAfterAFailedRunStartsAgain() {
        // A reused connector must not carry the previous run's exit flag: the second run tries again (refused = FAILED).
        val c = LibRtspConnector("rtsp://127.0.0.1:1/x", null, null, connectTimeoutMs = 500)
        val ev = object : RtspEvents {
            override fun onConnected(info: CameraStreamInfo) {}
            override fun onVideo(data: ByteArray, off: Int, len: Int, tsMs: Long) {}
            override fun onAudio(data: ByteArray, off: Int, len: Int, tsMs: Long) {}
        }
        assertEquals(ConnectEnd.FAILED, c.run(RtspTransport.TCP, ev))
        assertEquals(ConnectEnd.FAILED, c.run(RtspTransport.UDP, ev))
        c.stop()
        assertEquals(ConnectEnd.STOPPED, c.run(RtspTransport.TCP, ev))
    }

    @Test
    fun helperIsInitialisedBeforeTheDecoderStarts() {
        val order = ArrayList<String>()
        val sink = LibVideoSink(640, 480, { order.add("init") }, { _, _, _, _ -> order.add("start"); { order.add("stop") } })
        sink.configure("video/avc", null, null, null)
        assertEquals(listOf("init", "start"), order)
        sink.configure("video/avc", null, null, null)
        assertEquals(listOf("init", "start", "stop", "init", "start"), order)
    }

    @Test
    fun helperInitRunsAtMostOncePerProcessAcrossSinks() {
        var inits = 0
        val once = OnceInit({ inits++ }, {})
        repeat(3) {
            val sink = LibVideoSink(640, 480, { once.ensure() }, { _, _, _, _ -> {} })
            sink.configure("video/avc", null, null, null)
            sink.configure("video/hevc", null, null, null)
        }
        assertEquals(1, inits)
    }

    @Test
    fun aThrowingHelperInitDoesNotPropagateAndWarnsOnce() {
        var warns = 0
        var starts = 0
        val once = OnceInit({ throw IllegalStateException("boom") }, { warns++ })
        val sink = LibVideoSink(640, 480, { once.ensure() }, { _, _, _, _ -> starts++; {} })
        sink.configure("video/avc", null, null, null)
        sink.configure("video/avc", null, null, null)
        assertEquals(1, warns)
        assertEquals(2, starts)
        // a throwing warn callback must not escape either
        OnceInit({ throw Error("x") }, { throw RuntimeException("y") }).ensure()
    }

    // ---- 2026.11.15, D3: a weak link (C1) and a silent decoder (C2) ----

    private fun nal(type: Int) = byteArrayOf(0, 0, 0, 1, type.toByte(), 1, 2, 3)

    @Test
    fun nalKindsAreReadFromAnnexBAndFromABareUnit() {
        assertEquals(NalKind.KEY, NalKind.of(nal(0x65), 0, 8, h265 = false)) // IDR
        assertEquals(NalKind.CONFIG, NalKind.of(nal(0x67), 0, 8, false)) // SPS
        assertEquals(NalKind.CONFIG, NalKind.of(nal(0x68), 0, 8, false)) // PPS
        assertEquals(NalKind.OTHER, NalKind.of(nal(0x41), 0, 8, false)) // P slice
        // SPS + PPS + IDR in one buffer is a keyframe
        val au = nal(0x67) + nal(0x68) + nal(0x65)
        assertEquals(NalKind.KEY, NalKind.of(au, 0, au.size, false))
        // no start code: the first byte is the header
        assertEquals(NalKind.KEY, NalKind.of(byteArrayOf(0x65, 1, 2), 0, 3, false))
        // H.265: IDR_W_RADL (19), VPS (32), TRAIL_R (1)
        assertEquals(NalKind.KEY, NalKind.of(nal(19 shl 1), 0, 8, h265 = true))
        assertEquals(NalKind.CONFIG, NalKind.of(nal(32 shl 1), 0, 8, true))
        assertEquals(NalKind.OTHER, NalKind.of(nal(1 shl 1), 0, 8, true))
        // an offset into a larger buffer
        val padded = ByteArray(5) + nal(0x65)
        assertEquals(NalKind.KEY, NalKind.of(padded, 5, 8, false))
        assertEquals(NalKind.OTHER, NalKind.of(ByteArray(0), 0, 0, false))
    }

    @Test
    fun aNewConnectionStartsAtItsFirstKeyframe() {
        val g = KeyframeGate()
        assertFalse(g.admit(NalKind.OTHER)) // joined in the middle of a group of pictures
        assertFalse(g.admit(NalKind.OTHER))
        assertTrue("parameter sets always pass", g.admit(NalKind.CONFIG))
        assertTrue(g.waitingForKey)
        assertTrue(g.admit(NalKind.KEY))
        assertTrue(g.admit(NalKind.OTHER))
        assertEquals(2L, g.held)
        g.reset() // reconnect
        assertFalse(g.admit(NalKind.OTHER))
        assertTrue(g.admit(NalKind.KEY))
    }

    @Test
    fun overflowDropsToTheNextKeyframe() {
        // C1: the queue is full, one frame is lost; everything up to the next keyframe would decode as garbage
        val g = KeyframeGate()
        val fed = ArrayList<String>()
        var full = false
        fun push(name: String, kind: NalKind) {
            if (!g.admit(kind)) return
            if (full) { g.overflow(); return } // the queue refused it
            fed.add(name)
        }
        push("I1", NalKind.KEY); push("P1", NalKind.OTHER)
        full = true
        push("P2", NalKind.OTHER) // lost
        full = false
        push("P3", NalKind.OTHER); push("P4", NalKind.OTHER) // must not reach the decoder
        push("sps", NalKind.CONFIG)
        push("I2", NalKind.KEY); push("P5", NalKind.OTHER)
        assertEquals(listOf("I1", "P1", "sps", "I2", "P5"), fed)
    }

    @Test
    fun theWaitForAKeyframeIsBounded() {
        // a camera with very rare keyframes is fed as it comes after five seconds, as before this gate existed
        val g = KeyframeGate()
        assertFalse(g.admit(NalKind.OTHER, 1000))
        assertFalse(g.admit(NalKind.OTHER, 5999))
        assertTrue(g.admit(NalKind.OTHER, 6000))
        assertTrue(g.admit(NalKind.OTHER, 6040))
        assertFalse(g.waitingForKey)
    }

    @Test
    fun afterTwoStallsInARowTheWatchStopsCuttingTheConnection() {
        // reconnecting did not bring a picture back: a third cut would only add to the trouble
        val w = DecodeWatch()
        var t = 0L
        var stalls = 0
        while (t < 60_000) {
            t += 100
            w.onNal(t, true)
            w.onStamp(5L, t)
            if (w.stalled(t)) { stalls++; w.stallHandled() }
        }
        assertEquals(DecodeWatch.MAX_STALLS, stalls)
        // a picture comes out again: the watch is back on duty
        var stamp = 5L
        for (i in 0 until 10) { t += 100; w.onNal(t, true); w.onStamp(++stamp, t) }
        val from = t
        while (!w.stalled(t)) { t += 100; w.onNal(t, true); w.onStamp(stamp, t); assertTrue(t - from < 10_000) }
        assertTrue(t - from in 5900L..6200L)
    }

    @Test
    fun aHealthyStreamIsFedInFull() {
        // success path: nothing is held once the first keyframe came
        val g = KeyframeGate()
        var fed = 0
        for (i in 0 until 300) if (g.admit(if (i % 30 == 0) NalKind.KEY else NalKind.OTHER)) fed++
        assertEquals(300, fed)
        assertEquals(0L, g.held)
    }

    @Test
    fun nalsButNoDecodedFramesForSixSecondsIsAStall() {
        // C2: the old watchdog counted NAL units arriving and saw nothing wrong
        val w = DecodeWatch()
        var t = 1000L
        var stalled = false
        while (t <= 7200 && !stalled) {
            w.onNal(t, fed = true)
            w.onStamp(42L, t) // the texture never gets a new picture
            stalled = w.stalled(t)
            if (!stalled) t += 100
        }
        assertTrue(stalled)
        assertEquals(7000L, t) // six seconds after the first frame was fed
        assertEquals(0L, w.decodedFrames)
    }

    @Test
    fun aHealthyStreamRaisesNothing() {
        val w = DecodeWatch()
        var stamp = 0L
        for (t in 1000L..61_000L step 40) {
            w.onNal(t, fed = true)
            if (t % 200 == 0L) w.onStamp(++stamp, t) // the poll sees a new picture each time
            assertFalse("at $t", w.stalled(t))
        }
        assertTrue(w.decodedFrames > 100)
    }

    @Test
    fun waitingForAKeyframeOrASilentCameraIsNotADecoderStall() {
        // held back by the keyframe gate for ten seconds: nothing can come out, so nothing is judged
        val gated = DecodeWatch()
        for (t in 1000L..11_000L step 100) {
            gated.onNal(t, fed = false)
            gated.onStamp(1L, t)
            assertFalse(gated.stalled(t))
        }
        // the camera stopped sending: that is the connection watchdog's case, not this one
        val silent = DecodeWatch()
        silent.onNal(1000, true)
        silent.onStamp(1L, 1000)
        assertFalse(silent.stalled(9000))
    }

    @Test
    fun aDecoderThatStopsMidStreamIsCaughtAndANewConnectionStartsClean() {
        val w = DecodeWatch()
        var stamp = 0L
        for (t in 1000L..5000L step 100) { w.onNal(t, true); w.onStamp(++stamp, t) }
        // the decoder dies: data still arrives, the stamp stands still
        var t = 5100L
        while (!w.stalled(t)) { w.onNal(t, true); w.onStamp(stamp, t); t += 100; assertTrue(t < 20_000) }
        assertTrue("about six seconds after the last picture", t in 10_900L..11_200L)
        w.reset()
        assertFalse(w.stalled(t + 100))
        w.onNal(t + 200, true)
        assertFalse(w.stalled(t + 300))
    }

    @Test
    fun whereTheStampNeverMovesTheWatchStaysQuietOnceTheDecoderRendered() {
        // a phone on which the time stamp cannot be read is not cut off every six seconds
        val w = DecodeWatch()
        w.onNal(1000, true)
        w.onFirstFrame(1300)
        for (t in 1400L..30_000L step 100) {
            w.onNal(t, true)
            w.onStamp(0L, t)
            assertFalse(w.stalled(t))
        }
        assertEquals(1L, w.decodedFrames)
    }

    @Test
    fun aStalledDecoderDropsTheConnectionAndTheSupervisorShowsLost() {
        var now = 0L
        var drops = 0
        val conn = object : RtspConnector {
            override fun run(transport: RtspTransport, events: RtspEvents) = ConnectEnd.FAILED
            override fun stop() {}
            override fun drop() { drops++ }
        }
        val src = RtspVideoSource("rtsp://192.0.2.5/stream", null, null, log = {}, nowMs = { now })
        src.connector = conn
        // frames are fed for six seconds and no picture comes out
        for (t in 1000L..7000L step 100) {
            now = t
            src.frameWatch.onFrame(NalKind.OTHER, true)
            if (src.watchOnce(7L, playing = true)) break
        }
        assertEquals(1, drops)
        assertEquals(7000L, now)
        // a healthy stream: no drop
        val ok = RtspVideoSource("rtsp://192.0.2.5/stream", null, null, log = {}, nowMs = { now })
        ok.connector = conn
        var stamp = 0L
        for (t in 1000L..20_000L step 100) {
            now = t
            ok.frameWatch.onFrame(NalKind.OTHER, true)
            assertFalse(ok.watchOnce(++stamp, playing = true))
        }
        assertEquals(1, drops)
        assertTrue(ok.decodedFrames > 0)

        // and what a dropped connection means one level up: the supervisor goes to LOST and tries again
        val script = Script(listOf(plays(ConnectEnd.DISCONNECTED), plays(ConnectEnd.STOPPED)))
        val states = ArrayList<CameraLinkState>()
        val waits = ArrayList<Long>()
        val sup = supervisor(script, TransportMode.TCP, Sink(), waits, 5)
        sup.onState = { states.add(it) }
        sup.runLoop()
        assertTrue(states.containsAll(listOf(CameraLinkState.PLAYING, CameraLinkState.LOST)))
        assertTrue(script.transports.size >= 2)
    }

    @Test
    fun aFailedDecoderDropsTheConnectionToo() {
        var drops = 0
        val src = RtspVideoSource("rtsp://192.0.2.5/stream", null, null, log = {})
        src.connector = object : RtspConnector {
            override fun run(transport: RtspTransport, events: RtspEvents) = ConnectEnd.FAILED
            override fun stop() {}
            override fun drop() { drops++ }
        }
        src.onDecoder(DecoderEvent.FIRST_FRAME)
        assertEquals(0, drops)
        src.onDecoder(DecoderEvent.FAILED)
        assertEquals(1, drops)
    }

    @Test
    fun theIngestWarningComesWhenFarFewerPicturesArriveAndGoesWhenTheyReturn() {
        val m = IngestMeter()
        var t = 0L
        fun run(fps: Int, seconds: Int): List<Boolean> {
            val out = ArrayList<Boolean>()
            val end = t + seconds * 1000L
            while (t < end) {
                if (fps > 0 && t % (1000 / fps) == 0L) m.onFrame(t)
                m.poll(t)?.let { out.add(it) }
                t += 1
            }
            return out
        }
        assertEquals(emptyList<Boolean>(), run(25, 20)) // a healthy camera: nothing
        assertFalse(m.isWeak)
        assertEquals(listOf(true), run(2, 20)) // the 22 Nov case: 1.7 frames a second
        assertTrue(m.isWeak)
        assertEquals(listOf(false), run(25, 20))
        assertFalse(m.isWeak)
        // a lost link has its own message: the warning is withdrawn with it
        run(2, 20)
        assertTrue(m.isWeak)
        assertEquals(false, m.restart())
        assertEquals(null, m.restart())
    }

    @Test
    fun aCameraThatIsSimplySlowIsNotCalledWeak() {
        // 12 frames a second all along is the camera's own rate, not a weak link
        val m = IngestMeter()
        val seen = ArrayList<Boolean>()
        for (t in 0L until 60_000L) {
            if (t % 83 == 0L) m.onFrame(t)
            m.poll(t)?.let { seen.add(it) }
        }
        assertEquals(emptyList<Boolean>(), seen)
    }

    @Test
    fun theWeakIngestWarningHasItsOwnKind() {
        assertEquals("weakIngest", SourceLogic.WARN_WEAK_INGEST)
    }
}
