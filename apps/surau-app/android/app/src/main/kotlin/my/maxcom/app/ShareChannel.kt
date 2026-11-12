package my.maxcom.app

import android.app.Activity
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.ClipData
import android.content.ComponentName
import android.content.ContentValues
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.provider.MediaStore
import androidx.core.content.FileProvider
import io.flutter.embedding.engine.FlutterEngine
import io.flutter.plugin.common.MethodCall
import io.flutter.plugin.common.MethodChannel
import java.io.File
import java.io.IOException

/** The rules for what the channel will write or send. Pure, so a unit test can run them. */
object ShareArgs {
    const val MAX_NAME = 100
    const val MAX_BYTES = 20 * 1024 * 1024

    val MIMES = setOf(
        "application/pdf",
        "text/csv",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    )

    private val EMAIL_PACKAGES = setOf(
        "com.google.android.gm",
        "com.microsoft.office.outlook",
        "com.yahoo.mobile.client.android.mail",
        "ch.protonmail.android",
        "com.samsung.android.email.provider",
        "com.android.email",
    )

    /** A plain file name: 1 to 100 characters, no `/`, `\` or `..`, no control character. */
    fun nameOk(name: String?): Boolean {
        if (name == null || name.isEmpty() || name.length > MAX_NAME) return false
        if (name.contains('/') || name.contains('\\') || name.contains("..")) return false
        return name.none { it.code < 0x20 || it.code == 0x7f }
    }

    fun mimeOk(mime: String?): Boolean = mime != null && mime in MIMES

    /** `whatsapp`, `email` or `other`, from the package the person chose (null when unknown). */
    fun classOf(pkg: String?): String = when {
        pkg == null -> "other"
        pkg == "com.whatsapp" || pkg == "com.whatsapp.w4b" -> "whatsapp"
        pkg in EMAIL_PACKAGES || pkg.contains("email") -> "email"
        else -> "other"
    }
}

/**
 * MethodChannel `my.maxcom/share` (Plan 7 Task 9). `save` writes the bytes to Downloads through
 * MediaStore on Android 10 and later (older phones answer `saved: false` and Dart opens the share
 * sheet); `share` writes them to `cache/finance/<name>` and sends them with ACTION_SEND through a
 * FileProvider URI, answering `{via, completed}` when the person picks an app (or after a timeout).
 *
 * A file name or content is never logged, and error replies carry no detail. Files in the cache
 * folder older than an hour are deleted on the next call.
 */
class ShareChannel private constructor(private val activity: Activity) : MethodChannel.MethodCallHandler {

    companion object {
        const val CHANNEL = "my.maxcom/share"
        const val AUTHORITY = "my.maxcom.app.files"
        private const val DIR = "finance"
        private const val STALE_MS = 60L * 60L * 1000L
        private const val CHOOSER_TIMEOUT_MS = 90_000L
        private const val ACTION_CHOSEN = "my.maxcom.app.SHARE_CHOSEN"

        @Volatile
        private var current: ShareChannel? = null

        fun register(engine: FlutterEngine, activity: Activity) {
            val ch = ShareChannel(activity)
            current = ch
            MethodChannel(engine.dartExecutor.binaryMessenger, CHANNEL).setMethodCallHandler(ch)
        }

        /** The chooser tells which component the person picked (from [ShareChosenReceiver]). */
        fun onChosen(pkg: String?) {
            current?.finishShare(ShareArgs.classOf(pkg), true)
        }
    }

    private val handler = Handler(Looper.getMainLooper())
    private var pending: MethodChannel.Result? = null
    private val timeout = Runnable { finishShare("other", false) }

    override fun onMethodCall(call: MethodCall, result: MethodChannel.Result) {
        if (call.method != "save" && call.method != "share") {
            result.notImplemented()
            return
        }
        val name = call.argument<String>("filename")
        val mime = call.argument<String>("mime")
        val bytes = call.argument<ByteArray>("bytes")
        if (!ShareArgs.nameOk(name) || !ShareArgs.mimeOk(mime) ||
            bytes == null || bytes.isEmpty() || bytes.size > ShareArgs.MAX_BYTES
        ) {
            result.error("bad_args", "bad arguments", null)
            return
        }
        try {
            if (call.method == "save") save(name!!, mime!!, bytes, result) else share(name!!, mime!!, bytes, result)
        } catch (_: Exception) {
            result.error("failed", "failed", null)
        }
    }

    private fun save(name: String, mime: String, bytes: ByteArray, result: MethodChannel.Result) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) {
            // Android 8 and 9: no scoped Downloads write without a storage permission; Dart shares instead.
            result.success(mapOf("saved" to false))
            return
        }
        val resolver = activity.contentResolver
        val values = ContentValues().apply {
            put(MediaStore.Downloads.DISPLAY_NAME, name)
            put(MediaStore.Downloads.MIME_TYPE, mime)
            put(MediaStore.Downloads.IS_PENDING, 1)
        }
        val uri = resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values) ?: throw IOException()
        try {
            val out = resolver.openOutputStream(uri) ?: throw IOException()
            out.use { it.write(bytes) }
            values.clear()
            values.put(MediaStore.Downloads.IS_PENDING, 0)
            resolver.update(uri, values, null, null)
        } catch (e: Exception) {
            resolver.delete(uri, null, null)
            throw e
        }
        result.success(mapOf("saved" to true))
    }

    private fun share(name: String, mime: String, bytes: ByteArray, result: MethodChannel.Result) {
        val dir = File(activity.cacheDir, DIR)
        dir.mkdirs()
        val cutoff = System.currentTimeMillis() - STALE_MS
        dir.listFiles()?.forEach { if (it.isFile && it.lastModified() < cutoff) it.delete() }

        val file = File(dir, name)
        // Belt and braces after nameOk: the file must sit directly in the share folder.
        if (file.canonicalFile.parentFile != dir.canonicalFile) throw IOException()
        file.writeBytes(bytes)
        val uri = FileProvider.getUriForFile(activity, AUTHORITY, file)

        val send = Intent(Intent.ACTION_SEND).apply {
            type = mime
            putExtra(Intent.EXTRA_STREAM, uri)
            clipData = ClipData.newRawUri("", uri)
            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        }
        // An earlier chooser still open is answered as not reported.
        finishShare("other", false)
        val chosen = PendingIntent.getBroadcast(
            activity,
            0,
            Intent(activity, ShareChosenReceiver::class.java).setAction(ACTION_CHOSEN),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_MUTABLE,
        )
        pending = result
        handler.postDelayed(timeout, CHOOSER_TIMEOUT_MS)
        try {
            activity.startActivity(Intent.createChooser(send, null, chosen.intentSender))
        } catch (e: Exception) {
            pending = null
            handler.removeCallbacks(timeout)
            throw e
        }
    }

    private fun finishShare(via: String, completed: Boolean) {
        val r = pending ?: return
        pending = null
        handler.removeCallbacks(timeout)
        r.success(mapOf("via" to via, "completed" to completed))
    }
}

/** Receives the chooser's "this app was picked" broadcast. Not exported (see the manifest). */
class ShareChosenReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val comp: ComponentName? = if (Build.VERSION.SDK_INT >= 33) {
            intent.getParcelableExtra(Intent.EXTRA_CHOSEN_COMPONENT, ComponentName::class.java)
        } else {
            @Suppress("DEPRECATION")
            intent.getParcelableExtra<ComponentName>(Intent.EXTRA_CHOSEN_COMPONENT)
        }
        ShareChannel.onChosen(comp?.packageName)
    }
}
