package my.maxcom.box

/** One text in the three languages of the box: Bahasa Malaysia (default), English, Arabic. */
class Tri(val ms: String, val en: String, val ar: String) {
    fun all(): List<String> = listOf(ms, en, ar)
}

/**
 * What the start screen and the maintenance screen say when this box is a follower (an extra TV of a main box).
 * The same words live in the three strings.xml files (the maintenance screen reads them there); a unit test keeps
 * the two copies equal, because the start screen text is built in plain Kotlin that runs in JVM tests.
 */
object FollowerTexts {
    /** The product term for one box; never the bare word "Kotak". Mirrors `box_term` in strings.xml. */
    const val BOX_TERM = "MAXCOM Kiosk Box"

    private const val LINE_MS = "TV tambahan kepada %s"
    private const val LINE_EN = "Extra TV for %s"
    private const val LINE_AR = "تلفاز إضافي تابع لـ %s"

    private val LINE_NO_NAME = Tri(
        "TV tambahan",
        "Extra TV",
        "تلفاز إضافي",
    )

    /** "TV tambahan kepada <name>" in the three languages; without a name the line says only that the TV is an extra one. */
    fun line(masterName: String): Tri {
        val n = masterName.trim()
        if (n.isEmpty()) return LINE_NO_NAME
        return Tri(LINE_MS.format(n), LINE_EN.format(n), LINE_AR.format(n))
    }

    /** The mode line of the maintenance status block. */
    fun mode(): Tri = Tri(
        "Mod: $BOX_TERM pengikut",
        "Mode: $BOX_TERM follower",
        "الوضع: $BOX_TERM تابع",
    )

    /** The maintenance menu entry that takes this box out of the surau (visible only on a follower). */
    val UNLINK_ENTRY = Tri(
        "Tanggalkan dari surau",
        "Remove from the surau",
        "إزالة من المصلى",
    )
}
