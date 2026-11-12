package my.maxcom.box.core

import java.io.File
import java.io.IOException
import java.io.InputStream
import java.security.DigestInputStream
import java.security.MessageDigest

/** The release archive shipped inside the APK. [open] returns a fresh stream each call. */
class BundledRelease(val version: String, val sha256: String, val open: () -> InputStream)

/**
 * The install root `box/`: `releases/<version>/` (with `.ok` written last), `current` (a relative
 * link `releases/<version>` switched by rename) and `previous.txt`. Mirrors the Windows layout.
 */
class ReleaseStore(
    private val root: File,
    private val links: Links,
    private val limits: TarLimits = TarLimits(),
) {
    private val releases = File(root, "releases")
    private val current = File(root, "current")
    private val currentTmp = File(root, "current.tmp")
    private val previousTxt = File(root, "previous.txt")

    /** The version `current` points at, or null when there is no valid link. */
    fun installed(): String? {
        val t = links.readLink(current) ?: return null
        val prefix = "releases/"
        if (!t.startsWith(prefix)) return null
        val v = t.substring(prefix.length).trimEnd('/')
        return if (VersionOrder.isValid(v)) v else null
    }

    /** The bundled release's version (validated). */
    fun bundled(assets: BundledRelease): String {
        require(VersionOrder.isValid(assets.version)) { "bad bundled version" }
        return assets.version
    }

    /** True when nothing is installed or the installed version is older than the bundled one. Newer on disk wins. */
    fun needsUnpack(bundledVersion: String): Boolean {
        val have = installed() ?: return true
        return VersionOrder.compare(have, bundledVersion) < 0
    }

    fun isComplete(version: String): Boolean =
        VersionOrder.isValid(version) && File(File(releases, version), ".ok").isFile

    /**
     * Unpacks [archive] (gzip tar) to `releases/<version>.part`, checks the whole stream against
     * [expectedSha256], makes the workspace links from `release.json`, renames the folder and writes
     * `.ok`. On any failure the `.part` folder is removed and the error rethrown; a finished release
     * is left alone (a second call is a no-op).
     */
    fun unpack(archive: InputStream, expectedSha256: String, version: String, progress: (done: Int) -> Unit) {
        require(VersionOrder.isValid(version)) { "bad version" }
        val expected = expectedSha256.lowercase()
        require(Regex("[0-9a-f]{64}").matches(expected)) { "bad sha256" }
        val finalDir = File(releases, version)
        if (File(finalDir, ".ok").isFile) return
        releases.mkdirs()
        val part = File(releases, "$version.part")
        deleteTree(part)
        deleteTree(finalDir) // a folder without .ok is the debris of a crash between rename and .ok
        try {
            val digest = MessageDigest.getInstance("SHA-256")
            val hashed = DigestInputStream(archive, digest)
            if (!part.mkdirs()) throw IOException("cannot create ${part.name}")
            var done = 0
            TarReader.read(hashed, limits) { entry, data ->
                if (entry.path.isEmpty()) return@read // archive root "./"
                val target = resolveInside(part, entry.path)
                if (entry.type == TarType.DIR) {
                    if (target.exists() && !target.isDirectory) throw BadEntry("directory over a file")
                    target.mkdirs()
                    if (!target.isDirectory) throw IOException("cannot create folder")
                } else {
                    val parent = target.parentFile
                    parent.mkdirs()
                    if (!parent.isDirectory) throw BadEntry("parent is not a folder")
                    if (target.isDirectory) throw BadEntry("file over a directory")
                    target.outputStream().use { out -> data.copyTo(out) }
                    if ((entry.mode and 0x40) != 0) target.setExecutable(true, true)
                    done++
                    progress(done)
                }
            }
            // Take the rest of the stream (gzip trailer, padding) so the hash covers every byte.
            val sink = ByteArray(8192)
            while (hashed.read(sink) >= 0) { /* drain */ }
            val actual = digest.digest().joinToString("") { "%02x".format(it) }
            if (actual != expected) throw IOException("sha256 mismatch")

            makeWorkspaceLinks(part, version)
            if (!part.renameTo(finalDir)) throw IOException("cannot rename ${part.name}")
            File(finalDir, ".ok").writeText("$version\n")
        } catch (t: Throwable) {
            deleteTree(part)
            throw t
        }
    }

    /** Makes `current` point at [version]. Requires `.ok`; records the old version in `previous.txt`. */
    fun switchTo(version: String) {
        require(VersionOrder.isValid(version)) { "bad version" }
        if (!isComplete(version)) throw IOException("release $version is not complete")
        val old = installed()
        if (old != null && old != version) {
            val tmp = File(root, "previous.txt.tmp")
            tmp.writeText("$old\n")
            java.nio.file.Files.move(
                tmp.toPath(), previousTxt.toPath(),
                java.nio.file.StandardCopyOption.ATOMIC_MOVE, java.nio.file.StandardCopyOption.REPLACE_EXISTING,
            )
        }
        deleteTree(currentTmp)
        links.symlink("releases/$version", currentTmp)
        links.renameOver(currentTmp, current)
    }

    /** Removes every release folder not in [keep] (the installed one is always kept). Links are removed, never followed. */
    fun prune(keep: Set<String>) {
        val protectedNames = keep + listOfNotNull(installed())
        val kids = releases.listFiles() ?: return
        for (k in kids) {
            if (k.name in protectedNames) continue
            deleteTree(k)
        }
    }

    /** Removes every `*.part` folder and a stale `current.tmp`, left by a power cut. */
    fun cleanParts() {
        releases.listFiles()?.filter { it.name.endsWith(".part") }?.forEach { deleteTree(it) }
        deleteTree(currentTmp)
        File(root, "previous.txt.tmp").delete()
    }

    // --- internals ---

    /** [base] + the already checked relative [path], verified once more to stay inside [base]. */
    private fun resolveInside(base: File, path: String): File {
        val f = File(base, path)
        val b = base.absoluteFile.normalize().path
        val p = f.absoluteFile.normalize().path
        if (!p.startsWith(b + File.separator)) throw BadEntry("entry resolves outside the release")
        return f
    }

    private fun makeWorkspaceLinks(part: File, version: String) {
        val meta = File(part, "release.json")
        if (!meta.isFile || meta.length() > 1_000_000) throw BadEntry("release.json missing or too large")
        val doc = MiniJson.parse(meta.readText(Charsets.UTF_8))
        val obj = doc as? Map<*, *> ?: throw BadEntry("release.json is not an object")
        val declared = obj["version"]
        if (declared != null && declared != version) throw BadEntry("release.json version differs from the archive version")
        val list = obj["workspaceLinks"] ?: return
        val items = list as? List<*> ?: throw BadEntry("workspaceLinks is not a list")
        val nameOk = Regex("@surau/[a-z-]+")
        for (item in items) {
            val m = item as? Map<*, *> ?: throw BadEntry("bad workspace link")
            val name = m["name"] as? String ?: throw BadEntry("bad workspace link name")
            val target = m["target"] as? String ?: throw BadEntry("bad workspace link target")
            if (!nameOk.matches(name)) throw BadEntry("workspace link name refused")
            val cleanTarget = try {
                TarReader.checkPath(target).also { if (it.isEmpty()) throw BadEntry("empty target") }
            } catch (e: BadEntry) {
                throw BadEntry("workspace link target refused")
            }
            val targetDir = resolveInside(part, cleanTarget)
            if (!targetDir.isDirectory) throw BadEntry("workspace link target is not a folder in the release")
            val link = resolveInside(part, "node_modules/$name")
            link.parentFile.mkdirs()
            if (link.exists()) throw BadEntry("workspace link path already exists")
            val depth = name.split('/').size // node_modules/@surau/x: parent folder is `depth` levels deep
            val rel = "../".repeat(depth) + cleanTarget
            links.symlink(rel, link)
        }
    }

    /** Deletes a file, link or folder tree. A link is removed itself; its target is never entered. */
    private fun deleteTree(f: File) {
        if (links.readLink(f) != null) {
            f.delete()
            return
        }
        if (!f.exists()) return
        if (f.isDirectory) f.listFiles()?.forEach { deleteTree(it) }
        f.delete()
    }

    /** Minimal JSON reader (objects, arrays, strings, numbers, true/false/null) so the core needs no android.* or library. */
    private object MiniJson {
        fun parse(text: String): Any? {
            val p = Parser(text)
            p.ws()
            val v = p.value(0)
            p.ws()
            if (p.pos != text.length) throw BadEntry("trailing data in JSON")
            return v
        }

        private class Parser(val s: String) {
            var pos = 0

            fun ws() {
                while (pos < s.length && (s[pos] == ' ' || s[pos] == '\t' || s[pos] == '\n' || s[pos] == '\r')) pos++
            }

            fun value(depth: Int): Any? {
                if (depth > 32) throw BadEntry("JSON too deep")
                if (pos >= s.length) throw BadEntry("unexpected end of JSON")
                return when (val c = s[pos]) {
                    '{' -> obj(depth)
                    '[' -> arr(depth)
                    '"' -> str()
                    't' -> lit("true", true)
                    'f' -> lit("false", false)
                    'n' -> lit("null", null)
                    else -> if (c == '-' || c in '0'..'9') num() else throw BadEntry("bad JSON")
                }
            }

            private fun lit(word: String, v: Any?): Any? {
                if (!s.startsWith(word, pos)) throw BadEntry("bad JSON")
                pos += word.length
                return v
            }

            private fun num(): Any {
                val start = pos
                while (pos < s.length && (s[pos] in '0'..'9' || s[pos] in "+-.eE")) pos++
                return s.substring(start, pos).toDoubleOrNull() ?: throw BadEntry("bad JSON number")
            }

            private fun str(): String {
                pos++ // opening quote
                val sb = StringBuilder()
                while (true) {
                    if (pos >= s.length) throw BadEntry("unterminated JSON string")
                    val c = s[pos++]
                    when {
                        c == '"' -> return sb.toString()
                        c == '\\' -> {
                            if (pos >= s.length) throw BadEntry("bad JSON escape")
                            when (val e = s[pos++]) {
                                '"', '\\', '/' -> sb.append(e)
                                'b' -> sb.append('\b')
                                'f' -> sb.append('\u000c')
                                'n' -> sb.append('\n')
                                'r' -> sb.append('\r')
                                't' -> sb.append('\t')
                                'u' -> {
                                    if (pos + 4 > s.length) throw BadEntry("bad JSON escape")
                                    val code = s.substring(pos, pos + 4).toIntOrNull(16) ?: throw BadEntry("bad JSON escape")
                                    sb.append(code.toChar())
                                    pos += 4
                                }
                                else -> throw BadEntry("bad JSON escape")
                            }
                        }
                        c.code < 0x20 -> throw BadEntry("control character in JSON string")
                        else -> sb.append(c)
                    }
                }
            }

            private fun arr(depth: Int): List<Any?> {
                pos++
                val out = ArrayList<Any?>()
                ws()
                if (pos < s.length && s[pos] == ']') { pos++; return out }
                while (true) {
                    ws()
                    out.add(value(depth + 1))
                    ws()
                    if (pos >= s.length) throw BadEntry("unterminated JSON array")
                    if (s[pos] == ',') { pos++; continue }
                    if (s[pos] == ']') { pos++; return out }
                    throw BadEntry("bad JSON array")
                }
            }

            private fun obj(depth: Int): Map<String, Any?> {
                pos++
                val out = LinkedHashMap<String, Any?>()
                ws()
                if (pos < s.length && s[pos] == '}') { pos++; return out }
                while (true) {
                    ws()
                    if (pos >= s.length || s[pos] != '"') throw BadEntry("bad JSON object")
                    val k = str()
                    ws()
                    if (pos >= s.length || s[pos] != ':') throw BadEntry("bad JSON object")
                    pos++
                    ws()
                    out[k] = value(depth + 1)
                    ws()
                    if (pos >= s.length) throw BadEntry("unterminated JSON object")
                    if (s[pos] == ',') { pos++; continue }
                    if (s[pos] == '}') { pos++; return out }
                    throw BadEntry("bad JSON object")
                }
            }
        }
    }
}
