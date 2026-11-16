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

        /**
         * The local name line. [newRoot] false: a legacy root keeps IP access only (the name is not in its leaf).
         * [host] is the claimed name now, [exhausted] all 99 taken, [failed] the node could not start.
         */
        fun localName(
            newRoot: Boolean,
            host: String?,
            exhausted: Boolean,
            failed: Boolean,
            reason: String? = null,
            warning: String? = null,
        ): DoctorLine = when {
            !newRoot -> DoctorLine(true, "Nama setempat: tidak dipakai (sijil akar lama); akses melalui alamat IP.")
            exhausted -> DoctorLine(false, "Nama setempat: box1 hingga box99 semuanya sudah dipakai; akses melalui alamat IP sahaja.")
            host != null -> DoctorLine(warning == null, "Nama setempat: https://$host:8443" + (warning?.let { " ($it)" } ?: ""))
            failed -> DoctorLine(
                false,
                "Nama setempat: nama setempat tidak diumumkan" + (reason?.let { " ($it)" } ?: "") + "; akses melalui alamat IP.",
            )
            else -> DoctorLine(false, "Nama setempat: belum dituntut (menunggu rangkaian).")
        }

        /** The theme the TV wears: [themeOk] false is an uploaded theme that hid the clock, the prayer times or the logo. */
        fun theme(themeOk: Boolean?): DoctorLine = when (themeOk) {
            true -> DoctorLine(true, "tema paparan sah")
            false -> DoctorLine(false, "Tema tidak sah: TV memakai tema asas. Buka apl MAXCOM, Tetapan, Templat paparan.")
            null -> DoctorLine(true, "tema paparan: tiada laporan")
        }

        fun freeSpace(freeBytes: Long): DoctorLine =
            if (freeBytes >= MIN_FREE_BYTES) DoctorLine(true, "Ruang kosong ${freeBytes / (1024 * 1024)} MB.")
            else DoctorLine(false, "Ruang kosong tinggal ${freeBytes / (1024 * 1024)} MB (perlu 1024 MB atau lebih).")
    }
}
