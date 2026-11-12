package my.maxcom.box.core

import java.io.ByteArrayOutputStream
import java.io.EOFException
import java.io.IOException
import java.io.InputStream
import java.util.zip.GZIPInputStream

/** An archive entry that must not be unpacked (unsafe path, wrong type, over a limit, damaged header). */
class BadEntry(message: String) : IOException(message)

enum class TarType { FILE, DIR, SYMLINK, HARDLINK, CHAR_DEVICE, BLOCK_DEVICE, FIFO, OTHER }

/** [path] is the checked, normalised path (no leading "./", no trailing slash; empty for the archive root). */
data class TarEntry(val path: String, val type: TarType, val size: Long, val mode: Int)

/** Hard ceilings so a hostile archive cannot fill the disk or memory. */
data class TarLimits(
    val maxEntries: Int = 100_000,
    val maxEntryBytes: Long = 512L * 1024 * 1024,
    val maxTotalBytes: Long = 1536L * 1024 * 1024,
    val maxPathBytes: Int = 1024,
    val maxSegmentBytes: Int = 255,
    val maxHeaderBlobBytes: Int = 64 * 1024,
)

/**
 * Reads a gzip-compressed ustar archive (pax and GNU long names supported). Only regular files and
 * directories are ever handed to the caller; every path is checked before the callback runs.
 */
object TarReader {
    private const val BLOCK = 512

    /**
     * Throws [BadEntry] for an absolute path, a ".." segment, a backslash, a colon in the first
     * segment, an empty segment, a NUL or control character, or an over-long path. Returns the
     * normalised path: "." segments are dropped and one trailing slash is allowed, so "./a/b/" gives
     * "a/b" and "./" gives "".
     */
    fun checkPath(path: String, limits: TarLimits = TarLimits()): String {
        if (path.isEmpty()) throw BadEntry("empty path")
        if (path.toByteArray(Charsets.UTF_8).size > limits.maxPathBytes) throw BadEntry("path too long")
        if (path[0] == '/') throw BadEntry("absolute path")
        if (path.indexOf('\\') >= 0) throw BadEntry("backslash in path")
        for (ch in path) if (ch.code < 0x20 || ch.code == 0x7f) throw BadEntry("control character in path")
        val trimmed = if (path.endsWith("/")) path.substring(0, path.length - 1) else path
        val segs = if (trimmed.isEmpty()) emptyList() else trimmed.split('/')
        if (segs.isNotEmpty() && segs[0].indexOf(':') >= 0) throw BadEntry("drive letter or scheme in path")
        val out = ArrayList<String>()
        for (s in segs) {
            if (s.isEmpty()) throw BadEntry("empty path segment")
            if (s == "..") throw BadEntry("parent segment in path")
            if (s.toByteArray(Charsets.UTF_8).size > limits.maxSegmentBytes) throw BadEntry("path segment too long")
            if (s == ".") continue
            out.add(s)
        }
        return out.joinToString("/")
    }

    /** Checks the type as well as the path; only regular files and directories pass. */
    fun checkEntry(path: String, type: TarType, limits: TarLimits = TarLimits()): String {
        if (type != TarType.FILE && type != TarType.DIR) throw BadEntry("entry type not allowed: $type")
        return checkPath(path, limits)
    }

    /**
     * Reads a gzip archive. [onEntry] gets each regular file or directory with a stream limited to
     * the entry's bytes (it need not read all of it). Any other entry type aborts the read.
     */
    fun read(input: InputStream, limits: TarLimits = TarLimits(), onEntry: (TarEntry, InputStream) -> Unit) {
        readTar(GZIPInputStream(input, 64 * 1024), limits, onEntry)
    }

    /** Same as [read] for an archive that is not compressed (used by tests). */
    fun readTar(tar: InputStream, limits: TarLimits = TarLimits(), onEntry: (TarEntry, InputStream) -> Unit) {
        val header = ByteArray(BLOCK)
        var longName: String? = null
        var paxPath: String? = null
        var paxSize: Long? = null
        var entries = 0
        var total = 0L
        while (true) {
            if (!readBlock(tar, header)) return // clean end without the zero blocks
            if (header.all { it == 0.toByte() }) return // end-of-archive marker
            verifyChecksum(header)
            val typeFlag = header[156].toInt().toChar()
            var size = parseOctal(header, 124, 12)
            val mode = parseOctal(header, 100, 8).toInt()
            val isUstar = String(header, 257, 5, Charsets.US_ASCII) == "ustar"
            when (typeFlag) {
                'x' -> {
                    val blob = readBlob(tar, size, limits)
                    val pax = parsePax(blob)
                    pax["path"]?.let { paxPath = it }
                    pax["size"]?.let { paxSize = it.toLongOrNull()?.takeIf { v -> v >= 0 } ?: throw BadEntry("bad pax size") }
                    continue
                }
                'g' -> {
                    readBlob(tar, size, limits) // global header: consumed and ignored
                    continue
                }
                'L' -> {
                    longName = cString(readBlob(tar, size, limits))
                    continue
                }
                'K' -> {
                    readBlob(tar, size, limits) // long link name: links are refused anyway
                    continue
                }
            }
            val name = paxPath ?: longName ?: run {
                val base = cString(header, 0, 100)
                val prefix = if (isUstar) cString(header, 345, 155) else ""
                if (prefix.isEmpty()) base else "$prefix/$base"
            }
            paxSize?.let { size = it }
            longName = null
            paxPath = null
            paxSize = null

            val type = when (typeFlag) {
                '0', '\u0000', '7' -> TarType.FILE // '7' is contiguous file; treated as regular
                '5' -> TarType.DIR
                '2' -> TarType.SYMLINK
                '1' -> TarType.HARDLINK
                '3' -> TarType.CHAR_DEVICE
                '4' -> TarType.BLOCK_DEVICE
                '6' -> TarType.FIFO
                else -> TarType.OTHER
            }
            val path = checkEntry(name, type, limits)
            if (type == TarType.FILE && (name.endsWith("/") || path.isEmpty())) throw BadEntry("file entry named like a directory")
            if (type == TarType.DIR && size != 0L) throw BadEntry("directory with data")
            if (size < 0 || size > limits.maxEntryBytes) throw BadEntry("entry too large")
            entries++
            if (entries > limits.maxEntries) throw BadEntry("too many entries")
            total += size
            if (total > limits.maxTotalBytes) throw BadEntry("archive too large")

            val data = LimitedInput(tar, size)
            onEntry(TarEntry(path, type, size, mode and 0xfff), data)
            data.drain()
            val pad = ((BLOCK - (size % BLOCK)) % BLOCK).toInt()
            skipFully(tar, pad.toLong())
        }
    }

    private fun readBlock(input: InputStream, buf: ByteArray): Boolean {
        var off = 0
        while (off < buf.size) {
            val n = input.read(buf, off, buf.size - off)
            if (n < 0) {
                if (off == 0) return false
                throw EOFException("truncated tar header")
            }
            off += n
        }
        return true
    }

    private fun skipFully(input: InputStream, count: Long) {
        var left = count
        val scratch = ByteArray(BLOCK)
        while (left > 0) {
            val n = input.read(scratch, 0, minOf(left, scratch.size.toLong()).toInt())
            if (n < 0) throw EOFException("truncated tar padding")
            left -= n
        }
    }

    private fun readBlob(input: InputStream, size: Long, limits: TarLimits): ByteArray {
        if (size < 0 || size > limits.maxHeaderBlobBytes) throw BadEntry("extended header too large")
        val out = ByteArrayOutputStream(size.toInt())
        val buf = ByteArray(BLOCK)
        var left = size
        while (left > 0) {
            val n = input.read(buf, 0, minOf(left, buf.size.toLong()).toInt())
            if (n < 0) throw EOFException("truncated extended header")
            out.write(buf, 0, n)
            left -= n
        }
        skipFully(input, (BLOCK - (size % BLOCK)) % BLOCK)
        return out.toByteArray()
    }

    private fun verifyChecksum(h: ByteArray) {
        var sum = 0L
        for (i in 0 until BLOCK) sum += if (i in 148..155) 0x20 else (h[i].toInt() and 0xff)
        val stored = parseOctal(h, 148, 8)
        if (sum != stored) throw BadEntry("tar header checksum mismatch")
    }

    /** Octal field; a binary (base-256) field is refused rather than guessed at. */
    private fun parseOctal(b: ByteArray, off: Int, len: Int): Long {
        if ((b[off].toInt() and 0x80) != 0) throw BadEntry("binary number field not supported")
        var v = 0L
        var seen = false
        for (i in off until off + len) {
            val c = b[i].toInt() and 0xff
            if (c == 0 || c == 0x20) {
                if (seen) break
                continue
            }
            if (c < '0'.code || c > '7'.code) throw BadEntry("bad number field")
            seen = true
            v = v * 8 + (c - '0'.code)
            if (v < 0 || v > (1L shl 50)) throw BadEntry("number field too large")
        }
        return v
    }

    private fun cString(b: ByteArray, off: Int = 0, len: Int = b.size): String {
        var end = off
        while (end < off + len && b[end] != 0.toByte()) end++
        return String(b, off, end - off, Charsets.UTF_8)
    }

    /** pax records are "<len> <key>=<value>\n" with len counted in bytes including itself. */
    private fun parsePax(blob: ByteArray): Map<String, String> {
        val map = HashMap<String, String>()
        var pos = 0
        while (pos < blob.size) {
            var sp = pos
            while (sp < blob.size && blob[sp] != ' '.code.toByte()) sp++
            if (sp >= blob.size) throw BadEntry("bad pax record")
            val len = String(blob, pos, sp - pos, Charsets.US_ASCII).toIntOrNull() ?: throw BadEntry("bad pax length")
            if (len <= sp - pos + 1 || pos + len > blob.size) throw BadEntry("bad pax length")
            val end = pos + len - 1 // the record ends with a newline
            if (blob[end] != '\n'.code.toByte()) throw BadEntry("bad pax record")
            val rec = String(blob, sp + 1, end - sp - 1, Charsets.UTF_8)
            val eq = rec.indexOf('=')
            if (eq <= 0) throw BadEntry("bad pax record")
            map[rec.substring(0, eq)] = rec.substring(eq + 1)
            pos += len
        }
        return map
    }

    private class LimitedInput(private val src: InputStream, private var left: Long) : InputStream() {
        override fun read(): Int {
            if (left <= 0) return -1
            val v = src.read()
            if (v < 0) throw EOFException("truncated entry data")
            left--
            return v
        }

        override fun read(b: ByteArray, off: Int, len: Int): Int {
            if (len == 0) return 0
            if (left <= 0) return -1
            val n = src.read(b, off, minOf(len.toLong(), left).toInt())
            if (n < 0) throw EOFException("truncated entry data")
            left -= n
            return n
        }

        override fun available(): Int = minOf(left, src.available().toLong()).toInt()

        fun drain() {
            val scratch = ByteArray(8192)
            while (left > 0) {
                val n = src.read(scratch, 0, minOf(left, scratch.size.toLong()).toInt())
                if (n < 0) throw EOFException("truncated entry data")
                left -= n
            }
        }
    }
}
