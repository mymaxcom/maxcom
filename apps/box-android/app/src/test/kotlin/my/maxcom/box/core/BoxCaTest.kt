package my.maxcom.box.core

import java.io.ByteArrayInputStream
import java.io.File
import java.nio.file.FileSystems
import java.nio.file.Files
import java.nio.file.attribute.PosixFilePermissions
import java.security.KeyFactory
import java.security.KeyPairGenerator
import java.security.PublicKey
import java.security.SecureRandom
import java.security.cert.CertPathValidator
import java.security.cert.CertPathValidatorException
import java.security.cert.CertificateFactory
import java.security.cert.PKIXParameters
import java.security.cert.TrustAnchor
import java.security.cert.X509Certificate
import java.security.interfaces.ECPublicKey
import java.security.spec.ECGenParameterSpec
import java.security.spec.PKCS8EncodedKeySpec
import java.time.Instant
import java.util.Base64
import java.util.Date
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Test

class BoxCaTest {
    private val now = Instant.parse("2026-11-11T00:00:00Z")
    private val signer = PkiTestKeys.rootA
    private val ips = listOf("10.0.0.5", "10.168.1.20")
    private val cf = CertificateFactory.getInstance("X.509")
    private val rnd = SecureRandom()

    private fun parse(der: ByteArray): X509Certificate = cf.generateCertificate(ByteArrayInputStream(der)) as X509Certificate

    private fun root() = BoxCa.makeRoot(signer, "Boxaaaa0001", now)

    private fun leaf(rootDer: ByteArray = root(), list: List<String> = ips, days: Int = 730) =
        BoxCa.makeLeaf(signer, rootDer, PkiTestKeys.leaf.public, list, now, days)

    private fun unwrap(extensionValue: ByteArray): ByteArray {
        val outer = Der.read(extensionValue, 0)
        return extensionValue.copyOfRange(outer.contentStart, outer.end)
    }

    private fun tmp(): File = Files.createTempDirectory("boxca").toFile().also { it.deleteOnExit() }

    private fun posix() = FileSystems.getDefault().supportedFileAttributeViews().contains("posix")

    /**
     * PKIX with the root as the only trust anchor. The JDK validator does not apply the name constraints
     * of a trust anchor (it rejects them as a parameter), so that property is proved by BoringSSL in the
     * Dart test instead.
     */
    private fun validate(rootDer: ByteArray, leafDer: ByteArray, at: Instant = now.plusSeconds(60)) {
        val params = PKIXParameters(setOf(TrustAnchor(parse(rootDer), null)))
        params.isRevocationEnabled = false
        params.date = Date.from(at)
        CertPathValidator.getInstance("PKIX").validate(cf.generateCertPath(listOf(parse(leafDer))), params)
    }

    // ---- root -----------------------------------------------------------------------------------

    @Test
    fun rootHasTheShapeBoxCaPs1Gives() {
        val der = root()
        val c = parse(der)
        assertEquals(3, c.version)
        assertEquals("CN=MAXCOM Root CA Boxaaaa0001", c.subjectX500Principal.getName())
        assertEquals(c.subjectX500Principal, c.issuerX500Principal)
        assertEquals("1.2.840.10045.4.3.2", c.sigAlgOID)
        assertTrue(c.basicConstraints >= 0)
        val ku = c.keyUsage
        for (i in ku.indices) assertEquals("key usage bit $i", i == 5 || i == 6, ku[i])
        assertTrue(c.criticalExtensionOIDs.containsAll(listOf("2.5.29.19", "2.5.29.15", "2.5.29.30")))
        assertTrue(c.nonCriticalExtensionOIDs.contains("2.5.29.14"))
        assertEquals(Instant.parse("2026-11-10T00:00:00Z"), c.notBefore.toInstant())
        assertEquals(Instant.parse("2046-11-11T00:00:00Z"), c.notAfter.toInstant())
        c.verify(c.publicKey)
        val key = c.publicKey as ECPublicKey
        assertEquals(256, key.params.curve.field.fieldSize)
        assertArrayEquals(signer.publicKey.encoded, key.encoded)
    }

    @Test
    fun rootNameConstraintsAreTheBytesBoxCaPs1Builds() {
        // Get-NameConstraintsHex in scripts/box-ca.ps1: SEQ { [0] { SEQ { [2] name } ... } }
        fun node(tag: Int, content: ByteArray) = byteArrayOf(tag.toByte(), content.size.toByte()) + content
        val names = listOf("localhost", "box.surau.local")
        val subtrees = names.map { node(0x30, node(0x82, it.toByteArray(Charsets.US_ASCII))) }
        val expected = node(0x30, node(0xA0, subtrees.reduce { a, b -> a + b }))
        val literal = "3022a020300b8209" + "6c6f63616c686f7374" + "3011820f" + "626f782e73757261752e6c6f63616c"
        assertEquals(literal, BoxCa.bytesToHex(expected))
        val c = parse(root())
        assertArrayEquals(expected, unwrap(c.getExtensionValue("2.5.29.30")))
        assertTrue(c.criticalExtensionOIDs.contains("2.5.29.30"))
    }

    @Test
    fun serialsArePositiveAndRandom() {
        val a = parse(root())
        val b = parse(root())
        assertTrue(a.serialNumber.signum() > 0 && b.serialNumber.signum() > 0)
        assertTrue(a.serialNumber.bitLength() >= 120)
        assertNotEquals(a.serialNumber, b.serialNumber)
        assertFalse(root().contentEquals(root()))
    }

    @Test
    fun rootLabelsAreChecked() {
        assertTrue(Regex("^Box[0-9a-f]{8}$").matches(BoxCa.newLabel()))
        assertNotEquals(BoxCa.newLabel(), BoxCa.newLabel())
        for (bad in listOf("", "x".repeat(41), "a\"b", "a,b", "a\nb", "é")) {
            assertThrows(IllegalArgumentException::class.java) { BoxCa.makeRoot(signer, bad, now) }
        }
    }

    // ---- leaf -----------------------------------------------------------------------------------

    @Test
    fun leafHasTheShapeBoxCaPs1Gives() {
        val rootDer = root()
        val r = parse(rootDer)
        val c = parse(leaf(rootDer))
        assertEquals(3, c.version)
        assertEquals("CN=MAXCOM Box", c.subjectX500Principal.getName())
        assertEquals(r.subjectX500Principal, c.issuerX500Principal)
        assertEquals(Instant.parse("2026-11-10T00:00:00Z"), c.notBefore.toInstant())
        assertEquals(Instant.parse("2028-11-10T00:00:00Z"), c.notAfter.toInstant())
        assertTrue(c.serialNumber.signum() > 0)
        assertEquals(-1, c.basicConstraints)
        assertEquals(listOf("1.3.6.1.5.5.7.3.1"), c.extendedKeyUsage)
        val ku = c.keyUsage
        for (i in ku.indices) assertEquals("key usage bit $i", i == 0, ku[i])
        assertTrue(c.criticalExtensionOIDs.containsAll(listOf("2.5.29.19", "2.5.29.15")))
        assertTrue(c.nonCriticalExtensionOIDs.containsAll(listOf("2.5.29.17", "2.5.29.37", "2.5.29.14", "2.5.29.35")))
        val san = c.subjectAlternativeNames.map { (it[0] as Int) to (it[1] as String) }
        assertEquals(
            listOf(7 to "10.0.0.5", 7 to "10.168.1.20", 2 to "localhost", 2 to "box.surau.local"),
            san,
        )
        assertArrayEquals(PkiTestKeys.leaf.public.encoded, c.publicKey.encoded)
        c.verify(r.publicKey)
        // the authority key identifier names the root's subject key identifier
        val rootSki = unwrap(unwrap(r.getExtensionValue("2.5.29.14")))
        val aki = unwrap(c.getExtensionValue("2.5.29.35"))
        val akiInner = Der.read(aki, 0)
        val keyId = Der.read(aki, akiInner.contentStart)
        assertEquals(0x80, keyId.tag)
        assertArrayEquals(rootSki, aki.copyOfRange(keyId.contentStart, keyId.end))
    }

    @Test
    fun leafValidatesAgainstTheRootAlone() {
        val rootDer = root()
        validate(rootDer, leaf(rootDer))
        validate(rootDer, leaf(rootDer, emptyList()))
    }

    @Test
    fun leafOutsideItsDatesIsRefused() {
        val rootDer = root()
        val l = leaf(rootDer, days = 730)
        assertThrows(CertPathValidatorException::class.java) { validate(rootDer, l, now.minusSeconds(2 * 86400)) }
        assertThrows(CertPathValidatorException::class.java) { validate(rootDer, l, now.plusSeconds(731L * 86400)) }
    }

    @Test
    fun aLeafFromAnotherRootIsRefused() {
        val rootDer = root()
        val other = BoxCa.makeRoot(PkiTestKeys.rootB, "Boxbbbb0002", now)
        val foreign = BoxCa.makeLeaf(PkiTestKeys.rootB, other, PkiTestKeys.leaf.public, ips, now)
        assertThrows(CertPathValidatorException::class.java) { validate(rootDer, foreign) }
    }

    @Test
    fun aLeafWithOtherDnsNamesIsPossibleOnlyThroughTheTestHook() {
        // makeLeaf always uses the two permitted names; buildLeaf (internal) is for the Dart fixture of a
        // leaf the phone must refuse. Here: it is signed by the root and carries the extra name.
        val rootDer = root()
        val evil = BoxCa.buildLeaf(
            signer, rootDer, PkiTestKeys.leaf.public, ips, listOf("localhost", "evil.example"), now, 730, rnd,
        )
        val c = parse(evil)
        c.verify(parse(rootDer).publicKey)
        assertTrue(c.subjectAlternativeNames.any { it[0] == 2 && it[1] == "evil.example" })
        assertTrue(parse(leaf(rootDer)).subjectAlternativeNames.none { it[1] == "evil.example" })
    }

    @Test
    fun leafInputsAreChecked() {
        val rootDer = root()
        val pub = PkiTestKeys.leaf.public
        fun make(list: List<String> = ips, days: Int = 730, r: ByteArray = rootDer, s: CaSigner = signer, k: PublicKey = pub) =
            BoxCa.makeLeaf(s, r, k, list, now, days)
        for (bad in listOf("256.0.0.1", "01.2.3.4", "::1", "1.2.3", "1.2.3.4 ", "localhost", "")) {
            assertThrows(bad, IllegalArgumentException::class.java) { make(list = listOf(bad)) }
        }
        assertThrows(IllegalArgumentException::class.java) { make(list = listOf("10.0.0.1", "10.0.0.1")) }
        assertThrows(IllegalArgumentException::class.java) { make(list = (1..17).map { "10.0.0.$it" }) }
        assertThrows(IllegalArgumentException::class.java) { make(days = 0) }
        assertThrows(IllegalArgumentException::class.java) { make(days = 826) }
        make(days = 825)
        // a root made for another key cannot be used with this signer
        val other = BoxCa.makeRoot(PkiTestKeys.rootB, "Boxbbbb0002", now)
        assertThrows(IllegalArgumentException::class.java) { make(r = other) }
        assertThrows(IllegalArgumentException::class.java) { make(r = byteArrayOf(1, 2, 3)) }
        // only P-256 keys
        val rsa = KeyPairGenerator.getInstance("RSA").apply { initialize(2048) }.generateKeyPair()
        assertThrows(IllegalArgumentException::class.java) { make(k = rsa.public) }
        val p384 = KeyPairGenerator.getInstance("EC").apply { initialize(ECGenParameterSpec("secp384r1")) }.generateKeyPair()
        assertThrows(IllegalArgumentException::class.java) { make(k = p384.public) }
        // a leaf may not outlive its root
        assertThrows(IllegalArgumentException::class.java) {
            BoxCa.makeLeaf(signer, rootDer, pub, ips, now.plusSeconds(19L * 365 * 86400), 825)
        }
    }

    @Test
    fun aBrokenSignerIsCaught() {
        val garbage = object : CaSigner {
            override val publicKey = signer.publicKey
            override fun sign(tbs: ByteArray) = ByteArray(70) { 7 }
        }
        assertThrows(IllegalStateException::class.java) { BoxCa.makeRoot(garbage, "Boxaaaa0001", now) }
        val wrongKey = object : CaSigner {
            override val publicKey = signer.publicKey
            override fun sign(tbs: ByteArray) = PkiTestKeys.rootB.sign(tbs)
        }
        assertThrows(IllegalStateException::class.java) { BoxCa.makeRoot(wrongKey, "Boxaaaa0001", now) }
    }

    @Test
    fun leafKeyPemIsPkcs8AndRoundTrips() {
        val pair = PkiTestKeys.leaf
        val pem = BoxCa.pkcs8Pem(pair.private)
        assertTrue(pem.startsWith("-----BEGIN PRIVATE KEY-----\n") && pem.endsWith("\n-----END PRIVATE KEY-----\n"))
        assertTrue(pem.lines().all { it.length <= 64 })
        val body = pem.lines().filter { !it.startsWith("-----") && it.isNotEmpty() }.joinToString("")
        val key = KeyFactory.getInstance("EC").generatePrivate(PKCS8EncodedKeySpec(Base64.getDecoder().decode(body)))
        assertArrayEquals(pair.private.encoded, key.encoded)
        val fresh = BoxCa.newLeafKey()
        assertEquals(256, (fresh.public as ECPublicKey).params.curve.field.fieldSize)
        assertNotNull(fresh.private.encoded)
    }

    // ---- the root is made once ------------------------------------------------------------------

    @Test
    fun ensureRootMakesItOnceAndKeepsTwoCopies() {
        val base = tmp()
        val ca = File(base, "ca")
        val pki = File(base, "data/pki")
        val first = BoxCa.ensureRoot(ca, pki, signer, "Boxaaaa0001", now)
        assertArrayEquals(first, File(ca, "root-ca.cer").readBytes())
        assertArrayEquals(first, File(pki, "root-ca.cer").readBytes())
        // a later call, even with another label and time, returns the same bytes
        val again = BoxCa.ensureRoot(ca, pki, signer, "Boxzzzz9999", now.plusSeconds(86400L * 400))
        assertArrayEquals(first, again)
        assertEquals(BoxCa.sha256Hex(first), BoxCa.sha256Hex(again))
    }

    @Test
    fun ensureRootRestoresTheMissingOrDamagedCopy() {
        val base = tmp()
        val ca = File(base, "ca")
        val pki = File(base, "data/pki")
        val first = BoxCa.ensureRoot(ca, pki, signer, "Boxaaaa0001", now)
        File(pki, "root-ca.cer").delete()
        assertArrayEquals(first, BoxCa.ensureRoot(ca, pki, signer, "Boxbbbb0002", now))
        assertArrayEquals(first, File(pki, "root-ca.cer").readBytes())
        File(ca, "root-ca.cer").delete()
        assertArrayEquals(first, BoxCa.ensureRoot(ca, pki, signer, "Boxbbbb0002", now))
        assertArrayEquals(first, File(ca, "root-ca.cer").readBytes())
        File(ca, "root-ca.cer").writeBytes(byteArrayOf(1, 2, 3))
        assertArrayEquals(first, BoxCa.ensureRoot(ca, pki, signer, "Boxbbbb0002", now))
        assertArrayEquals(first, File(ca, "root-ca.cer").readBytes())
    }

    @Test
    fun ensureRootNeverReplacesARootOfAnotherKey() {
        val base = tmp()
        val ca = File(base, "ca")
        val pki = File(base, "data/pki")
        val first = BoxCa.ensureRoot(ca, pki, signer, "Boxaaaa0001", now)
        assertThrows(RootMismatch::class.java) { BoxCa.ensureRoot(ca, pki, PkiTestKeys.rootB, "Boxbbbb0002", now) }
        assertArrayEquals(first, File(ca, "root-ca.cer").readBytes())
        assertArrayEquals(first, File(pki, "root-ca.cer").readBytes())
    }

    @Test
    fun ensureRootMakesANewRootOnlyWhenBothCopiesAreGone() {
        val base = tmp()
        val ca = File(base, "ca")
        val pki = File(base, "data/pki")
        val first = BoxCa.ensureRoot(ca, pki, signer, "Boxaaaa0001", now)
        File(ca, "root-ca.cer").delete()
        File(pki, "root-ca.cer").delete()
        val second = BoxCa.ensureRoot(ca, pki, signer, "Boxaaaa0001", now)
        assertFalse(first.contentEquals(second))
        parse(second).verify(signer.publicKey)
    }

    // ---- files ----------------------------------------------------------------------------------

    private val meta = CaMeta(ips, "AndroidKeyStore", "Boxaaaa0001", 730)

    @Test
    fun writeFilesWritesWhatTheBoxServerReads() {
        val data = tmp()
        val rootDer = root()
        val leafDer = leaf(rootDer)
        val pem = BoxCa.pkcs8Pem(PkiTestKeys.leaf.private)
        BoxCa.writeFiles(data, rootDer, leafDer, pem, meta)
        assertArrayEquals(rootDer, File(data, "pki/root-ca.cer").readBytes())
        assertArrayEquals(leafDer, File(data, "pki/box-leaf.cer").readBytes())
        assertEquals(pem, File(data, "secret/box-key.pem").readText())
        assertEquals(
            "{\"ips\":[\"10.0.0.5\",\"10.168.1.20\"],\"store\":\"AndroidKeyStore\",\"label\":\"Boxaaaa0001\",\"days\":730,\"madeBy\":\"android\"}\n",
            File(data, "pki/box-ca.json").readText(),
        )
        assertEquals(setOf("root-ca.cer", "box-leaf.cer", "box-ca.json"), File(data, "pki").list()!!.toSet())
        assertEquals(setOf("box-key.pem"), File(data, "secret").list()!!.toSet())
        if (posix()) {
            assertEquals("rw-------", PosixFilePermissions.toString(Files.getPosixFilePermissions(File(data, "secret/box-key.pem").toPath())))
            assertEquals("rwx------", PosixFilePermissions.toString(Files.getPosixFilePermissions(File(data, "secret").toPath())))
        }
        // renewal: a second leaf replaces the first in place, nothing else is left behind
        val leaf2 = leaf(rootDer, listOf("10.0.0.9"))
        BoxCa.writeFiles(data, rootDer, leaf2, pem, meta.copy(ips = listOf("10.0.0.9")))
        assertArrayEquals(leaf2, File(data, "pki/box-leaf.cer").readBytes())
        assertEquals(setOf("root-ca.cer", "box-leaf.cer", "box-ca.json"), File(data, "pki").list()!!.toSet())
    }

    @Test
    fun metaJsonRecordsTheHardwareFlagOnlyWhenKnown() {
        assertFalse(BoxCa.metaJson(meta).contains("secureHardware"))
        assertTrue(BoxCa.metaJson(meta.copy(secureHardware = true)).endsWith(",\"secureHardware\":true}\n"))
        assertTrue(BoxCa.metaJson(meta.copy(secureHardware = false)).endsWith(",\"secureHardware\":false}\n"))
    }

    @Test
    fun writeFilesRefusesBeforeTouchingAnything() {
        val data = tmp()
        val rootDer = root()
        val leafDer = leaf(rootDer)
        val pem = BoxCa.pkcs8Pem(PkiTestKeys.leaf.private)
        // a key that is not the leaf's
        val otherPem = BoxCa.pkcs8Pem(BoxCa.newLeafKey().private)
        assertThrows(IllegalArgumentException::class.java) { BoxCa.writeFiles(data, rootDer, leafDer, otherPem, meta) }
        assertThrows(IllegalArgumentException::class.java) { BoxCa.writeFiles(data, rootDer, leafDer, "not a key", meta) }
        // a leaf of another root
        val otherRoot = BoxCa.makeRoot(PkiTestKeys.rootB, "Boxbbbb0002", now)
        assertThrows(IllegalArgumentException::class.java) { BoxCa.writeFiles(data, otherRoot, leafDer, pem, meta) }
        assertThrows(IllegalArgumentException::class.java) { BoxCa.writeFiles(data, rootDer, byteArrayOf(1), pem, meta) }
        // bad metadata
        assertThrows(IllegalArgumentException::class.java) { BoxCa.writeFiles(data, rootDer, leafDer, pem, meta.copy(store = "x")) }
        assertThrows(IllegalArgumentException::class.java) { BoxCa.writeFiles(data, rootDer, leafDer, pem, meta.copy(label = "a\"b")) }
        assertThrows(IllegalArgumentException::class.java) { BoxCa.writeFiles(data, rootDer, leafDer, pem, meta.copy(ips = listOf("x"))) }
        assertEquals(0, data.list()!!.size)
    }

    @Test
    fun metaJsonForTheFileFallback() {
        assertTrue(BoxCa.metaJson(meta.copy(store = "File")).contains("\"store\":\"File\""))
    }

    // ---- fixtures for the Dart test -------------------------------------------------------------

    /**
     * Run with the environment variable MAXCOM_WRITE_PKI_FIXTURES set to a folder to (re)write the
     * certificates `apps/surau-app/test/box/android_box_pki_test.dart` uses. The keys are the fixed
     * test keys in [PkiTestKeys]; serials and dates are fresh, so the leaf (825 days) must be remade
     * before `leafNotAfter` in `fixture-info.json`. Skipped in a normal run.
     */
    @Test
    fun writeDartFixtures() {
        val dir = System.getenv("MAXCOM_WRITE_PKI_FIXTURES") ?: System.getProperty("pki.fixtures.dir")
        assumeTrue("set MAXCOM_WRITE_PKI_FIXTURES to write the Dart fixtures", dir != null)
        val out = File(dir!!)
        out.mkdirs()
        val at = Instant.now().truncatedTo(java.time.temporal.ChronoUnit.DAYS)
        val fixtureIps = listOf("127.0.0.1", "10.168.1.20")
        val leafKey = PkiTestKeys.leaf
        val rootA = BoxCa.makeRoot(PkiTestKeys.rootA, "BoxDart0001", at)
        val rootB = BoxCa.makeRoot(PkiTestKeys.rootB, "BoxDart0002", at)
        val good = BoxCa.makeLeaf(PkiTestKeys.rootA, rootA, leafKey.public, fixtureIps, at, BoxCa.MAX_LEAF_DAYS)
        val foreign = BoxCa.makeLeaf(PkiTestKeys.rootB, rootB, leafKey.public, fixtureIps, at, BoxCa.MAX_LEAF_DAYS)
        val evil = BoxCa.buildLeaf(
            PkiTestKeys.rootA, rootA, leafKey.public, fixtureIps, listOf("localhost", "evil.example"), at, BoxCa.MAX_LEAF_DAYS, rnd,
        )
        // the good chain must pass the JVM validator before it is written
        validate(rootA, good, at.plusSeconds(60))
        assertThrows(CertPathValidatorException::class.java) { validate(rootA, foreign, at.plusSeconds(60)) }
        File(out, "root-ca.cer").writeBytes(rootA)
        File(out, "box-leaf.cer").writeBytes(good)
        File(out, "box-key.pem").writeText(BoxCa.pkcs8Pem(leafKey.private))
        File(out, "other-root-ca.cer").writeBytes(rootB)
        File(out, "other-box-leaf.cer").writeBytes(foreign)
        File(out, "evil-box-leaf.cer").writeBytes(evil)
        val info = "{\"rootSha256\":\"${BoxCa.sha256Hex(rootA)}\",\"otherRootSha256\":\"${BoxCa.sha256Hex(rootB)}\"," +
            "\"leafNotAfter\":\"${parse(good).notAfter.toInstant()}\",\"ips\":[\"127.0.0.1\",\"10.168.1.20\"]," +
            "\"note\":\"made by BoxCaTest.writeDartFixtures with MAXCOM_WRITE_PKI_FIXTURES; keys are test keys\"}\n"
        File(out, "fixture-info.json").writeText(info)
    }
}
