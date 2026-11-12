package my.maxcom.box.core

import java.security.KeyFactory
import java.security.KeyPair
import java.security.KeyPairGenerator
import java.security.PrivateKey
import java.security.PublicKey
import java.security.Signature
import java.security.spec.ECGenParameterSpec
import java.security.spec.PKCS8EncodedKeySpec
import java.security.spec.X509EncodedKeySpec

/**
 * Whatever holds the root CA private key. The key never leaves the signer: the CA only asks it to
 * sign the to-be-signed bytes of a certificate. The Android Keystore signer is a separate class
 * outside `core/`; [SoftwareCaSigner] serves tests and the file fallback.
 */
interface CaSigner {
    /** The root's public key, X.509 SubjectPublicKeyInfo encoding, EC P-256. */
    val publicKey: PublicKey

    /** ECDSA with SHA-256 over [tbs]; the result is the DER `Ecdsa-Sig-Value` (not the raw r||s form). */
    fun sign(tbs: ByteArray): ByteArray
}

/** A signer with the key in memory (tests, and the documented file fallback of decision 18). */
class SoftwareCaSigner(private val privateKey: PrivateKey, override val publicKey: PublicKey) : CaSigner {
    constructor(pair: KeyPair) : this(pair.private, pair.public)

    override fun sign(tbs: ByteArray): ByteArray {
        val s = Signature.getInstance("SHA256withECDSA")
        s.initSign(privateKey)
        s.update(tbs)
        return s.sign()
    }

    /** PKCS#8 bytes of the private key, for the file fallback only. */
    fun privateKeyPkcs8(): ByteArray = privateKey.encoded ?: error("private key is not exportable")

    companion object {
        fun generate(): SoftwareCaSigner {
            val g = KeyPairGenerator.getInstance("EC")
            g.initialize(ECGenParameterSpec("secp256r1"))
            return SoftwareCaSigner(g.generateKeyPair())
        }

        /** Rebuild a signer from stored PKCS#8 private and X.509 public key bytes. */
        fun fromEncoded(pkcs8: ByteArray, spki: ByteArray): SoftwareCaSigner {
            val f = KeyFactory.getInstance("EC")
            return SoftwareCaSigner(f.generatePrivate(PKCS8EncodedKeySpec(pkcs8)), f.generatePublic(X509EncodedKeySpec(spki)))
        }
    }
}
