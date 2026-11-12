package my.maxcom.app.upload

/**
 * What the clean-up (Plan 6 Task 13) may delete: only this app's own recordings,
 * `Movies/MAXCOM/MAXCOM-<date>-<HHmm>-<label>-<nn>.mp4` (naming scheme 2), and only by name.
 * Files of the older scheme (no HHmm) and any renamed copy ("... (1).mp4") never pass. A file the app did not create
 * (another owner, another folder, another name) can never pass, whatever Dart asks for. Pure
 * functions, so the rule is unit tested off the device.
 */
object RecordingGuard {
    private val NAME = Regex("^MAXCOM-[0-9]{4}-[0-9]{2}-[0-9]{2}-([01][0-9]|2[0-3])[0-5][0-9]-[A-Za-z0-9_-]{1,40}-[0-9]{1,4}[.]mp4$")
    const val MAX_NAMES = 200

    /** True only for the exact name pattern the recorder writes (no path, no suffix, no line break). */
    fun isRecordingName(name: String): Boolean = NAME.matches(name)

    /** A MediaStore row: right name, directly in `Movies/MAXCOM`, and owned by this app's package. */
    fun acceptMediaRow(name: String, relativePath: String?, owner: String?, myPackage: String): Boolean {
        if (!isRecordingName(name)) return false
        if (owner == null || owner.isEmpty() || owner != myPackage) return false
        val p = relativePath?.trimEnd('/') ?: return false
        return p == "Movies/MAXCOM"
    }

    /** A file in the app's own `Movies/MAXCOM` folder: right name and directly inside it (no `..`, no sub folder). */
    fun acceptAppFile(appDir: String, name: String, path: String): Boolean {
        if (!isRecordingName(name)) return false
        if (path.contains("..")) return false
        return path == appDir.trimEnd('/') + "/" + name
    }

    /** The names Dart asked for that may be considered at all: valid, unique, at most [MAX_NAMES]. */
    fun askedNames(asked: List<String>): List<String> =
        asked.filter { isRecordingName(it) }.distinct().take(MAX_NAMES)
}
