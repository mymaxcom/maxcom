package my.maxcom.box.core

/**
 * Detects a key sequence typed within [windowMs] of its first key. [onKey] returns true once, on the
 * key that completes the sequence; a wrong key or a slow sequence starts over. Not thread-safe:
 * call it from the main thread.
 */
class KeyCombo(private val sequence: List<Int>, private val windowMs: Long = 10_000L) {
    private var index = 0
    private var startedAt = 0L

    init {
        require(sequence.isNotEmpty()) { "empty sequence" }
    }

    fun onKey(code: Int, now: Long): Boolean {
        if (index > 0 && now - startedAt > windowMs) index = 0
        if (code == sequence[index]) {
            if (index == 0) startedAt = now
            index++
            if (index == sequence.size) {
                index = 0
                return true
            }
            return false
        }
        // A wrong key may itself be the start of a new attempt.
        index = 0
        if (code == sequence[0]) {
            startedAt = now
            index = 1
            if (sequence.size == 1) {
                index = 0
                return true
            }
        }
        return false
    }
}
