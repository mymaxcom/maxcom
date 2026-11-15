package my.maxcom.box.core

/** The local name of a box: one DNS label `boxN-surau` under `.local`, N from 1 to 99. */
object BoxName {
    const val MAX_N = 99
    const val SUFFIX = "-surau.local"
    private val SHAPE = Regex("^box([1-9][0-9]?)-surau\\.local$")

    /** `box<n>-surau.local`; [n] must be 1..99. */
    fun hostFor(n: Int): String {
        require(n in 1..MAX_N) { "box number must be 1..$MAX_N" }
        return "box$n$SUFFIX"
    }

    /** The number in [name] (lower case, exact shape), or null for anything else. */
    fun parse(name: String): Int? = SHAPE.matchEntire(name)?.groupValues?.get(1)?.toInt()

    /** All 99 names, in order. */
    fun all(): List<String> = (1..MAX_N).map { hostFor(it) }
}
