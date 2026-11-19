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
    const val MAX_TEXT = 4096
    const val MAX_SUBJECT = 200

    val MIMES = setOf(
        "application/pdf",
        "text/csv",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "application/vnd.maxcom.theme+zip",
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

    /** A text to share: 1 to 4,096 characters (counted as Dart counts them, in UTF-16 units). */
    fun textOk(text: String?): Boolean = text != null && text.isNotEmpty() && text.length <= MAX_TEXT

    val WHATSAPP_PACKAGES = listOf("com.whatsapp", "com.whatsapp.w4b")

    /** The live notice picture: absent, or a JPEG of 1 byte to 4 MB (starts with FF D8). */
    fun noticePictureOk(bytes: ByteArray?): Boolean =
        bytes == null || (bytes.size in 2..(4 * 1024 * 1024) && bytes[0] == 0xFF.toByte() && bytes[1] == 0xD8.toByte())

    /** An optional subject: absent, or at most 200 characters. */
    fun subjectOk(subject: String?): Boolean = subject == null || subject.length <= MAX_SUBJECT

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
        private const val DIR = "finance"
        private const val NOTICE_DIR = "live-notice"
        private const val STALE_MS = 60L * 60L * 1000L
        private const val CHOOSER_TIMEOUT_MS = 90_000L

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
        if (call.method == "shareText") {
            val text = call.argument<String>("text")
            val subject = call.argument<String>("subject")
            if (!ShareArgs.textOk(text) || !ShareArgs.subjectOk(subject)) {
                result.error("bad_args", "bad arguments", null)
                return
            }
            try {
                shareText(text!!, subject, result)
            } catch (_: Exception) {
                result.error("failed", "failed", null)
            }
            return
        }
        if (call.method == "whatsappInstalled") {
            result.success(whatsAppPackage() != null)
            return
        }
        if (call.method == "cleanNotice") {
            cleanNoticeDir()
            result.success(null)
            return
        }
        if (call.method == "shareNotice") {
            val text = call.argument<String>("text")
            val bytes = call.argument<ByteArray>("bytes")
            val toWhatsApp = call.argument<Boolean>("whatsapp") == true
            if (!ShareArgs.textOk(text) || !ShareArgs.noticePictureOk(bytes)) {
                result.error("bad_args", "bad arguments", null)
                return
            }
            try {
                shareNotice(text!!, bytes, toWhatsApp, result)
            } catch (_: Exception) {
                result.error("failed", "failed", null)
            }
            return
        }
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
        // A notice picture is only deleted when the sheet opens or the next one is written (the receiving app
        // may still be starting); one that nobody replaced goes after an hour like these.
        File(activity.cacheDir, NOTICE_DIR).listFiles()?.forEach { if (it.isFile && it.lastModified() < cutoff) it.delete() }

        val file = File(dir, name)
        // Belt and braces after nameOk: the file must sit directly in the share folder.
        if (file.canonicalFile.parentFile != dir.canonicalFile) throw IOException()
        file.writeBytes(bytes)
        val uri = FileProvider.getUriForFile(activity, activity.packageName + ".files", file)

        val send = Intent(Intent.ACTION_SEND).apply {
            type = mime
            putExtra(Intent.EXTRA_STREAM, uri)
            clipData = ClipData.newRawUri("", uri)
            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        }
        openChooser(send, result)
    }

    /** A plain text through ACTION_SEND; the text is never logged. Answers like [share]. */
    private fun shareText(text: String, subject: String?, result: MethodChannel.Result) {
        val send = Intent(Intent.ACTION_SEND).apply {
            type = "text/plain"
            putExtra(Intent.EXTRA_TEXT, text)
            if (subject != null) putExtra(Intent.EXTRA_SUBJECT, subject)
        }
        openChooser(send, result)
    }

    /** The first installed WhatsApp package (consumer, then Business), or null. */
    private fun whatsAppPackage(): String? {
        for (pkg in ShareArgs.WHATSAPP_PACKAGES) {
            try {
                activity.packageManager.getPackageInfo(pkg, 0)
                return pkg
            } catch (_: Exception) {
                // not installed
            }
        }
        return null
    }

    private fun cleanNoticeDir() {
        File(activity.cacheDir, NOTICE_DIR).listFiles()?.forEach { if (it.isFile) it.delete() }
    }

    /**
     * The live notice: the text, and a JPEG when given (cache/live-notice/siaran.jpg through the
     * FileProvider, deleted on the next call or by cleanNotice). With [toWhatsApp] and WhatsApp
     * installed the intent is aimed at that package (its own chooser of chats and groups); else the
     * system chooser. The text is the picture's caption. Nothing is logged.
     */
    private fun shareNotice(text: String, bytes: ByteArray?, toWhatsApp: Boolean, result: MethodChannel.Result) {
        cleanNoticeDir()
        val send = Intent(Intent.ACTION_SEND)
        send.putExtra(Intent.EXTRA_TEXT, text)
        if (bytes != null) {
            val dir = File(activity.cacheDir, NOTICE_DIR)
            dir.mkdirs()
            val file = File(dir, "siaran.jpg")
            file.writeBytes(bytes)
            val uri = FileProvider.getUriForFile(activity, activity.packageName + ".files", file)
            send.type = "image/jpeg"
            send.putExtra(Intent.EXTRA_STREAM, uri)
            send.clipData = ClipData.newRawUri("", uri)
            send.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        } else {
            send.type = "text/plain"
        }
        val pkg = if (toWhatsApp) whatsAppPackage() else null
        if (pkg != null) {
            // Straight into WhatsApp's own chooser: no system sheet, so no "which app" report.
            send.setPackage(pkg)
            finishShare("other", false)
            activity.startActivity(send)
            result.success(mapOf("via" to "whatsapp", "completed" to true))
            return
        }
        openChooser(send, result)
    }

    private fun openChooser(send: Intent, result: MethodChannel.Result) {
        // An earlier chooser still open is answered as not reported.
        finishShare("other", false)
        val chosen = PendingIntent.getBroadcast(
            activity,
            0,
            Intent(activity, ShareChosenReceiver::class.java).setAction(activity.packageName + ".SHARE_CHOSEN"),
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
