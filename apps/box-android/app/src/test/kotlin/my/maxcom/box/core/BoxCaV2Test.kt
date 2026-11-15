package my.maxcom.box.core

import java.io.ByteArrayInputStream
import java.io.File
import java.nio.file.Files
import java.security.cert.CertPathValidator
import java.security.cert.CertificateFactory
import java.security.cert.PKIXParameters
import java.security.cert.TrustAnchor
import java.security.cert.X509Certificate
import java.time.Instant
import java.util.Date
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

/** The V2 root (99 explicit box names plus localhost, DNS only) and the leaf that carries the claimed name. */
class BoxCaV2Test {
    private val now = Instant.parse("2026-11-11T00:00:00Z")
    private val signer = PkiTestKeys.rootA
    private val ips = listOf("10.0.0.5", "10.168.1.20")
    private val cf = CertificateFactory.getInstance("X.509")

    private fun parse(der: ByteArray): X509Certificate = cf.generateCertificate(ByteArrayInputStream(der)) as X509Certificate

    private fun v2Root() = BoxCa.makeRoot(signer, "Boxaaaa0001", now, generation = RootGeneration.V2)
    private fun legacyRoot() = BoxCa.makeRoot(signer, "Boxaaaa0001", now)

    private fun unwrap(extensionValue: ByteArray): ByteArray {
        val outer = Der.read(extensionValue, 0)
        return extensionValue.copyOfRange(outer.contentStart, outer.end)
    }

    /** DER TLV written independently of [Der] so the test does not trust the code it checks. */
    private fun tlv(tag: Int, content: ByteArray): ByteArray {
        val len = content.size
        val l = when {
            len < 0x80 -> byteArrayOf(len.toByte())
            len < 0x100 -> byteArrayOf(0x81.toByte(), len.toByte())
            else -> byteArrayOf(0x82.toByte(), (len shr 8).toByte(), len.toByte())
        }
        return byteArrayOf(tag.toByte()) + l + content
    }

    private fun validate(rootDer: ByteArray, leafDer: ByteArray) {
        val params = PKIXParameters(setOf(TrustAnchor(parse(rootDer), null)))
        params.isRevocationEnabled = false
        params.date = Date.from(now.plusSeconds(60))
        CertPathValidator.getInstance("PKIX").validate(cf.generateCertPath(listOf(parse(leafDer))), params)
    }

    private fun sans(c: X509Certificate): Pair<Set<String>, Set<String>> {
        val ip = HashSet<String>()
        val dns = HashSet<String>()
        for (e in c.subjectAlternativeNames ?: emptyList()) {
            if (e[0] == 7) ip.add(e[1] as String) else if (e[0] == 2) dns.add(e[1] as String)
        }
        return ip to dns
    }

    @Test
    fun theV2ConstraintsAreLocalhostAndTheNinetyNineExplicitNamesAndNothingElse() {
        val names = listOf("localhost") + (1..99).map { "box$it-surau.local" }
        val subtrees = names.map { tlv(0x30, tlv(0x82, it.toByteArray(Charsets.US_ASCII))) }
        val expected = tlv(0x30, tlv(0xA0, subtrees.reduce { a, b -> a + b }))
        val c = parse(v2Root())
        assertArrayEquals(expected, unwrap(c.getExtensionValue("2.5.29.30")))
        assertTrue(c.criticalExtensionOIDs.contains("2.5.29.30"))
        assertEquals(names, BoxCa.PERMITTED_DNS_V2)
        assertEquals(100, names.size)
        // DNS only: the only context tag inside the subtrees is [2] (0x82), never an IP ([7]) or a name type
        for (st in subtrees) assertEquals(0x82.toByte(), st[2])
        // no subtree wider than one box name: none is "local" or "surau.local"
        assertTrue(names.none { it == "local" || it == "surau.local" || it == "box.surau.local" })
    }

    @Test
    fun generationIsReadFromTheRootsOwnConstraints() {
        assertEquals(RootGeneration.V2, BoxCa.rootGeneration(v2Root()))
        assertEquals(RootGeneration.LEGACY, BoxCa.rootGeneration(legacyRoot()))
        assertTrue(BoxCa.rootPermitsSubtree(v2Root()))
        assertFalse(BoxCa.rootPermitsSubtree(legacyRoot()))
        assertNull(BoxCa.rootGeneration(byteArrayOf(1, 2, 3)))
        // a leaf is not a root
        val leaf = BoxCa.makeLeaf(signer, v2Root(), PkiTestKeys.leaf.public, ips, now)
        assertNull(BoxCa.rootGeneration(leaf))
        assertFalse(BoxCa.rootPermitsSubtree(leaf))
    }

    @Test
    fun theRootLabelIsReadBack() {
        assertEquals("Boxaaaa0001", BoxCa.rootLabelOf(v2Root()))
        assertNull(BoxCa.rootLabelOf(byteArrayOf(1, 2, 3)))
    }

    @Test
    fun aV2RootStillMakesALegacyRootByDefault() {
        // makeRoot keeps the legacy default (existing roots and fixtures); ensureRoot makes V2 for a new install
        assertEquals(RootGeneration.LEGACY, BoxCa.rootGeneration(BoxCa.makeRoot(signer, "Boxaaaa0001", now)))
        val d = Files.createTempDirectory("v2root").toFile().also { it.deleteOnExit() }
        val root = BoxCa.ensureRoot(File(d, "ca"), File(d, "pki"), signer, "Boxaaaa0001", now)
        assertEquals(RootGeneration.V2, BoxCa.rootGeneration(root))
    }

    @Test
    fun aV2LeafCarriesTheIpsLocalhostAndTheClaimedNameOnly() {
        val root = v2Root()
        val leaf = BoxCa.makeLeaf(signer, root, PkiTestKeys.leaf.public, ips, now, boxName = "box1-surau.local")
        val (ip, dns) = sans(parse(leaf))
        assertEquals(ips.toSet(), ip)
        assertEquals(setOf("localhost", "box1-surau.local"), dns)
        validate(root, leaf)
    }

    @Test
    fun aV2LeafWithoutAClaimedNameHasLocalhostOnly() {
        val root = v2Root()
        val leaf = BoxCa.makeLeaf(signer, root, PkiTestKeys.leaf.public, ips, now)
        assertEquals(setOf("localhost"), sans(parse(leaf)).second)
        validate(root, leaf)
    }

    @Test
    fun aV2LeafRefusesAnyNameThatIsNotOneOfTheNinetyNine() {
        val root = v2Root()
        for (bad in listOf("box100-surau.local", "box0-surau.local", "box.surau.local", "evil.example", "localhost", "box1.surau.local", "BOX1-surau.local", "")) {
            assertThrows(bad, IllegalArgumentException::class.java) {
                BoxCa.makeLeaf(signer, root, PkiTestKeys.leaf.public, ips, now, boxName = bad)
            }
        }
    }

    @Test
    fun aLegacyRootKeepsTheLegacyLeafAndIgnoresTheName() {
        val root = legacyRoot()
        val leaf = BoxCa.makeLeaf(signer, root, PkiTestKeys.leaf.public, ips, now, boxName = "box1-surau.local")
        assertEquals(setOf("localhost", "box.surau.local"), sans(parse(leaf)).second)
        validate(root, leaf)
    }

    @Test
    fun aCertificateThatIsNotAKnownRootCannotIssueALeaf() {
        assertThrows(IllegalArgumentException::class.java) {
            BoxCa.makeLeaf(signer, byteArrayOf(1, 2, 3), PkiTestKeys.leaf.public, ips, now)
        }
        // a leaf certificate (no CA bit, no constraints) is no root either
        val leaf = BoxCa.makeLeaf(signer, v2Root(), PkiTestKeys.leaf.public, ips, now)
        assertThrows(IllegalArgumentException::class.java) {
            BoxCa.makeLeaf(signer, leaf, PkiTestKeys.leaf.public, ips, now)
        }
    }

    @Test
    fun theMetaRecordsTheNameOnlyWhenThereIsOne() {
        val meta = CaMeta(ips, "File", "Boxaaaa0001", 730, null, "box2-surau.local")
        assertEquals(
            "{\"ips\":[\"10.0.0.5\",\"10.168.1.20\"],\"store\":\"File\",\"label\":\"Boxaaaa0001\",\"days\":730,\"madeBy\":\"android\",\"name\":\"box2-surau.local\"}\n",
            BoxCa.metaJson(meta),
        )
        assertFalse(BoxCa.metaJson(meta.copy(name = null)).contains("name"))
        assertThrows(IllegalArgumentException::class.java) { BoxCa.metaJson(meta.copy(name = "evil.example")) }
        assertThrows(IllegalArgumentException::class.java) { BoxCa.metaJson(meta.copy(name = "box1-surau.local\",\"x\":\"")) }
    }

    @Test
    fun writeFilesKeepsTheOldFileSet() {
        val data = Files.createTempDirectory("v2files").toFile().also { it.deleteOnExit() }
        val root = v2Root()
        val leaf = BoxCa.makeLeaf(signer, root, PkiTestKeys.leaf.public, ips, now, boxName = "box3-surau.local")
        BoxCa.writeFiles(data, root, leaf, BoxCa.pkcs8Pem(PkiTestKeys.leaf.private), CaMeta(ips, "AndroidKeyStore", "Boxaaaa0001", 730, true, "box3-surau.local"))
        assertEquals(setOf("root-ca.cer", "box-leaf.cer", "box-ca.json"), File(data, "pki").list()!!.toSet())
        assertTrue(File(data, "pki/box-ca.json").readText().contains("\"name\":\"box3-surau.local\""))
    }

    @Test
    fun theTwoNamesNeverMixAcrossGenerations() {
        // the legacy name is not permitted by a V2 root, and a numbered name not by a legacy root
        assertFalse(BoxCa.PERMITTED_DNS_V2.contains("box.surau.local"))
        assertFalse(BoxCa.PERMITTED_DNS.any { it.startsWith("box1-") })
    }
}
