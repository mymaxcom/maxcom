package my.maxcom.box.core

/** Release versions look like 2026.11.2 (year.month.counter). Compared numerically per part. */
object VersionOrder {
    private val FORMAT = Regex("[0-9]{4}\\.[0-9]{1,2}\\.[0-9]{1,4}")

    fun isValid(version: String): Boolean = FORMAT.matches(version)

    /** Throws IllegalArgumentException for anything that is not a valid version. */
    fun parse(version: String): List<Int> {
        require(isValid(version)) { "bad version" }
        return version.split('.').map { it.toInt() }
    }

    /** Negative when a is older than b, zero when equal, positive when newer. */
    fun compare(a: String, b: String): Int {
        val pa = parse(a)
        val pb = parse(b)
        for (i in pa.indices) {
            val c = pa[i].compareTo(pb[i])
            if (c != 0) return c
        }
        return 0
    }
}
