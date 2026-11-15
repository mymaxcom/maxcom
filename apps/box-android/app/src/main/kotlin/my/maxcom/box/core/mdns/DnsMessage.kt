package my.maxcom.box.core.mdns

import java.io.ByteArrayOutputStream

/** DNS record types the box speaks. */
object DnsType {
    const val A = 1
    const val PTR = 12
    const val TXT = 16
    const val AAAA = 28
    const val SRV = 33
    const val NSEC = 47
    const val ANY = 255
}

/** The data of a record. Names are lower-case-insensitive dotted strings without a trailing dot. */
sealed class RData {
    /** An IPv4 address, four bytes. */
    class A(val addr: ByteArray) : RData() {
        init { require(addr.size == 4) { "A needs 4 bytes" } }
        override fun equals(other: Any?) = other is A && other.addr.contentEquals(addr)
        override fun hashCode() = addr.contentHashCode()
    }

    data class Ptr(val target: String) : RData()
    data class Srv(val priority: Int, val weight: Int, val port: Int, val target: String) : RData()
    data class Txt(val strings: List<String>) : RData()

    /** NSEC with one window block: the types that exist for [next] (the record's own name for a host). */
    data class Nsec(val next: String, val types: List<Int>) : RData()

    /** Anything else, kept as raw bytes (compressed names inside it are NOT expanded). */
    class Raw(val bytes: ByteArray) : RData() {
        override fun equals(other: Any?) = other is Raw && other.bytes.contentEquals(bytes)
        override fun hashCode() = bytes.contentHashCode()
    }
}

data class DnsQuestion(val name: String, val type: Int, val unicastResponse: Boolean = false, val cls: Int = 1)

data class DnsRecord(
    val name: String,
    val type: Int,
    val data: RData,
    val ttl: Long = 120,
    val cacheFlush: Boolean = false,
    val cls: Int = 1,
)

/**
 * One mDNS/DNS message. [decode] never throws: a malformed, truncated or oversized packet gives null. Names
 * may be compressed on read (a pointer must go strictly backwards, so no loop is possible); [encode] writes
 * every name in full, which every resolver accepts.
 */
data class DnsMessage(
    val id: Int = 0,
    val flags: Int = 0,
    val questions: List<DnsQuestion> = emptyList(),
    val answers: List<DnsRecord> = emptyList(),
    val authorities: List<DnsRecord> = emptyList(),
    val additionals: List<DnsRecord> = emptyList(),
) {
    val isResponse: Boolean get() = (flags and 0x8000) != 0

    fun encode(): ByteArray {
        val out = ByteArrayOutputStream(512)
        u16(out, id)
        u16(out, flags)
        u16(out, questions.size)
        u16(out, answers.size)
        u16(out, authorities.size)
        u16(out, additionals.size)
        for (q in questions) {
            name(out, q.name)
            u16(out, q.type)
            u16(out, (q.cls and 0x7FFF) or (if (q.unicastResponse) 0x8000 else 0))
        }
        for (r in answers + authorities + additionals) record(out, r)
        return out.toByteArray()
    }

    companion object {
        const val FLAG_RESPONSE_AUTHORITATIVE = 0x8400
        const val MAX_PACKET = 9000
        private const val MAX_RECORDS = 200

        /** A response flag word: QR and AA set. */
        fun response(answers: List<DnsRecord>, additionals: List<DnsRecord> = emptyList()) =
            DnsMessage(0, FLAG_RESPONSE_AUTHORITATIVE, emptyList(), answers, emptyList(), additionals)

        fun decode(bytes: ByteArray): DnsMessage? = try {
            if (bytes.size < 12 || bytes.size > MAX_PACKET) null else Reader(bytes).message()
        } catch (e: RuntimeException) {
            null
        }

        private fun u16(out: ByteArrayOutputStream, v: Int) {
            out.write((v shr 8) and 0xFF)
            out.write(v and 0xFF)
        }

        private fun u32(out: ByteArrayOutputStream, v: Long) {
            out.write(((v shr 24) and 0xFF).toInt())
            out.write(((v shr 16) and 0xFF).toInt())
            out.write(((v shr 8) and 0xFF).toInt())
            out.write((v and 0xFF).toInt())
        }

        private fun name(out: ByteArrayOutputStream, n: String) {
            if (n.isNotEmpty()) {
                var total = 1
                for (label in n.split('.')) {
                    val b = label.toByteArray(Charsets.UTF_8)
                    require(b.size in 1..63) { "bad label" }
                    total += b.size + 1
                    require(total <= 255) { "name too long" }
                    out.write(b.size)
                    out.write(b)
                }
            }
            out.write(0)
        }

        private fun record(out: ByteArrayOutputStream, r: DnsRecord) {
            name(out, r.name)
            u16(out, r.type)
            u16(out, (r.cls and 0x7FFF) or (if (r.cacheFlush) 0x8000 else 0))
            u32(out, r.ttl)
            val body = ByteArrayOutputStream()
            when (val d = r.data) {
                is RData.A -> body.write(d.addr)
                is RData.Ptr -> name(body, d.target)
                is RData.Srv -> {
                    u16(body, d.priority); u16(body, d.weight); u16(body, d.port); name(body, d.target)
                }
                is RData.Txt -> {
                    if (d.strings.isEmpty()) body.write(0)
                    for (s in d.strings) {
                        val b = s.toByteArray(Charsets.UTF_8)
                        require(b.size <= 255) { "txt string too long" }
                        body.write(b.size); body.write(b)
                    }
                }
                is RData.Nsec -> {
                    name(body, d.next)
                    // one window block per 256 types; the box only uses types below 256
                    val types = d.types.filter { it in 0..255 }.sorted().distinct()
                    if (types.isNotEmpty()) {
                        val len = types.last() / 8 + 1
                        val bitmap = ByteArray(len)
                        for (t in types) bitmap[t / 8] = (bitmap[t / 8].toInt() or (0x80 shr (t % 8))).toByte()
                        body.write(0); body.write(len); body.write(bitmap)
                    }
                }
                is RData.Raw -> body.write(d.bytes)
            }
            require(body.size() <= 65535) { "record too long" }
            u16(out, body.size())
            out.write(body.toByteArray())
        }
    }

    private class Reader(private val b: ByteArray) {
        private var pos = 0

        private fun u8(): Int {
            if (pos >= b.size) throw IllegalArgumentException("short")
            return b[pos++].toInt() and 0xFF
        }

        private fun u16(): Int = (u8() shl 8) or u8()
        private fun u32(): Long = (u16().toLong() shl 16) or u16().toLong()

        fun message(): DnsMessage {
            val id = u16()
            val flags = u16()
            val qd = u16()
            val an = u16()
            val ns = u16()
            val ar = u16()
            require(qd + an + ns + ar <= MAX_RECORDS) { "too many records" }
            val qs = ArrayList<DnsQuestion>()
            repeat(qd) {
                val n = name()
                val t = u16()
                val c = u16()
                qs.add(DnsQuestion(n, t, (c and 0x8000) != 0, c and 0x7FFF))
            }
            val a = List(an) { record() }
            val n = List(ns) { record() }
            val d = List(ar) { record() }
            return DnsMessage(id, flags, qs, a, n, d)
        }

        /** A name at the cursor; the cursor ends after the name (or after its first pointer). */
        private fun name(): String {
            val labels = ArrayList<String>()
            var at = pos
            var jumped = false
            var guard = 0
            var total = 1
            while (true) {
                require(at < b.size) { "short name" }
                val len = b[at].toInt() and 0xFF
                when {
                    len == 0 -> {
                        if (!jumped) pos = at + 1
                        return labels.joinToString(".")
                    }
                    (len and 0xC0) == 0xC0 -> {
                        require(at + 1 < b.size) { "short pointer" }
                        val target = ((len and 0x3F) shl 8) or (b[at + 1].toInt() and 0xFF)
                        // strictly backwards: a loop cannot form
                        require(target < at) { "forward pointer" }
                        if (!jumped) pos = at + 2
                        jumped = true
                        require(++guard <= 64) { "pointer chain" }
                        at = target
                    }
                    (len and 0xC0) != 0 -> throw IllegalArgumentException("bad label type")
                    else -> {
                        require(at + 1 + len <= b.size) { "short label" }
                        total += len + 1
                        require(total <= 255) { "name too long" }
                        val label = String(b, at + 1, len, Charsets.UTF_8)
                        require(!label.contains('.')) { "dot in label" }
                        labels.add(label)
                        at += 1 + len
                    }
                }
            }
        }

        private fun record(): DnsRecord {
            val n = name()
            val type = u16()
            val c = u16()
            val ttl = u32()
            val rdlen = u16()
            require(pos + rdlen <= b.size) { "short rdata" }
            val end = pos + rdlen
            val data: RData = when (type) {
                DnsType.A -> {
                    require(rdlen == 4) { "bad A" }
                    RData.A(b.copyOfRange(pos, end))
                }
                DnsType.PTR -> RData.Ptr(name())
                DnsType.SRV -> {
                    require(rdlen >= 7) { "bad SRV" }
                    RData.Srv(u16(), u16(), u16(), name())
                }
                DnsType.TXT -> {
                    val list = ArrayList<String>()
                    while (pos < end) {
                        val l = u8()
                        require(pos + l <= end) { "bad TXT" }
                        list.add(String(b, pos, l, Charsets.UTF_8))
                        pos += l
                    }
                    RData.Txt(list)
                }
                DnsType.NSEC -> {
                    val next = name()
                    val types = ArrayList<Int>()
                    while (pos < end) {
                        val window = u8()
                        val len = u8()
                        require(len in 1..32 && pos + len <= end) { "bad NSEC" }
                        for (i in 0 until len) {
                            val octet = u8()
                            for (bit in 0..7) if ((octet and (0x80 shr bit)) != 0) types.add(window * 256 + i * 8 + bit)
                        }
                    }
                    RData.Nsec(next, types)
                }
                else -> RData.Raw(b.copyOfRange(pos, end))
            }
            // names inside rdata are read through the cursor; always continue from the declared end
            pos = end
            return DnsRecord(n, type, data, ttl, (c and 0x8000) != 0, c and 0x7FFF)
        }
    }
}

/** Lower-cases a DNS name for comparison (ASCII only, as DNS does). */
fun dnsKey(name: String): String = buildString(name.length) { for (ch in name) append(if (ch in 'A'..'Z') ch + 32 else ch) }
