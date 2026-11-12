package my.maxcom.box.core

import java.time.Duration
import java.time.Instant
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class LeafPolicyTest {
    private val t0 = Instant.parse("2026-11-11T00:00:00Z")
    private val build = Instant.parse("2026-11-01T00:00:00Z")
    private val signer = PkiTestKeys.rootA
    private val root = BoxCa.makeRoot(signer, "Boxaaaa0001", t0)
    private val ips = listOf("10.0.0.5", "10.168.1.20")

    private fun leaf(list: List<String> = ips, at: Instant = t0): ByteArray =
        BoxCa.makeLeaf(signer, root, PkiTestKeys.leaf.public, list, at)

    private fun decide(
        der: ByteArray?,
        wanted: List<String> = ips,
        now: Instant = t0,
        buildTime: Instant = build,
        rootDer: ByteArray? = null,
    ) = LeafPolicy.decide(der, wanted, now, buildTime, rootDer = rootDer)

    @Test
    fun noLeafMeansIssue() {
        assertTrue(decide(null) is LeafDecision.Issue)
        assertTrue(decide(byteArrayOf(1, 2, 3)) is LeafDecision.Issue)
    }

    @Test
    fun goodLeafIsSkipped() {
        assertEquals(LeafDecision.Skip, decide(leaf()))
        assertEquals(LeafDecision.Skip, decide(leaf(), rootDer = root))
    }

    @Test
    fun sixtyDaysIsTheLine() {
        val der = leaf()
        // issued at t0 for 730 days
        val notAfter = t0.plus(Duration.ofDays(730))
        val sixtyOne = notAfter.minus(Duration.ofDays(61))
        val sixty = notAfter.minus(Duration.ofDays(60))
        val fiftyNine = notAfter.minus(Duration.ofDays(59))
        assertEquals(LeafDecision.Skip, decide(der, now = sixtyOne))
        assertTrue(decide(der, now = sixty) is LeafDecision.Issue)
        val d = decide(der, now = fiftyNine)
        assertTrue(d is LeafDecision.Issue && d.reason.contains("59"))
        val expired = decide(der, now = notAfter.plus(Duration.ofDays(3)))
        assertTrue(expired is LeafDecision.Issue && expired.reason.contains("expired"))
    }

    @Test
    fun changedAddressListIssuesButAnotherOrderDoesNot() {
        val der = leaf()
        assertEquals(LeafDecision.Skip, decide(der, wanted = listOf("10.168.1.20", "10.0.0.5")))
        assertTrue(decide(der, wanted = listOf("10.0.0.5")) is LeafDecision.Issue)
        assertTrue(decide(der, wanted = listOf("10.0.0.5", "10.168.1.20", "10.168.1.21")) is LeafDecision.Issue)
        assertTrue(decide(der, wanted = listOf("10.0.0.6", "10.168.1.20")) is LeafDecision.Issue)
    }

    @Test
    fun noNetworkKeepsAGoodLeafButStillMakesTheFirstOne() {
        assertEquals(LeafDecision.Skip, decide(leaf(), wanted = emptyList()))
        assertTrue(decide(null, wanted = emptyList()) is LeafDecision.Issue)
    }

    @Test
    fun clockBeforeTheBuildTimeWaits() {
        assertEquals(LeafDecision.WaitForClock, decide(null, now = build.minusSeconds(1)))
        assertEquals(LeafDecision.WaitForClock, decide(byteArrayOf(1, 2, 3), now = build.minusSeconds(1)))
        assertEquals(LeafDecision.Skip, decide(leaf(), now = build))
    }

    @Test
    fun aGoodLeafIsKeptEvenWhenTheClockLooksWrong() {
        val early = build.minusSeconds(1)
        assertEquals(LeafDecision.Skip, decide(leaf(), now = early))
        assertEquals(LeafDecision.Skip, decide(leaf(), now = early, rootDer = root))
        // a leaf that would need replacing still waits for a sane clock
        assertEquals(LeafDecision.WaitForClock, decide(leaf(), wanted = listOf("10.0.0.99"), now = early))
        val otherRoot = BoxCa.makeRoot(PkiTestKeys.rootB, "Boxbbbb0002", t0)
        assertEquals(LeafDecision.WaitForClock, decide(leaf(), now = early, rootDer = otherRoot))
    }

    @Test
    fun aLeafKeyThatDoesNotMatchIsReplaced() {
        val der = leaf()
        val good = BoxCa.pkcs8Pem(PkiTestKeys.leaf.private)
        val other = BoxCa.pkcs8Pem(BoxCa.newLeafKey().private)
        fun d(pem: String?, check: Boolean = true) =
            LeafPolicy.decide(der, ips, t0, build, leafKeyPem = pem, checkKey = check)
        assertEquals(LeafDecision.Skip, d(good))
        assertTrue(d(other) is LeafDecision.Issue)
        assertTrue(d(null) is LeafDecision.Issue)
        assertTrue(d("not a key") is LeafDecision.Issue)
        // the key is not looked at unless asked
        assertEquals(LeafDecision.Skip, d(other, check = false))
        // with a wrong clock a torn pair waits for the clock instead of issuing
        assertEquals(
            LeafDecision.WaitForClock,
            LeafPolicy.decide(der, ips, build.minusSeconds(1), build, leafKeyPem = other, checkKey = true),
        )
    }

    @Test
    fun aLeafFromAnotherRootIsReplaced() {
        val otherRoot = BoxCa.makeRoot(PkiTestKeys.rootB, "Boxbbbb0002", t0)
        assertTrue(decide(leaf(), rootDer = otherRoot) is LeafDecision.Issue)
    }

    @Test
    fun aLeafWithoutTheTwoNamesIsReplaced() {
        val odd = BoxCa.buildLeaf(
            signer, root, PkiTestKeys.leaf.public, ips, listOf("localhost"), t0, 730, java.security.SecureRandom(),
        )
        assertTrue(decide(odd) is LeafDecision.Issue)
    }
}
