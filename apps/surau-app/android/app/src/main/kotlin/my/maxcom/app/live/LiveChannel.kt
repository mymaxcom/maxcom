package my.maxcom.app.live

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.media.AudioManager
import android.os.Build
import android.view.WindowManager
import androidx.activity.result.ActivityResultLauncher
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.content.ContextCompat
import androidx.fragment.app.FragmentActivity
import io.flutter.embedding.engine.FlutterEngine
import io.flutter.plugin.common.EventChannel
import io.flutter.plugin.common.MethodCall
import io.flutter.plugin.common.MethodChannel

/**
 * MethodChannel `my.maxcom/live` and EventChannel `my.maxcom/live/events`.
 * The stream key and SRT passphrase arrive once inside `start`; they are
 * passed to the engine and not stored, logged or put in the notification.
 * Errors to Dart carry reason codes only.
 *
 * 2026.11.15 (3.2, B9): the engine and the service outlive this channel. A screen that attaches later is told the
 * present state at once (`onListen` replays it) and can ask `status` for the live the service holds: the session id
 * the app gave at `start`, since when, whether the picture is being sent right now, and the recordings so far.
 * Nothing secret is in that answer.
 */
class LiveChannel private constructor(
    private val activity: FragmentActivity,
    private val engine: LiveEngine,
) : MethodChannel.MethodCallHandler, EventChannel.StreamHandler {

    companion object {
        const val METHOD = "my.maxcom/live"
        const val EVENTS = "my.maxcom/live/events"
        const val PREVIEW = "my.maxcom/live/preview"

        /** Call from `configureFlutterEngine`, which runs during `onCreate`. */
        fun register(flutter: FlutterEngine, activity: FragmentActivity) {
            val engine = LiveEngine.get(activity)
            // the Bluetooth call link below Android 12 listens for a broadcast: it needs a context
            engine.micRouting.context = activity.applicationContext
            val channel = LiveChannel(activity, engine)
            MethodChannel(flutter.dartExecutor.binaryMessenger, METHOD).setMethodCallHandler(channel)
            EventChannel(flutter.dartExecutor.binaryMessenger, EVENTS).setStreamHandler(channel)
            flutter.platformViewsController.registry.registerViewFactory(PREVIEW, PreviewFactory())
            // N1: however a live ends (the screen, the notification, a lost camera, nobody watching), the screen-on
            // flag of the activity that is there now is cleared. A newer activity replaces this hook.
            engine.onLiveEnded = { channel.keepScreenOn(false) }
            // O12: an activity made while a live or a recording runs (rotation, process kept alive) keeps the screen on.
            channel.keepScreenOn(ScreenOn.wanted(engine.live))
        }

        /** O12: called when the app comes back to the front; the flag follows the engine, on every app screen. */
        fun reapplyScreenOn(activity: FragmentActivity) {
            try {
                val on = ScreenOn.wanted(LiveEngine.get(activity).live)
                if (on) activity.window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
                else activity.window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
            } catch (_: RuntimeException) {
            }
        }
    }

    private fun keepScreenOn(on: Boolean) {
        try {
            if (on) activity.window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
            else activity.window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        } catch (_: RuntimeException) {
        }
    }

    private var permissionReply: ((Map<String, Boolean>) -> Unit)? = null
    private val permissionLauncher: ActivityResultLauncher<Array<String>> =
        activity.registerForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { grants ->
            val reply = permissionReply
            permissionReply = null
            reply?.invoke(grants)
        }
    private var askedNotifications = false

    override fun onListen(arguments: Any?, events: EventChannel.EventSink?) {
        engine.sink = events?.let { s -> LiveEngine.Sink { try { s.success(it) } catch (_: RuntimeException) {} } }
        // A screen opened during a live: it gets the phase, the legs, the recording and the warnings as they are now.
        if (events != null) {
            engine.replayState()
            keepScreenOn(ScreenOn.wanted(engine.live))
        }
    }

    override fun onCancel(arguments: Any?) {
        engine.sink = null
        // The screen is gone. A running live goes on in the service; an idle engine is let go (N1).
        engine.releaseIfIdle()
    }

    override fun onMethodCall(call: MethodCall, result: MethodChannel.Result) {
        when (call.method) {
            "prepare" -> prepare(call, result)
            "start" -> start(call, result)
            "stop" -> {
                // Off the main thread; answers when the recording is finished and its name is listed.
                engine.stopAsync(StopPath.SCREEN) {
                    try { LiveService.stop(activity.applicationContext) } catch (_: RuntimeException) {}
                    keepScreenOn(false)
                    try { result.success(null) } catch (_: RuntimeException) {}
                }
            }
            // B11: this phone will not take the picture itself (the box pulls the camera, or another device holds it):
            // a prepared engine that sends nothing closes its camera or its pull. Never during a live.
            "release" -> result.success(engine.releasePrepared())
            // F1: a live this phone only controls keeps the screen on (set at its start, cleared at its end).
            "keepScreen" -> {
                val on = call.arguments as? Boolean ?: false
                ScreenOn.control = on
                keepScreenOn(ScreenOn.wanted(engine.live))
                result.success(null)
            }
            // The live the service holds, or null. No stream key, passphrase or address: see LiveSessionHolder.status.
            "status" -> result.success(LiveService.session.status(engine.streamingNow(), engine.sessionRecordings()))
            // The app learned the box's session id after the engine started.
            "setSession" -> {
                LiveService.session.setSessionId(call.argument<String>("sessionId") ?: "")
                result.success(null)
            }
            // B7: the picture brightness setting (`auto`, `normal`, `bright`, `brighter`); anything else is `auto`.
            "setBrightness" -> {
                engine.setBrightness(call.argument<String>("level"))
                result.success(null)
            }
            "startYoutube" -> {
                val err = engine.startYoutube(call.argument<String>("url"))
                if (err != null) result.error(err, null, null) else result.success(null)
            }
            "sessionRecordings" -> result.success(engine.sessionRecordings())
            "switchCamera" -> { engine.switchCamera(); result.success(null) }
            "setPortrait" -> { engine.reframe(); result.success(null) }
            "setMuted" -> {
                // the phone's mute silences everything the phone sends (A4): the sources read it from the routing
                engine.micRouting.muteAll = call.arguments == true
                engine.setMuted(call.arguments == true)
                result.success(null)
            }
            // "Naikkan suara perlahan" of one source (the camera sound or the phone microphone): {id, on}.
            "setLift" -> {
                val ok = SourceLogic.applyLift(engine.micRouting, call.argument<String>("id"), call.argument<Boolean>("on") != false)
                if (ok) result.success(null) else result.error("lift_source_unknown", null, null)
            }
            // The external camera and the audio mix (plan rev 4). The camera address (it may hold the login) arrives
            // in `source.url`, goes to the engine and is not stored, logged or echoed back.
            "setSource" -> {
                val spec = specOf(call)
                withPermissions(spec.video, spec.mix, result) {
                    SourceLogic.applyMixToRouting(engine.micRouting, spec.mix)
                    val err = engine.setSource(spec)
                    refreshService()
                    if (err != null) result.error(err, null, null) else result.success(null)
                }
            }
            "setMix" -> {
                val kind = VideoKind.parse((call.argument<Map<String, Any?>>("source"))?.get("kind") as? String)
                val mix = AudioMixCfg.fromMap(call.argument<Map<String, Any?>>("mix"), kind)
                withPermissions(kind, mix, result) {
                    SourceLogic.applyMixToRouting(engine.micRouting, mix)
                    val err = engine.setAudioMix(mix)
                    refreshService()
                    if (err != null) result.error(err, null, null) else result.success(null)
                }
            }
            "setAvOffset" -> {
                engine.setAvOffsetMs((call.arguments as? Number)?.toInt() ?: 0)
                result.success(null)
            }
            "clapCapture" -> {
                val err = engine.clapCapture()
                if (err != null) result.error(err, null, null) else result.success(null)
            }
            "clapReplay" -> {
                val err = engine.clapReplay((call.arguments as? Number)?.toInt() ?: 0)
                if (err != null) result.error(err, null, null) else result.success(null)
            }
            "clapOffset" -> { engine.clapOffset((call.arguments as? Number)?.toInt() ?: 0); result.success(null) }
            "clapStop" -> { engine.clapStop(); result.success(null) }
            // The microphones the system offers now (the Live tab reads this every few seconds to notice a plugged-in one).
            "audioInputs" -> result.success(audioInputs())
            // Which microphone the live records from: a `type:product` id, "own" or null (automatic). Reasons only.
            "setMic" -> setMic(call.argument<String>("id"), result)
            // A plain 3-pole plug in a 4-pole jack: headphones are seen, no microphone.
            "headphonesWithoutMic" -> result.success(AudioRecordPort.headphonesWithoutMic(activity.getSystemService(Context.AUDIO_SERVICE) as? AudioManager))
            else -> result.notImplemented()
        }
    }

    /**
     * Real microphones only (built-in, wired, USB, Bluetooth). The id is the type and the product name, not the
     * system's number, so a microphone plugged in again is the same one. Nothing but names leaves here.
     */
    private fun audioInputs(): List<Map<String, Any?>> {
        val am = activity.getSystemService(Context.AUDIO_SERVICE) as AudioManager
        return AudioRecordPort.inputs(am).map { r ->
            // a neutral kind, never a words: the app names "builtin" and a nameless "external" in its own language;
            // a USB or wired microphone keeps its product name
            mapOf("id" to r.id, "name" to r.name, "kind" to r.kind, "builtin" to r.builtin, "bluetooth" to r.bluetooth)
        }
    }

    /**
     * The person chose a microphone. A Bluetooth one needs the Bluetooth permission on Android 12 and later: it is
     * asked here, only now (never for a wired or USB microphone), and a refusal answers `bluetooth_permission_denied`
     * (the row says so, the live goes on with the microphone it had).
     */
    private fun setMic(id: String?, result: MethodChannel.Result) {
        val perm = Manifest.permission.BLUETOOTH_CONNECT
        if (!MicRouting.needsBluetoothPermission(id, Build.VERSION.SDK_INT) || granted(perm)) {
            engine.setPreferredMic(id)
            result.success(null)
            return
        }
        if (permissionReply != null) {
            result.error("busy", null, null)
            return
        }
        permissionReply = { grants ->
            if (grants[perm] == true || granted(perm)) {
                engine.setPreferredMic(id)
                result.success(null)
            } else {
                result.error("bluetooth_permission_denied", null, null)
            }
        }
        permissionLauncher.launch(arrayOf(perm))
    }

    private fun specOf(call: MethodCall): SourceSpec = SourceLogic.specFrom(
        call.argument<Map<String, Any?>>("source"),
        call.argument<Map<String, Any?>>("mix"),
        call.argument<Number>("avOffsetMs"),
    )

    private fun granted(permission: String) =
        ContextCompat.checkSelfPermission(activity, permission) == PackageManager.PERMISSION_GRANTED

    private fun manifestName(p: LivePermission) = when (p) {
        LivePermission.CAMERA -> Manifest.permission.CAMERA
        LivePermission.MICROPHONE -> Manifest.permission.RECORD_AUDIO
    }

    /**
     * Runs [go] once the permissions this source really uses are granted (C9): the phone camera needs the camera
     * and the microphone; the external camera needs the microphone only when the phone's microphone is in the mix,
     * and nothing at all otherwise. On Android 13 and later the notification permission is asked for once alongside
     * (the notification carries "Hentikan siaran"); a refusal of it never blocks the live.
     */
    private fun withPermissions(video: VideoKind, mix: AudioMixCfg, result: MethodChannel.Result, go: () -> Unit) {
        val missing = SourceLogic.permissionsFor(video, mix.deviceMic.enabled).map(::manifestName).filter { !granted(it) }
        val askNotify = Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU && !askedNotifications &&
            !granted(Manifest.permission.POST_NOTIFICATIONS)
        if (missing.isEmpty() && !askNotify) {
            go()
            return
        }
        if (permissionReply != null) {
            result.error("busy", null, null)
            return
        }
        permissionReply = { grants ->
            if (missing.all { grants[it] == true || granted(it) }) go() else result.error("permission_denied", null, null)
        }
        val wanted = missing.toMutableList()
        if (askNotify) {
            askedNotifications = true
            wanted += Manifest.permission.POST_NOTIFICATIONS
        }
        permissionLauncher.launch(wanted.toTypedArray())
    }

    private fun prepare(call: MethodCall, result: MethodChannel.Result) {
        val front = call.argument<String>("facing") == "front"
        val width = call.argument<Int>("width") ?: 1280
        val height = call.argument<Int>("height") ?: 720
        val fps = call.argument<Int>("fps") ?: 30
        val spec = specOf(call)
        withPermissions(spec.video, spec.mix, result) {
            SourceLogic.applyMixToRouting(engine.micRouting, spec.mix)
            val err = engine.prepare(front, width, height, fps, spec)
            if (err != null) {
                result.error(err, null, null)
            } else {
                // `live`: the engine kept a running live as it was (the screen was opened again during it)
                result.success(mapOf("ok" to true, "cameras" to engine.cameras(), "live" to engine.live))
            }
        }
    }

    /** A source or microphone change during the live: the service takes the types of what is in use now. */
    private fun refreshService() {
        if (!engine.live) return
        try { LiveService.refresh(activity.applicationContext, engine.foregroundNeeds()) } catch (_: RuntimeException) {}
    }

    private fun start(call: MethodCall, result: MethodChannel.Result) {
        val srtMap = call.argument<Map<String, Any?>>("srt")
        val srt = srtMap?.let {
            SrtTarget(
                host = it["host"] as? String ?: return@let null,
                port = (it["port"] as? Number)?.toInt() ?: return@let null,
                streamId = it["streamId"] as? String ?: "",
                passphrase = it["passphrase"] as? String,
            )
        }
        val rtmps = call.argument<Map<String, Any?>>("rtmps")?.get("url") as? String
        val rec = call.argument<Map<String, Any?>>("record")?.let {
            RecordCfg(
                prefix = LiveLogic.sanitizePrefix(it["prefix"] as? String),
                segmentMinutes = (it["segmentMinutes"] as? Number)?.toInt() ?: 15,
            )
        }
        val kbps = (call.argument<Map<String, Any?>>("video")?.get("bitrateKbps") as? Number)?.toInt() ?: 3500
        if (srtMap != null && srt == null) {
            result.error("srt_target_invalid", null, null)
            return
        }
        if (engine.live) {
            // The engine already runs a live (the screen came back): nothing is started twice.
            result.error("already_live", null, null)
            return
        }
        // The foreground service first: the camera and microphone must be held by it.
        try {
            LiveService.start(activity.applicationContext, engine.foregroundNeeds())
        } catch (e: RuntimeException) {
            result.error("service_failed", null, null)
            return
        }
        keepScreenOn(true)
        // The box's session id (a handle, not a secret): the service keeps it so `status` can name the live.
        val err = engine.start(srt, rtmps, rec, kbps, call.argument<String>("sessionId"))
        if (err != null) {
            LiveService.stop(activity.applicationContext)
            keepScreenOn(false)
            result.error(err, null, null)
        } else {
            result.success(null)
        }
    }
}
