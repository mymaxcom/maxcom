package my.maxcom.app

import android.content.Context
import android.os.Build
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyPermanentlyInvalidatedException
import android.security.keystore.KeyProperties
import android.util.Base64
import androidx.biometric.BiometricManager
import androidx.biometric.BiometricPrompt
import androidx.core.content.ContextCompat
import androidx.fragment.app.FragmentActivity
import io.flutter.plugin.common.MethodChannel
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * The unlock PIN, sealed with an AES-256-GCM Keystore key that only a strong biometric can use
 * (alias `surau-pin-seal`, per-use authentication, invalidated by a new fingerprint). Both seal
 * and open show a BiometricPrompt bound to the Cipher. Ciphertext and IV live in app-private
 * SharedPreferences; the PIN is never stored or logged in clear and error replies carry only a
 * short code.
 */
class BiometricSeal(private val activity: FragmentActivity) {
    companion object {
        const val ALIAS = "surau-pin-seal"
        private const val PROVIDER = "AndroidKeyStore"
        private const val PREFS = "surau_pin_seal_store"
        private const val K_CT = "ct"
        private const val K_IV = "iv"
        private const val TRANSFORM = "AES/GCM/NoPadding"
    }

    private var busy = false

    private fun store(): KeyStore = KeyStore.getInstance(PROVIDER).apply { load(null) }
    private fun prefs() = activity.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    fun available(): Boolean =
        BiometricManager.from(activity)
            .canAuthenticate(BiometricManager.Authenticators.BIOMETRIC_STRONG) ==
            BiometricManager.BIOMETRIC_SUCCESS

    fun hasSealedPin(): Boolean {
        val p = prefs()
        return p.contains(K_CT) && p.contains(K_IV) && store().containsAlias(ALIAS)
    }

    fun clear() {
        if (store().containsAlias(ALIAS)) store().deleteEntry(ALIAS)
        prefs().edit().clear().apply()
    }

    private fun newKey(): SecretKey {
        val ks = store()
        if (ks.containsAlias(ALIAS)) ks.deleteEntry(ALIAS)
        val b = KeyGenParameterSpec.Builder(
            ALIAS,
            KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT
        )
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .setKeySize(256)
            .setUserAuthenticationRequired(true)
            .setInvalidatedByBiometricEnrollment(true)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            b.setUserAuthenticationParameters(0, KeyProperties.AUTH_BIOMETRIC_STRONG)
        } else {
            @Suppress("DEPRECATION")
            b.setUserAuthenticationValidityDurationSeconds(-1)
        }
        val gen = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, PROVIDER)
        gen.init(b.build())
        return gen.generateKey()
    }

    private fun prompt(
        title: String,
        cipher: Cipher,
        result: MethodChannel.Result,
        onSuccess: (Cipher) -> Unit
    ) {
        if (busy) {
            result.error("busy", "busy", null)
            return
        }
        busy = true
        val executor = ContextCompat.getMainExecutor(activity)
        val cb = object : BiometricPrompt.AuthenticationCallback() {
            override fun onAuthenticationSucceeded(r: BiometricPrompt.AuthenticationResult) {
                busy = false
                val c = r.cryptoObject?.cipher
                if (c == null) {
                    result.error("auth_failed", "auth failed", null)
                    return
                }
                try {
                    onSuccess(c)
                } catch (e: Exception) {
                    // Never include e.message.
                    result.error("seal_failed", "seal failure", null)
                }
            }

            override fun onAuthenticationError(code: Int, msg: CharSequence) {
                busy = false
                // Short codes only; the Dart side tells cancel, lockout and failure apart.
                val reply = when (code) {
                    BiometricPrompt.ERROR_USER_CANCELED,
                    BiometricPrompt.ERROR_NEGATIVE_BUTTON,
                    BiometricPrompt.ERROR_CANCELED -> "cancelled"
                    BiometricPrompt.ERROR_LOCKOUT,
                    BiometricPrompt.ERROR_LOCKOUT_PERMANENT -> "lockout"
                    else -> "auth_error"
                }
                result.error(reply, reply, null)
            }
        }
        val info = BiometricPrompt.PromptInfo.Builder()
            .setTitle(title)
            .setNegativeButtonText("Guna PIN")
            .setAllowedAuthenticators(BiometricManager.Authenticators.BIOMETRIC_STRONG)
            .setConfirmationRequired(false)
            .build()
        BiometricPrompt(activity, executor, cb).authenticate(info, BiometricPrompt.CryptoObject(cipher))
    }

    fun seal(pin: String, result: MethodChannel.Result) {
        val key = newKey()
        val cipher = Cipher.getInstance(TRANSFORM)
        cipher.init(Cipher.ENCRYPT_MODE, key)
        prompt("Sahkan cap jari", cipher, result) { c ->
            val ct = c.doFinal(pin.toByteArray(Charsets.UTF_8))
            prefs().edit()
                .putString(K_CT, Base64.encodeToString(ct, Base64.NO_WRAP))
                .putString(K_IV, Base64.encodeToString(c.iv, Base64.NO_WRAP))
                .apply()
            result.success(null)
        }
    }

    fun open(result: MethodChannel.Result) {
        if (!hasSealedPin()) {
            result.success(null)
            return
        }
        val cipher = Cipher.getInstance(TRANSFORM)
        try {
            val key = store().getKey(ALIAS, null) as SecretKey
            val iv = Base64.decode(prefs().getString(K_IV, "")!!, Base64.NO_WRAP)
            cipher.init(Cipher.DECRYPT_MODE, key, GCMParameterSpec(128, iv))
        } catch (e: KeyPermanentlyInvalidatedException) {
            // A new fingerprint was enrolled: the key is gone for good. Fall back to the PIN.
            clear()
            result.success(null)
            return
        }
        prompt("Buka kunci MAXCOM", cipher, result) { c ->
            val ct = Base64.decode(prefs().getString(K_CT, "")!!, Base64.NO_WRAP)
            result.success(String(c.doFinal(ct), Charsets.UTF_8))
        }
    }
}
