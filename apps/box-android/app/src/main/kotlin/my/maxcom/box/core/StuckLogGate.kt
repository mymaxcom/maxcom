package my.maxcom.box.core

/**
 * Decides whether the watchdog may log "preparation is stuck": only while a preparation is still running
 * (a failed or finished one is not stuck, it ended), and at most once per stage per [intervalMs].
 */
class StuckLogGate(private val intervalMs: Long = TEN_MINUTES_MS) {
    private var lastStage: String? = null
    private var lastAt = 0L

    @Synchronized
    fun shouldLog(stage: String, preparing: Boolean, nowMs: Long): Boolean {
        if (!preparing) return false
        if (stage == lastStage && nowMs - lastAt < intervalMs) return false
        lastStage = stage
        lastAt = nowMs
        return true
    }

    companion object {
        const val TEN_MINUTES_MS = 10L * 60 * 1000
    }
}
