package my.maxcom.app.live

import android.content.ContentValues
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.hardware.camera2.CameraCharacteristics
import android.hardware.camera2.CameraManager
import android.graphics.Color
import android.graphics.SurfaceTexture
import android.hardware.display.DisplayManager
import android.media.MediaFormat
import android.net.Uri
import android.os.BatteryManager
import android.os.Build
import android.os.Environment
import android.os.Handler
import android.os.Looper
import android.os.PowerManager
import android.os.StatFs
import android.os.SystemClock
import android.provider.MediaStore
import android.view.Display
import android.view.Surface
import android.util.Log
import android.view.TextureView
import com.pedro.common.ConnectChecker
import com.pedro.encoder.input.gl.render.filters.`object`.TextObjectFilterRender
import com.pedro.encoder.input.sources.OrientationConfig
import com.pedro.encoder.input.sources.OrientationForced
import com.pedro.encoder.input.sources.audio.AudioSource
import com.pedro.encoder.input.sources.audio.MicrophoneSource
import com.pedro.encoder.input.sources.video.Camera2Source
import com.pedro.encoder.input.sources.video.VideoSource
import com.pedro.encoder.input.video.CameraHelper
import com.pedro.library.view.GlStreamInterface
import com.pedro.library.multiple.MultiStream
import com.pedro.library.multiple.MultiType
import com.pedro.library.base.recording.RecordController
import com.pedro.encoder.utils.ViewPort
import com.pedro.encoder.utils.gl.AspectRatioMode
import com.pedro.encoder.utils.gl.TranslateTo
import com.pedro.library.util.streamclient.SrtStreamClient
import java.io.File
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.concurrent.Executors

/**
 * Pure rules the engine and its unit tests share.
 */
object LiveLogic {
    /** Reconnect delay for attempt 1, 2, 3 ...: 2, 4, 8, 16, then 30 s for ever. */
    fun backoffSeconds(attempt: Int): Int {
        if (attempt <= 1) return 2
        val d = 2L shl (attempt - 1).coerceAtMost(5)
        return d.coerceAtMost(30L).toInt()
    }

    /** Letters, digits, underscore and dash only; never empty; at most 40. */
    fun sanitizePrefix(prefix: String?): String {
        val s = (prefix ?: "").replace(Regex("[^A-Za-z0-9_-]"), "-").take(40)
        return if (s.isEmpty()) "siaran" else s
    }

    /** The output is always upright 16:9, whatever way the device is held. */
    const val STREAM_WIDTH = 1280
    const val STREAM_HEIGHT = 720

    /**
     * The `rotation` given to RootEncoder's `prepareVideo`. A rotation of 90 or
     * 270 makes it swap width and height (a 9:16 encoder), and the output must
     * stay 1280x720, so it is always 0. RootEncoder turns the picture upright
     * on the GL side (its own camera pass), see [LiveEngine].
     */
    const val PREPARE_ROTATION = 0

    /** `Surface.ROTATION_0..3` as degrees (0, 90, 180, 270). */
    fun displayDegrees(surfaceRotation: Int): Int = ((surfaceRotation % 4) + 4) % 4 * 90

    /**
     * True when the device is held upright or upside down (display rotation 0
     * or 180): the upright camera picture is then portrait shaped and only a
     * centred 16:9 band of it is sent (see [cropViewport]). RootEncoder turns
     * the picture itself; this is only the shape.
     */
    fun isPortrait(displayDegrees: Int): Boolean {
        val d = ((displayDegrees % 360) + 360) % 360
        return d == 0 || d == 180
    }

    /**
     * The one diagnostic line (orientation facts only, never a URL or secret):
     * display rotation, RootEncoder's own camera orientation value, the sensor
     * angle, camera facing, preview aspect mode and encoder size.
     */
    fun orientationLine(
        displayDeg: Int, cameraOrientation: Int, sensorOrientation: Int,
        front: Boolean, aspect: String, w: Int, h: Int,
    ): String =
        "orientation display=$displayDeg camera=$cameraOrientation sensor=$sensorOrientation " +
            "facing=${if (front) "front" else "back"} aspect=$aspect enc=${w}x$h"

    /**
     * The GL viewport [x, y, w, h] that fills a [surfaceW] x [surfaceH] surface
     * with the upright portrait camera frame (9:16): scaled to the surface
     * width, so only the centred 16:9 band is inside the surface and the rest
     * falls outside it (a viewport is not clipped by RootEncoder). Null when
     * the device is held in landscape: the frame is 16:9 already and uses the
     * default viewport.
     */
    fun cropViewport(surfaceW: Int, surfaceH: Int, portrait: Boolean): IntArray? {
        if (!portrait || surfaceW <= 0 || surfaceH <= 0) return null
        val h = (surfaceW * 16L / 9).toInt()
        return intArrayOf(0, (surfaceH - h) / 2, surfaceW, h)
    }

    /** What `startYoutube` should do. */
    enum class YoutubeStart { OPEN, ALREADY_UP, NOT_LIVE, STOPPING, NO_URL }

    /** Pure state decision for opening the YouTube leg on a running stream. */
    fun youtubeStartDecision(
        live: Boolean, stopping: Boolean, hasStream: Boolean, wantYoutube: Boolean, url: String?,
    ): YoutubeStart = when {
        stopping -> YoutubeStart.STOPPING
        !live || !hasStream -> YoutubeStart.NOT_LIVE
        url.isNullOrBlank() -> YoutubeStart.NO_URL
        wantYoutube -> YoutubeStart.ALREADY_UP
        else -> YoutubeStart.OPEN
    }

    /**
     * `MAXCOM-<date>-<HHmm>-<prefix>-<nn>.mp4`; [date] is yyyy-MM-dd and [time] is HHmm, both taken when
     * the live starts, so every file of one live shares them and a second live of the same day and
     * prefix gets other names (naming scheme 2, Plan 6 gate 2). Files named without the HHmm part
     * (the older scheme) are never touched by the app.
     */
    fun segmentName(date: String, time: String, prefix: String?, n: Int): String =
        "MAXCOM-$date-$time-${sanitizePrefix(prefix)}-${n.toString().padStart(2, '0')}.mp4"

    /**
     * The first name at index [from] or higher that [taken] does not know. Nothing existing is ever
     * reused, overwritten or left to MediaStore to rename ("name (1).mp4").
     */
    fun freeSegmentName(date: String, time: String, prefix: String?, from: Int, taken: (String) -> Boolean): Pair<String, Int> {
        var n = from.coerceAtLeast(1)
        while (n < 10_000) {
            val name = segmentName(date, time, prefix, n)
            if (!taken(name)) return name to n
            n++
        }
        throw IllegalStateException("no_free_name")
    }

    /**
     * The SRT address the engine dials; the passphrase rides the query. RootEncoder
     * passes the query values to the SRT handshake verbatim (no URL decoding) and
     * MediaMTX needs `publish:path:user:pass` with plain colons, so nothing is
     * percent-encoded. The box issues alphanumeric credentials only.
     */
    fun srtUrl(host: String, port: Int, streamId: String, passphrase: String?): String {
        val sb = StringBuilder("srt://").append(host).append(':').append(port)
            .append("?streamid=").append(streamId)
        if (!passphrase.isNullOrEmpty()) {
            sb.append("&passphrase=").append(passphrase)
        }
        return sb.toString()
    }
}

/**
 * Says whether orientation work may touch the GL interface. Closed until a
 * session is prepared, paused while a stop is running, closed again on release.
 * A late display callback or posted reframe then does nothing, so it cannot
 * race the recorder or the GL being torn down.
 */
class OrientationGuard {
    private enum class S { CLOSED, OPEN, PAUSED }

    @Volatile private var s = S.CLOSED
    fun open() { s = S.OPEN }
    fun pause() { if (s == S.OPEN) s = S.PAUSED }
    fun resume() { if (s == S.PAUSED) s = S.OPEN }
    fun close() { s = S.CLOSED }
    fun allows(): Boolean = s == S.OPEN
}

class SrtTarget(val host: String, val port: Int, val streamId: String, val passphrase: String?)

class RecordCfg(val prefix: String, val segmentMinutes: Int)

/**
 * One camera capture and one H.264 encoder (RootEncoder [MultiStream]) feeding
 * up to two network legs: `kiosk` over SRT and `youtube` over RTMPS. Each leg
 * connects and reconnects on its own; the MP4 recorder is independent of both.
 * All control calls happen on the main thread. Secrets (stream key, SRT
 * passphrase) are held only inside the connect strings of the running
 * clients; this class never logs them and events carry reason codes only.
 */
class LiveEngine private constructor(private val app: Context) {
    companion object {
        @Volatile private var instance: LiveEngine? = null

        fun get(context: Context): LiveEngine =
            instance ?: synchronized(this) {
                instance ?: LiveEngine(context.applicationContext).also { Diag.init(context); instance = it }
            }

        const val RECORD_SUBDIR = "Movies/MAXCOM"
        private const val SESSION_PREFS = "maxcom_live_session"
        private const val SESSION_KEY = "names"
        // File names hold letters, digits, dash, underscore and a dot only, so a comma never occurs in one.
        private const val SESSION_SEP = ","
        private const val TAG = "MaxcomLive"
        private const val LOW_BATTERY_PERCENT = 15
        private const val STOP_RECORD_BATTERY_PERCENT = 5
        private const val LOW_STORAGE_BYTES = 1_500L * 1024 * 1024
        private const val STOP_RECORD_STORAGE_BYTES = 300L * 1024 * 1024
        // The engine's audio rate; the aligner works at 16 kHz and searches up to 4 s of lag (the camera is late by
        // 0.3 to 1 s, plus the headroom the unit may carry).
        private const val AUDIO_RATE = 48_000
        private const val ALIGN_RATE = 16_000
        private const val ALIGN_MAX_LAG_MS = 4_000
        private const val METER_MS = 250L
    }

    fun interface Sink { fun send(event: Map<String, Any?>) }

    @Volatile var sink: Sink? = null

    private val main = Handler(Looper.getMainLooper())
    private val io = Executors.newSingleThreadExecutor()
    // The stop runs here, off the main thread; the recorder step has its own
    // thread so a hung muxer can be given up on (StopSequence).
    private val stopExec = Executors.newSingleThreadExecutor()
    private val recordExec = Executors.newCachedThreadPool()

    // A stop is under way: no preview teardown, prepare or start until it ends.
    @Volatile private var stopping = false
    private var pendingPreviewStop = false
    private val stopWaiters = mutableListOf<() -> Unit>()

    private var camera: Camera2Source? = null
    private var mic: MicrophoneSource? = null
    private var stream: MultiStream? = null
    private var previewView: TextureView? = null
    private var previewing = false
    private var frontCamera = false
    private var displayListenerOn = false
    private val guard = OrientationGuard()
    private var lastOrientationLine: String? = null

    // ---- sources (plan rev 4: phone camera, or the external camera the phone pulls) ----
    @Volatile private var videoKind = VideoKind.PHONE
    private var mixCfg = AudioMixCfg.default(VideoKind.PHONE)
    private var userMuted = false
    private var restorePhoneOrientation = false
    // Held in memory only for the session; never logged, never written (it may carry the camera login).
    private var extCam: ExternalCamera? = null
    @Volatile private var rtspVideo: RtspVideoSource? = null
    private var rtspAudio: RtspAudioSource? = null
    private var mixedAudio: MixedAudioSource? = null
    private var aligner: AudioAligner? = null
    private var appliedMicEnabled: Boolean? = null
    @Volatile private var camW = 0
    @Volatile private var camH = 0
    private var lostFilter: TextObjectFilterRender? = null
    private var liveStartedEpochMs = 0L
    private var endedByCamera = false
    private val camSilence = SilenceTracker()
    private val micSilence = SilenceTracker()
    // clap test (fallback for a camera with no audio track)
    private var clapCapturing = false
    private var clapSavedOffset = 0
    private var clapReplay: ClapReplay? = null

    var prepared = false; private set
    var live = false; private set

    private var wantKiosk = false
    private var wantYoutube = false
    private val attempts = mutableMapOf("kiosk" to 0, "youtube" to 0)
    private val bitrates = mutableMapOf("kiosk" to 0L, "youtube" to 0L)
    private var fps = 0
    private var startedAt = 0L

    // recording
    private var recordCfg: RecordCfg? = null
    private var recording = false
    private var segmentIndex = 0
    private var segmentFile: File? = null
    // Naming scheme 2: date and HHmm of the live start, and the last index used for a name.
    private var liveDate = ""
    private var liveTime = ""
    private var nameIndex = 0
    // The exact names this live wrote (the only files the clean-up and the catch-up may ever use).
    private val sessionNames = mutableListOf<String>()
    private var publishedBytes = 0L
    private var recordError: String? = null
    private var recordHalted = false
    private val warnings = mutableSetOf<String>()

    // ---- events ----

    private fun emit(e: Map<String, Any?>) {
        val s = sink ?: return
        main.post { s.send(e) }
    }

    private fun phase(v: String) = emit(mapOf("type" to "phase", "value" to v))

    private fun output(name: String, state: String, retryInSec: Int? = null, message: String? = null) =
        emit(
            mapOf(
                "type" to "output", "name" to name, "state" to state,
                "retryInSec" to retryInSec, "message" to message,
            ),
        )

    private fun warn(kind: String, active: Boolean) {
        val changed = if (active) warnings.add(kind) else warnings.remove(kind)
        if (changed) emit(mapOf("type" to "warning", "kind" to kind, "active" to active))
    }

    private fun recordingEvent() = emit(
        mapOf(
            "type" to "recording", "segments" to segmentIndex,
            "bytes" to publishedBytes + (segmentFile?.length() ?: 0L),
            "lastError" to recordError,
        ),
    )

    // ---- prepare and preview ----

    /** Names of the cameras present: `back` and/or `front`. */
    fun cameras(): List<String> {
        val cm = app.getSystemService(Context.CAMERA_SERVICE) as CameraManager
        val out = mutableListOf<String>()
        for (id in cm.cameraIdList) {
            when (cm.getCameraCharacteristics(id).get(CameraCharacteristics.LENS_FACING)) {
                CameraCharacteristics.LENS_FACING_BACK -> if ("back" !in out) out += "back"
                CameraCharacteristics.LENS_FACING_FRONT -> if ("front" !in out) out += "front"
            }
        }
        return out
    }

    /** The two sources of one picture kind, built fresh (RootEncoder releases the old ones on a change). */
    private class Built(val video: VideoSource, val audio: AudioSource)

    /**
     * Builds the sources for [spec]. The phone camera is today's `Camera2Source` + `MicrophoneSource`; the external
     * camera is `RtspVideoSource` + `MixedAudioSource` (camera sound as the reference, the phone microphone added
     * through the aligner). Nothing is live until [commitSources]; a failure before it leaves the old sources as they were.
     */
    private fun buildSources(spec: SourceSpec): Built {
        if (spec.video == VideoKind.PHONE) {
            val cam = Camera2Source(app)
            val mc = MicrophoneSource()
            return Built(cam, mc)
        }
        val ext = spec.camera ?: throw IllegalArgumentException("camera_source_missing")
        val audio = RtspAudioSource(AUDIO_RATE)
        val al = AudioAligner(ALIGN_RATE, ALIGN_MAX_LAG_MS)
        val mixed = MixedAudioSource(audio, al, ALIGN_RATE)
        val holder = arrayOfNulls<RtspVideoSource>(1)
        val video = RtspVideoSource(
            url = ext.url, user = null, password = null, mode = ext.transport, audio = audio,
            sinkFactory = { surface, w, h -> SizingSink(surface, w, h) { holder[0] } },
        )
        holder[0] = video
        video.onLinkState = { st -> main.post { onCameraLink(video, st) } }
        mixed.onAlignChange = { _, _ -> main.post { emitAudio() } }
        mixed.setManualOffsetMs(spec.avOffsetMs)
        pendingExternal = ExternalParts(video, audio, mixed, al, ext)
        return Built(video, mixed)
    }

    private class ExternalParts(
        val video: RtspVideoSource,
        val audio: RtspAudioSource,
        val mixed: MixedAudioSource,
        val aligner: AudioAligner,
        val camera: ExternalCamera,
    )

    private var pendingExternal: ExternalParts? = null

    /** Takes the sources just built (and, for a switch, just handed to the stream) as the live ones. */
    private fun commitSources(spec: SourceSpec, built: Built) {
        videoKind = spec.video
        mixCfg = spec.mix
        if (spec.video == VideoKind.PHONE) {
            camera = built.video as Camera2Source
            mic = built.audio as MicrophoneSource
            rtspVideo = null; rtspAudio = null; mixedAudio = null; aligner = null; extCam = null
            camW = 0; camH = 0
        } else {
            val p = pendingExternal ?: return
            camera = null; mic = null
            rtspVideo = p.video; rtspAudio = p.audio; mixedAudio = p.mixed; aligner = p.aligner; extCam = p.camera
            camW = 0; camH = 0
            camSilence.reset(); micSilence.reset()
        }
        pendingExternal = null
        appliedMicEnabled = null
    }

    /** Builds the capture and encoders. Returns null on success or a reason code. */
    fun prepare(front: Boolean, width: Int, height: Int, fps: Int, spec: SourceSpec? = null): String? {
        if (live || stopping) return null // a running session is kept as it is
        teardown()
        frontCamera = front
        val sp = spec ?: SourceSpec(VideoKind.PHONE, null, AudioMixCfg.default(VideoKind.PHONE))
        if (sp.video == VideoKind.EXTERNAL && sp.camera == null) return "camera_source_missing"
        return try {
            val built = buildSources(sp)
            val kiosk = Leg("kiosk")
            val yt = Leg("youtube")
            val ms = MultiStream(app, arrayOf<ConnectChecker>(yt), null, arrayOf<ConnectChecker>(kiosk), null, built.video, built.audio)
            ms.getStreamClient(MultiType.SRT, 0).setReTries(Int.MAX_VALUE)
            ms.getStreamClient(MultiType.RTMP, 0).setReTries(Int.MAX_VALUE)
            ms.setFpsListener { f -> this.fps = f }
            // Always an upright 16:9 encoder (width x height as given, never swapped).
            val rotation = LiveLogic.PREPARE_ROTATION
            val okVideo = ms.prepareVideo(width, height, 2_500_000, fps, 2, rotation)
            val okAudio = ms.prepareAudio(AUDIO_RATE, false, 128_000)
            if (!okVideo || !okAudio) {
                ms.release()
                pendingExternal = null
                return "encoder_unsupported"
            }
            val cam = built.video as? Camera2Source
            if (cam != null && front != (cam.getCameraFacing() == CameraHelper.Facing.FRONT)) cam.switchCamera()
            commitSources(sp, built)
            stream = ms
            Diag.log("source_prepare", "video=${sp.video.wire} transport=${sp.camera?.transport?.name?.lowercase() ?: "-"}")
            applyMixSettings()
            if (videoKind == VideoKind.EXTERNAL) main.postDelayed(meterTick, METER_MS)
            prepared = true
            // RootEncoder's own handling: it turns the picture upright in its
            // camera pass (forceOrientation NONE follows the display rotation,
            // and its sensor handler follows the device). The preview crops to
            // fill instead of letterboxing.
            try {
                ms.getGlInterface().setAspectRatioMode(AspectRatioMode.Fill)
                ms.getGlInterface().autoHandleOrientation = true
            } catch (e: Exception) {
                Log.w(TAG, "gl setup failed: ${e.javaClass.simpleName}")
            }
            guard.open()
            watchDisplay()
            lastOrientationLine = null
            applyFraming()
            attachPreviewIfReady()
            null
        } catch (e: IllegalArgumentException) {
            teardown(); "resolution_unsupported"
        } catch (e: RuntimeException) {
            teardown(); "prepare_failed"
        }
    }

    /**
     * The device was turned (or the camera switched): read the display rotation
     * again. Kept for the Dart `setPortrait` call; the display listener does
     * the same on its own, so 90 to 270 and 0 to 180 turns, which Flutter never
     * reports, are followed too.
     */
    fun reframe() = applyFraming()

    private val displayListener = object : DisplayManager.DisplayListener {
        override fun onDisplayAdded(displayId: Int) {}
        override fun onDisplayRemoved(displayId: Int) {}
        override fun onDisplayChanged(displayId: Int) {
            if (displayId == Display.DEFAULT_DISPLAY) applyFraming()
        }
    }

    private fun watchDisplay() {
        if (displayListenerOn) return
        val dm = app.getSystemService(Context.DISPLAY_SERVICE) as DisplayManager
        dm.registerDisplayListener(displayListener, main)
        displayListenerOn = true
    }

    private fun unwatchDisplay() {
        if (!displayListenerOn) return
        try {
            val dm = app.getSystemService(Context.DISPLAY_SERVICE) as DisplayManager
            dm.unregisterDisplayListener(displayListener)
        } catch (e: Exception) {
            Log.w(TAG, "unwatch failed: ${e.javaClass.simpleName}")
        }
        displayListenerOn = false
    }

    /** SENSOR_ORIENTATION of the first camera facing the way in use (0 if unknown). */
    private fun sensorOrientation(front: Boolean): Int {
        val want = if (front) CameraCharacteristics.LENS_FACING_FRONT else CameraCharacteristics.LENS_FACING_BACK
        return try {
            val cm = app.getSystemService(Context.CAMERA_SERVICE) as CameraManager
            for (id in cm.cameraIdList) {
                val c = cm.getCameraCharacteristics(id)
                if (c.get(CameraCharacteristics.LENS_FACING) == want) {
                    return c.get(CameraCharacteristics.SENSOR_ORIENTATION) ?: 0
                }
            }
            0
        } catch (_: Exception) {
            0
        }
    }

    /**
     * Follows the device turn. RootEncoder does the rotation itself:
     * `forceOrientation(NONE)` reads the display rotation again and sets its
     * camera-pass orientation (and `autoHandleOrientation` does the same from
     * the accelerometer). All the engine adds is the shape: `setIsPortrait` for
     * the preview's aspect maths, and, for the stream (which has no fill mode),
     * a viewport that crops the centred 16:9 band when the upright picture is
     * portrait. The stream and preview rotations stay at 0. Safe during a live:
     * these are plain field writes read on the next frame. Does nothing before
     * prepare, while a stop runs or after release; never throws.
     */
    private fun applyFraming() {
        if (!guard.allows()) return
        try {
            val gl = stream?.getGlInterface() ?: return
            if (videoKind == VideoKind.EXTERNAL) {
                applyExternalFraming(gl)
                return
            }
            if (restorePhoneOrientation) {
                // Back from the external camera: the camera pass follows the device again.
                restorePhoneOrientation = false
                gl.autoHandleOrientation = true
                gl.setCameraOrientation(CameraHelper.getCameraOrientation(app))
                gl.setPreviewViewPort(null)
                gl.setAspectRatioMode(AspectRatioMode.Fill)
            }
            val dm = app.getSystemService(Context.DISPLAY_SERVICE) as DisplayManager
            val display = dm.getDisplay(Display.DEFAULT_DISPLAY)
            val deg = LiveLogic.displayDegrees(display?.rotation ?: Surface.ROTATION_0)
            val portrait = LiveLogic.isPortrait(deg)
            gl.forceOrientation(OrientationForced.NONE)
            gl.setIsPortrait(portrait)
            val enc = LiveLogic.cropViewport(LiveLogic.STREAM_WIDTH, LiveLogic.STREAM_HEIGHT, portrait)
            gl.setStreamViewPort(enc?.let { ViewPort(it[0], it[1], it[2], it[3]) })
            val front = camera?.let { it.getCameraFacing() == CameraHelper.Facing.FRONT } ?: frontCamera
            val line = LiveLogic.orientationLine(
                deg, CameraHelper.getCameraOrientation(app), sensorOrientation(front), front,
                AspectRatioMode.Fill.name, LiveLogic.STREAM_WIDTH, LiveLogic.STREAM_HEIGHT,
            )
            if (line != lastOrientationLine) {
                lastOrientationLine = line
                Log.i(TAG, line)
                Diag.log("orientation", "deg=$deg portrait=$portrait front=$front")
            }
        } catch (e: Exception) {
            Log.w(TAG, "orientation failed: ${e.javaClass.simpleName}")
        }
    }

    /**
     * The external camera's picture is upright already, so the device's turn must not rotate or crop it: no auto
     * orientation, landscape, camera rotation 0. A camera that is not 16:9 is kept in its own shape in the
     * SurfaceTexture (see [SizingSink]) and shown undistorted by a viewport that leaves bars (stream and preview), the
     * same mechanism the portrait crop uses the other way round. Never throws.
     */
    private fun applyExternalFraming(gl: GlStreamInterface) {
        try {
            gl.autoHandleOrientation = false
            gl.setOrientationConfig(OrientationConfig(0, false, OrientationForced.LANDSCAPE))
            gl.setIsPortrait(false)
            gl.setAspectRatioMode(AspectRatioMode.Fill)
            val enc = SourceLogic.letterbox(camW, camH, LiveLogic.STREAM_WIDTH, LiveLogic.STREAM_HEIGHT)
            gl.setStreamViewPort(enc?.let { ViewPort(it[0], it[1], it[2], it[3]) })
            val v = previewView
            val pv = if (v != null) SourceLogic.letterbox(camW, camH, v.width, v.height) else null
            gl.setPreviewViewPort(pv?.let { ViewPort(it[0], it[1], it[2], it[3]) })
            val line = "orientation external cam=${camW}x$camH letterbox=${enc != null}"
            if (line != lastOrientationLine) {
                lastOrientationLine = line
                Diag.log("orientation", "external=true cam=${camW}x$camH letterbox=${enc != null}")
            }
        } catch (e: Exception) {
            Log.w(TAG, "external framing failed: ${e.javaClass.simpleName}")
        }
    }

    private val previewLayout = android.view.View.OnLayoutChangeListener { _, _, _, _, _, _, _, _, _ -> applyFraming() }

    fun attachPreview(view: TextureView) {
        previewView = view
        view.addOnLayoutChangeListener(previewLayout)
        applyFraming()
        attachPreviewIfReady()
    }

    fun detachPreview(view: TextureView) {
        if (previewView !== view) return
        view.removeOnLayoutChangeListener(previewLayout)
        previewView = null
        val s = stream
        if (stopping) {
            // The recorder is still finishing: the preview (GL) stays up until
            // the stop is done, then completeStop() takes it down.
            pendingPreviewStop = previewing
            Diag.log("preview_detach_deferred")
            return
        }
        if (previewing && s != null) {
            try { s.stopPreview(true) } catch (_: RuntimeException) {}
        }
        previewing = false
    }

    private fun attachPreviewIfReady() {
        val s = stream ?: return
        val v = previewView ?: return
        if (!prepared || previewing) return
        try {
            s.startPreview(v, true)
            previewing = true
        } catch (_: RuntimeException) {
            // The surface is not ready; the auto handler starts it when it is.
            previewing = false
        }
    }

    private fun teardown() {
        guard.close()
        unwatchDisplay()
        main.removeCallbacks(meterTick)
        clapReplay?.stop()
        clapReplay = null
        main.removeCallbacks(clapFinish)
        clapCapturing = false
        val s = stream
        if (s != null) {
            try { if (previewing) s.stopPreview(true) } catch (_: RuntimeException) {}
            try { s.release() } catch (_: RuntimeException) {}
        }
        stream = null; camera = null; mic = null; prepared = false; previewing = false
        // The camera address and its sources go with the session; nothing of it is kept.
        rtspVideo = null; rtspAudio = null; mixedAudio = null; aligner = null; extCam = null; pendingExternal = null
        lostFilter = null; camW = 0; camH = 0; endedByCamera = false
        videoKind = VideoKind.PHONE
    }

    // ---- start and stop ----

    /** Returns null on success or a reason code. */
    fun start(
        srt: SrtTarget?,
        rtmpsUrl: String?,
        record: RecordCfg?,
        videoBitrateKbps: Int,
    ): String? {
        val s = stream ?: return "not_prepared"
        if (live) return "already_live"
        if (stopping) return "stopping"
        if (srt == null && rtmpsUrl == null && record == null) return "no_output"
        live = true
        Diag.log("live_start", "kiosk=${srt != null} youtube=${rtmpsUrl != null} record=${record != null}")
        startedAt = SystemClock.elapsedRealtime()
        liveStartedEpochMs = System.currentTimeMillis()
        endedByCamera = false
        warnings.clear(); recordError = null; recordHalted = false; publishedBytes = 0; segmentIndex = 0
        val begun = Date()
        liveDate = SimpleDateFormat("yyyy-MM-dd", Locale.US).format(begun)
        liveTime = SimpleDateFormat("HHmm", Locale.US).format(begun)
        nameIndex = 0
        synchronized(sessionNames) { sessionNames.clear() }
        saveSessionNames()
        attempts["kiosk"] = 0; attempts["youtube"] = 0
        wantKiosk = srt != null; wantYoutube = rtmpsUrl != null
        phase("starting")
        lastOrientationLine = null
        applyFraming() // logs the orientation once at start
        try {
            if (record != null) startRecording(record)
            if (srt != null) {
                output("kiosk", "connecting")
                s.startStream(MultiType.SRT, 0, LiveLogic.srtUrl(srt.host, srt.port, srt.streamId, srt.passphrase))
            }
            if (rtmpsUrl != null) {
                output("youtube", "connecting")
                s.startStream(MultiType.RTMP, 0, rtmpsUrl)
            }
            if (srt != null || rtmpsUrl != null) s.setVideoBitrateOnFly(videoBitrateKbps * 1000)
        } catch (e: RuntimeException) {
            stop()
            return "start_failed"
        }
        phase("live")
        main.postDelayed(tick, 2000)
        if (videoKind == VideoKind.EXTERNAL) {
            // the meter loop runs from prepare; make sure it is on (a stop never ends it while prepared)
            main.removeCallbacks(meterTick)
            main.postDelayed(meterTick, METER_MS)
        }
        return null
    }

    /**
     * Opens the YouTube (RTMPS) leg on the already-running stream, the same way
     * [start] opens it. Null on success (also when the leg is already wanted:
     * a no-op) or a reason code. The url is never logged.
     */
    fun startYoutube(rtmpsUrl: String?): String? {
        val s = stream
        return when (LiveLogic.youtubeStartDecision(live, stopping, s != null, wantYoutube, rtmpsUrl)) {
            LiveLogic.YoutubeStart.STOPPING -> "stopping"
            LiveLogic.YoutubeStart.NOT_LIVE -> "not_live"
            LiveLogic.YoutubeStart.NO_URL -> "no_url"
            LiveLogic.YoutubeStart.ALREADY_UP -> null
            LiveLogic.YoutubeStart.OPEN -> {
                Diag.log("youtube_leg_start")
                attempts["youtube"] = 0
                wantYoutube = true
                try {
                    output("youtube", "connecting")
                    s!!.startStream(MultiType.RTMP, 0, rtmpsUrl!!)
                    null
                } catch (e: RuntimeException) {
                    wantYoutube = false
                    output("youtube", "down", message = "start_failed")
                    "youtube_start_failed"
                }
            }
        }
    }

    /**
     * The stop used by the channel. Everything that can block (the recorder's
     * moov, the network legs) runs on a worker thread in the order
     * StopSequence fixes; the state is settled back on the main thread and
     * [done] runs there. Owned by this process singleton, not by the
     * activity: if the activity goes away the stop still finishes.
     */
    fun stopAsync(done: () -> Unit) {
        if (stopping) { stopWaiters.add(done); return }
        stopping = true
        stopWaiters.add(done)
        val s = stream
        guard.pause()
        unwatchDisplay()
        main.removeCallbacks(tick)
        main.removeCallbacks(rotate)
        val wasRecording = recording
        val file = segmentFile
        val kiosk = wantKiosk
        val youtube = wantYoutube
        Diag.log("stop_begin", "live=$live recording=$wasRecording")
        phase("stopping")
        stopExec.execute {
            val finished = StopSequence.run(
                stopRecord = if (wasRecording && s != null) ({ s.stopRecord() }) else null,
                stopOutputs = {
                    if (s != null) {
                        try { if (kiosk) s.stopStream(MultiType.SRT, 0) } catch (_: Exception) {}
                        try { if (youtube) s.stopStream(MultiType.RTMP, 0) } catch (_: Exception) {}
                    }
                },
                release = { main.post { completeStop(file, wasRecording, kiosk, youtube) } },
                timeoutMs = StopSequence.STOP_RECORD_TIMEOUT_MS,
                recordExecutor = recordExec,
                log = { e, f -> Diag.log(e, f) },
            )
            if (!finished) Diag.log("stop_record_unfinished")
        }
    }

    private fun completeStop(file: File?, wasRecording: Boolean, kiosk: Boolean, youtube: Boolean) {
        if (wasRecording) {
            recording = false
            segmentFile = null
            if (file != null && file.exists()) {
                publishedBytes += file.length()
                Diag.log("record_finish", "bytes=${file.length()}")
                io.execute { publishToGallery(file) }
            }
            recordingEvent()
        }
        if (kiosk) output("kiosk", "down")
        if (youtube) output("youtube", "down")
        wantKiosk = false; wantYoutube = false; live = false
        recordCfg = null
        val s = stream
        if (pendingPreviewStop && s != null) {
            try { s.stopPreview(true) } catch (_: RuntimeException) {}
            previewing = false
        }
        pendingPreviewStop = false
        if (s != null && prepared) {
            guard.resume()
            watchDisplay()
        }
        stopping = false
        phase("stopped")
        Diag.log("stop_end")
        val waiters = stopWaiters.toList()
        stopWaiters.clear()
        waiters.forEach { try { it() } catch (_: Exception) {} }
    }

    /** Synchronous stop for start failure and release; the channel uses [stopAsync]. */
    fun stop() {
        val s = stream
        Diag.log("stop_sync_begin")
        // No orientation callback may run while the recorder and the outputs stop.
        guard.pause()
        unwatchDisplay()
        main.removeCallbacks(tick)
        main.removeCallbacks(rotate)
        phase("stopping")
        if (s != null) {
            // The recording is finished (moov written) before anything is released.
            try { if (recording) finishSegment(s) } catch (e: Exception) { Log.w(TAG, "finish failed: ${e.javaClass.simpleName}") }
            try { if (wantKiosk) s.stopStream(MultiType.SRT, 0) } catch (_: Exception) {}
            try { if (wantYoutube) s.stopStream(MultiType.RTMP, 0) } catch (_: Exception) {}
        }
        if (wantKiosk) output("kiosk", "down")
        if (wantYoutube) output("youtube", "down")
        wantKiosk = false; wantYoutube = false; live = false
        recordCfg = null
        // Still prepared (preview on)? Follow the device again; a released
        // session stays closed.
        if (stream != null && prepared) {
            guard.resume()
            watchDisplay()
        }
        phase("stopped")
    }

    fun switchCamera() {
        camera?.switchCamera()
        main.post { applyFraming() }
    }

    /** Today's mute (phone camera with its microphone). With "Mic-in pada kotak" added it stays unmuted, see [SourceLogic]. */
    fun setMuted(muted: Boolean) {
        userMuted = muted
        applyMixSettings()
    }

    // ---- the external camera and the audio mix (plan 4.5) ----

    /**
     * Applies the mix to the sources: the phone mixer for the external camera, `MicrophoneSource` mute for the phone
     * camera. The added microphone is switched only when that changes (adding it starts a new alignment search).
     */
    private fun applyMixSettings() {
        val mixed = mixedAudio
        if (videoKind == VideoKind.EXTERNAL && mixed != null) {
            val hasAudio = rtspAudio?.let { if (it.formatKnown) it.hasAudio else true } ?: true
            val ms = SourceLogic.mixSettings(mixCfg, hasAudio)
            applyCameraVolume(ms)
            mixed.setMicVolume(ms.micVolume)
            if (appliedMicEnabled != ms.micEnabled) {
                appliedMicEnabled = ms.micEnabled
                mixed.setMicEnabled(ms.micEnabled)
            }
        } else {
            mic?.let { if (SourceLogic.effectiveMuted(userMuted, mixCfg)) it.mute() else it.unMute() }
        }
    }

    private fun applyCameraVolume(ms: MixSettings) {
        val mixed = mixedAudio ?: return
        val lost = rtspVideo?.linkState == CameraLinkState.LOST
        val aligned = mixed.mixer?.micAligned ?: false
        mixed.setCameraVolume(SourceLogic.effectiveCameraVolume(ms.cameraVolume, lost, ms.micEnabled, aligned))
    }

    /** A volume, add or remove of the microphone, or Mic-in change during the live. Null on success or a reason code. */
    fun setAudioMix(cfg: AudioMixCfg): String? {
        if (stream == null) return "not_prepared"
        mixCfg = cfg
        applyMixSettings()
        Diag.log(
            "audio_mix",
            "video=${videoKind.wire} cam=${cfg.camera.volume} mic=${cfg.deviceMic.enabled}/${cfg.deviceMic.volume} " +
                "boxin=${cfg.boxInput.enabled}",
        )
        emitAudio()
        return null
    }

    /** The fixed offset ("Imbangan masa audio"), used only while the camera has no audio track. */
    fun setAvOffsetMs(ms: Int) {
        mixedAudio?.setManualOffsetMs(ClapPlan.clampOffset(ms))
    }

    /**
     * Changes the picture source, also during the live (no restart: [com.pedro.library.base.StreamBase.changeVideoSource]
     * and `changeAudioSource` swap the sources on the running encoder, so the SRT session, the YouTube leg and the
     * recording carry on). The sound follows in the same step: to the phone camera the microphone alone with no delay
     * (today's flow); back to the external camera the camera sound returns and the mix is restored after the new lock.
     * Null on success or a reason code.
     */
    fun setSource(spec: SourceSpec): String? {
        val s = stream ?: return "not_prepared"
        if (stopping) return "stopping"
        if (clapCapturing) return "clap_busy"
        val same = spec.video == videoKind &&
            (spec.video == VideoKind.PHONE || (extCam?.url == spec.camera?.url && extCam?.transport == spec.camera?.transport))
        if (same) {
            mixCfg = spec.mix
            applyMixSettings()
            setAvOffsetMs(spec.avOffsetMs)
            emitAudio()
            return null
        }
        if (spec.video == VideoKind.EXTERNAL && spec.camera == null) return "camera_source_missing"
        stopClap()
        return try {
            Diag.log("source_switch", "to=${spec.video.wire} live=$live")
            val built = buildSources(spec)
            val cam = built.video as? Camera2Source
            if (cam != null && frontCamera != (cam.getCameraFacing() == CameraHelper.Facing.FRONT)) cam.switchCamera()
            // Picture first, then the sound, back to back on the main thread. The old sources are released by the stream.
            val oldSpec = SourceSpec(videoKind, extCam, mixCfg, mixedAudio?.manualOffsetMs ?: 0)
            try {
                s.changeVideoSource(built.video)
            } catch (e: RuntimeException) {
                releaseQuietly(built.video); releaseQuietly(built.audio) // nothing of the new pair is attached
                throw e
            }
            try {
                s.changeAudioSource(built.audio)
            } catch (e: RuntimeException) {
                // The stream now holds the new picture but still the old sound: put the old kind back so the engine
                // fields and the stream agree, and release the new sound that was never attached.
                releaseQuietly(built.audio)
                rollbackSources(s, oldSpec)
                throw e
            }
            if (spec.video == VideoKind.PHONE) restorePhoneOrientation = true
            commitSources(spec, built)
            setLostOverlay(false) // the new source starts connecting, the old one's message goes
            applyMixSettings()
            setAvOffsetMs(spec.avOffsetMs)
            main.removeCallbacks(meterTick)
            if (spec.video == VideoKind.EXTERNAL) main.postDelayed(meterTick, METER_MS)
            lastOrientationLine = null
            applyFraming()
            main.post { emitAudio() }
            null
        } catch (e: IllegalArgumentException) {
            Diag.error("source_switch_failed", e)
            pendingExternal = null
            "switch_failed"
        } catch (e: RuntimeException) {
            Diag.error("source_switch_failed", e)
            pendingExternal = null
            "switch_failed"
        }
    }

    private fun releaseQuietly(v: VideoSource) {
        try { v.stop() } catch (_: Exception) {}
        try { v.release() } catch (_: Exception) {}
    }

    private fun releaseQuietly(a: AudioSource) {
        try { a.stop() } catch (_: Exception) {}
        try { a.release() } catch (_: Exception) {}
    }

    /** Swaps freshly built sources of the previous kind back into the stream after a half-done switch. */
    private fun rollbackSources(s: MultiStream, old: SourceSpec) {
        pendingExternal = null
        try {
            val b = buildSources(old)
            try {
                s.changeVideoSource(b.video)
                s.changeAudioSource(b.audio)
            } catch (e: RuntimeException) {
                releaseQuietly(b.video); releaseQuietly(b.audio)
                throw e
            }
            commitSources(old, b)
            Diag.log("source_switch_rolled_back", "to=${old.video.wire}")
        } catch (e: RuntimeException) {
            Diag.error("source_rollback_failed", e)
        }
    }

    /** The camera link changed (supervisor thread, posted to main): the message in the picture, the sound rules. */
    private fun onCameraLink(source: RtspVideoSource, st: CameraLinkState) {
        if (source !== rtspVideo) return
        Diag.log("camera_link", "state=${SourceLogic.linkWire(st)} transport=${source.transportInUse?.name?.lowercase() ?: "-"}")
        setLostOverlay(st == CameraLinkState.LOST)
        applyMixSettings()
        emitAudio()
    }

    /**
     * Draws "Siaran akan bersambung sebentar lagi" over the held last picture while the camera is lost (4.5 item 6),
     * in the stream and in the preview; removes it when the camera returns. The picture itself is the last frame the
     * decoder left in the SurfaceTexture.
     */
    private fun setLostOverlay(on: Boolean) {
        val gl = stream?.getGlInterface() ?: return
        try {
            if (on && lostFilter == null) {
                val f = TextObjectFilterRender()
                f.setText(SourceLogic.LOST_MESSAGE, 26f, Color.WHITE)
                f.setPosition(TranslateTo.BOTTOM)
                gl.addFilter(f)
                lostFilter = f
            } else if (!on) {
                lostFilter?.let { gl.removeFilter(it) }
                lostFilter = null
            }
        } catch (e: RuntimeException) {
            Log.w(TAG, "lost overlay failed: ${e.javaClass.simpleName}")
        }
    }

    /** The camera picture size became known (or changed): keep its shape, then frame it. Main thread. */
    private fun onCameraSize(w: Int, h: Int) {
        if (videoKind != VideoKind.EXTERNAL || (w == camW && h == camH)) return
        camW = w
        camH = h
        lastOrientationLine = null
        applyFraming()
    }

    /**
     * Decoder sink that first learns the camera's own picture size from the SPS and gives the SurfaceTexture that size
     * (K1 note: its default buffer is the engine size, which would stretch a camera that is not 16:9), then decodes onto
     * the same surface. When the size cannot be read the picture is stretched as K1 delivers it (cosmetic only).
     */
    private inner class SizingSink(
        private val surface: Surface,
        private val w: Int,
        private val h: Int,
        private val owner: () -> RtspVideoSource?,
    ) : VideoSink {
        // configure/stop run on the supervisor thread, the main thread may stop it too
        @Volatile private var inner: VideoSink? = null

        override fun configure(mime: String, sps: ByteArray?, pps: ByteArray?, vps: ByteArray?) {
            inner?.stop()
            val size = SpsSize.parse(sps, mime == MediaFormat.MIMETYPE_VIDEO_HEVC)
            val cw = size?.first ?: w
            val ch = size?.second ?: h
            if (size != null) {
                try {
                    owner()?.surfaceTexture?.setDefaultBufferSize(cw, ch)
                } catch (_: Exception) {
                }
            }
            main.post { onCameraSize(size?.first ?: 0, size?.second ?: 0) }
            val s = LibVideoSink(surface, cw, ch)
            inner = s
            s.configure(mime, sps, pps, vps)
        }

        override fun push(data: ByteArray, off: Int, len: Int, tsMs: Long) {
            inner?.push(data, off, len, tsMs)
        }

        override fun stop() {
            inner?.stop()
            inner = null
        }
    }

    // ---- meters, alignment state and the 10 minute stop ----

    private val meterTick = object : Runnable {
        override fun run() {
            if (videoKind != VideoKind.EXTERNAL || stream == null) return
            // The microphone may have been aligned since the last look: the camera volume rule depends on it.
            applyCameraVolume(SourceLogic.mixSettings(mixCfg, rtspAudio?.let { if (it.formatKnown) it.hasAudio else true } ?: true))
            emitAudio()
            checkCameraLost()
            main.postDelayed(this, METER_MS)
        }
    }

    private fun checkCameraLost() {
        val v = rtspVideo ?: return
        if (!live || stopping || endedByCamera) return
        val base = SourceLogic.lostBase(v.lostSinceMs, liveStartedEpochMs)
        if (!SourceLogic.lostExpired(base, System.currentTimeMillis())) return
        endedByCamera = true
        Diag.log("camera_lost_stop")
        emit(mapOf("type" to "ended", "reason" to SourceLogic.ENDED_CAMERA_LOST))
        stopAsync { try { LiveService.stop(app) } catch (_: RuntimeException) {} }
    }

    /** One `audio` event: a row per source with its level and state, the mixed level, the camera link. */
    private fun emitAudio() {
        if (videoKind != VideoKind.EXTERNAL) return
        val mixed = mixedAudio ?: return
        val now = SystemClock.elapsedRealtime()
        val v = rtspVideo
        val a = rtspAudio
        val link = v?.linkState ?: CameraLinkState.IDLE
        val known = a?.formatKnown == true
        val hasAudio: Boolean? = if (known) a?.hasAudio else null
        val lv = mixed.levels
        val camSilent = camSilence.update(lv.camera, now)
        val micSilent = micSilence.update(lv.mic, now)
        val rows = mutableListOf<Map<String, Any?>>()
        rows += SourceLogic.sourceRow(
            "camera", mixCfg.camera.enabled && hasAudio != false, mixCfg.camera.volume, lv.camera,
            SourceLogic.sourceState(link == CameraLinkState.LOST, camSilent || hasAudio == false),
        )
        val al = aligner
        if (mixCfg.deviceMic.enabled && al != null) {
            rows += SourceLogic.sourceRow(
                "deviceMic", true, mixCfg.deviceMic.volume, lv.mic,
                SourceLogic.sourceState(mixed.micFailed, micSilent),
                SourceLogic.alignInfo(mixed.mixer?.alignState ?: al.state, mixed.mixer?.delayMs ?: al.delayMs, al.residualMs),
            )
        }
        val camera = SourceLogic.cameraStatus(
            link, hasAudio, SourceLogic.lostSeconds(v?.lostSinceMs ?: 0L, System.currentTimeMillis()),
            v?.transportInUse, camW, camH,
        )
        emit(SourceLogic.audioEvent(rows, lv.mixed, camera, mixed.micFailed))
    }

    // ---- clap test (a camera with no audio track only) ----

    private fun clapFile(): File? {
        val dir = File(app.cacheDir, "clap")
        if (!dir.exists() && !dir.mkdirs()) return null
        return File(dir, "clap.mp4")
    }

    private fun clap(state: String) = emit(mapOf("type" to "clap", "state" to state))

    private val clapFinish = Runnable {
        val s = stream
        if (!clapCapturing || s == null) return@Runnable
        try {
            recordExec.submit { s.stopRecord() }.get(StopSequence.STOP_RECORD_TIMEOUT_MS, java.util.concurrent.TimeUnit.MILLISECONDS)
        } catch (e: Exception) {
            Diag.error("clap_stop_failed", e)
        }
        clapCapturing = false
        mixedAudio?.setManualOffsetMs(clapSavedOffset)
        val ok = clapFile()?.let { it.exists() && it.length() > 0 } == true
        clap(if (ok) "ready" else "failed")
    }

    /**
     * Records about five seconds of the camera picture and the phone microphone with the offset at 0. Only for a camera
     * that has no audio track, a microphone that is added, not during a live. Null on success or a reason code.
     */
    fun clapCapture(): String? {
        val s = stream ?: return "not_prepared"
        if (live || stopping || clapCapturing) return "clap_busy"
        if (videoKind != VideoKind.EXTERNAL) return "clap_unavailable"
        val a = rtspAudio
        if (a == null || !a.formatKnown || a.hasAudio) return "camera_has_audio"
        if (!mixCfg.deviceMic.enabled) return "mic_not_added"
        if (rtspVideo?.linkState != CameraLinkState.PLAYING) return "camera_not_playing"
        val file = clapFile() ?: return "clap_failed"
        stopClap()
        file.delete()
        clapSavedOffset = mixedAudio?.manualOffsetMs ?: 0
        mixedAudio?.setManualOffsetMs(0)
        return try {
            s.startRecord(file.absolutePath, null, object : RecordController.Listener {
                override fun onStatusChange(status: RecordController.Status) {}
                override fun onError(e: Exception?) {
                    main.post {
                        // The capture is over: give the manual offset back and drop the pending finish.
                        main.removeCallbacks(clapFinish)
                        clapCapturing = false
                        mixedAudio?.setManualOffsetMs(clapSavedOffset)
                        clap("failed")
                    }
                }
            })
            clapCapturing = true
            clap("capturing")
            main.postDelayed(clapFinish, ClapPlan.CAPTURE_MS)
            null
        } catch (e: Exception) {
            mixedAudio?.setManualOffsetMs(clapSavedOffset)
            "clap_failed"
        }
    }

    /** Plays the captured clip in a loop with the sound [offsetMs] after the picture (in the preview). */
    fun clapReplay(offsetMs: Int): String? {
        val s = stream ?: return "not_prepared"
        if (live || stopping || clapCapturing) return "clap_busy"
        val file = clapFile()?.takeIf { it.exists() && it.length() > 0 } ?: return "clap_missing"
        val texture = previewView?.takeIf { it.isAvailable }?.surfaceTexture ?: return "clap_no_preview"
        val r = clapReplay
        if (r != null && r.playing) {
            r.setOffset(offsetMs)
            return null
        }
        // The engine's own preview gives the surface up while the clip plays; stopClap() takes it back.
        try { if (previewing) s.stopPreview(true) } catch (_: RuntimeException) {}
        previewing = false
        val player = ClapReplay(file, main)
        if (!player.start(texture, offsetMs)) {
            attachPreviewIfReady()
            return "clap_failed"
        }
        clapReplay = player
        clap("replaying")
        return null
    }

    /** The stepper moved during a replay. */
    fun clapOffset(offsetMs: Int) {
        clapReplay?.setOffset(offsetMs)
    }

    /** Ends the replay and gives the preview back. */
    fun clapStop() {
        stopClap()
    }

    private fun stopClap() {
        val r = clapReplay ?: return
        r.stop()
        clapReplay = null
        if (stream != null && !stopping) attachPreviewIfReady()
        clap("idle")
    }

    fun release() {
        guard.close()
        unwatchDisplay()
        prepared = false // stop() then leaves the orientation guard closed
        if (live) stop()
        teardown()
    }

    // ---- legs ----

    private inner class Leg(private val name: String) : ConnectChecker {
        override fun onConnectionStarted(url: String) { main.post { if (live) output(name, "connecting") } }

        override fun onConnectionSuccess() {
            main.post {
                if (!live) return@post
                attempts[name] = 0
                output(name, "up")
            }
        }

        override fun onConnectionFailed(reason: String) {
            main.post { retry(name, "connect_failed") }
        }

        override fun onDisconnect() {
            main.post { if (live && wanted(name)) output(name, "down") }
        }

        override fun onAuthError() { main.post { if (live) output(name, "down", message = "auth_failed") } }

        override fun onAuthSuccess() {}

        override fun onNewBitrate(bitrate: Long) { bitrates[name] = bitrate }
    }

    private fun wanted(name: String) = if (name == "kiosk") wantKiosk else wantYoutube

    private fun retry(name: String, code: String) {
        val s = stream ?: return
        if (!live || stopping || !wanted(name)) return
        val n = (attempts[name] ?: 0) + 1
        attempts[name] = n
        val delay = LiveLogic.backoffSeconds(n)
        output(name, "retrying", retryInSec = delay, message = code)
        val client = if (name == "kiosk") s.getStreamClient(MultiType.SRT, 0) else s.getStreamClient(MultiType.RTMP, 0)
        val again = try { client.reTry(delay * 1000L, code) } catch (_: RuntimeException) { false }
        if (!again) output(name, "down", message = code)
    }

    // ---- recording ----

    /** The names this live (or, after it, the last live) wrote, in order. */
    fun sessionRecordings(): List<String> {
        synchronized(sessionNames) {
            if (sessionNames.isNotEmpty()) return sessionNames.toList()
        }
        if (live) return emptyList()
        val raw = app.getSharedPreferences(SESSION_PREFS, Context.MODE_PRIVATE).getString(SESSION_KEY, "") ?: ""
        return raw.split(SESSION_SEP).filter { it.isNotEmpty() }
    }

    private fun saveSessionNames() {
        val text = synchronized(sessionNames) { sessionNames.joinToString(SESSION_SEP) }
        app.getSharedPreferences(SESSION_PREFS, Context.MODE_PRIVATE).edit().putString(SESSION_KEY, text).apply()
    }

    private fun nameTaken(dir: File, name: String): Boolean {
        if (File(dir, name).exists()) return true
        synchronized(sessionNames) { if (name in sessionNames) return true }
        return galleryHas(name)
    }

    /** A MediaStore row (any folder, any owner) already has this display name. */
    private fun galleryHas(name: String): Boolean {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) return false
        return try {
            app.contentResolver.query(
                MediaStore.Video.Media.EXTERNAL_CONTENT_URI,
                arrayOf(MediaStore.Video.Media._ID),
                "${MediaStore.Video.Media.DISPLAY_NAME} = ?",
                arrayOf(name),
                null,
            )?.use { it.count > 0 } ?: false
        } catch (_: Exception) {
            false
        }
    }

    private fun recordDir(): File? {
        val base = app.getExternalFilesDir(Environment.DIRECTORY_MOVIES) ?: return null
        return File(base, "MAXCOM").also { it.mkdirs() }
    }

    private fun startRecording(cfg: RecordCfg) {
        recordCfg = cfg
        startSegment()
    }

    private val rotate = Runnable {
        val s = stream ?: return@Runnable
        if (recordCfg == null || !live || !recording) return@Runnable
        finishSegment(s)
        if (!recordHalted) startSegment() // startSegment schedules the next rotation
    }

    private fun startSegment() {
        val s = stream ?: return
        val cfg = recordCfg ?: return
        val dir = recordDir()
        if (dir == null) { recordError = "no_storage"; recordingEvent(); return }
        segmentIndex += 1
        // A name no file of any earlier live (gallery or app folder) has: the index goes up, nothing is overwritten.
        val (name, used) = try {
            LiveLogic.freeSegmentName(liveDate, liveTime, cfg.prefix, nameIndex + 1) { nameTaken(dir, it) }
        } catch (_: IllegalStateException) {
            recordError = "no_storage"; recordingEvent(); return
        }
        nameIndex = used
        val file = File(dir, name)
        try {
            s.startRecord(file.absolutePath, null, object : RecordController.Listener {
                override fun onStatusChange(status: RecordController.Status) {}
                override fun onError(e: Exception?) {
                    // The recording failed; the outputs keep going.
                    main.post { recordError = "write_failed"; recording = false; recordingEvent() }
                }
            })
            segmentFile = file
            recording = true
            synchronized(sessionNames) { sessionNames.add(file.name) }
            saveSessionNames()
            Diag.log("record_start", "segment=$segmentIndex")
            if (cfg.segmentMinutes > 0) main.postDelayed(rotate, cfg.segmentMinutes * 60_000L)
        } catch (e: Exception) {
            recording = false
            recordError = "record_failed"
        }
        recordingEvent()
    }

    /** Closes the running segment and hands the file to the gallery. */
    private fun finishSegment(s: MultiStream) {
        main.removeCallbacks(rotate)
        val file = segmentFile
        // Bounded: a hung muxer must not freeze the main thread for good.
        try {
            recordExec.submit { s.stopRecord() }.get(StopSequence.STOP_RECORD_TIMEOUT_MS, java.util.concurrent.TimeUnit.MILLISECONDS)
        } catch (e: Exception) {
            Log.w(TAG, "stopRecord failed: ${e.javaClass.simpleName}")
            Diag.error("stop_record_failed", e)
        }
        recording = false
        segmentFile = null
        if (file != null && file.exists()) {
            publishedBytes += file.length()
            Diag.log("record_finish", "bytes=${file.length()}")
            io.execute { publishToGallery(file) }
        }
        recordingEvent()
    }

    /**
     * Copies a finished segment into `Movies/MAXCOM` (Android 10 and later).
     * The app-private copy is removed only after the copy is verified to have
     * the same size; on any failure it stays where it is.
     */
    private fun publishToGallery(file: File) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) return
        val resolver = app.contentResolver
        // Never let MediaStore rename to "name (1).mp4": if the name appeared meanwhile, the file stays
        // in the app folder and is dropped from the session list (so it is never uploaded or deleted by name).
        if (galleryHas(file.name)) {
            synchronized(sessionNames) { sessionNames.remove(file.name) }
            saveSessionNames()
            main.post { recordError = "publish_failed"; recordingEvent() }
            return
        }
        val values = ContentValues().apply {
            put(MediaStore.Video.Media.DISPLAY_NAME, file.name)
            put(MediaStore.Video.Media.MIME_TYPE, "video/mp4")
            put(MediaStore.Video.Media.RELATIVE_PATH, RECORD_SUBDIR)
            put(MediaStore.Video.Media.IS_PENDING, 1)
        }
        var uri: Uri? = null
        try {
            uri = resolver.insert(MediaStore.Video.Media.EXTERNAL_CONTENT_URI, values) ?: return
            val copied = resolver.openOutputStream(uri)?.use { out ->
                file.inputStream().use { it.copyTo(out) }
            } ?: -1L
            if (copied != file.length()) throw java.io.IOException("short copy")
            values.clear()
            values.put(MediaStore.Video.Media.IS_PENDING, 0)
            resolver.update(uri, values, null, null)
            file.delete()
        } catch (e: Exception) {
            uri?.let { try { resolver.delete(it, null, null) } catch (_: Exception) {} }
            main.post { recordError = "publish_failed"; recordingEvent() }
        }
    }

    // ---- telemetry, battery, heat, storage ----

    private val tick = object : Runnable {
        override fun run() {
            if (!live) return
            val s = stream
            var dropped = 0L
            var rtt: Int? = null
            if (s != null) {
                if (wantKiosk) {
                    val c = s.getStreamClient(MultiType.SRT, 0)
                    dropped += c.getDroppedVideoFrames()
                    (c as? SrtStreamClient)?.let { rtt = it.getRtt().toInt() }
                }
                if (wantYoutube) dropped += s.getStreamClient(MultiType.RTMP, 0).getDroppedVideoFrames()
            }
            val kbps = ((if (wantKiosk) bitrates["kiosk"] else bitrates["youtube"]) ?: 0L) / 1000
            emit(
                mapOf(
                    "type" to "stats", "bitrateKbps" to kbps, "fps" to fps, "dropped" to dropped,
                    "rttMs" to rtt,
                    "durationSec" to ((SystemClock.elapsedRealtime() - startedAt) / 1000).toInt(),
                ),
            )
            checkDevice()
            if (recording) recordingEvent()
            main.postDelayed(this, 2000)
        }
    }

    private fun checkDevice() {
        val s = stream ?: return
        // Battery
        val b: Intent? = app.registerReceiver(null, IntentFilter(Intent.ACTION_BATTERY_CHANGED))
        if (b != null) {
            val level = b.getIntExtra(BatteryManager.EXTRA_LEVEL, -1)
            val scale = b.getIntExtra(BatteryManager.EXTRA_SCALE, 100)
            if (level >= 0 && scale > 0) {
                val pct = level * 100 / scale
                warn("lowBattery", pct < LOW_BATTERY_PERCENT)
                if (pct < STOP_RECORD_BATTERY_PERCENT && recording) {
                    recordHalted = true; finishSegment(s); recordError = "battery_low"; recordingEvent()
                }
            }
        }
        // Heat (Android 10 and later)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            val pm = app.getSystemService(Context.POWER_SERVICE) as PowerManager
            warn("hot", pm.currentThermalStatus >= PowerManager.THERMAL_STATUS_SEVERE)
        }
        // Storage
        val dir = recordDir()
        if (dir != null) {
            val free = StatFs(dir.absolutePath).availableBytes
            warn("lowStorage", free < LOW_STORAGE_BYTES)
            if (free < STOP_RECORD_STORAGE_BYTES && recording) {
                recordHalted = true; finishSegment(s); recordError = "storage_low"; recordingEvent()
            }
        }
    }
}
