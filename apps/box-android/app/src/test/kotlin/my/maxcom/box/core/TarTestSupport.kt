package my.maxcom.box.core

import java.io.ByteArrayOutputStream
import java.io.File
import java.nio.file.Files
import java.security.MessageDigest
import java.util.zip.GZIPOutputStream

/** A tiny ustar writer for tests; it can produce deliberately hostile archives. */
class TarBuilder {
    private val out = ByteArrayOutputStream()

    fun file(name: String, data: ByteArray = ByteArray(0), mode: Int = 420, type: Char = '0', linkName: String = ""): TarBuilder {
        out.write(header(name, data.size.toLong(), mode, type, linkName))
        out.write(data)
        pad(data.size)
        return this
    }

    fun file(name: String, text: String, mode: Int = 420): TarBuilder = file(name, text.toByteArray(Charsets.UTF_8), mode)
    fun dir(name: String): TarBuilder = file(if (name.endsWith("/")) name else "$name/", ByteArray(0), 493, '5')
    fun symlink(name: String, target: String): TarBuilder = file(name, ByteArray(0), 511, '2', target)
    fun hardlink(name: String, target: String): TarBuilder = file(name, ByteArray(0), 420, '1', target)
    fun device(name: String): TarBuilder = file(name, ByteArray(0), 420, '3')

    /** A pax extended header carrying `path`, then a short-named entry. */
    fun paxFile(longPath: String, data: ByteArray, mode: Int = 420): TarBuilder {
        val body = paxRecord("path", longPath)
        out.write(header("PaxHeader/x", body.size.toLong(), 420, 'x', ""))
        out.write(body)
        pad(body.size)
        return file("short-name", data, mode)
    }

    /** A GNU long name block (type L), then the entry. */
    fun gnuLongFile(longPath: String, data: ByteArray): TarBuilder {
        val body = longPath.toByteArray(Charsets.UTF_8) + byteArrayOf(0)
        out.write(header("././@LongLink", body.size.toLong(), 0, 'L', ""))
        out.write(body)
        pad(body.size)
        return file("short-name", data)
    }

    /** A ustar entry that uses the prefix field. */
    fun prefixedFile(prefix: String, name: String, data: ByteArray): TarBuilder {
        val h = header(name, data.size.toLong(), 420, '0', "")
        val p = prefix.toByteArray(Charsets.UTF_8)
        for (i in 345 until 500) h[i] = 0
        System.arraycopy(p, 0, h, 345, p.size)
        fixChecksum(h)
        out.write(h)
        out.write(data)
        pad(data.size)
        return this
    }

    /** An entry whose header claims [claimed] bytes but carries [data]. */
    fun lyingSize(name: String, claimed: Long, data: ByteArray): TarBuilder {
        out.write(header(name, claimed, 420, '0', ""))
        out.write(data)
        pad(data.size)
        return this
    }

    fun corruptChecksum(): TarBuilder {
        val b = out.toByteArray()
        b[148] = '9'.code.toByte() // not an octal digit
        out.reset()
        out.write(b)
        return this
    }

    fun tar(): ByteArray {
        val r = ByteArrayOutputStream()
        r.write(out.toByteArray())
        r.write(ByteArray(1024))
        return r.toByteArray()
    }

    fun gz(): ByteArray {
        val bo = ByteArrayOutputStream()
        GZIPOutputStream(bo).use { it.write(tar()) }
        return bo.toByteArray()
    }

    private fun pad(n: Int) {
        val p = (512 - n % 512) % 512
        out.write(ByteArray(p))
    }

    private fun paxRecord(key: String, value: String): ByteArray {
        val rest = " $key=$value\n".toByteArray(Charsets.UTF_8)
        var len = rest.size + 1
        while ((len.toString().length + rest.size) != len) len = len.toString().length + rest.size
        return (len.toString().toByteArray(Charsets.US_ASCII)) + rest
    }

    private fun header(name: String, size: Long, mode: Int, type: Char, linkName: String): ByteArray {
        val h = ByteArray(512)
        put(h, 0, 100, name)
        put(h, 100, 8, "%07o".format(mode))
        put(h, 108, 8, "0000000")
        put(h, 116, 8, "0000000")
        put(h, 124, 12, "%011o".format(size))
        put(h, 136, 12, "%011o".format(0))
        h[156] = type.code.toByte()
        put(h, 157, 100, linkName)
        put(h, 257, 6, "ustar")
        put(h, 263, 2, "00")
        fixChecksum(h)
        return h
    }

    private fun put(h: ByteArray, off: Int, len: Int, s: String) {
        val b = s.toByteArray(Charsets.UTF_8)
        require(b.size <= len) { "field too long in test builder" }
        System.arraycopy(b, 0, h, off, b.size)
    }

    private fun fixChecksum(h: ByteArray) {
        for (i in 148..155) h[i] = 0x20
        var sum = 0
        for (b in h) sum += b.toInt() and 0xff
        put(h, 148, 7, "%06o".format(sum))
        h[154] = 0
        h[155] = 0x20
    }
}

fun sha256Hex(b: ByteArray): String = MessageDigest.getInstance("SHA-256").digest(b).joinToString("") { "%02x".format(it) }

fun tempDir(prefix: String): File = Files.createTempDirectory(prefix).toFile()

/** A small valid release archive. */
fun releaseArchive(version: String, workspaceLinks: String = """[{"name":"@surau/core","target":"packages/core"}]"""): TarBuilder =
    TarBuilder()
        .dir("./")
        .file("./release.json", """{"v":1,"version":"$version","platform":"android","workspaceLinks":$workspaceLinks}""")
        .file("./package.json", """{"name":"x"}""")
        .dir("./packages/core")
        .file("./packages/core/index.js", "export const a = 1;\n")
        .file("./bin/run.sh", "#!/bin/sh\n", 493)
