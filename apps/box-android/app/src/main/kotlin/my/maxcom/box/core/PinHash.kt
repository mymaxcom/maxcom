package my.maxcom.box.core

import java.security.MessageDigest
import java.security.SecureRandom
import java.util.Base64
import javax.crypto.SecretKeyFactory
import javax.crypto.spec.PBEKeySpec

/**
 * Maintenance PIN storage: `pbkdf2-sha256;<rounds>;<salt b64>;<hash b64>`. A new PIN is 6 to 8 digits; an older 4 or 5 digit PIN still verifies until it is changed.
 * The stored value is the only thing kept; the PIN itself is never written anywhere.
 */
object PinHash {
    const val ROUNDS = 100_000
    private const val SALT_BYTES = 16
    private const val HASH_BITS = 256
    private const val PREFIX = "pbkdf2-sha256"
    private const val SEP = ";"

    const val MIN_DIGITS = 6
    private const val LEGACY_MIN_DIGITS = 4
    private const val MAX_DIGITS = 8

    /** A PIN that may be set now: 6 to 8 digits. */
    fun isValidPin(pin: String): Boolean = pin.length in MIN_DIGITS..MAX_DIGITS && pin.all { it in '0'..'9' }

    private fun isAcceptedForVerify(pin: String): Boolean =
        pin.length in LEGACY_MIN_DIGITS..MAX_DIGITS && pin.all { it in '0'..'9' }

    /** The stored form of [pin]; throws [IllegalArgumentException] when [pin] is not 6 to 8 digits. */
    fun make(pin: String, random: SecureRandom = SecureRandom()): String {
        require(isValidPin(pin)) { "PIN must be 6 to 8 digits" }
        return makeUnchecked(pin, random)
    }

    /** Test hook for a stored PIN made before the 6 digit minimum. */
    internal fun makeLegacy(pin: String): String {
        require(isAcceptedForVerify(pin)) { "bad legacy PIN" }
        return makeUnchecked(pin, SecureRandom())
    }

    private fun makeUnchecked(pin: String, random: SecureRandom): String {
        val salt = ByteArray(SALT_BYTES).also { random.nextBytes(it) }
        val hash = derive(pin, salt, ROUNDS)
        val b64 = Base64.getEncoder()
        return listOf(PREFIX, ROUNDS.toString(), b64.encodeToString(salt), b64.encodeToString(hash)).joinToString(SEP)
    }

    /** True only for a well-formed [stored] value made from [pin]; anything malformed is false, never an error. */
    fun verify(pin: String, stored: String): Boolean {
        if (!isAcceptedForVerify(pin)) return false
        val parts = stored.trim().split(SEP)
        if (parts.size != 4 || parts[0] != PREFIX) return false
        val rounds = parts[1].toIntOrNull() ?: return false
        if (rounds < 1_000 || rounds > 10_000_000) return false
        val salt: ByteArray
        val want: ByteArray
        try {
            salt = Base64.getDecoder().decode(parts[2])
            want = Base64.getDecoder().decode(parts[3])
        } catch (_: IllegalArgumentException) {
            return false
        }
        if (salt.size < 8 || want.size != HASH_BITS / 8) return false
        return MessageDigest.isEqual(derive(pin, salt, rounds), want)
    }

    private fun derive(pin: String, salt: ByteArray, rounds: Int): ByteArray {
        val spec = PBEKeySpec(pin.toCharArray(), salt, rounds, HASH_BITS)
        try {
            return SecretKeyFactory.getInstance("PBKDF2WithHmacSHA256").generateSecret(spec).encoded
        } finally {
            spec.clearPassword()
        }
    }
}

/**
 * Wrong-PIN counter state. [lockedUntilMs] is on the monotonic clock (SystemClock.elapsedRealtime), which a
 * wrong wall clock cannot shorten; [bootId] says which boot that clock belongs to.
 */
data class LockState(val failures: Int = 0, val lockedUntilMs: Long = 0L, val bootId: Long = 0L)

/** Five wrong tries lock the PIN screen for five minutes. Pure: the caller keeps the state. */
object Lockout {
    const val MAX_TRIES = 5
    const val LOCK_MS = 5L * 60 * 1000

    fun isLocked(s: LockState, nowMs: Long): Boolean = nowMs < s.lockedUntilMs

    fun remainingMs(s: LockState, nowMs: Long): Long = maxOf(0L, s.lockedUntilMs - nowMs)

    fun onWrong(s: LockState, nowMs: Long, bootId: Long = s.bootId): LockState {
        if (isLocked(s, nowMs)) return s
        val n = s.failures + 1
        return if (n >= MAX_TRIES) LockState(0, nowMs + LOCK_MS, bootId) else LockState(n, 0L, bootId)
    }

    /**
     * Brings a stored state onto the current boot before it is read. A lock made in an earlier boot cannot be
     * measured (the monotonic clock restarted), so it starts again in full: a reboot never shortens it. A lock
     * that already ended in this boot is cleared. [nowMs] is the monotonic clock now.
     */
    fun rebase(s: LockState, nowMs: Long, bootId: Long): LockState = when {
        s.lockedUntilMs == 0L -> s.copy(bootId = bootId)
        s.bootId != bootId -> LockState(s.failures, nowMs + LOCK_MS, bootId)
        nowMs >= s.lockedUntilMs -> LockState(s.failures, 0L, bootId)
        else -> s
    }

    fun onSuccess(): LockState = LockState()
}
