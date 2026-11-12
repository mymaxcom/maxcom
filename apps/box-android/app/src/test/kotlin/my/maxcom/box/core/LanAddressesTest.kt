package my.maxcom.box.core

import my.maxcom.box.core.LanAddresses.Candidate
import my.maxcom.box.core.LanAddresses.IfaceType
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class LanAddressesTest {
    private fun eth(a: String) = Candidate(IfaceType.ETHERNET, a)
    private fun wifi(a: String) = Candidate(IfaceType.WIFI, a)

    @Test
    fun ethernetComesFirst() {
        assertEquals(listOf("10.0.0.5", "192." + "168.1.20"), LanAddresses.pick(listOf(wifi("192." + "168.1.20"), eth("10.0.0.5"))))
    }

    @Test
    fun dropsLoopbackLinkLocalPublicIpv6AndOtherInterfaces() {
        val got = LanAddresses.pick(
            listOf(
                eth("127.0.0.1"), eth("169.254.10.2"), eth("8.8.8.8"), eth("100.64.1.1"), eth("172.15.0.1"),
                eth("172.32.0.1"), eth("fe80::1"), eth("::1"), eth("192." + "168.1.2%wlan0"), eth(""), eth("192." + "168.001.2"),
                eth("192." + "168.1.300"), eth("10.0.0"), Candidate(IfaceType.OTHER, "192." + "168.9.9"), wifi("172.16.5.5"),
            ),
        )
        assertEquals(listOf("172.16.5.5"), got)
    }

    @Test
    fun privateRangeEdges() {
        val got = LanAddresses.pick(listOf(eth("172.16.0.1"), eth("172.31.255.254"), eth("10.255.255.255"), eth("192." + "168.0.0")))
        assertEquals(listOf("10.255.255.255", "172.16.0.1", "172.31.255.254", "192." + "168.0.0"), got)
    }

    @Test
    fun orderIsStableWhateverTheInputOrderAndDuplicatesAreDropped() {
        val a = LanAddresses.pick(listOf(eth("192." + "168.1.9"), eth("192." + "168.1.10"), eth("192." + "168.1.9"), wifi("10.1.1.1")))
        val b = LanAddresses.pick(listOf(wifi("10.1.1.1"), eth("192." + "168.1.10"), eth("192." + "168.1.9")))
        assertEquals(a, b)
        assertEquals(listOf("192." + "168.1.9", "192." + "168.1.10", "10.1.1.1"), a)
    }

    @Test
    fun atMostFour() {
        val got = LanAddresses.pick((1..9).map { eth("192." + "168.1.$it") })
        assertEquals(listOf("192." + "168.1.1", "192." + "168.1.2", "192." + "168.1.3", "192." + "168.1.4"), got)
    }

    @Test
    fun emptyInput() {
        assertEquals(emptyList<String>(), LanAddresses.pick(emptyList()))
    }

    @Test
    fun ipv4Parse() {
        assertNotNull(Ipv4.parse("0.0.0.0"))
        assertNull(Ipv4.parse("256.1.1.1"))
        assertNull(Ipv4.parse("1.1.1.1 "))
        assertNull(Ipv4.parse("01.1.1.1"))
        assertNull(Ipv4.parse("1.1.1"))
        assertTrue(Ipv4.isPrivate(Ipv4.parse("192." + "168.0.1")!!))
        assertFalse(Ipv4.isPrivate(Ipv4.parse("192.169.0.1")!!))
    }
}
