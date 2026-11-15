package my.maxcom.box.core

import java.io.ByteArrayInputStream
import java.io.File
import java.nio.file.Files
import java.security.cert.CertificateFactory
import java.security.cert.X509Certificate
import java.time.Instant
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class RootRekeyTest {
    private val now = Instant.parse("2026-11-11T00:00:00Z")
    private val ips = listOf("10.0.0.5")
    private fun tmp(): File = Files.createTempDirectory("rekey").toFile().also { it.deleteOnExit() }
    private fun parse(der: ByteArray) = CertificateFactory.getInstance("X.509").generateCertificate(ByteArrayInputStream(der)) as X509Certificate

    private class Box(val ca: File, val pki: File, val oldRoot: ByteArray, val oldLeaf: ByteArray)

    /** A box with a legacy root (key A) and a leaf, the way a fielded box looks. */
    private fun legacyBox(): Box {
        val base = tmp()
        val ca = File(base, "ca")
        val data = File(base, "data")
        val pki = File(data, "pki")
        val root = BoxCa.ensureRoot(ca, pki, PkiTestKeys.rootA, "Boxaaaa0001", now, RootGeneration.LEGACY)
        val leaf = BoxCa.makeLeaf(PkiTestKeys.rootA, root, PkiTestKeys.leaf.public, ips, now)
        BoxCa.writeFiles(data, root, leaf, BoxCa.pkcs8Pem(PkiTestKeys.leaf.private), CaMeta(ips, "File", "Boxaaaa0001", 730))
        return Box(ca, pki, root, leaf)
    }

    private val newSigner = { _: String -> RootSigner(PkiTestKeys.rootB, "File") }

    @Test
    fun rekeyMakesAV2RootUnderTheNewKeyAndArchivesTheOldOnes() {
        val b = legacyBox()
        val r = RootRekey.run(b.ca, b.pki, now, newSigner, label = "Boxbbbb0002")
        assertEquals(RootGeneration.V2, BoxCa.rootGeneration(r.rootDer))
        assertEquals("Boxbbbb0002", BoxCa.rootLabelOf(r.rootDer))
        parse(r.rootDer).verify(PkiTestKeys.rootB.publicKey)
        assertArrayEquals(r.rootDer, File(b.ca, "root-ca.cer").readBytes())
        assertArrayEquals(r.rootDer, File(b.pki, "root-ca.cer").readBytes())
        assertEquals("old/Boxaaaa0001", r.archivedAs)
        val arch = File(b.pki, "old/Boxaaaa0001")
        assertArrayEquals(b.oldRoot, File(arch, "root-ca.cer").readBytes())
        assertArrayEquals(b.oldLeaf, File(arch, "box-leaf.cer").readBytes())
        assertTrue(File(arch, "box-ca.json").isFile)
        assertNotEquals(BoxCa.sha256Hex(b.oldRoot), BoxCa.sha256Hex(r.rootDer))
        // the old leaf and key files are left for the service to replace; nothing secret was archived
        assertEquals(setOf("root-ca.cer", "box-leaf.cer", "box-ca.json"), arch.list()!!.toSet())
    }

    @Test
    fun theOldLeafNoLongerChainsSoTheNextCertifyIssuesANewOne() {
        val b = legacyBox()
        val r = RootRekey.run(b.ca, b.pki, now, newSigner, label = "Boxbbbb0002")
        val d = LeafPolicy.decide(b.oldLeaf, ips, now, now.minusSeconds(86400), rootDer = r.rootDer, wantedName = "box1-surau.local")
        assertTrue(d is LeafDecision.Issue)
        // and a new leaf under the new root carries the name
        val leaf = BoxCa.makeLeaf(PkiTestKeys.rootB, r.rootDer, PkiTestKeys.leaf.public, ips, now, boxName = "box1-surau.local")
        assertEquals(LeafDecision.Skip, LeafPolicy.decide(leaf, ips, now, now.minusSeconds(86400), rootDer = r.rootDer, wantedName = "box1-surau.local"))
    }

    @Test
    fun aFailingNewKeyChangesNothing() {
        val b = legacyBox()
        val before = b.pki.walkTopDown().filter { it.isFile }.associate { it.relativeTo(b.pki).path to it.readBytes().toList() }
        assertThrows(java.security.GeneralSecurityException::class.java) {
            RootRekey.run(b.ca, b.pki, now, { throw java.security.GeneralSecurityException("keystore busy") })
        }
        val after = b.pki.walkTopDown().filter { it.isFile }.associate { it.relativeTo(b.pki).path to it.readBytes().toList() }
        assertEquals(before, after)
        assertArrayEquals(b.oldRoot, File(b.ca, "root-ca.cer").readBytes())
    }

    @Test
    fun aV2RootIsNeverReKeyedAgainAndNoRootIsAnError() {
        val b = legacyBox()
        RootRekey.run(b.ca, b.pki, now, newSigner, label = "Boxbbbb0002")
        assertThrows(IllegalStateException::class.java) {
            RootRekey.run(b.ca, b.pki, now, { RootSigner(PkiTestKeys.rootA, "File") }, label = "Boxcccc0003")
        }
        val empty = tmp()
        assertThrows(IllegalStateException::class.java) { RootRekey.run(File(empty, "ca"), File(empty, "pki"), now, newSigner) }
    }

    @Test
    fun aCrashBetweenTheTwoRootWritesIsRepairedByEnsureRoot() {
        val b = legacyBox()
        val r = RootRekey.run(b.ca, b.pki, now, newSigner, label = "Boxbbbb0002")
        // simulate: the pki copy still holds the old root
        File(b.pki, "root-ca.cer").writeBytes(b.oldRoot)
        val again = BoxCa.ensureRoot(b.ca, b.pki, PkiTestKeys.rootB, "Boxzzzz9999", now)
        assertArrayEquals(r.rootDer, again)
        assertArrayEquals(r.rootDer, File(b.pki, "root-ca.cer").readBytes())
    }

    @Test
    fun theKeyNamesFollowTheStoredRoot() {
        val b = legacyBox()
        assertEquals("maxcom-root-ca", RootKeys.resolve(b.ca, b.pki, "Boxnew00001").alias)
        assertEquals("root-key", RootKeys.resolve(b.ca, b.pki, null).fileBase)
        RootRekey.run(b.ca, b.pki, now, newSigner, label = "Boxbbbb0002")
        val n = RootKeys.resolve(b.ca, b.pki, "Boxnew00001")
        assertEquals("maxcom-root-ca-Boxbbbb0002", n.alias)
        assertEquals("root-key-Boxbbbb0002", n.fileBase)
        // no root at all: the label of the root about to be made, or the legacy names when none is given
        val e = tmp()
        assertEquals("maxcom-root-ca-Boxnew00001", RootKeys.resolve(File(e, "ca"), File(e, "pki"), "Boxnew00001").alias)
        assertEquals("maxcom-root-ca", RootKeys.resolve(File(e, "ca"), File(e, "pki"), null).alias)
        // an unreadable root file is not a V2 root
        File(e, "ca").mkdirs()
        File(e, "ca/root-ca.cer").writeBytes(byteArrayOf(1, 2, 3))
        assertNull(RootKeys.storedRoot(File(e, "ca"), File(e, "pki")))
        assertFalse(RootKeys.resolve(File(e, "ca"), File(e, "pki"), null).alias.contains("Box"))
    }

    @Test
    fun theChooserFindsTheFileKeyOfTheNewRootByItsLabelAndTheWriterMakesThePair() {
        val base = tmp()
        val ca = File(base, "ca")
        val names = RootKeys.namesForLabel("Boxbbbb0002")
        val rs = RootSignerChooser.writeFileKey(ca, names.fileBase, SoftwareCaSigner.generate())
        assertEquals("File", rs.store)
        assertTrue(File(ca, "root-key-Boxbbbb0002.pk8").isFile && File(ca, "root-key-Boxbbbb0002.pub").isFile)
        val again = RootSignerChooser.open(ca, File(base, "pki"), keystore = { error("keystore must not be used") }, fileBase = names.fileBase)
        assertArrayEquals(rs.signer.publicKey.encoded, again.signer.publicKey.encoded)
        // the legacy file names are untouched
        assertFalse(File(ca, "root-key.pk8").exists())
    }

    @Test
    fun theCertLockIsReentrantAndReleases() {
        val r = CertLock.held { CertLock.held { 7 } }
        assertEquals(7, r)
        assertFalse(CertLock.lock.isHeldByCurrentThread)
        assertThrows(IllegalStateException::class.java) { CertLock.held { throw IllegalStateException("x") } }
        assertFalse(CertLock.lock.isHeldByCurrentThread)
    }
}
