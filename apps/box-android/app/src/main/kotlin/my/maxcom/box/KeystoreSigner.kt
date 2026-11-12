package my.maxcom.box

import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import java.io.File
import java.security.KeyPairGenerator
import java.security.KeyStore
import java.security.PrivateKey
import java.security.PublicKey
import java.security.Signature
import java.security.spec.ECGenParameterSpec
import my.maxcom.box.core.CaSigner
import my.maxcom.box.core.RootSigner
import my.maxcom.box.core.RootSignerChooser

/**
 * The root CA key as an EC P-256 key in the Android Keystore (alias [ALIAS]): the key never leaves the
 * keystore, the CA only asks for signatures. No user authentication is needed (a TV box has nobody to ask).
 */
class KeystoreSigner private constructor(
    private val privateKey: PrivateKey,
    override val publicKey: PublicKey,
) : CaSigner {

    override fun sign(tbs: ByteArray): ByteArray {
        val s = Signature.getInstance("SHA256withECDSA")
        s.initSign(privateKey)
        s.update(tbs)
        return s.sign() // DER Ecdsa-Sig-Value, as the Keystore provider returns it
    }

    /** KeyInfo.isInsideSecureHardware of the root key; null when the platform cannot say. */
    fun insideSecureHardware(): Boolean? = try {
        val info = java.security.KeyFactory.getInstance(privateKey.algorithm, PROVIDER)
            .getKeySpec(privateKey, android.security.keystore.KeyInfo::class.java)
        info.isInsideSecureHardware
    } catch (e: Exception) {
        null
    }

    companion object {
        const val ALIAS = "maxcom-root-ca"
        private const val PROVIDER = "AndroidKeyStore"

        /** Opens the key, making it when absent, and proves it with a test signature. Throws on any failure. */
        fun openOrCreate(): KeystoreSigner {
            val ks = KeyStore.getInstance(PROVIDER)
            ks.load(null)
            if (!ks.containsAlias(ALIAS)) {
                val gen = KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_EC, PROVIDER)
                gen.initialize(
                    KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_SIGN)
                        .setAlgorithmParameterSpec(ECGenParameterSpec("secp256r1"))
                        .setDigests(KeyProperties.DIGEST_SHA256)
                        .setUserAuthenticationRequired(false)
                        .build(),
                )
                gen.generateKeyPair()
            }
            val priv = ks.getKey(ALIAS, null) as? PrivateKey ?: error("keystore key missing")
            val pub = ks.getCertificate(ALIAS)?.publicKey ?: error("keystore public key missing")
            val signer = KeystoreSigner(priv, pub)
            // A key that cannot sign (some firmware) must not become the root: prove it now.
            val probe = ByteArray(32) { it.toByte() }
            val sig = signer.sign(probe)
            val v = Signature.getInstance("SHA256withECDSA")
            v.initVerify(pub)
            v.update(probe)
            check(v.verify(sig)) { "keystore test signature failed" }
            return signer
        }
    }
}

/**
 * Decision 18: the Keystore holds the root key. The choice (retries, file fallback only without any root
 * certificate) lives in [RootSignerChooser], pure Kotlin and tested with fakes.
 */
object RootSignerProvider {
    fun open(caDir: File, pkiDir: File): RootSigner = RootSignerChooser.open(caDir, pkiDir, keystore = {
        val ks = KeystoreSigner.openOrCreate()
        RootSigner(ks, "AndroidKeyStore", ks.insideSecureHardware())
    })
}
