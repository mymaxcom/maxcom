package my.maxcom.box.core

/** One check: [ok] and a Bahasa Malaysia [text]; [render] starts with `OK` or `GAGAL`. */
data class DoctorLine(val ok: Boolean, val text: String) {
    fun render(): String = (if (ok) "OK: " else "GAGAL: ") + clean(text)

    companion object {
        /** One line, bounded, and never a PEM block or a path under `secret`. */
        fun clean(text: String): String {
            if (text.contains("-----")) return "[dibuang]"
            val one = text.replace(Regex("[\\r\\n\\t]+"), " ").trim()
            val noSecret = Regex("\\S*[/\\\\]secret[/\\\\]\\S*").replace(one, "[dibuang]")
            return if (noSecret.length > 300) noSecret.substring(0, 300) else noSecret
        }
    }
}

/** The result of the on-box health check. [allOk] is false when any line failed. */
class DoctorReport(val lines: List<DoctorLine>, val logTail: List<String> = emptyList()) {
    val allOk: Boolean get() = lines.all { it.ok }

    fun render(): List<String> = lines.map { it.render() }

    companion object {
        const val WARN_DAYS = 60
        const val MIN_FREE_BYTES = 1L * 1024 * 1024 * 1024

        /** The last [n] lines that contain `WARNING` or `failed`, cleaned. */
        fun lastProblems(logLines: List<String>, n: Int = 5): List<String> =
            logLines.filter { it.contains("WARNING") || it.contains("failed") }.takeLast(n).map { DoctorLine.clean(it) }

        fun certDays(daysLeft: Long): DoctorLine =
            if (daysLeft >= WARN_DAYS) DoctorLine(true, "Pensijil sah $daysLeft hari lagi.")
            else if (daysLeft >= 0) DoctorLine(false, "Pensijil tinggal $daysLeft hari (kurang daripada $WARN_DAYS).")
            else DoctorLine(false, "Pensijil telah tamat tempoh.")

        fun freeSpace(freeBytes: Long): DoctorLine =
            if (freeBytes >= MIN_FREE_BYTES) DoctorLine(true, "Ruang kosong ${freeBytes / (1024 * 1024)} MB.")
            else DoctorLine(false, "Ruang kosong tinggal ${freeBytes / (1024 * 1024)} MB (perlu 1024 MB atau lebih).")
    }
}
