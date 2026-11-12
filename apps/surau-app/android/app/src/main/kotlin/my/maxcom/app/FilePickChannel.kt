package my.maxcom.app

import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.provider.OpenableColumns
import io.flutter.embedding.engine.FlutterEngine
import io.flutter.plugin.common.MethodCall
import io.flutter.plugin.common.MethodChannel
import java.io.ByteArrayOutputStream
import java.io.InputStream

/** What [FilePick.readCapped] found: the bytes, or that the stream went past the cap. */
class CappedRead(val bytes: ByteArray?, val tooBig: Boolean)

object FilePick {
    /**
     * Reads [input] into memory, never holding more than [maxBytes] plus one buffer. A stream longer than
     * [maxBytes] is reported `tooBig` and the rest is not read.
     */
    fun readCapped(input: InputStream, maxBytes: Int): CappedRead {
        val out = ByteArrayOutputStream()
        val buf = ByteArray(8192)
        var total = 0
        while (true) {
            val n = input.read(buf)
            if (n < 0) break
            total += n
            if (total > maxBytes) return CappedRead(null, true)
            out.write(buf, 0, n)
        }
        return CappedRead(out.toByteArray(), false)
    }

    /** A display name safe to hand to Dart: the last path segment, control characters removed, cut at 200. */
    fun cleanName(raw: String?): String {
        val last = (raw ?: "").substringAfterLast('/').replace(Regex("[\\u0000-\\u001f\\u007f]"), "").trim()
        return if (last.isEmpty()) "file" else last.take(200)
    }
}

/**
 * MethodChannel `my.maxcom/filepick` (Plan 13 Task 10). `pick` opens the system document picker
 * (ACTION_OPEN_DOCUMENT) for the MIME types Dart names and answers null when the person backs out,
 * `{name, tooBig: true}` over `maxBytes`, otherwise `{name, bytes}`. The file is read through the
 * content resolver into memory only; nothing is written to storage or logged.
 *
 * Register from `configureFlutterEngine`: `FilePickChannel.register(flutterEngine, this)`, and forward
 * `onActivityResult` to [onResult].
 */
class FilePickChannel private constructor(private val activity: Activity) : MethodChannel.MethodCallHandler {

    companion object {
        const val METHOD = "my.maxcom/filepick"
        const val REQUEST = 7413
        private val DEFAULT_TYPES = listOf(
            "text/csv",
            "text/comma-separated-values",
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            "application/zip",
        )

        @Volatile
        private var current: FilePickChannel? = null

        fun register(flutter: FlutterEngine, activity: Activity) {
            val ch = FilePickChannel(activity)
            current = ch
            MethodChannel(flutter.dartExecutor.binaryMessenger, METHOD).setMethodCallHandler(ch)
        }

        /** Forward the activity's result here; true when it was the pick's. */
        fun onResult(requestCode: Int, resultCode: Int, data: Intent?): Boolean {
            if (requestCode != REQUEST) return false
            current?.finish(resultCode, data)
            return true
        }
    }

    private var pending: MethodChannel.Result? = null
    private var maxBytes: Int = 0

    override fun onMethodCall(call: MethodCall, result: MethodChannel.Result) {
        if (call.method != "pick") {
            result.notImplemented()
            return
        }
        if (pending != null) {
            result.error("busy", "pick already open", null)
            return
        }
        val types = (call.argument<List<*>>("mimeTypes") ?: emptyList<Any>()).filterIsInstance<String>()
            .ifEmpty { DEFAULT_TYPES }
        maxBytes = (call.argument<Number>("maxBytes") ?: 0).toInt()
        if (maxBytes <= 0) {
            result.error("bad_args", "maxBytes", null)
            return
        }
        val intent = Intent(Intent.ACTION_OPEN_DOCUMENT).apply {
            addCategory(Intent.CATEGORY_OPENABLE)
            // Some providers report a CSV as octet-stream, so the type is open and the list narrows it.
            type = "*/*"
            putExtra(Intent.EXTRA_MIME_TYPES, types.toTypedArray())
        }
        pending = result
        try {
            activity.startActivityForResult(intent, REQUEST)
        } catch (_: RuntimeException) {
            pending = null
            result.error("no_picker", "no document picker", null)
        }
    }

    private fun finish(resultCode: Int, data: Intent?) {
        val result = pending ?: return
        pending = null
        val uri: Uri? = data?.data
        if (resultCode != Activity.RESULT_OK || uri == null) {
            result.success(null)
            return
        }
        try {
            val name = FilePick.cleanName(displayName(uri))
            val stream = activity.contentResolver.openInputStream(uri)
            if (stream == null) {
                result.error("unreadable", "cannot open", null)
                return
            }
            val read = stream.use { FilePick.readCapped(it, maxBytes) }
            if (read.tooBig) {
                result.success(mapOf("name" to name, "tooBig" to true))
            } else {
                result.success(mapOf("name" to name, "bytes" to read.bytes))
            }
        } catch (_: Exception) {
            result.error("unreadable", "cannot read", null)
        }
    }

    private fun displayName(uri: Uri): String? =
        activity.contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { c ->
            if (c.moveToFirst()) c.getString(0) else null
        } ?: uri.lastPathSegment
}
