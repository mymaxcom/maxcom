package my.maxcom.app

import android.os.Build
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.security.keystore.StrongBoxUnavailableException
import android.os.Handler
import android.os.Looper
import androidx.fragment.app.FragmentActivity
import io.flutter.embedding.engine.FlutterEngine
import io.flutter.plugin.common.MethodCall
import io.flutter.plugin.common.MethodChannel
import java.security.KeyPairGenerator
import java.security.KeyStore
import java.security.PrivateKey
import java.security.ProviderException
import java.security.Signature
import java.security.interfaces.ECPublicKey
import java.security.spec.ECGenParameterSpec
import java.util.concurrent.Executor
import java.util.concurrent.Executors

/**
 * Runs [work] on [executor] and hands its outcome to [deliver] through [postMain], so a slow job
 * (a multi-MB AES-GCM seal through the Keystore) never blocks the Android main thread and the
 * platform reply still happens on it. An Error counts as a failure too: a job that dies without
 * an answer would leave the Dart side waiting forever.
 */
internal fun <T> runOffMain(
    executor: Executor,
    postMain: (Runnable) -> Unit,
    work: () -> T,
    deliver: (Result<T>) -> Unit,
) {
    executor.execute {
        val outcome = try {
            Result.success(work())
        } catch (t: Throwable) {
            Result.failure(t)
        }
        postMain(Runnable { deliver(outcome) })
    }
}

/**
 * Device signing key in the Android Keystore (channel `my.maxcom/keystore`).
 *
 * The private key is generated inside the Keystore (StrongBox when the phone offers it, else the
 * TEE) and is never exported: this channel only returns the public point and DER signatures. The
 * key has no user-authentication requirement (the PIN and the box check the person; this key
 * proves the device). Error replies carry a short code and no key or platform detail.
 */
class KeystoreChannel(
    private val seal: BiometricSeal,
    private val filesDir: java.io.File? = null,
    private val executor: Executor = defaultExecutor,
    private val postMain: (Runnable) -> Unit = defaultPostMain,
) : MethodChannel.MethodCallHandler {
    companion object {
        const val CHANNEL = "my.maxcom/keystore"
        const val ALIAS = "surau-device-key"
        private const val PROVIDER = "AndroidKeyStore"

        /** Seal, open and key reset of the local store run here, two at a time at most. */
        private val defaultExecutor: Executor = Executors.newFixedThreadPool(2) { r ->
            Thread(r, "keystore-local-seal").apply { isDaemon = true }
        }
        private val defaultPostMain: (Runnable) -> Unit = { r ->
            Handler(Looper.getMainLooper()).post(r)
        }

        fun register(engine: FlutterEngine, activity: FragmentActivity) {
            MethodChannel(engine.dartExecutor.binaryMessenger, CHANNEL)
                .setMethodCallHandler(KeystoreChannel(BiometricSeal(activity), activity.filesDir))
        }
    }

    private fun store(): KeyStore = KeyStore.getInstance(PROVIDER).apply { load(null) }

    override fun onMethodCall(call: MethodCall, result: MethodChannel.Result) {
        try {
            when (call.method) {
                "exists" -> result.success(store().containsAlias(ALIAS) && store().getKey(ALIAS, null) != null)
                "generate" -> result.success(generate())
                "publicKey" -> result.success(publicPoint())
                "sign" -> {
                    val message = call.arguments as? ByteArray
                    if (message == null) {
                        result.error("bad_args", "bad arguments", null)
                    } else {
                        result.success(sign(message))
                    }
                }
                "clear" -> {
                    if (store().containsAlias(ALIAS)) store().deleteEntry(ALIAS)
                    result.success(null)
                }
                "available" -> result.success(seal.available())
                "hasSealedPin" -> result.success(seal.hasSealedPin())
                "sealPin" -> {
                    val pin = (call.arguments as? Map<*, *>)?.get("pin") as? String
                    if (pin.isNullOrEmpty()) {
                        result.error("bad_args", "bad arguments", null)
                    } else {
                        seal.seal(pin, result)
                    }
                }
                "openPin" -> seal.open(result)
                "clearSealedPin" -> {
                    seal.clear()
                    result.success(null)
                }
                "localSeal", "localOpen" -> {
                    val args = call.arguments as? Map<*, *>
                    val box = args?.get("box") as? String
                    val bytes = args?.get("bytes") as? ByteArray
                    if (box == null || bytes == null || !LocalSeal.isBoxId(box)) {
                        result.error("bad_args", "bad arguments", null)
                    } else {
                        // Off the main thread: a multi-MB blob through the Keystore takes
                        // seconds on a mid-range phone. The reply goes back on the main thread.
                        val sealing = call.method == "localSeal"
                        runOffMain(
                            executor,
                            postMain,
                            { if (sealing) LocalSeal.forBox(box).seal(bytes) else LocalSeal.forBox(box).open(bytes) },
                        ) { outcome ->
                            outcome.fold(
                                { result.success(it) },
                                { e ->
                                    // Never include e.message: it can carry provider internals.
                                    if (e is NoKeyException) {
                                        result.error("no_key", "no key", null)
                                    } else {
                                        result.error("keystore_failed", "keystore failure", null)
                                    }
                                },
                            )
                        }
                    }
                }
                "localKeyReset" -> {
                    val box = (call.arguments as? Map<*, *>)?.get("box") as? String
                    if (box == null || !LocalSeal.isBoxId(box)) {
                        result.error("bad_args", "bad arguments", null)
                    } else {
                        // Same executor as seal/open, so a reset is queued behind the seals
                        // already running instead of racing them from the main thread.
                        runOffMain(executor, postMain, { LocalSeal.reset(box) }) { outcome ->
                            outcome.fold(
                                { result.success(null) },
                                { result.error("keystore_failed", "keystore failure", null) },
                            )
                        }
                    }
                }
                // Folder for the local store files (app-private, excluded from backup).
                "localDir" -> result.success(filesDir?.absolutePath)
                else -> result.notImplemented()
            }
        } catch (e: NoKeyException) {
            result.error("no_key", "no key", null)
        } catch (e: Exception) {
            // Never include e.message: it can carry provider internals.
            result.error("keystore_failed", "keystore failure", null)
        }
    }

    private class NoKeyException : Exception()

    private fun spec(strongBox: Boolean): KeyGenParameterSpec {
        val b = KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_SIGN)
            .setAlgorithmParameterSpec(ECGenParameterSpec("secp256r1"))
            .setDigests(KeyProperties.DIGEST_SHA256)
            .setUserAuthenticationRequired(false)
        if (strongBox && Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            b.setIsStrongBoxBacked(true)
        }
        return b.build()
    }

    private fun generateWith(strongBox: Boolean) {
        val gen = KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_EC, PROVIDER)
        gen.initialize(spec(strongBox))
        gen.generateKeyPair()
    }

    /** Replaces any existing key. StrongBox first, falling back to the TEE-backed Keystore. */
    private fun generate(): ByteArray {
        val ks = store()
        if (ks.containsAlias(ALIAS)) ks.deleteEntry(ALIAS)
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) generateWith(true) else generateWith(false)
        } catch (e: StrongBoxUnavailableException) {
            if (ks.containsAlias(ALIAS)) ks.deleteEntry(ALIAS)
            generateWith(false)
        } catch (e: ProviderException) {
            // Some devices report missing StrongBox as a plain ProviderException.
            if (ks.containsAlias(ALIAS)) ks.deleteEntry(ALIAS)
            generateWith(false)
        }
        return publicPoint()
    }

    /** Uncompressed SEC1 point `04 || X(32) || Y(32)`. */
    private fun publicPoint(): ByteArray {
        val cert = store().getCertificate(ALIAS) ?: throw NoKeyException()
        val w = (cert.publicKey as ECPublicKey).w
        val out = ByteArray(65)
        out[0] = 0x04
        fixed32(w.affineX.toByteArray()).copyInto(out, 1)
        fixed32(w.affineY.toByteArray()).copyInto(out, 33)
        return out
    }

    /** BigInteger.toByteArray() may add a sign byte or be short; return exactly 32 bytes. */
    private fun fixed32(b: ByteArray): ByteArray {
        var start = 0
        while (start < b.size - 1 && b[start] == 0.toByte()) start++
        val len = b.size - start
        if (len > 32) throw IllegalStateException("coordinate too long")
        val out = ByteArray(32)
        System.arraycopy(b, start, out, 32 - len, len)
        return out
    }

    /** DER `SEQUENCE { r, s }`; Dart converts it to the 64-byte P1363 form. */
    private fun sign(message: ByteArray): ByteArray {
        val key = store().getKey(ALIAS, null) as? PrivateKey ?: throw NoKeyException()
        val sig = Signature.getInstance("SHA256withECDSA")
        sig.initSign(key)
        sig.update(message)
        return sig.sign()
    }
}
