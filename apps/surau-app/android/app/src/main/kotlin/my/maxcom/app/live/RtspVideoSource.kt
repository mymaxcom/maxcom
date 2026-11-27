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

    /**
     * Ends the connection that is running now, without stopping the connector for good: [run] returns and the
     * supervisor reconnects. Used when the picture stopped although data still arrives (C2).
     */
    fun drop() {}
}

/* ---- C1 and C2 (2026.11.15): what a weak link does to the picture, and how the phone notices ----

   Until now a weak Wi-Fi gave a broken picture at one or two frames a second and never a "lost": the only watchdog
   counted NAL units ARRIVING, the decoder's listener was empty, and when the frame queue overflowed the newest frame
   was dropped in the middle of a group of pictures, so every frame after it decoded as garbage until the next
   keyframe. Four small pure pieces fix that; the Android side only feeds them. */

/** What one buffer from the RTSP client holds. */
enum class NalKind {
    /** A keyframe (H.264 IDR, H.265 IRAP): decoding can start here. */
    KEY,
    /** Parameter sets (SPS, PPS, VPS): always passed on, the decoder needs them. */
    CONFIG,
    /** Any other picture data: only decodable after a keyframe. */
    OTHER;

    companion object {
        /**
         * Looks at the NAL units in the first [scan] bytes of an Annex B buffer (start codes `00 00 01`); a buffer
         * with no start code is read as one NAL unit. A keyframe anywhere in it makes it [KEY].
         */
        fun of(data: ByteArray, off: Int, len: Int, h265: Boolean, scan: Int = 1000): NalKind {
            val end = minOf(off + len, data.size, off + scan)
            var kind: NalKind? = null
            var i = off
            var found = false
            while (i + 3 < end) {
                if (data[i].toInt() == 0 && data[i + 1].toInt() == 0 && data[i + 2].toInt() == 1) {
                    found = true
                    kind = stronger(kind, typeKind(data[i + 3].toInt() and 0xFF, h265))
                    if (kind == KEY) return KEY
                    i += 4
                } else {
                    i++
                }
            }
            if (!found && off < end) return typeKind(data[off].toInt() and 0xFF, h265)
            return kind ?: OTHER
        }

        private fun stronger(a: NalKind?, b: NalKind): NalKind = when {
            a == KEY || b == KEY -> KEY
            a == CONFIG || b == CONFIG -> CONFIG
            else -> OTHER
        }

        private fun typeKind(header: Int, h265: Boolean): NalKind =
            if (h265) {
                when ((header shr 1) and 0x3F) {
                    in 16..21 -> KEY
                    32, 33, 34 -> CONFIG
                    else -> OTHER
                }
            } else {
                when (header and 0x1F) {
                    5 -> KEY
                    7, 8 -> CONFIG
                    else -> OTHER
                }
            }
    }
}

/**
 * C1: the decoder is fed whole groups of pictures only. After a (re)connection, and after any frame was dropped
 * because the queue was full, everything is held back until the next keyframe; parameter sets always pass. A drop
 * then costs the rest of one group of pictures, shown as the held last frame, instead of a smeared picture.
 *
 * The wait is bounded by [maxWaitMs]: a camera whose keyframes are rarer than that (or whose stream this code does
 * not read a keyframe out of) is fed as it comes, which is what happened before this gate existed.
 */
class KeyframeGate(private val maxWaitMs: Long = MAX_WAIT_MS) {
    @Volatile private var waiting = true
    @Volatile private var waitingSince = -1L

    /** Frames held back while waiting for a keyframe. */
    @Volatile var held = 0L
        private set

    val waitingForKey: Boolean get() = waiting

    /** A new connection: wait for its first keyframe. */
    fun reset() {
        waiting = true
        waitingSince = -1L
    }

    /** True when the frame may go to the decoder. [nowMs] bounds the wait. */
    fun admit(kind: NalKind, nowMs: Long = 0L): Boolean {
        if (kind == NalKind.CONFIG) return true
        if (waiting) {
            if (waitingSince < 0) waitingSince = nowMs
            if (kind != NalKind.KEY && nowMs - waitingSince < maxWaitMs) {
                held++
                return false
            }
            waiting = false
            waitingSince = -1L
        }
        return true
    }

    /** The queue was full and a frame was lost: nothing after it can be decoded until the next keyframe. */
    fun overflow() {
        waiting = true
        waitingSince = -1L
    }

    companion object {
        const val MAX_WAIT_MS = 5000L
    }
}

/**
 * C2: notices a decoder that produces no pictures although the camera keeps sending (the old watchdog saw the data
 * arrive and stayed quiet). "A picture came out" is read from the engine's SurfaceTexture time stamp, which moves with
 * every new decoded frame; the decoder's own "first frame" callback is the second witness. If the stamp is never seen
 * to move on this phone while the decoder says it rendered, the stamp cannot be trusted and the watch stays quiet
 * rather than cut a healthy picture. It also stops after [MAX_STALLS] stalls in a row with no picture in between:
 * reconnecting did not help, so it must not go on cutting the connection. Thread safe.
 */
class DecodeWatch(private val stallMs: Long = STALL_MS, private val flowMs: Long = 1500) {
    private var fedSince = 0L
    private var lastNalAt = 0L
    private var lastProgressAt = 0L
    private var lastStamp: Long? = null
    private var stampWorks = false
    private var firstFrame = false
    private var frames = 0L
    private var stallsInARow = 0

    /** Decoded pictures seen so far (a lower bound: the stamp is polled). */
    val decodedFrames: Long @Synchronized get() = frames

    /** A new connection (or the decoder waits for a keyframe again): the clock starts with the next frame fed. */
    @Synchronized
    fun reset() {
        fedSince = 0L
        lastNalAt = 0L
        lastProgressAt = 0L
        firstFrame = false
    }

    /** Data arrived from the camera; [fed] when it went on to the decoder (not held back by the keyframe gate). */
    @Synchronized
    fun onNal(nowMs: Long, fed: Boolean) {
        lastNalAt = nowMs
        if (fed) {
            if (fedSince == 0L) fedSince = nowMs
        } else {
            // waiting for a keyframe: nothing can come out, so the clock does not run
            fedSince = 0L
        }
    }

    /** The SurfaceTexture time stamp as polled now. */
    @Synchronized
    fun onStamp(stamp: Long, nowMs: Long) {
        val last = lastStamp
        if (last != null && stamp != last) {
            stampWorks = true
            lastProgressAt = nowMs
            frames++
            stallsInARow = 0
        }
        lastStamp = stamp
    }

    /** The decoder says it rendered its first picture of this connection. */
    @Synchronized
    fun onFirstFrame(nowMs: Long) {
        firstFrame = true
        frames++
        if (lastProgressAt < fedSince) lastProgressAt = nowMs
    }

    /** True when frames have been fed for [stallMs] and are still arriving, but no picture came out. */
    @Synchronized
    fun stalled(nowMs: Long): Boolean {
        if (fedSince == 0L) return false
        if (stallsInARow >= MAX_STALLS) return false // dropping the connection did not bring a picture back
        if (nowMs - lastNalAt > flowMs) return false // nothing arrives: that is the connection watchdog's case
        if (!stampWorks && firstFrame) return false // the stamp never moved here: it cannot be the judge
        return nowMs - maxOf(fedSince, lastProgressAt) >= stallMs
    }

    /** The owner acted on a stall (it dropped the connection): counted, and the clock starts again. */
    @Synchronized
    fun stallHandled() {
        stallsInARow++
        fedSince = 0L
        lastNalAt = 0L
        lastProgressAt = 0L
        firstFrame = false
    }

    companion object {
        const val STALL_MS = 6000L
        const val MAX_STALLS = 2
    }
}

/**
 * C1: says when the phone receives far fewer pictures than the camera sends (a weak Wi-Fi between the phone and the
 * camera). It compares the frames of each [windowMs] with the best window seen from this camera: below half of that
 * (or below [minFps]) for [need] windows in a row is "weak"; back above three quarters for as many windows clears it.
 * [poll] returns the new state when it changes, else null. Thread safe.
 */
class IngestMeter(
    private val windowMs: Long = 2000,
    private val need: Int = 3,
    private val minFps: Double = 5.0,
) {
    private var windowStart = 0L
    private var count = 0
    private var peakFps = 0.0
    private var low = 0
    private var good = 0
    private var weak = false

    val isWeak: Boolean @Synchronized get() = weak

    /** The link was lost or a new connection starts: the count starts again; the best rate of this camera is kept. */
    @Synchronized
    fun restart(): Boolean? {
        windowStart = 0L
        count = 0
        low = 0
        good = 0
        if (!weak) return null
        weak = false
        return false
    }

    @Synchronized
    fun onFrame(nowMs: Long) {
        if (windowStart == 0L) windowStart = nowMs
        count++
    }

    @Synchronized
    fun poll(nowMs: Long): Boolean? {
        if (windowStart == 0L || nowMs - windowStart < windowMs) return null
        val fps = count * 1000.0 / (nowMs - windowStart)
        windowStart = nowMs
        count = 0
        if (fps > peakFps) peakFps = fps
        val isLow = fps < minFps || fps < peakFps * 0.5
        val isGood = fps >= minFps && fps >= peakFps * 0.75
        low = if (isLow) low + 1 else 0
        good = if (isGood) good + 1 else 0
        if (!weak && low >= need) {
            weak = true
            return true
        }
        if (weak && good >= need) {
            weak = false
            return false
        }
        return null
    }
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

    override fun drop() {
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

/** What the decoder reports (C2: the listener used to be empty, so a dead decoder was silent). */
enum class DecoderEvent { FIRST_FRAME, FAILED }

/** What the sink tells its owner about one buffer: whether it went to the decoder, and whether it is picture data. */
fun interface FrameWatch {
    fun onFrame(kind: NalKind, fed: Boolean)
}

/** MediaCodec decoding onto [surface] through the library's decoder thread. */
class LibVideoSink(
    private val width: Int,
    private val height: Int,
    private val ensureHelper: () -> Unit,
    private val startDecoder: (mime: String, width: Int, height: Int, queue: VideoFrameQueue) -> () -> Unit,
    private val frameWatch: FrameWatch? = null,
) : VideoSink {
    constructor(
        surface: Surface, width: Int, height: Int, context: android.content.Context? = null,
        onDecoder: (DecoderEvent) -> Unit = {}, frameWatch: FrameWatch? = null,
    ) : this(
        width, height,
        ensureHelper = { DecoderHelper.ensure(context) },
        startDecoder = { mime, w, h, q ->
            val t = VideoDecoderSurfaceThread(
                surface, mime, w, h, 0, q,
                object : VideoDecodeThread.VideoDecoderListener {
                    override fun onVideoDecoderFirstFrameRendered() = onDecoder(DecoderEvent.FIRST_FRAME)

                    // The message may echo codec details; only the fact is passed on.
                    override fun onVideoDecoderFailed(message: String?) = onDecoder(DecoderEvent.FAILED)
                },
            )
            t.start()
            ({ t.stopAsync() })
        },
        frameWatch = frameWatch,
    )

    /** C1: whole groups of pictures only. */
    val gate = KeyframeGate()

    @Volatile private var queue: VideoFrameQueue? = null
    @Volatile private var stopDecoder: (() -> Unit)? = null
    @Volatile private var h265 = false

    override fun configure(mime: String, sps: ByteArray?, pps: ByteArray?, vps: ByteArray?) {
        stop()
        h265 = mime == MediaFormat.MIMETYPE_VIDEO_HEVC
        gate.reset() // a new connection starts at its first keyframe
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
        // The library's own reading counts too: what it calls a keyframe opens the gate.
        val kind = NalKind.of(data, off, len, h265).let { if (key && it == NalKind.OTHER) NalKind.KEY else it }
        if (!gate.admit(kind, System.nanoTime() / 1_000_000)) {
            frameWatch?.onFrame(kind, false)
            return
        }
        // The queue keeps the arrays; the client reuses its buffer, so copy the NAL unit.
        val taken = try {
            queue?.push(FrameQueue.VideoFrame(codec(), key, data.copyOfRange(off, off + len), 0, len, tsMs)) ?: false
        } catch (_: InterruptedException) {
            false
        }
        // C1: the queue was full, this frame is gone: what follows cannot be decoded until the next keyframe.
        if (!taken && kind != NalKind.CONFIG) gate.overflow()
        frameWatch?.onFrame(kind, taken)
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
    private val nowMs: () -> Long = { System.nanoTime() / 1_000_000 },
) : VideoSource() {
    /** C2: is the decoder producing pictures? Fed by [frameWatch], [onDecoder] and the watch thread. */
    val decodeWatch = DecodeWatch()

    /** C1: does the phone receive what the camera sends? */
    val ingestMeter = IngestMeter()

    /** Decoded camera pictures so far (a lower bound). The recorder reads it to tell an empty segment (B3). */
    val decodedFrames: Long get() = decodeWatch.decodedFrames

    /** Called (watch thread) when the received frame rate falls far below the camera's, and when it recovers. */
    @Volatile var onIngestWeak: ((Boolean) -> Unit)? = null

    /** Give this to the sink: every buffer is counted here. Called on the RTSP receive thread. */
    val frameWatch = FrameWatch { kind, fed ->
        val now = nowMs()
        decodeWatch.onNal(now, fed)
        if (kind != NalKind.CONFIG) ingestMeter.onFrame(now)
    }

    /** Give this to the sink: the decoder's own word. Called on the decoder thread. */
    val onDecoder: (DecoderEvent) -> Unit = { e ->
        when (e) {
            DecoderEvent.FIRST_FRAME -> decodeWatch.onFirstFrame(nowMs())
            DecoderEvent.FAILED -> {
                log("rtsp decoder_failed")
                dropConnection()
            }
        }
    }

    @Volatile internal var connector: RtspConnector? = null
    @Volatile private var watchThread: Thread? = null

    /** Ends the running connection so the supervisor shows "lost" and connects again with a fresh decoder. */
    private fun dropConnection() {
        try {
            connector?.drop()
        } catch (_: Exception) {
        }
    }

    /**
     * One look by the watch thread (also called by tests): the time stamp is read, a stalled decoder ends the
     * connection (C2), a weak or recovered link is reported (C1). Returns true when the connection was dropped.
     */
    fun watchOnce(stamp: Long?, playing: Boolean = supervisor?.state == CameraLinkState.PLAYING): Boolean {
        val now = nowMs()
        if (stamp != null) decodeWatch.onStamp(stamp, now)
        if (playing) {
            ingestMeter.poll(now)?.let { weak ->
                log("rtsp ingest_weak=$weak")
                onIngestWeak?.invoke(weak)
            }
            if (decodeWatch.stalled(now)) {
                log("rtsp decode_stall")
                decodeWatch.stallHandled()
                dropConnection()
                return true
            }
        }
        return false
    }

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
                decodeWatch.reset()
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
        val conn = connectorFactory()
        connector = conn
        val sup = RtspSupervisor(conn, mode, events, log = log)
        sup.onState = { st ->
            if (st == CameraLinkState.LOST) {
                // Keep the last frame on the SurfaceTexture; stop feeding the decoder; the camera sound stops with it.
                sink?.stop()
                sink = null
                audio?.onLost()
                decodeWatch.reset()
                // "lost" has its own message; the weak-link warning goes with it
                ingestMeter.restart()?.let { onIngestWeak?.invoke(it) }
            }
            onLinkState?.invoke(st)
        }
        supervisor = sup
        running = true
        thread = Thread({ sup.runLoop() }, "maxcom-rtsp").also {
            it.isDaemon = true
            it.start()
        }
        watchThread = Thread({
            try {
                while (running) {
                    Thread.sleep(WATCH_MS)
                    // getTimestamp moves when the engine latched a newly decoded frame
                    val stamp: Long? = try { surfaceTexture.timestamp } catch (_: Exception) { null }
                    watchOnce(stamp)
                }
            } catch (_: InterruptedException) {
            }
        }, "maxcom-rtsp-watch-decode").also {
            it.isDaemon = true
            it.start()
        }
    }

    override fun stop() {
        running = false
        watchThread?.interrupt()
        watchThread = null
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
        connector = null
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

    private companion object {
        const val WATCH_MS = 250L
    }
}
