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
            val channel = LiveChannel(activity, LiveEngine.get(activity))
            MethodChannel(flutter.dartExecutor.binaryMessenger, METHOD).setMethodCallHandler(channel)
            EventChannel(flutter.dartExecutor.binaryMessenger, EVENTS).setStreamHandler(channel)
            flutter.platformViewsController.registry.registerViewFactory(PREVIEW, PreviewFactory())
        }
    }

    private var permissionReply: ((Boolean) -> Unit)? = null
    private val permissionLauncher: ActivityResultLauncher<Array<String>> =
        activity.registerForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { grants ->
            val ok = grants[Manifest.permission.CAMERA] == true && grants[Manifest.permission.RECORD_AUDIO] == true
            permissionReply?.invoke(ok)
            permissionReply = null
        }

    override fun onListen(arguments: Any?, events: EventChannel.EventSink?) {
        engine.sink = events?.let { s -> LiveEngine.Sink { s.success(it) } }
    }

    override fun onCancel(arguments: Any?) {
        engine.sink = null
    }

    override fun onMethodCall(call: MethodCall, result: MethodChannel.Result) {
        when (call.method) {
            "prepare" -> prepare(call, result)
            "start" -> start(call, result)
            "stop" -> {
                // Off the main thread; answers when the recording is finished.
                engine.stopAsync {
                    try { LiveService.stop(activity.applicationContext) } catch (_: RuntimeException) {}
                    try { activity.window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON) } catch (_: RuntimeException) {}
                    try { result.success(null) } catch (_: RuntimeException) {}
                }
            }
            "startYoutube" -> {
                val err = engine.startYoutube(call.argument<String>("url"))
                if (err != null) result.error(err, null, null) else result.success(null)
            }
            "sessionRecordings" -> result.success(engine.sessionRecordings())
            "switchCamera" -> { engine.switchCamera(); result.success(null) }
            "setPortrait" -> { engine.reframe(); result.success(null) }
            "setMuted" -> { engine.setMuted(call.arguments == true); result.success(null) }
            // The external camera and the audio mix (plan rev 4). The camera address (it may hold the login) arrives
            // in `source.url`, goes to the engine and is not stored, logged or echoed back.
            "setSource" -> {
                val err = engine.setSource(specOf(call))
                refreshService()
                if (err != null) result.error(err, null, null) else result.success(null)
            }
            "setMix" -> {
                val kind = VideoKind.parse((call.argument<Map<String, Any?>>("source"))?.get("kind") as? String)
                val err = engine.setAudioMix(AudioMixCfg.fromMap(call.argument<Map<String, Any?>>("mix"), kind))
                refreshService()
                if (err != null) result.error(err, null, null) else result.success(null)
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
            "setMic" -> {
                engine.setPreferredMic(call.argument<String>("id"))
                result.success(null)
            }
            // A plain 3-pole plug in a 4-pole jack: headphones are seen, no microphone.
            "headphonesWithoutMic" -> result.success(AudioRecordPort.headphonesWithoutMic(activity.getSystemService(Context.AUDIO_SERVICE) as? AudioManager))
            else -> result.notImplemented()
        }
    }

    /**
     * Real microphones only (built-in, wired, USB). The id is the type and the product name, not the
     * system's number, so a microphone plugged in again is the same one. Nothing but names leaves here.
     */
    private fun audioInputs(): List<Map<String, Any?>> {
        val am = activity.getSystemService(Context.AUDIO_SERVICE) as AudioManager
        return AudioRecordPort.inputs(am).map { r ->
            // a neutral kind, never a words: the app names "builtin" and a nameless "external" in its own language;
            // a USB or wired microphone keeps its product name
            mapOf("id" to r.id, "name" to r.name, "kind" to r.kind, "builtin" to r.builtin)
        }
    }

    private fun specOf(call: MethodCall): SourceSpec = SourceLogic.specFrom(
        call.argument<Map<String, Any?>>("source"),
        call.argument<Map<String, Any?>>("mix"),
        call.argument<Number>("avOffsetMs"),
    )

    private fun hasPermissions() =
        listOf(Manifest.permission.CAMERA, Manifest.permission.RECORD_AUDIO).all {
            ContextCompat.checkSelfPermission(activity, it) == PackageManager.PERMISSION_GRANTED
        }

    private fun prepare(call: MethodCall, result: MethodChannel.Result) {
        val front = call.argument<String>("facing") == "front"
        val width = call.argument<Int>("width") ?: 1280
        val height = call.argument<Int>("height") ?: 720
        val fps = call.argument<Int>("fps") ?: 30
        val spec = specOf(call)
        val go = {
            val err = engine.prepare(front, width, height, fps, spec)
            if (err != null) {
                result.error(err, null, null)
            } else {
                result.success(mapOf("ok" to true, "cameras" to engine.cameras()))
            }
        }
        if (hasPermissions()) {
            go()
            return
        }
        if (permissionReply != null) {
            result.error("busy", null, null)
            return
        }
        permissionReply = { ok -> if (ok) go() else result.error("permission_denied", null, null) }
        val wanted = mutableListOf(Manifest.permission.CAMERA, Manifest.permission.RECORD_AUDIO)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) wanted += Manifest.permission.POST_NOTIFICATIONS
        permissionLauncher.launch(wanted.toTypedArray())
    }

    /** A source or microphone change during the live: the service takes the types of what is in use now. */
    private fun refreshService() {
        if (!engine.live) return
        try { LiveService.start(activity, engine.foregroundNeeds()) } catch (_: RuntimeException) {}
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
        val kbps = (call.argument<Map<String, Any?>>("video")?.get("bitrateKbps") as? Number)?.toInt() ?: 2500
        if (srtMap != null && srt == null) {
            result.error("srt_target_invalid", null, null)
            return
        }
        // The foreground service first: the camera and microphone must be held by it.
        try {
            LiveService.start(activity, engine.foregroundNeeds())
        } catch (e: RuntimeException) {
            result.error("service_failed", null, null)
            return
        }
        activity.window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        val err = engine.start(srt, rtmps, rec, kbps)
        if (err != null) {
            LiveService.stop(activity)
            activity.window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
            result.error(err, null, null)
        } else {
            result.success(null)
        }
    }
}
