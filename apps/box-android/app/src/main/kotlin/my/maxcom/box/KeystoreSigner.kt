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
import my.maxcom.box.core.RootKeys
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

        /** Opens the key [alias], making it when absent, and proves it with a test signature. Throws on any failure. */
        fun openOrCreate(alias: String = ALIAS): KeystoreSigner {
            val ks = KeyStore.getInstance(PROVIDER)
            ks.load(null)
            if (!ks.containsAlias(alias)) {
                val gen = KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_EC, PROVIDER)
                gen.initialize(
                    KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_SIGN)
                        .setAlgorithmParameterSpec(ECGenParameterSpec("secp256r1"))
                        .setDigests(KeyProperties.DIGEST_SHA256)
                        .setUserAuthenticationRequired(false)
                        .build(),
                )
                gen.generateKeyPair()
            }
            val priv = ks.getKey(alias, null) as? PrivateKey ?: error("keystore key missing")
            val pub = ks.getCertificate(alias)?.publicKey ?: error("keystore public key missing")
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
    /**
     * The signer of the box's root. The key is named after the stored root (a legacy root keeps the original
     * alias and file names; a V2 root uses `maxcom-root-ca-<label>`); with no root yet the key is named after
     * [freshLabel], the label the new root will get.
     */
    fun open(caDir: File, pkiDir: File, freshLabel: String? = null): RootSigner {
        val names = RootKeys.resolve(caDir, pkiDir, freshLabel)
        return RootSignerChooser.open(caDir, pkiDir, keystore = {
            val ks = KeystoreSigner.openOrCreate(names.alias)
            RootSigner(ks, "AndroidKeyStore", ks.insideSecureHardware())
        }, fileBase = names.fileBase)
    }

    /**
     * A NEW root key for a re-key, named after [label], in the same kind of store as the box uses now (a file key
     * when the box already has one, else the Keystore). Throws when the Keystore cannot make it: nothing has changed then.
     */
    fun createForRekey(caDir: File, label: String): RootSigner {
        val names = RootKeys.namesForLabel(label)
        if (File(caDir, RootKeys.DEFAULT_FILE_BASE + ".pk8").isFile) {
            return RootSignerChooser.writeFileKey(caDir, names.fileBase, my.maxcom.box.core.SoftwareCaSigner.generate())
        }
        val ks = KeystoreSigner.openOrCreate(names.alias)
        return RootSigner(ks, "AndroidKeyStore", ks.insideSecureHardware())
    }
}
