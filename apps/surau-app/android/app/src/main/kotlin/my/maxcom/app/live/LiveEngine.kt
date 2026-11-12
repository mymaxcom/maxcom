package my.maxcom.app.live

import android.content.ContentValues
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.hardware.camera2.CameraCharacteristics
import android.hardware.camera2.CameraManager
import android.hardware.display.DisplayManager
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
import android.view.SurfaceView
import com.pedro.common.ConnectChecker
import com.pedro.encoder.input.sources.OrientationForced
import com.pedro.encoder.input.sources.audio.MicrophoneSource
import com.pedro.encoder.input.sources.video.Camera2Source
import com.pedro.encoder.input.video.CameraHelper
import com.pedro.library.multiple.MultiStream
import com.pedro.library.multiple.MultiType
import com.pedro.library.base.recording.RecordController
import com.pedro.encoder.utils.ViewPort
import com.pedro.encoder.utils.gl.AspectRatioMode
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
    private var previewView: SurfaceView? = null
    private var previewing = false
    private var frontCamera = false
    private var displayListenerOn = false
    private val guard = OrientationGuard()
    private var lastOrientationLine: String? = null

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

    /** Builds the capture and encoders. Returns null on success or a reason code. */
    fun prepare(front: Boolean, width: Int, height: Int, fps: Int): String? {
        if (live || stopping) return null // a running session is kept as it is
        teardown()
        frontCamera = front
        return try {
            val cam = Camera2Source(app)
            val mc = MicrophoneSource()
            val kiosk = Leg("kiosk")
            val yt = Leg("youtube")
            val ms = MultiStream(app, arrayOf<ConnectChecker>(yt), null, arrayOf<ConnectChecker>(kiosk), null, cam, mc)
            ms.getStreamClient(MultiType.SRT, 0).setReTries(Int.MAX_VALUE)
            ms.getStreamClient(MultiType.RTMP, 0).setReTries(Int.MAX_VALUE)
            ms.setFpsListener { f -> this.fps = f }
            // Always an upright 16:9 encoder (width x height as given, never swapped).
            val rotation = LiveLogic.PREPARE_ROTATION
            val okVideo = ms.prepareVideo(width, height, 2_500_000, fps, 2, rotation)
            val okAudio = ms.prepareAudio(48_000, false, 128_000)
            if (!okVideo || !okAudio) {
                ms.release()
                return "encoder_unsupported"
            }
            if (front != (cam.getCameraFacing() == CameraHelper.Facing.FRONT)) cam.switchCamera()
            camera = cam; mic = mc; stream = ms
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

    private val previewLayout = android.view.View.OnLayoutChangeListener { _, _, _, _, _, _, _, _, _ -> applyFraming() }

    fun attachPreview(view: SurfaceView) {
        previewView = view
        view.addOnLayoutChangeListener(previewLayout)
        applyFraming()
        attachPreviewIfReady()
    }

    fun detachPreview(view: SurfaceView) {
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
        val s = stream
        if (s != null) {
            try { if (previewing) s.stopPreview(true) } catch (_: RuntimeException) {}
            try { s.release() } catch (_: RuntimeException) {}
        }
        stream = null; camera = null; mic = null; prepared = false; previewing = false
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

    fun setMuted(muted: Boolean) { if (muted) mic?.mute() else mic?.unMute() }

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
