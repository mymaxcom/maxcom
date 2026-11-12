package my.maxcom.box.core

/** Strict dotted IPv4 literals: four decimal parts, no leading zeros, no spaces, nothing else. */
object Ipv4 {
    private val SHAPE = Regex("^(0|[1-9][0-9]{0,2})(\\.(0|[1-9][0-9]{0,2})){3}$")

    /** The four address bytes, or null when [text] is not a plain IPv4 literal. */
    fun parse(text: String): ByteArray? {
        if (!SHAPE.matches(text)) return null
        val parts = text.split('.')
        val out = ByteArray(4)
        for (i in 0 until 4) {
            val v = parts[i].toInt()
            if (v > 255) return null
            out[i] = v.toByte()
        }
        return out
    }

    /** RFC 1918 only: 10/8, 172.16/12, 192.168/16. */
    fun isPrivate(b: ByteArray): Boolean {
        val a = b[0].toInt() and 0xFF
        val c = b[1].toInt() and 0xFF
        return a == 10 || (a == 172 && c in 16..31) || (a == 192 && c == 168)
    }
}

/** Which addresses of the box go into the leaf certificate. */
object LanAddresses {
    enum class IfaceType { ETHERNET, WIFI, OTHER }

    /** One address seen on one network interface; [address] is whatever the platform printed. */
    data class Candidate(val ifaceType: IfaceType, val address: String)

    const val MAX_ADDRESSES = 4

    /**
     * Private IPv4 addresses on Ethernet and Wi-Fi only (VPN, mobile and other interfaces are dropped),
     * no loopback, no link-local, no public, no IPv6. Ethernet first, then Wi-Fi; inside one type by
     * numeric address, so the same set always gives the same list. Duplicates are dropped; at most four.
     */
    fun pick(candidates: List<Candidate>): List<String> {
        val seen = HashSet<String>()
        val kept = ArrayList<Pair<Int, String>>()
        for (c in candidates) {
            val rank = when (c.ifaceType) {
                IfaceType.ETHERNET -> 0
                IfaceType.WIFI -> 1
                IfaceType.OTHER -> continue
            }
            val bytes = Ipv4.parse(c.address) ?: continue
            if (!Ipv4.isPrivate(bytes)) continue
            if (!seen.add(c.address)) continue
            kept.add(rank to c.address)
        }
        kept.sortWith(
            compareBy<Pair<Int, String>> { it.first }.thenComparator { a, b -> compareNumeric(a.second, b.second) },
        )
        return kept.take(MAX_ADDRESSES).map { it.second }
    }

    private fun compareNumeric(a: String, b: String): Int {
        val x = Ipv4.parse(a)!!
        val y = Ipv4.parse(b)!!
        for (i in 0 until 4) {
            val d = (x[i].toInt() and 0xFF) - (y[i].toInt() and 0xFF)
            if (d != 0) return d
        }
        return 0
    }
}
