package my.maxcom.box.core.mdns

import my.maxcom.box.core.BoxName

/** What a box says about itself in DNS-SD. [boxId] and [caShort] are public hints and may be unknown at first. */
class MdnsIdentity(val n: Int, val boxId: String?, val caShort: String?) {
    val host: String = BoxName.hostFor(n)
    val instanceFqdn: String = "MAXCOM box$n.${MdnsNames.SERVICE}"

    fun txt(): RData.Txt {
        val parts = ArrayList<String>()
        parts.add("v=1")
        if (boxId != null && Regex("^[0-9a-f]{16}$").matches(boxId)) parts.add("id=$boxId")
        if (caShort != null && Regex("^[0-9a-f]{16}$").matches(caShort)) parts.add("ca=$caShort")
        return RData.Txt(parts)
    }
}

object MdnsNames {
    const val SERVICE = "_maxcom._tcp.local"
    const val ENUM = "_services._dns-sd._udp.local"
    const val PORT = 8443
}

/** A reply to send: [unicast] to the asker, else multicast. */
class MdnsReply(val message: DnsMessage, val unicast: Boolean)

/**
 * Builds the records of one box on one interface address and answers queries. Pure: no socket, no clock.
 * Records: A (the interface's address) and an NSEC that denies AAAA; PTR `_maxcom._tcp.local` to the instance;
 * SRV instance to `boxN-surau.local:8443`; TXT `v=1`, `id=`, `ca=`; and the DNS-SD service enumeration PTR.
 */
object MdnsAnswerer {
    const val TTL_HOST = 120L
    const val TTL_OTHER = 4500L
    private const val LEGACY_TTL = 10L

    fun hostA(id: MdnsIdentity, addr: ByteArray, ttl: Long = TTL_HOST) =
        DnsRecord(id.host, DnsType.A, RData.A(addr), ttl, cacheFlush = true)

    fun hostNsec(id: MdnsIdentity, ttl: Long = TTL_HOST) =
        DnsRecord(id.host, DnsType.NSEC, RData.Nsec(id.host, listOf(DnsType.A)), ttl, cacheFlush = true)

    fun ptr(id: MdnsIdentity, ttl: Long = TTL_OTHER) =
        DnsRecord(MdnsNames.SERVICE, DnsType.PTR, RData.Ptr(id.instanceFqdn), ttl)

    fun srv(id: MdnsIdentity, ttl: Long = TTL_HOST) =
        DnsRecord(id.instanceFqdn, DnsType.SRV, RData.Srv(0, 0, MdnsNames.PORT, id.host), ttl, cacheFlush = true)

    fun txt(id: MdnsIdentity, ttl: Long = TTL_OTHER) =
        DnsRecord(id.instanceFqdn, DnsType.TXT, id.txt(), ttl, cacheFlush = true)

    fun enumPtr(ttl: Long = TTL_OTHER) =
        DnsRecord(MdnsNames.ENUM, DnsType.PTR, RData.Ptr(MdnsNames.SERVICE), ttl)

    /** Every record, for an announcement; [ttlZero] makes it the goodbye (TTL 0). */
    fun all(id: MdnsIdentity, addr: ByteArray, ttlZero: Boolean = false): List<DnsRecord> {
        val list = listOf(hostA(id, addr), hostNsec(id), ptr(id), srv(id), txt(id), enumPtr())
        return if (ttlZero) list.map { it.copy(ttl = 0) } else list
    }

    fun announcement(id: MdnsIdentity, addr: ByteArray): DnsMessage = DnsMessage.response(all(id, addr))

    fun goodbye(id: MdnsIdentity, addr: ByteArray): DnsMessage = DnsMessage.response(all(id, addr, ttlZero = true))

    /** The probe for [host] with our proposed A record in the authority section (RFC 6762 8.1). */
    fun probe(host: String, addr: ByteArray): DnsMessage = DnsMessage(
        0, 0,
        listOf(DnsQuestion(host, DnsType.ANY, unicastResponse = false)),
        emptyList(),
        listOf(DnsRecord(host, DnsType.A, RData.A(addr), TTL_HOST)),
        emptyList(),
    )

    /**
     * The answer to [query] for a box that owns its name (the caller answers only while the name is claimed),
     * or null when the query asks nothing we know. [legacy] is true for a query from a source port other than
     * 5353: the reply is then unicast, echoes the id and question, has TTL at most 10 and no cache-flush bits.
     */
    fun reply(id: MdnsIdentity, addr: ByteArray, query: DnsMessage, legacy: Boolean): MdnsReply? {
        if (query.isResponse || query.questions.isEmpty()) return null
        val host = dnsKey(id.host)
        val instance = dnsKey(id.instanceFqdn)
        val answers = LinkedHashMap<Triple<String, Int, RData>, DnsRecord>()
        val extra = LinkedHashMap<Triple<String, Int, RData>, DnsRecord>()
        var answeredQuestions = 0
        var allQu = true

        fun add(into: MutableMap<Triple<String, Int, RData>, DnsRecord>, r: DnsRecord) {
            into.putIfAbsent(Triple(dnsKey(r.name), r.type, r.data), r)
        }

        for (q in query.questions) {
            val name = dnsKey(q.name)
            val before = answers.size
            val any = q.type == DnsType.ANY
            when (name) {
                host -> {
                    if (any || q.type == DnsType.A) add(answers, hostA(id, addr))
                    if (any || q.type == DnsType.AAAA || q.type == DnsType.NSEC) add(answers, hostNsec(id))
                    if (q.type == DnsType.A) add(extra, hostNsec(id))
                }
                dnsKey(MdnsNames.SERVICE) -> if (any || q.type == DnsType.PTR) {
                    add(answers, ptr(id))
                    add(extra, srv(id)); add(extra, txt(id)); add(extra, hostA(id, addr)); add(extra, hostNsec(id))
                }
                dnsKey(MdnsNames.ENUM) -> if (any || q.type == DnsType.PTR) add(answers, enumPtr())
                instance -> {
                    if (any || q.type == DnsType.SRV) { add(answers, srv(id)); add(extra, hostA(id, addr)); add(extra, hostNsec(id)) }
                    if (any || q.type == DnsType.TXT) add(answers, txt(id))
                }
            }
            if (answers.size > before) {
                answeredQuestions++
                if (!q.unicastResponse) allQu = false
            }
        }
        if (answers.isEmpty()) return null

        // Known-answer suppression (RFC 6762 7.1): the asker already holds this record with more than half its TTL left.
        for (known in query.answers) {
            val it = answers.entries.iterator()
            while (it.hasNext()) {
                val mine = it.next().value
                if (dnsKey(mine.name) == dnsKey(known.name) && mine.type == known.type && mine.data == known.data &&
                    known.ttl * 2 >= mine.ttl
                ) it.remove()
            }
        }
        if (answers.isEmpty()) return null
        val ex = extra.values.filter { e -> answers.values.none { a -> dnsKey(a.name) == dnsKey(e.name) && a.type == e.type && a.data == e.data } }

        return if (legacy) {
            fun legacyRec(r: DnsRecord) = r.copy(ttl = minOf(r.ttl, LEGACY_TTL), cacheFlush = false)
            MdnsReply(
                DnsMessage(query.id, DnsMessage.FLAG_RESPONSE_AUTHORITATIVE, query.questions, answers.values.map(::legacyRec), emptyList(), ex.map(::legacyRec)),
                unicast = true,
            )
        } else {
            MdnsReply(DnsMessage.response(answers.values.toList(), ex), unicast = allQu && answeredQuestions > 0)
        }
    }
}
