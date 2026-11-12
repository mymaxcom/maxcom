package my.maxcom.box.core

import java.io.File
import java.time.Instant
import java.time.temporal.ChronoUnit

/** Writes `logs/cert-renew.log` in the format `tls.ts` reads: `<ISO time> SKIP|RENEWED|FAIL <message>`. */
object CertLog {
    enum class Kind { SKIP, RENEWED, FAIL }

    const val MAX_MESSAGE = 300
    private const val MAX_BYTES = 128 * 1024
    private const val KEEP_LINES = 300

    /**
     * Appends one line. The message is one line of at most 300 characters; control characters become
     * spaces and anything that looks like PEM material is replaced, so a key can never reach the log.
     * Beyond 128 KB the file is cut back to its last 300 lines.
     */
    fun append(file: File, kind: Kind, message: String, now: Instant = Instant.now()) {
        file.parentFile?.mkdirs()
        val line = "${now.truncatedTo(ChronoUnit.SECONDS)} ${kind.name} ${clean(message)}\n"
        file.appendBytes(line.toByteArray(Charsets.UTF_8))
        if (file.length() > MAX_BYTES) trim(file)
    }

    fun clean(message: String): String {
        val noPem = if (message.contains("-----")) "[removed]" else message
        val sb = StringBuilder()
        for (ch in noPem) sb.append(if (ch < ' ' || ch == '\u007f') ' ' else ch)
        val s = sb.toString().trim()
        return if (s.length > MAX_MESSAGE) s.substring(0, MAX_MESSAGE) else s
    }

    private fun trim(file: File) {
        val lines = file.readLines(Charsets.UTF_8)
        val tail = lines.takeLast(KEEP_LINES)
        val tmp = File(file.parentFile, file.name + ".tmp")
        tmp.writeText(tail.joinToString("\n", postfix = "\n"), Charsets.UTF_8)
        java.nio.file.Files.move(
            tmp.toPath(), file.toPath(),
            java.nio.file.StandardCopyOption.REPLACE_EXISTING,
        )
    }
}
