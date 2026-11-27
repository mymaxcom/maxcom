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

        /** The second slot: a key being enrolled while the first one is still in use. */
        const val ALIAS_B = "surau-device-key-b"
        private const val SLOT_FILE = "device-key-slot"
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

    // The key in use is [ALIAS] unless the slot file says "b". A pending key lives in the other alias; committing
    // flips the slot file and deletes the old alias, so a failed enrolment never touches the key in use.
    private fun slotFile(): java.io.File? = filesDir?.let { java.io.File(it, SLOT_FILE) }

    private fun activeAlias(): String =
        if (slotFile()?.takeIf { it.exists() }?.readText()?.trim() == "b") ALIAS_B else ALIAS

    private fun pendingAlias(): String = if (activeAlias() == ALIAS) ALIAS_B else ALIAS

    private fun setActive(alias: String) {
        val f = slotFile() ?: throw IllegalStateException("no slot file")
        if (alias == ALIAS_B) f.writeText("b") else f.delete()
    }

    override fun onMethodCall(call: MethodCall, result: MethodChannel.Result) {
        try {
            when (call.method) {
                "exists" -> {
                    val a = activeAlias()
                    result.success(store().containsAlias(a) && store().getKey(a, null) != null)
                }
                "generate" -> result.success(generate())
                "publicKey" -> result.success(publicPoint(activeAlias()))
                "sign" -> {
                    val message = call.arguments as? ByteArray
                    if (message == null) {
                        result.error("bad_args", "bad arguments", null)
                    } else {
                        result.success(sign(activeAlias(), message))
                    }
                }
                "generatePending" -> result.success(generatePending())
                "signPending" -> {
                    val message = call.arguments as? ByteArray
                    if (message == null) {
                        result.error("bad_args", "bad arguments", null)
                    } else {
                        result.success(sign(pendingAlias(), message))
                    }
                }
                "commitPending" -> {
                    commitPending()
                    result.success(null)
                }
                "discardPending" -> {
                    val ks = store()
                    val p = pendingAlias()
                    if (ks.containsAlias(p)) ks.deleteEntry(p)
                    result.success(null)
                }
                "clear" -> {
                    val ks = store()
                    for (a in listOf(ALIAS, ALIAS_B)) if (ks.containsAlias(a)) ks.deleteEntry(a)
                    slotFile()?.delete()
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

    private fun spec(alias: String, strongBox: Boolean): KeyGenParameterSpec {
        val b = KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_SIGN)
            .setAlgorithmParameterSpec(ECGenParameterSpec("secp256r1"))
            .setDigests(KeyProperties.DIGEST_SHA256)
            .setUserAuthenticationRequired(false)
        if (strongBox && Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            b.setIsStrongBoxBacked(true)
        }
        return b.build()
    }

    private fun generateWith(alias: String, strongBox: Boolean) {
        val gen = KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_EC, PROVIDER)
        gen.initialize(spec(alias, strongBox))
        gen.generateKeyPair()
    }

    /** Makes a key under [alias], replacing what is there. StrongBox first, falling back to the TEE-backed Keystore. */
    private fun generateAt(alias: String): ByteArray {
        val ks = store()
        if (ks.containsAlias(alias)) ks.deleteEntry(alias)
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) generateWith(alias, true) else generateWith(alias, false)
        } catch (e: StrongBoxUnavailableException) {
            if (ks.containsAlias(alias)) ks.deleteEntry(alias)
            generateWith(alias, false)
        } catch (e: ProviderException) {
            // Some devices report missing StrongBox as a plain ProviderException.
            if (ks.containsAlias(alias)) ks.deleteEntry(alias)
            generateWith(alias, false)
        }
        return publicPoint(alias)
    }

    /** Replaces any existing key (both slots) and makes the one in use. */
    private fun generate(): ByteArray {
        val ks = store()
        if (ks.containsAlias(ALIAS_B)) ks.deleteEntry(ALIAS_B)
        slotFile()?.delete()
        return generateAt(ALIAS)
    }

    /** A new key in the slot not in use; the key in use is not touched. */
    private fun generatePending(): ByteArray {
        if (slotFile() == null) throw IllegalStateException("no slot file")
        return generateAt(pendingAlias())
    }

    /** The pending key becomes the key in use and the old one is deleted. */
    private fun commitPending() {
        val ks = store()
        val pending = pendingAlias()
        val old = activeAlias()
        if (!ks.containsAlias(pending) || ks.getKey(pending, null) == null) throw NoKeyException()
        setActive(pending)
        if (ks.containsAlias(old)) ks.deleteEntry(old)
    }

    /** Uncompressed SEC1 point `04 || X(32) || Y(32)`. */
    private fun publicPoint(alias: String): ByteArray {
        val cert = store().getCertificate(alias) ?: throw NoKeyException()
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
    private fun sign(alias: String, message: ByteArray): ByteArray {
        val key = store().getKey(alias, null) as? PrivateKey ?: throw NoKeyException()
        val sig = Signature.getInstance("SHA256withECDSA")
        sig.initSign(key)
        sig.update(message)
        return sig.sign()
    }
}
