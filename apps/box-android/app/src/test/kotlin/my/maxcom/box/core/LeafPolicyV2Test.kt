package my.maxcom.box.core

import java.time.Instant
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class LeafPolicyV2Test {
    private val t0 = Instant.parse("2026-11-11T00:00:00Z")
    private val build = Instant.parse("2026-11-01T00:00:00Z")
    private val signer = PkiTestKeys.rootA
    private val ips = listOf("10.0.0.5", "10.168.1.20")
    private val v2 = BoxCa.makeRoot(signer, "Boxaaaa0001", t0, generation = RootGeneration.V2)
    private val legacy = BoxCa.makeRoot(signer, "Boxaaaa0001", t0)

    private fun leaf(root: ByteArray, name: String?) = BoxCa.makeLeaf(signer, root, PkiTestKeys.leaf.public, ips, t0, boxName = name)

    private fun decide(der: ByteArray?, root: ByteArray?, wantedName: String?) =
        LeafPolicy.decide(der, ips, t0, build, rootDer = root, wantedName = wantedName)

    @Test
    fun aLeafWithTheWantedNameIsKept() {
        assertEquals(LeafDecision.Skip, decide(leaf(v2, "box1-surau.local"), v2, "box1-surau.local"))
    }

    @Test
    fun aDifferentNumberIssuesWithTheNameChangedReason() {
        val d = decide(leaf(v2, "box1-surau.local"), v2, "box2-surau.local")
        assertTrue(d is LeafDecision.Issue && d.reason == "box name changed")
    }

    @Test
    fun aLeafWithoutTheWantedNameIssues() {
        val d = decide(leaf(v2, null), v2, "box1-surau.local")
        assertTrue(d is LeafDecision.Issue && d.reason == "box name changed")
    }

    @Test
    fun noWantedNameLeavesTheLeafsNameAlone() {
        assertEquals(LeafDecision.Skip, decide(leaf(v2, "box1-surau.local"), v2, null))
        assertEquals(LeafDecision.Skip, decide(leaf(v2, null), v2, null))
    }

    @Test
    fun noNameWantedStripsAStaleName() {
        val d = decide(leaf(v2, "box1-surau.local"), v2, LeafPolicy.NO_NAME)
        assertTrue(d is LeafDecision.Issue && d.reason == "box name changed")
        assertEquals(LeafDecision.Skip, decide(leaf(v2, null), v2, LeafPolicy.NO_NAME))
    }

    @Test
    fun aV2LeafNeedsNeitherTheLegacyNameNorMore() {
        // localhost only (no numbered name, none wanted): fine under a V2 root
        assertEquals(LeafDecision.Skip, decide(leaf(v2, null), v2, null))
    }

    @Test
    fun aLegacyRootIgnoresTheWantedNameAndStillWantsTheLegacyNames() {
        assertEquals(LeafDecision.Skip, decide(leaf(legacy, null), legacy, "box1-surau.local"))
        val odd = BoxCa.buildLeaf(signer, legacy, PkiTestKeys.leaf.public, ips, listOf("localhost"), t0, 730, java.security.SecureRandom())
        assertTrue(decide(odd, legacy, "box1-surau.local") is LeafDecision.Issue)
    }

    @Test
    fun aLegacyLeafUnderAV2RootIsReplacedBecauseItDoesNotChainOrCarryLocalhostOnlyNames() {
        // the old leaf was signed by the old root, so under a new root it is "not signed by the root"
        val oldRoot = BoxCa.makeRoot(PkiTestKeys.rootB, "Boxbbbb0002", t0)
        val oldLeaf = BoxCa.makeLeaf(PkiTestKeys.rootB, oldRoot, PkiTestKeys.leaf.public, ips, t0)
        val d = decide(oldLeaf, v2, "box1-surau.local")
        assertTrue(d is LeafDecision.Issue && d.reason.contains("not signed"))
    }

    @Test
    fun theClockRuleStillWinsOverAnIssue() {
        val early = build.minusSeconds(1)
        assertEquals(
            LeafDecision.WaitForClock,
            LeafPolicy.decide(leaf(v2, null), ips, early, build, rootDer = v2, wantedName = "box1-surau.local"),
        )
    }
}
