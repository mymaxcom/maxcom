package my.maxcom.app.live

import org.junit.Assert.assertEquals
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
}
