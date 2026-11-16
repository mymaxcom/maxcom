package my.maxcom.app

/** What a picked file must look like before its bytes are read into memory. Pure, so a unit test runs it. */
object FilePickRules {
    /**
     * Null when the file is acceptable, `"type"` when its name does not end with [suffix] (case-insensitive),
     * `"size"` when it is larger than [maxBytes].
     */
    fun accept(name: String, size: Long, maxBytes: Long, suffix: String = ".maxtheme"): String? {
        if (!name.lowercase().endsWith(suffix.lowercase())) return "type"
        if (size > maxBytes) return "size"
        return null
    }
}
