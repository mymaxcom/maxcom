package my.maxcom.box.core

import java.io.File
import java.io.IOException
import java.io.InputStream
import java.nio.file.Files
import java.nio.file.LinkOption
import java.nio.file.StandardCopyOption
import java.security.MessageDigest
import org.json.JSONArray
import org.json.JSONException
import org.json.JSONObject

/** Raised for a map or input the layout refuses; the message is Bahasa Malaysia for the start screen. */
class RuntimeLayoutException(message: String) : Exception(message)

/**
 * Remakes the symlink folders the child needs, at every start: `runtime/lib` (library names the
 * linker looks for, each pointing into the APK's native library folder) and `tools/live`.
 * Only links are made; nothing is copied into a place the child could execute from.
 */
class RuntimeLayout(private val paths: BoxPaths, private val links: Links) {

    private class Entry(val apk: String, val name: String)

    fun rebuild(libmapJson: String, versionsMd: String, certPem: InputStream) {
        // 1. Validate everything before touching the disk.
        val entries = parseMap(libmapJson)
        val certBytes = readCapped(certPem, MAX_CERT_BYTES)
        if (!String(certBytes, Charsets.ISO_8859_1).contains("BEGIN CERTIFICATE")) {
            throw RuntimeLayoutException("GAGAL: cert.pem bukan sijil PEM")
        }
        val versionsBytes = versionsMd.toByteArray(Charsets.UTF_8)
        if (versionsBytes.size > MAX_VERSIONS_BYTES) throw RuntimeLayoutException("GAGAL: VERSIONS.md terlalu besar")

        // 2. runtime/lib
        emptyDir(paths.runtimeLib)
        for (e in entries) {
            links.symlink(paths.nativeLib(e.apk).path, File(paths.runtimeLib, e.name))
        }

        // 3. tools/live (links, plus VERSIONS.md); a missing tool is left out, tools.ts reports it
        emptyDir(paths.toolsLive)
        for ((apk, link) in listOf("libmediamtx.so" to paths.mediamtxLink, "libffmpeg.so" to paths.ffmpegLink)) {
            if (paths.nativeLib(apk).isFile) {
                mkdirs(link.parentFile)
                links.symlink(paths.nativeLib(apk).path, link)
            }
        }
        writeAtomic(paths.versionsMd, versionsBytes)

        // 4. runtime/etc/cert.pem, copied only when it differs
        mkdirs(paths.runtimeEtc)
        val existing = try {
            if (paths.certPem.isFile) sha256(paths.certPem.readBytes()) else null
        } catch (_: IOException) {
            null
        }
        if (existing == null || existing != sha256(certBytes)) writeAtomic(paths.certPem, certBytes)

        mkdirs(paths.tmp)
    }

    private fun parseMap(json: String): List<Entry> {
        val arr = try {
            JSONArray(json)
        } catch (_: JSONException) {
            throw RuntimeLayoutException("GAGAL: libmap.json tidak sah")
        }
        if (arr.length() == 0 || arr.length() > MAX_ENTRIES) throw RuntimeLayoutException("GAGAL: libmap.json tidak sah")
        val out = ArrayList<Entry>()
        val seen = HashSet<String>()
        for (i in 0 until arr.length()) {
            val o = arr.opt(i) as? JSONObject ?: throw RuntimeLayoutException("GAGAL: libmap.json tidak sah")
            val apk = o.opt("apk") as? String
            val name = o.opt("name") as? String
            if (apk == null || name == null || !plain(apk) || !plain(name)) {
                throw RuntimeLayoutException("GAGAL: libmap.json mengandungi nama yang tidak dibenarkan")
            }
            if (!paths.nativeLib(apk).isFile) throw RuntimeLayoutException("GAGAL: pustaka tiada dalam APK: $apk")
            if (!seen.add(name)) throw RuntimeLayoutException("GAGAL: libmap.json mempunyai nama berulang")
            out.add(Entry(apk, name))
        }
        return out
    }

    /** A bare file name: no separator, no `..`, no NUL or control characters, not empty, not `.`. */
    private fun plain(s: String): Boolean =
        s.isNotEmpty() && s.length <= 128 && s != "." && !s.contains("..") &&
            s.none { it == '/' || it == '\\' || it == ':' || it < ' ' || it.code == 0x7f }

    /** Removes the contents without following links, keeps the folder. */
    private fun emptyDir(dir: File) {
        if (Files.isSymbolicLink(dir.toPath()) || (dir.exists() && !dir.isDirectory)) deleteNoFollow(dir)
        if (dir.exists()) dir.listFiles()?.forEach { deleteNoFollow(it) }
        mkdirs(dir)
    }

    private fun deleteNoFollow(f: File) {
        val p = f.toPath()
        if (!Files.isSymbolicLink(p) && f.isDirectory) f.listFiles()?.forEach { deleteNoFollow(it) }
        if (!f.delete() && Files.exists(p, LinkOption.NOFOLLOW_LINKS)) {
            throw RuntimeLayoutException("GAGAL: tidak dapat memadam ${f.name}")
        }
    }

    private fun mkdirs(dir: File?) {
        if (dir != null && !dir.isDirectory && !dir.mkdirs() && !dir.isDirectory) {
            throw RuntimeLayoutException("GAGAL: tidak dapat membuat folder ${dir.name}")
        }
    }

    private fun writeAtomic(target: File, bytes: ByteArray) {
        mkdirs(target.parentFile)
        val tmp = File(target.parentFile, target.name + ".tmp")
        tmp.writeBytes(bytes)
        try {
            Files.move(tmp.toPath(), target.toPath(), StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING)
        } catch (e: IOException) {
            tmp.delete()
            throw e
        }
    }

    private fun readCapped(input: InputStream, max: Int): ByteArray {
        val out = java.io.ByteArrayOutputStream()
        val buf = ByteArray(8192)
        while (true) {
            val n = input.read(buf)
            if (n < 0) break
            out.write(buf, 0, n)
            if (out.size() > max) throw RuntimeLayoutException("GAGAL: cert.pem terlalu besar")
        }
        return out.toByteArray()
    }

    private fun sha256(b: ByteArray): String =
        MessageDigest.getInstance("SHA-256").digest(b).joinToString("") { "%02x".format(it) }

    companion object {
        const val MAX_ENTRIES = 256
        const val MAX_CERT_BYTES = 2 * 1024 * 1024
        const val MAX_VERSIONS_BYTES = 64 * 1024
    }
}
