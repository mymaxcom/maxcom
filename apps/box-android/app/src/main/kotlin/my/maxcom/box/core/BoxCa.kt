package my.maxcom.box.core

import java.io.ByteArrayInputStream
import java.io.File
import java.nio.file.AtomicMoveNotSupportedException
import java.nio.file.Files
import java.nio.file.Path
import java.nio.file.StandardCopyOption
import java.nio.file.StandardOpenOption
import java.nio.file.attribute.PosixFilePermission
import java.nio.file.attribute.PosixFilePermissions
import java.security.KeyFactory
import java.security.KeyPair
import java.security.KeyPairGenerator
import java.security.MessageDigest
import java.security.PrivateKey
import java.security.PublicKey
import java.security.SecureRandom
import java.security.Signature
import java.security.cert.CertificateFactory
import java.security.cert.X509Certificate
import java.security.spec.ECGenParameterSpec
import java.security.spec.PKCS8EncodedKeySpec
import java.time.Instant
import java.time.ZoneOffset
import java.time.temporal.ChronoUnit
import java.util.Base64

/** The stored root certificate does not belong to the signer's key; the caller must not replace it. */
class RootMismatch(message: String) : Exception(message)

/** What `box-ca.json` records about how the leaf was made. No secrets. */
data class CaMeta(
    val ips: List<String>,
    val store: String,
    val label: String,
    val days: Int,
    /** KeyInfo.isInsideSecureHardware of the Keystore root key; null when unknown or the key is a file. */
    val secureHardware: Boolean? = null,
)

/**
 * The box certificate authority, with the same properties `scripts/box-ca.ps1` gives the Windows box:
 * a P-256 root (20 years) whose critical name constraints permit the two DNS names only (BoringSSL in
 * the phone app cannot verify IP name constraints), and a P-256 leaf (730 days) with the box's IP
 * addresses, `localhost` and `box.surau.local`, for server authentication.
 *
 * The root private key stays behind [CaSigner]; this class never sees it.
 */
object BoxCa {
    const val ROOT_CN_PREFIX = "MAXCOM Root CA "
    const val LEAF_CN = "MAXCOM Box"
    val PERMITTED_DNS: List<String> = listOf("localhost", "box.surau.local")
    const val ROOT_YEARS = 20L
    const val DEFAULT_LEAF_DAYS = 730
    const val MAX_LEAF_DAYS = 825
    const val MAX_LEAF_IPS = 16

    private const val OID_ECDSA_SHA256 = "1.2.840.10045.4.3.2"
    private const val OID_COMMON_NAME = "2.5.4.3"
    private const val OID_SKI = "2.5.29.14"
    private const val OID_KEY_USAGE = "2.5.29.15"
    private const val OID_SAN = "2.5.29.17"
    private const val OID_BASIC_CONSTRAINTS = "2.5.29.19"
    private const val OID_NAME_CONSTRAINTS = "2.5.29.30"
    private const val OID_AKI = "2.5.29.35"
    private const val OID_EKU = "2.5.29.37"
    private const val OID_SERVER_AUTH = "1.3.6.1.5.5.7.3.1"

    /** The longest root certificate the phone app accepts from the box (`maxRootCaBytes` in trust.dart). */
    private const val MAX_ROOT_BYTES = 16 * 1024

    private val LABEL = Regex("^[A-Za-z0-9 ._-]{1,40}$")

    /** SubjectPublicKeyInfo of an uncompressed P-256 key: 26 header bytes, then the 65-byte point. */
    private val P256_SPKI_HEADER = hexToBytes("3059301306072a8648ce3d020106082a8648ce3d030107034200")
    private const val SPKI_LENGTH = 91

    /** `Box` plus 8 random hex digits, the label of a new root. */
    fun newLabel(random: SecureRandom = SecureRandom()): String {
        val b = ByteArray(4)
        random.nextBytes(b)
        return "Box" + bytesToHex(b)
    }

    /**
     * The NameConstraints extension value of the root: `permittedSubtrees` holding the two DNS names
     * only. Byte for byte what `Get-NameConstraintsHex` in `box-ca.ps1` builds.
     */
    fun nameConstraintsValue(): ByteArray {
        val subtrees = PERMITTED_DNS.map { name ->
            Der.sequence(Der.contextPrimitive(2, name.toByteArray(Charsets.US_ASCII)))
        }
        return Der.sequence(Der.contextConstructed(0, Der.concat(*subtrees.toTypedArray())))
    }

    // ---- root -----------------------------------------------------------------------------------

    /** Makes the self-signed root certificate (DER). [label] is `Box` plus 8 hex digits from [newLabel]. */
    fun makeRoot(signer: CaSigner, label: String, now: Instant, random: SecureRandom = SecureRandom()): ByteArray {
        require(LABEL.matches(label)) { "bad CA label" }
        val spki = checkedSpki(signer.publicKey)
        val subject = name(ROOT_CN_PREFIX + label)
        val notBefore = now.minus(1, ChronoUnit.DAYS)
        val notAfter = now.atZone(ZoneOffset.UTC).plusYears(ROOT_YEARS).toInstant()
        val extensions = Der.sequence(
            extension(OID_BASIC_CONSTRAINTS, true, Der.sequence(Der.boolean(true))),
            // keyCertSign (bit 5) and cRLSign (bit 6): 0000 0110, one unused bit.
            extension(OID_KEY_USAGE, true, Der.bitString(byteArrayOf(0x06), 1)),
            extension(OID_SKI, false, Der.octetString(keyIdentifier(spki))),
            extension(OID_NAME_CONSTRAINTS, true, nameConstraintsValue()),
        )
        val tbs = Der.sequence(
            Der.contextConstructed(0, Der.integer(java.math.BigInteger.valueOf(2))),
            serial(random),
            sigAlg(),
            subject,
            Der.sequence(Der.time(notBefore), Der.time(notAfter)),
            subject,
            spki,
            Der.contextConstructed(3, extensions),
        )
        return signed(signer, tbs)
    }

    /**
     * Returns the root certificate to use, making one only when none exists. The root is made once and
     * kept in two places: [caDir]/root-ca.cer (outside the data folder) and [pkiDir]/root-ca.cer (served
     * to phones). A missing or damaged copy is restored from the other. A stored root that does not
     * belong to [signer] is never replaced: [RootMismatch] is thrown, because a new root would change
     * `caSha256` and every enrolled phone would stop trusting the box.
     */
    fun ensureRoot(caDir: File, pkiDir: File, signer: CaSigner, label: String, now: Instant): ByteArray {
        val signerSpki = checkedSpki(signer.publicKey)
        val primary = File(caDir, "root-ca.cer")
        val secondary = File(pkiDir, "root-ca.cer")
        var root: ByteArray? = null
        for (f in listOf(primary, secondary)) {
            val bytes = readBounded(f) ?: continue
            val cert = parseCertOrNull(bytes) ?: continue
            if (!cert.publicKey.encoded.contentEquals(signerSpki)) {
                throw RootMismatch("the stored root certificate does not belong to the root key")
            }
            root = bytes
            break
        }
        val der = root ?: makeRoot(signer, label, now)
        writeAtomic(primary.toPath(), der, secret = false)
        writeAtomic(secondary.toPath(), der, secret = false)
        return der
    }

    // ---- leaf -----------------------------------------------------------------------------------

    /** A new P-256 key pair for the leaf. */
    fun newLeafKey(): KeyPair {
        val g = KeyPairGenerator.getInstance("EC")
        g.initialize(ECGenParameterSpec("secp256r1"))
        return g.generateKeyPair()
    }

    /** The private key as a PKCS#8 PEM, the form `tls.ts` loads from `secret/box-key.pem`. */
    fun pkcs8Pem(privateKey: PrivateKey): String {
        require(privateKey.format == "PKCS#8") { "private key is not PKCS#8" }
        val body = Base64.getMimeEncoder(64, "\n".toByteArray()).encodeToString(privateKey.encoded)
        return "-----BEGIN PRIVATE KEY-----\n$body\n-----END PRIVATE KEY-----\n"
    }

    /**
     * Makes the leaf certificate (DER) for the box: subject `CN=MAXCOM Box`, the IPv4 addresses [ips]
     * (private LAN addresses; the caller filters with [LanAddresses.pick]), `localhost` and
     * `box.surau.local`, server authentication only, [days] long (1 to 825). The root must be a
     * certificate this code made for [signer].
     */
    fun makeLeaf(
        signer: CaSigner,
        rootDer: ByteArray,
        leafPublicKey: PublicKey,
        ips: List<String>,
        now: Instant,
        days: Int = DEFAULT_LEAF_DAYS,
        random: SecureRandom = SecureRandom(),
    ): ByteArray = buildLeaf(signer, rootDer, leafPublicKey, ips, PERMITTED_DNS, now, days, random)

    /** [makeLeaf] with chosen DNS names; test code uses it to prove the root refuses other names. */
    internal fun buildLeaf(
        signer: CaSigner,
        rootDer: ByteArray,
        leafPublicKey: PublicKey,
        ips: List<String>,
        dnsNames: List<String>,
        now: Instant,
        days: Int,
        random: SecureRandom,
    ): ByteArray {
        require(days in 1..MAX_LEAF_DAYS) { "days must be 1..$MAX_LEAF_DAYS" }
        require(ips.size <= MAX_LEAF_IPS && ips.toSet().size == ips.size) { "bad IP list" }
        val ipBytes = ips.map { Ipv4.parse(it) ?: throw IllegalArgumentException("not an IPv4 address: $it") }
        for (n in dnsNames) require(Regex("^[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?$").matches(n)) { "bad DNS name" }
        val signerSpki = checkedSpki(signer.publicKey)
        val leafSpki = checkedSpki(leafPublicKey)

        val root = parseCertOrNull(rootDer) ?: throw IllegalArgumentException("root is not a certificate")
        require(root.publicKey.encoded.contentEquals(signerSpki)) { "root does not belong to the signer" }
        require(root.basicConstraints >= 0) { "root is not a CA" }
        require(root.criticalExtensionOIDs?.contains(OID_NAME_CONSTRAINTS) == true) { "root has no critical name constraints" }
        require(root.getExtensionValue(OID_NAME_CONSTRAINTS)?.contentEquals(Der.octetString(nameConstraintsValue())) == true) {
            "root name constraints are not the DNS-only set"
        }
        val rawRootSubject = rawSubject(rootDer)

        val notBefore = now.minus(1, ChronoUnit.DAYS)
        val notAfter = now.plus(days.toLong(), ChronoUnit.DAYS)
        require(notAfter.truncatedTo(ChronoUnit.SECONDS) <= root.notAfter.toInstant()) { "the root expires before this leaf would" }

        val general = ArrayList<ByteArray>()
        for (b in ipBytes) general.add(Der.contextPrimitive(7, b))
        for (n in dnsNames) general.add(Der.contextPrimitive(2, n.toByteArray(Charsets.US_ASCII)))
        val rootKeyId = rootKeyIdentifier(root, signerSpki)
        val extensions = Der.sequence(
            // CA false is the DER default, so the BasicConstraints value is an empty SEQUENCE.
            extension(OID_BASIC_CONSTRAINTS, true, Der.sequence()),
            // digitalSignature (bit 0): 1000 0000, seven unused bits.
            extension(OID_KEY_USAGE, true, Der.bitString(byteArrayOf(0x80.toByte()), 7)),
            extension(OID_EKU, false, Der.sequence(Der.oid(OID_SERVER_AUTH))),
            extension(OID_SAN, false, Der.sequence(*general.toTypedArray())),
            extension(OID_SKI, false, Der.octetString(keyIdentifier(leafSpki))),
            extension(OID_AKI, false, Der.sequence(Der.contextPrimitive(0, rootKeyId))),
        )
        val tbs = Der.sequence(
            Der.contextConstructed(0, Der.integer(java.math.BigInteger.valueOf(2))),
            serial(random),
            sigAlg(),
            rawRootSubject,
            Der.sequence(Der.time(notBefore), Der.time(notAfter)),
            name(LEAF_CN),
            leafSpki,
            Der.contextConstructed(3, extensions),
        )
        return signed(signer, tbs)
    }

    // ---- files ----------------------------------------------------------------------------------

    /**
     * Writes the files the box server reads, each as a temporary file then a rename: the root copy
     * `pki/root-ca.cer` (only when it differs), then the leaf `pki/box-leaf.cer`, then the key
     * `secret/box-key.pem` (mode 0600, folder 0700), then `pki/box-ca.json`. Before anything is written the
     * leaf must be signed by [rootDer] and [leafKeyPem] must be the leaf's own key; otherwise nothing
     * on disk changes.
     */
    fun writeFiles(dataDir: File, rootDer: ByteArray, leafDer: ByteArray, leafKeyPem: String, meta: CaMeta) {
        checkMeta(meta)
        val root = parseCertOrNull(rootDer) ?: throw IllegalArgumentException("root is not a certificate")
        val leaf = parseCertOrNull(leafDer) ?: throw IllegalArgumentException("leaf is not a certificate")
        try {
            leaf.verify(root.publicKey)
        } catch (e: java.security.GeneralSecurityException) {
            throw IllegalArgumentException("the leaf is not signed by this root")
        }
        if (!keyMatches(leafKeyPem, leaf.publicKey)) throw IllegalArgumentException("the leaf key does not match the leaf")

        val pki = File(dataDir, "pki")
        val secret = File(dataDir, "secret")
        makeDir(pki.toPath(), private = false)
        makeDir(secret.toPath(), private = true)
        val rootFile = File(pki, "root-ca.cer")
        if (readBounded(rootFile)?.contentEquals(rootDer) != true) writeAtomic(rootFile.toPath(), rootDer, secret = false)
        // Leaf first, then its key: a crash between the two leaves a pair that does not match, and
        // LeafPolicy.decide (checkKey) issues a new leaf at the next certify.
        writeAtomic(File(pki, "box-leaf.cer").toPath(), leafDer, secret = false)
        writeAtomic(File(secret, "box-key.pem").toPath(), leafKeyPem.toByteArray(Charsets.US_ASCII), secret = true)
        writeAtomic(File(pki, "box-ca.json").toPath(), metaJson(meta).toByteArray(Charsets.US_ASCII), secret = false)
    }

    fun metaJson(meta: CaMeta): String {
        checkMeta(meta)
        val ips = meta.ips.joinToString(",") { "\"$it\"" }
        val hw = meta.secureHardware?.let { ",\"secureHardware\":$it" } ?: ""
        return "{\"ips\":[$ips],\"store\":\"${meta.store}\",\"label\":\"${meta.label}\",\"days\":${meta.days},\"madeBy\":\"android\"$hw}\n"
    }

    private fun checkMeta(meta: CaMeta) {
        require(meta.store == "AndroidKeyStore" || meta.store == "File") { "bad store" }
        require(LABEL.matches(meta.label)) { "bad label" }
        require(meta.days in 1..MAX_LEAF_DAYS) { "bad days" }
        for (ip in meta.ips) require(Ipv4.parse(ip) != null) { "bad IP" }
    }

    /** Lower-case hex sha256 of [bytes]: the value the QR carries as `caSha256`. */
    fun sha256Hex(bytes: ByteArray): String = bytesToHex(MessageDigest.getInstance("SHA-256").digest(bytes))

    // ---- internals ------------------------------------------------------------------------------

    private fun name(cn: String): ByteArray =
        Der.sequence(Der.set(Der.sequence(Der.oid(OID_COMMON_NAME), Der.utf8String(cn))))

    private fun sigAlg(): ByteArray = Der.sequence(Der.oid(OID_ECDSA_SHA256))

    private fun extension(oid: String, critical: Boolean, value: ByteArray): ByteArray =
        if (critical) Der.sequence(Der.oid(oid), Der.boolean(true), Der.octetString(value))
        else Der.sequence(Der.oid(oid), Der.octetString(value))

    /** 16 random bytes, positive: the top octet is 0x40 to 0x7F, so the INTEGER needs no padding. */
    private fun serial(random: SecureRandom): ByteArray {
        val b = ByteArray(16)
        random.nextBytes(b)
        b[0] = ((b[0].toInt() and 0x3F) or 0x40).toByte()
        return Der.integerUnsigned(b)
    }

    /** Signs [tbs] and wraps it as a certificate; the signature is checked with the signer's public key. */
    private fun signed(signer: CaSigner, tbs: ByteArray): ByteArray {
        val sig = signer.sign(tbs)
        val v = Signature.getInstance("SHA256withECDSA")
        v.initVerify(signer.publicKey)
        v.update(tbs)
        val ok = try { v.verify(sig) } catch (e: java.security.SignatureException) { false }
        check(ok) { "the signer returned a bad signature" }
        return Der.sequence(tbs, sigAlg(), Der.bitString(sig))
    }

    /** The X.509 encoding of [key], accepted only when it is an uncompressed P-256 key. */
    private fun checkedSpki(key: PublicKey): ByteArray {
        val enc = key.encoded ?: throw IllegalArgumentException("public key has no encoding")
        require(enc.size == SPKI_LENGTH && enc.copyOfRange(0, P256_SPKI_HEADER.size).contentEquals(P256_SPKI_HEADER)) {
            "public key is not an EC P-256 key"
        }
        require(enc[P256_SPKI_HEADER.size] == 0x04.toByte()) { "public key point is not uncompressed" }
        return enc
    }

    /** RFC 5280 method 1: SHA-1 of the subjectPublicKey bits (the 65-byte point). */
    private fun keyIdentifier(spki: ByteArray): ByteArray =
        MessageDigest.getInstance("SHA-1").digest(spki.copyOfRange(P256_SPKI_HEADER.size, spki.size))

    private fun rootKeyIdentifier(root: X509Certificate, rootSpki: ByteArray): ByteArray {
        val wrapped = root.getExtensionValue(OID_SKI) ?: return keyIdentifier(rootSpki)
        return try {
            val outer = Der.read(wrapped, 0)
            val inner = Der.read(wrapped, outer.contentStart)
            wrapped.copyOfRange(inner.contentStart, inner.end)
        } catch (e: IllegalArgumentException) {
            keyIdentifier(rootSpki)
        }
    }

    /** The subject Name of [certDer] exactly as stored (never re-encoded), used as the leaf's issuer. */
    private fun rawSubject(certDer: ByteArray): ByteArray {
        val cert = Der.read(certDer, 0)
        val tbs = Der.read(certDer, cert.contentStart)
        var at = tbs.contentStart
        var field = Der.read(certDer, at)
        if (field.tag == 0xA0) { // version
            at = field.end
            field = Der.read(certDer, at)
        }
        // serial, signature, issuer, validity, then the subject
        repeat(4) {
            at = Der.read(certDer, at).end
        }
        val subject = Der.read(certDer, at)
        require(subject.tag == Der.TAG_SEQUENCE) { "bad certificate" }
        return certDer.copyOfRange(subject.start, subject.end)
    }

    private fun parseCertOrNull(der: ByteArray): X509Certificate? = try {
        CertificateFactory.getInstance("X.509").generateCertificate(ByteArrayInputStream(der)) as? X509Certificate
    } catch (e: java.security.cert.CertificateException) {
        null
    }

    private fun readBounded(f: File): ByteArray? {
        if (!f.isFile || f.length() > MAX_ROOT_BYTES) return null
        return try { f.readBytes() } catch (e: java.io.IOException) { null }
    }

    /** True when [pem] is a PKCS#8 EC private key whose signatures verify with [publicKey]. */
    fun keyMatchesPublic(pem: String, publicKey: PublicKey): Boolean = keyMatches(pem, publicKey)

    private fun keyMatches(pem: String, publicKey: PublicKey): Boolean {
        val m = Regex("^-----BEGIN PRIVATE KEY-----\\s*([A-Za-z0-9+/=\\s]+?)\\s*-----END PRIVATE KEY-----\\s*$").find(pem)
            ?: return false
        return try {
            val der = Base64.getMimeDecoder().decode(m.groupValues[1])
            val priv = KeyFactory.getInstance("EC").generatePrivate(PKCS8EncodedKeySpec(der))
            val probe = ByteArray(32)
            SecureRandom().nextBytes(probe)
            val s = Signature.getInstance("SHA256withECDSA")
            s.initSign(priv)
            s.update(probe)
            val sig = s.sign()
            val v = Signature.getInstance("SHA256withECDSA")
            v.initVerify(publicKey)
            v.update(probe)
            v.verify(sig)
        } catch (e: java.security.GeneralSecurityException) {
            false
        } catch (e: IllegalArgumentException) {
            false
        }
    }

    private fun makeDir(dir: Path, private: Boolean) {
        Files.createDirectories(dir)
        if (private) restrict(dir, "rwx------")
    }

    private fun restrict(path: Path, mode: String) {
        try {
            Files.setPosixFilePermissions(path, PosixFilePermissions.fromString(mode))
        } catch (e: UnsupportedOperationException) {
            // not a POSIX file system (a Windows development machine): the app's own folder is private anyway
        }
    }

    /** Writes [bytes] to a temporary file beside [target], flushes it to disk and renames it over [target]. */
    internal fun writeAtomic(target: Path, bytes: ByteArray, secret: Boolean) {
        val dir = target.parent ?: throw IllegalArgumentException("no parent folder")
        Files.createDirectories(dir)
        val tmp = dir.resolve(target.fileName.toString() + ".tmp")
        Files.deleteIfExists(tmp)
        try {
            if (secret) {
                try {
                    Files.createFile(tmp, PosixFilePermissions.asFileAttribute(setOf(PosixFilePermission.OWNER_READ, PosixFilePermission.OWNER_WRITE)))
                } catch (e: UnsupportedOperationException) {
                    Files.createFile(tmp)
                }
            }
            java.nio.channels.FileChannel.open(
                tmp,
                StandardOpenOption.CREATE,
                StandardOpenOption.WRITE,
                StandardOpenOption.TRUNCATE_EXISTING,
            ).use { ch ->
                ch.write(java.nio.ByteBuffer.wrap(bytes))
                ch.force(true)
            }
            try {
                Files.move(tmp, target, StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING)
            } catch (e: AtomicMoveNotSupportedException) {
                Files.move(tmp, target, StandardCopyOption.REPLACE_EXISTING)
            }
        } finally {
            Files.deleteIfExists(tmp)
        }
    }

    private const val HEX = "0123456789abcdef"

    internal fun bytesToHex(b: ByteArray): String {
        val sb = StringBuilder(b.size * 2)
        for (x in b) {
            sb.append(HEX[(x.toInt() shr 4) and 0xF]).append(HEX[x.toInt() and 0xF])
        }
        return sb.toString()
    }

    internal fun hexToBytes(s: String): ByteArray {
        require(s.length % 2 == 0)
        return ByteArray(s.length / 2) { ((HEX.indexOf(s[2 * it]) shl 4) or HEX.indexOf(s[2 * it + 1])).toByte() }
    }
}
