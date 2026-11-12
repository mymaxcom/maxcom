package my.maxcom.box.core

import java.math.BigInteger
import java.time.Instant
import java.time.ZoneOffset
import java.time.format.DateTimeFormatter

/**
 * A small DER writer, just enough to build the two X.509 certificates of the box CA.
 * Pure JVM: nothing here needs the Android framework.
 */
object Der {
    const val TAG_BOOLEAN = 0x01
    const val TAG_INTEGER = 0x02
    const val TAG_BIT_STRING = 0x03
    const val TAG_OCTET_STRING = 0x04
    const val TAG_OID = 0x06
    const val TAG_UTF8_STRING = 0x0C
    const val TAG_UTC_TIME = 0x17
    const val TAG_GENERALIZED_TIME = 0x18
    const val TAG_SEQUENCE = 0x30
    const val TAG_SET = 0x31

    private val UTC_FORMAT: DateTimeFormatter = DateTimeFormatter.ofPattern("yyMMddHHmmss'Z'").withZone(ZoneOffset.UTC)
    private val GENERALIZED_FORMAT: DateTimeFormatter =
        DateTimeFormatter.ofPattern("yyyyMMddHHmmss'Z'").withZone(ZoneOffset.UTC)

    /** The DER length octets for a content of [n] bytes (definite, shortest form). */
    fun length(n: Int): ByteArray {
        require(n >= 0) { "negative length" }
        return when {
            n < 0x80 -> byteArrayOf(n.toByte())
            n < 0x100 -> byteArrayOf(0x81.toByte(), n.toByte())
            n < 0x10000 -> byteArrayOf(0x82.toByte(), (n shr 8).toByte(), n.toByte())
            n < 0x1000000 -> byteArrayOf(0x83.toByte(), (n shr 16).toByte(), (n shr 8).toByte(), n.toByte())
            else -> byteArrayOf(0x84.toByte(), (n shr 24).toByte(), (n shr 16).toByte(), (n shr 8).toByte(), n.toByte())
        }
    }

    /** One tag-length-value. Only single-octet tags are supported. */
    fun tlv(tag: Int, content: ByteArray): ByteArray {
        require(tag in 0..0xFF && (tag and 0x1F) != 0x1F) { "unsupported tag $tag" }
        return concat(byteArrayOf(tag.toByte()), length(content.size), content)
    }

    fun concat(vararg parts: ByteArray): ByteArray {
        var total = 0
        for (p in parts) total += p.size
        val out = ByteArray(total)
        var at = 0
        for (p in parts) {
            System.arraycopy(p, 0, out, at, p.size)
            at += p.size
        }
        return out
    }

    fun sequence(vararg parts: ByteArray): ByteArray = tlv(TAG_SEQUENCE, concat(*parts))

    fun set(vararg parts: ByteArray): ByteArray = tlv(TAG_SET, concat(*parts))

    /** Two's complement, minimal; a value with the high bit set gets a leading zero. */
    fun integer(value: BigInteger): ByteArray = tlv(TAG_INTEGER, value.toByteArray())

    /** A positive INTEGER from unsigned big-endian [bytes]. */
    fun integerUnsigned(bytes: ByteArray): ByteArray = integer(BigInteger(1, bytes))

    fun boolean(value: Boolean): ByteArray = tlv(TAG_BOOLEAN, byteArrayOf(if (value) 0xFF.toByte() else 0x00))

    fun octetString(content: ByteArray): ByteArray = tlv(TAG_OCTET_STRING, content)

    /** BIT STRING with [unusedBits] unused bits in the last octet of [content]. */
    fun bitString(content: ByteArray, unusedBits: Int = 0): ByteArray {
        require(unusedBits in 0..7) { "unusedBits" }
        return tlv(TAG_BIT_STRING, concat(byteArrayOf(unusedBits.toByte()), content))
    }

    fun utf8String(text: String): ByteArray = tlv(TAG_UTF8_STRING, text.toByteArray(Charsets.UTF_8))

    /** OBJECT IDENTIFIER from the dotted form, for example `2.5.29.19`. */
    fun oid(dotted: String): ByteArray {
        val arcs = dotted.split('.').map { part ->
            require(part.isNotEmpty() && part.all { it in '0'..'9' } && part.length <= 18) { "bad OID $dotted" }
            part.toLong()
        }
        require(arcs.size >= 2) { "bad OID $dotted" }
        require(arcs[0] in 0..2 && (arcs[0] == 2L || arcs[1] < 40)) { "bad OID $dotted" }
        val out = java.io.ByteArrayOutputStream()
        writeBase128(out, arcs[0] * 40 + arcs[1])
        for (i in 2 until arcs.size) writeBase128(out, arcs[i])
        return tlv(TAG_OID, out.toByteArray())
    }

    private fun writeBase128(out: java.io.ByteArrayOutputStream, value: Long) {
        var shift = 63 - java.lang.Long.numberOfLeadingZeros(value or 1L)
        shift -= shift % 7
        while (shift > 0) {
            out.write((((value ushr shift) and 0x7F) or 0x80).toInt())
            shift -= 7
        }
        out.write((value and 0x7F).toInt())
    }

    /** UTCTime up to the year 2049, GeneralizedTime after (RFC 5280 4.1.2.5). Whole seconds. */
    fun time(at: Instant): ByteArray {
        val whole = at.truncatedTo(java.time.temporal.ChronoUnit.SECONDS)
        val year = whole.atOffset(ZoneOffset.UTC).year
        return if (year in 1950..2049) {
            tlv(TAG_UTC_TIME, UTC_FORMAT.format(whole).toByteArray(Charsets.US_ASCII))
        } else {
            tlv(TAG_GENERALIZED_TIME, GENERALIZED_FORMAT.format(whole).toByteArray(Charsets.US_ASCII))
        }
    }

    /** `[n] EXPLICIT` (constructed context tag) around [content]. */
    fun contextConstructed(n: Int, content: ByteArray): ByteArray {
        require(n in 0..30) { "context tag" }
        return tlv(0xA0 or n, content)
    }

    /** `[n] IMPLICIT` primitive context tag. */
    fun contextPrimitive(n: Int, content: ByteArray): ByteArray {
        require(n in 0..30) { "context tag" }
        return tlv(0x80 or n, content)
    }

    /** One parsed TLV header: [start] is the tag offset, the content spans [contentStart] until [end]. */
    class Tlv(val tag: Int, val start: Int, val contentStart: Int, val end: Int)

    /** Reads the TLV header at [at] in [bytes]; definite lengths up to 4 octets, bounds checked. */
    fun read(bytes: ByteArray, at: Int): Tlv {
        require(at >= 0 && at + 2 <= bytes.size) { "truncated DER" }
        val tag = bytes[at].toInt() and 0xFF
        require((tag and 0x1F) != 0x1F) { "unsupported tag" }
        val first = bytes[at + 1].toInt() and 0xFF
        var contentStart = at + 2
        val len: Long
        if (first < 0x80) {
            len = first.toLong()
        } else {
            val n = first and 0x7F
            require(n in 1..4 && contentStart + n <= bytes.size) { "bad DER length" }
            var v = 0L
            for (i in 0 until n) v = (v shl 8) or (bytes[contentStart + i].toLong() and 0xFF)
            contentStart += n
            len = v
        }
        require(len <= bytes.size - contentStart) { "truncated DER" }
        return Tlv(tag, at, contentStart, contentStart + len.toInt())
    }
}
