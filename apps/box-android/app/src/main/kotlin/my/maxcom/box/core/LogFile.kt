package my.maxcom.box.core

import java.io.File
import java.io.FileOutputStream
import java.time.Instant
import java.time.ZoneOffset
import java.time.format.DateTimeFormatter

/**
 * `data/logs/box.log`: one ISO time per line (same shape as launcher.mjs), rotated at [maxBytes] with
 * [keep] older files (`box.log.1` newest). Values added with [addSecret] never reach the file.
 */
class LogFile(
    private val file: File,
    private val maxBytes: Long = 5L * 1024 * 1024,
    private val keep: Int = 3,
    private val nowMs: () -> Long = System::currentTimeMillis,
) {
    private val secrets = LinkedHashSet<String>()

    @Synchronized
    fun addSecret(value: String) {
        if (value.length >= MIN_SECRET_LENGTH) secrets.add(value)
    }

    @Synchronized
    fun redact(text: String): String {
        var out = text
        for (s in secrets) out = out.replace(s, "***")
        return out
    }

    /** Appends [text]; embedded newlines make one stamped line each. */
    @Synchronized
    fun appendLine(text: String) {
        val stamp = FORMAT.format(Instant.ofEpochMilli(nowMs())) + " "
        val sb = StringBuilder()
        for (raw in text.split('\n')) {
            sb.append(stamp).append(redact(raw.trimEnd('\r'))).append('\n')
        }
        val bytes = sb.toString().toByteArray(Charsets.UTF_8)
        file.absoluteFile.parentFile?.mkdirs()
        rotateIfNeeded(bytes.size)
        FileOutputStream(file, true).use { it.write(bytes) }
    }

    private fun rotateIfNeeded(incoming: Int) {
        if (!file.exists() || file.length() + incoming <= maxBytes) return
        if (keep <= 0) {
            file.delete()
            return
        }
        File(file.path + "." + keep).delete()
        for (i in keep - 1 downTo 1) {
            val src = File(file.path + "." + i)
            if (src.exists()) src.renameTo(File(file.path + "." + (i + 1)))
        }
        file.renameTo(File(file.path + ".1"))
    }

    companion object {
        const val MIN_SECRET_LENGTH = 8
        private val FORMAT: DateTimeFormatter =
            DateTimeFormatter.ofPattern("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'").withZone(ZoneOffset.UTC)
    }
}
