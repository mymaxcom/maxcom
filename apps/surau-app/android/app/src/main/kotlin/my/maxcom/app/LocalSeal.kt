package my.maxcom.app

import android.os.Build
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.security.keystore.StrongBoxUnavailableException
import java.security.KeyStore
import java.security.ProviderException
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * AES-256-GCM seal for the app's local store files (Plan 6 Task 7).
 *
 * The key lives in the Android Keystore under `maxcom-local-<boxId>` (StrongBox when the phone
 * offers it, else the TEE) and has no user-authentication requirement, so the store opens before
 * the PIN, as the device key does. Every seal uses a fresh random 12-byte IV and the output is
 * `IV || ciphertext || tag` (the JCE GCM output already ends with the 16-byte tag). A changed
 * byte, a short input or a missing key makes [open] throw; nothing here includes key material or
 * provider detail in an exception message.
 *
 * The cipher part takes its key from [keyProvider] so unit tests can run on the JVM, where there
 * is no Android Keystore.
 */
class LocalSeal(private val keyProvider: () -> SecretKey) {
    companion object {
        private const val PROVIDER = "AndroidKeyStore"
        private const val ALIAS_PREFIX = "maxcom-local-"
        const val IV_BYTES = 12
        const val TAG_BITS = 128
        private const val MIN_LEN = IV_BYTES + TAG_BITS / 8
        private val BOX_ID = Regex("^[A-Za-z0-9_-]{1,64}$")

        fun isBoxId(boxId: String): Boolean = BOX_ID.matches(boxId)

        fun aliasFor(boxId: String): String {
            require(BOX_ID.matches(boxId)) { "bad box id" }
            return ALIAS_PREFIX + boxId
        }

        private fun store(): KeyStore = KeyStore.getInstance(PROVIDER).apply { load(null) }

        /** A [LocalSeal] over the Keystore key of [boxId], created on first use. */
        fun forBox(boxId: String): LocalSeal {
            val alias = aliasFor(boxId)
            return LocalSeal { keystoreKey(alias, create = true)!! }
        }

        /** The Keystore key, or null when absent and [create] is false. */
        fun keystoreKey(alias: String, create: Boolean): SecretKey? {
            val ks = store()
            (ks.getKey(alias, null) as? SecretKey)?.let { return it }
            if (!create) return null
            return try {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) generate(alias, true) else generate(alias, false)
            } catch (e: StrongBoxUnavailableException) {
                generate(alias, false)
            } catch (e: ProviderException) {
                // Some devices report missing StrongBox as a plain ProviderException.
                generate(alias, false)
            }
        }

        private fun generate(alias: String, strongBox: Boolean): SecretKey {
            val b = KeyGenParameterSpec.Builder(
                alias,
                KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT,
            )
                .setKeySize(256)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                // Randomized encryption (the default): the Keystore draws a fresh 12-byte IV
                // for every seal and we read it back from the cipher.
                .setUserAuthenticationRequired(false)
            if (strongBox && Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
                b.setIsStrongBoxBacked(true)
            }
            val gen = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, PROVIDER)
            gen.init(b.build())
            return gen.generateKey()
        }

        /** Deletes the Keystore key of [boxId]; a missing key is fine. */
        fun reset(boxId: String) {
            val ks = store()
            val alias = aliasFor(boxId)
            if (ks.containsAlias(alias)) ks.deleteEntry(alias)
        }
    }

    /** `IV || ciphertext || tag`. The IV is random per call (Keystore keys draw it themselves). */
    fun seal(plain: ByteArray): ByteArray {
        val c = Cipher.getInstance("AES/GCM/NoPadding")
        c.init(Cipher.ENCRYPT_MODE, keyProvider())
        val iv = c.iv
        check(iv != null && iv.size == IV_BYTES) { "bad iv" }
        val body = c.doFinal(plain)
        val out = ByteArray(IV_BYTES + body.size)
        iv.copyInto(out, 0)
        body.copyInto(out, IV_BYTES)
        return out
    }

    /** Throws when the input is too short, was changed, or the key is not the one that sealed it. */
    fun open(sealed: ByteArray): ByteArray {
        require(sealed.size >= MIN_LEN) { "short input" }
        val c = Cipher.getInstance("AES/GCM/NoPadding")
        c.init(
            Cipher.DECRYPT_MODE,
            keyProvider(),
            GCMParameterSpec(TAG_BITS, sealed, 0, IV_BYTES),
        )
        return c.doFinal(sealed, IV_BYTES, sealed.size - IV_BYTES)
    }
}
