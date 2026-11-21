package my.maxcom.app.live

import android.graphics.SurfaceTexture
import android.media.MediaFormat
import android.view.Surface
import com.alexvas.rtsp.RtspClient
import com.alexvas.rtsp.codec.FrameQueue
import com.alexvas.rtsp.codec.VideoCodecType
import com.alexvas.rtsp.codec.VideoDecodeThread
import com.alexvas.rtsp.codec.VideoDecoderSurfaceThread
import com.alexvas.rtsp.codec.VideoFrameQueue
import com.alexvas.utils.NetUtils
import com.alexvas.utils.VideoCodecUtils
import com.pedro.encoder.input.sources.video.VideoSource
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.math.min

/* The external camera's picture on the phone (plan rev 4, 3.1 option X and 4.5): an RTSP pull (library
   rtsp-client-android 6.1.3) -> H.264 or H.265 NAL units -> MediaCodec decoding straight onto the engine's
   SurfaceTexture. Everything after that (GL, encoder, SRT, YouTube leg, recording) is today's engine, which is why a
   source change can happen mid-live.

   Split in two so the logic is JVM-testable: [RtspSupervisor] (transport order, reconnect with backoff, the lost
   state, a stall watchdog hook) talks to a small [RtspConnector]; [RtspVideoSource] is the RootEncoder VideoSource that
   owns the decoder and the Surface. On loss the decoder stops feeding but the SurfaceTexture keeps the last frame;
   [CameraLinkState.LOST] and [lostSinceMs] are what the engine reads to draw "Siaran akan bersambung sebentar lagi" and
   to stop after 10 minutes (K2).

   The library's widgets (its Rtsp view classes) are not used, so [DecoderHelper] initialises the library's
   MediaCodecHelper itself before the first decoder starts; without it every decoder fails and no video frame appears. */

/** The user's transport choice: "Automatik" (TCP then UDP), "TCP", "UDP". */
enum class TransportMode {
    AUTO, TCP, UDP;

    /** The order to try, the transport that worked last time first. */
    fun order(lastGood: RtspTransport? = null): List<RtspTransport> {
        val base = when (this) {
            AUTO -> listOf(RtspTransport.TCP, RtspTransport.UDP)
            TCP -> listOf(RtspTransport.TCP)
            UDP -> listOf(RtspTransport.UDP)
        }
        return if (lastGood != null && base.contains(lastGood)) listOf(lastGood) + base.filter { it != lastGood } else base
    }

    companion object {
        fun parse(s: String?): TransportMode = when (s?.lowercase()) {
            "tcp" -> TCP
            "udp" -> UDP
            else -> AUTO
        }
    }
}

enum class RtspTransport { TCP, UDP }

enum class CameraLinkState { IDLE, CONNECTING, PLAYING, LOST, STOPPED }

/** What the connection learned from the SDP. */
class CameraStreamInfo(
    val videoMime: String?, // "video/avc" | "video/hevc" | null
    val sps: ByteArray?,
    val pps: ByteArray?,
    val vps: ByteArray?,
    val audioCodec: CameraAudioCodec,
    val audioRate: Int,
    val audioChannels: Int,
    val audioConfig: ByteArray?,
)

/** Events from one connection (called on its own thread). */
interface RtspEvents {
    fun onConnected(info: CameraStreamInfo)
    fun onVideo(data: ByteArray, off: Int, len: Int, tsMs: Long)
    fun onAudio(data: ByteArray, off: Int, len: Int, tsMs: Long)
}

enum class ConnectEnd { UNAUTHORIZED, FAILED, DISCONNECTED, STOPPED }

/** One RTSP connection attempt. [run] blocks until the connection ends. The real one is [LibRtspConnector]. */
interface RtspConnector {
    fun run(transport: RtspTransport, events: RtspEvents): ConnectEnd
    fun stop()
}

/** Wait times between reconnect attempts: 2, 3, 5, then 8 seconds, until [reset] (a connection that played). */
class Backoff(private val steps: LongArray = longArrayOf(2000, 3000, 5000, 8000)) {
    private var i = 0

    fun next(): Long = steps[min(i++, steps.size - 1)]
    fun reset() {
        i = 0
    }
}

/**
 * Keeps one camera connected: tries the transports in order, remembers the one that worked, reconnects with backoff,
 * and tracks the lost state. [sleep] returns false when stopped while waiting. Runs on the caller's thread.
 */
class RtspSupervisor(
    private val connector: RtspConnector,
    private val mode: TransportMode,
    private val events: RtspEvents,
    private val backoff: Backoff = Backoff(),
    private val nowMs: () -> Long = System::currentTimeMillis,
    private val sleep: (Long) -> Boolean = { ms ->
        try {
            Thread.sleep(ms)
            true
        } catch (_: InterruptedException) {
            false
        }
    },
    private val log: (String) -> Unit = RtspLogger.default,
) {
    @Volatile var state = CameraLinkState.IDLE
        private set
    /** When the picture was last lost (epoch ms); 0 while playing or before the first connection. */
    @Volatile var lostSinceMs = 0L
        private set
    @Volatile var transport: RtspTransport? = null
        private set
    /** Why the last attempt failed: LOGIN (401) or OTHER. */
    @Volatile var lastFailure: ProbeFailure? = null
        private set
    @Volatile var attempts = 0
        private set
    @Volatile private var stopped = false
    var onState: ((CameraLinkState) -> Unit)? = null

    fun stop() {
        stopped = true
        connector.stop()
    }

    private fun set(s: CameraLinkState) {
        if (state == s) return
        state = s
        onState?.invoke(s)
    }

    fun runLoop() {
        while (!stopped) {
            if (state != CameraLinkState.LOST) set(CameraLinkState.CONNECTING)
            for (t in mode.order(transport)) {
                if (stopped) break
                attempts++
                var gotMedia = false
                val wrapped = object : RtspEvents {
                    override fun onConnected(info: CameraStreamInfo) = events.onConnected(info)
                    override fun onVideo(data: ByteArray, off: Int, len: Int, tsMs: Long) {
                        if (!gotMedia) {
                            gotMedia = true
                            transport = t
                            lostSinceMs = 0
                            lastFailure = null
                            backoff.reset()
                            set(CameraLinkState.PLAYING)
                            log("rtsp playing transport=${t.name.lowercase()}")
                        }
                        events.onVideo(data, off, len, tsMs)
                    }

                    override fun onAudio(data: ByteArray, off: Int, len: Int, tsMs: Long) = events.onAudio(data, off, len, tsMs)
                }
                val end = connector.run(t, wrapped)
                if (stopped || end == ConnectEnd.STOPPED) break
                if (gotMedia) {
                    break // it worked on this transport; a drop is a loss, not a transport problem
                }
                if (end == ConnectEnd.UNAUTHORIZED) {
                    lastFailure = ProbeFailure.LOGIN
                    break // another transport cannot fix a wrong password
                }
                lastFailure = ProbeFailure.OTHER
                log("rtsp transport_failed ${t.name.lowercase()} end=${end.name.lowercase()}")
            }
            if (stopped) break
            if (lostSinceMs == 0L) lostSinceMs = nowMs()
            set(CameraLinkState.LOST)
            if (!sleep(backoff.next())) break
        }
        set(CameraLinkState.STOPPED)
    }
}

/** Splits `rtsp://user:pass@host:port/path` into the address without login and the login (percent-decoded). */
object RtspUrl {
    class Parts(val uri: String, val host: String, val port: Int, val user: String?, val password: String?)

    fun split(url: String, user: String? = null, password: String? = null): Parts {
        val p = RtspProbe.parseUrl(url)
        val u = user?.takeIf { it.isNotEmpty() } ?: p.user
        val pw = if (!user.isNullOrEmpty()) password else (password ?: p.password)
        return Parts(p.requestUri, p.host, p.port, u, pw)
    }
}

/** The real connection on rtsp-client-android. [stallMs] ends a connection that stops delivering pictures. */
class LibRtspConnector(
    url: String,
    user: String?,
    password: String?,
    private val connectTimeoutMs: Int = 5000,
    private val firstFrameMs: Long = 8000,
    private val stallMs: Long = 6000,
    private val nowMs: () -> Long = System::currentTimeMillis,
    private val log: (String) -> Unit = RtspLogger.default,
) : RtspConnector {
    private val parts = RtspUrl.split(url, user, password)
    // One flag per run: the watchdog sets it on a stall, and the next run must start clear.
    @Volatile private var exit = AtomicBoolean(false)

    @Volatile private var socket: java.net.Socket? = null

    override fun stop() {
        stoppedByCaller = true
        exit.set(true)
        try {
            socket?.close()
        } catch (_: Exception) {
        }
    }

    override fun run(transport: RtspTransport, events: RtspEvents): ConnectEnd {
        // A stop() that landed before run() (or between transport attempts) must stand: this connector is used once.
        if (stoppedByCaller) return ConnectEnd.STOPPED
        val exit = AtomicBoolean(false)
        this.exit = exit
        if (stoppedByCaller) return ConnectEnd.STOPPED // a stop() between the first check and the new flag
        var unauthorized = false
        var lastVideoAt = nowMs()
        var gotVideo = false
        val listener = object : RtspClient.RtspClientListener {
            override fun onRtspConnecting() {}
            override fun onRtspConnected(sdpInfo: RtspClient.SdpInfo) {
                events.onConnected(infoFrom(sdpInfo))
            }

            override fun onRtspVideoNalUnitReceived(data: ByteArray, offset: Int, length: Int, timestamp: Long) {
                gotVideo = true
                lastVideoAt = nowMs()
                events.onVideo(data, offset, length, timestamp)
            }

            override fun onRtspAudioSampleReceived(data: ByteArray, offset: Int, length: Int, timestamp: Long) {
                events.onAudio(data, offset, length, timestamp)
            }

            override fun onRtspApplicationDataReceived(data: ByteArray, offset: Int, length: Int, timestamp: Long) {}
            override fun onRtspDisconnecting() {}
            override fun onRtspDisconnected() {}
            override fun onRtspFailedUnauthorized() {
                unauthorized = true
            }

            override fun onRtspFailed(message: String?) {
                // The text may echo the address; the masked address is all that is logged.
                log("rtsp failed ${RtspMask.redact(message ?: "", parts.password).take(80)}")
            }
        }
        val startedAt = nowMs()
        val watchdog = Thread({
            try {
                while (!exit.get()) {
                    Thread.sleep(500)
                    val idle = nowMs() - (if (gotVideo) lastVideoAt else startedAt)
                    if (idle > (if (gotVideo) stallMs else firstFrameMs) + (if (gotVideo) 0 else connectTimeoutMs)) {
                        log("rtsp stall idle_ms=$idle")
                        exit.set(true)
                        try {
                            socket?.close()
                        } catch (_: Exception) {
                        }
                    }
                }
            } catch (_: InterruptedException) {
            }
        }, "maxcom-rtsp-watch")
        watchdog.isDaemon = true
        var s: java.net.Socket? = null
        try {
            s = NetUtils.createSocketAndConnect(parts.host, parts.port, connectTimeoutMs)
            socket = s
            watchdog.start()
            val client = RtspClient.Builder(s, parts.uri, exit, listener)
                .requestVideo(true)
                .requestAudio(true)
                .requestApplication(false)
                .withDebug(false)
                .withCredentials(parts.user, parts.password)
                .withTransport(if (transport == RtspTransport.UDP) RtspClient.Transport.UDP else RtspClient.Transport.TCP)
                .build()
            client.execute()
        } catch (e: Exception) {
            if (stoppedByCaller) return ConnectEnd.STOPPED
            if (exit.get()) return ConnectEnd.FAILED
            log("rtsp error ${e.javaClass.simpleName}")
            return if (unauthorized) ConnectEnd.UNAUTHORIZED else ConnectEnd.FAILED
        } finally {
            watchdog.interrupt()
            NetUtils.closeSocket(s)
            socket = null
        }
        return when {
            stoppedByCaller -> ConnectEnd.STOPPED
            unauthorized -> ConnectEnd.UNAUTHORIZED
            else -> ConnectEnd.DISCONNECTED
        }
    }

    @Volatile private var stoppedByCaller = false

    private fun infoFrom(sdp: RtspClient.SdpInfo): CameraStreamInfo {
        val v = sdp.videoTrack
        val a = sdp.audioTrack
        val mime = when (v?.videoCodec) {
            RtspClient.VIDEO_CODEC_H264 -> MediaFormat.MIMETYPE_VIDEO_AVC
            RtspClient.VIDEO_CODEC_H265 -> MediaFormat.MIMETYPE_VIDEO_HEVC
            else -> null // AV1 is not decoded on the phone path: no picture
        }
        return CameraStreamInfo(
            videoMime = mime, sps = v?.sps, pps = v?.pps, vps = v?.vps,
            audioCodec = if (a == null) CameraAudioCodec.NONE else RtspAudioSource.codecFromSdp(a.audioCodec),
            audioRate = a?.sampleRateHz ?: 0, audioChannels = a?.channels ?: 0, audioConfig = a?.config,
        )
    }
}

/** The decoder side, so the supervisor events can be tested without MediaCodec. */
interface VideoSink {
    fun configure(mime: String, sps: ByteArray?, pps: ByteArray?, vps: ByteArray?)
    fun push(data: ByteArray, off: Int, len: Int, tsMs: Long)
    fun stop()
}

/**
 * Runs [init] until it has succeeded once per process and never throws: a failure is reported once through [warn] and
 * swallowed (the decoder start then fails as it would have and the existing error path reports it).
 */
class OnceInit(private val init: () -> Unit, private val warn: (Throwable) -> Unit) {
    private val done = AtomicBoolean(false)
    private val warned = AtomicBoolean(false)

    // Synchronized: a second caller waits until the first init has finished, so no decoder starts before the helper is ready.
    // A failed init is tried again at the next call (the next decoder start); the warning is given once.
    @Synchronized
    fun ensure() {
        if (done.get()) return
        try {
            init()
            done.set(true)
        } catch (t: Throwable) {
            if (!warned.compareAndSet(false, true)) return
            try {
                warn(t)
            } catch (_: Throwable) {
            }
        }
    }
}

/** The library's decoder needs MediaCodecHelper initialised first; its own widgets do it, we use none of them. */
object DecoderHelper {
    private const val TAG = "DecoderHelper"

    /** Context of the first caller; one init per process is enough (the helper guards itself too). */
    @Volatile private var ctx: android.content.Context? = null
    private val once = OnceInit(
        init = {
            // Same call as the library widget's initView: application context and an empty glRenderer string.
            com.limelight.binding.video.MediaCodecHelper.initialize(ctx!!, "")
        },
        warn = { android.util.Log.w(TAG, "MediaCodecHelper init failed: $it") },
    )

    fun ensure(context: android.content.Context?) {
        if (context == null) return
        ctx = context.applicationContext ?: context
        once.ensure()
    }
}

/** MediaCodec decoding onto [surface] through the library's decoder thread. */
class LibVideoSink(
    private val width: Int,
    private val height: Int,
    private val ensureHelper: () -> Unit,
    private val startDecoder: (mime: String, width: Int, height: Int, queue: VideoFrameQueue) -> () -> Unit,
) : VideoSink {
    constructor(surface: Surface, width: Int, height: Int, context: android.content.Context? = null) : this(
        width, height,
        ensureHelper = { DecoderHelper.ensure(context) },
        startDecoder = { mime, w, h, q ->
            val t = VideoDecoderSurfaceThread(
                surface, mime, w, h, 0, q, object : VideoDecodeThread.VideoDecoderListener {},
            )
            t.start()
            ({ t.stopAsync() })
        },
    )

    @Volatile private var queue: VideoFrameQueue? = null
    @Volatile private var stopDecoder: (() -> Unit)? = null
    @Volatile private var h265 = false

    override fun configure(mime: String, sps: ByteArray?, pps: ByteArray?, vps: ByteArray?) {
        stop()
        h265 = mime == MediaFormat.MIMETYPE_VIDEO_HEVC
        val q = VideoFrameQueue(60)
        queue = q
        if (sps != null && pps != null) {
            // The decoder needs the parameter sets first; the library's own view does the same.
            val v = vps ?: ByteArray(0)
            val data = ByteArray(sps.size + pps.size + v.size)
            sps.copyInto(data, 0)
            pps.copyInto(data, sps.size)
            v.copyInto(data, sps.size + pps.size)
            q.push(FrameQueue.VideoFrame(codec(), true, data, 0, data.size, 0))
        }
        ensureHelper()
        stopDecoder = startDecoder(mime, width, height, q)
    }

    private fun codec() = if (h265) VideoCodecType.H265 else VideoCodecType.H264

    override fun push(data: ByteArray, off: Int, len: Int, tsMs: Long) {
        val key = VideoCodecUtils.isAnyKeyFrame(data, off, min(len, 1000), h265)
        // The queue keeps the arrays; the client reuses its buffer, so copy the NAL unit.
        queue?.push(FrameQueue.VideoFrame(codec(), key, data.copyOfRange(off, off + len), 0, len, tsMs))
    }

    override fun stop() {
        stopDecoder?.invoke()
        stopDecoder = null
        queue = null
    }
}

/**
 * RootEncoder VideoSource (2.8.1: create / start(SurfaceTexture) / stop / release / isRunning) that draws the camera
 * picture into the engine's SurfaceTexture. [audio] receives the camera's audio samples and format.
 */
class RtspVideoSource(
    private val url: String,
    private val user: String?,
    private val password: String?,
    private val mode: TransportMode = TransportMode.AUTO,
    private val audio: RtspAudioSource? = null,
    private val connectorFactory: () -> RtspConnector = { LibRtspConnector(url, user, password) },
    private val sinkFactory: (Surface, Int, Int) -> VideoSink = { s, w, h -> LibVideoSink(s, w, h) },
    private val log: (String) -> Unit = RtspLogger.default,
) : VideoSource() {
    // Touched from the supervisor thread and the main thread.
    @Volatile private var supervisor: RtspSupervisor? = null
    @Volatile private var thread: Thread? = null
    @Volatile private var surface: Surface? = null
    @Volatile private var sink: VideoSink? = null
    @Volatile private var running = false

    /** Called on every link state change (supervisor thread): K2 shows the message while LOST. */
    @Volatile var onLinkState: ((CameraLinkState) -> Unit)? = null

    val linkState: CameraLinkState get() = supervisor?.state ?: CameraLinkState.IDLE
    /** Epoch ms when the picture was lost, or 0. K2 stops the live after 10 minutes. */
    val lostSinceMs: Long get() = supervisor?.lostSinceMs ?: 0L
    val lastFailure: ProbeFailure? get() = supervisor?.lastFailure
    val transportInUse: RtspTransport? get() = supervisor?.transport

    override fun create(width: Int, height: Int, fps: Int, rotation: Int): Boolean {
        log("rtsp video create ${width}x$height fps=$fps rot=$rotation ${RtspMask.maskUrl(url)}")
        return true
    }

    override fun start(surfaceTexture: SurfaceTexture) {
        if (running) return
        this.surfaceTexture = surfaceTexture
        try {
            surfaceTexture.setDefaultBufferSize(width, height)
        } catch (_: Exception) {
        }
        val surf = Surface(surfaceTexture)
        surface = surf
        val events = object : RtspEvents {
            override fun onConnected(info: CameraStreamInfo) {
                audio?.onFormat(info.audioCodec, info.audioRate, info.audioChannels, info.audioConfig)
                sink?.stop()
                val mime = info.videoMime ?: return
                val s = sinkFactory(surf, width, height)
                sink = s
                s.configure(mime, info.sps, info.pps, info.vps)
            }

            override fun onVideo(data: ByteArray, off: Int, len: Int, tsMs: Long) {
                sink?.push(data, off, len, tsMs)
            }

            override fun onAudio(data: ByteArray, off: Int, len: Int, tsMs: Long) {
                audio?.onSample(data, off, len)
            }
        }
        val sup = RtspSupervisor(connectorFactory(), mode, events, log = log)
        sup.onState = { st ->
            if (st == CameraLinkState.LOST) {
                // Keep the last frame on the SurfaceTexture; stop feeding the decoder; the camera sound stops with it.
                sink?.stop()
                sink = null
                audio?.onLost()
            }
            onLinkState?.invoke(st)
        }
        supervisor = sup
        running = true
        thread = Thread({ sup.runLoop() }, "maxcom-rtsp").also {
            it.isDaemon = true
            it.start()
        }
    }

    override fun stop() {
        running = false
        supervisor?.stop()
        thread?.let {
            it.interrupt()
            try {
                it.join(1500)
            } catch (_: InterruptedException) {
            }
        }
        thread = null
        supervisor = null
        sink?.stop()
        sink = null
        audio?.onLost()
        try {
            surface?.release()
        } catch (_: Exception) {
        }
        surface = null
    }

    override fun release() {
        stop()
        audio?.release()
    }

    override fun isRunning(): Boolean = running
}
