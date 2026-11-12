package my.maxcom.box.core

/**
 * Restart delay after a child exit. Same table as `nextDelayMs` in launcher.mjs (75 restarts at once,
 * anything else waits 5 s) plus the growing steps of the Android plan: after 5 failing exits in a row
 * the wait grows 5, 10, 20, 40, 60 s.
 *
 * "In a row" means the gap between two neighbouring exits is at most [WINDOW_MS] (120 s). The window is
 * applied between exits (and from the newest exit to `now`), so the 60 s steps keep the streak alive
 * instead of dropping it. A run longer than [RESET_RUN_MS] (10 min) resets the streak; the caller
 * clears its list (see [Supervisor]); a run longer than the window breaks the streak by itself.
 */
object Backoff {
    const val RESTART_NOW_EXIT = 75
    const val APK_WAITING_EXIT = 76
    const val BASE_DELAY_MS = 5_000L
    const val WINDOW_MS = 120_000L
    const val RESET_RUN_MS = 10 * 60_000L
    const val FAILING_STREAK = 5
    val STEPS_MS = longArrayOf(5_000, 10_000, 20_000, 40_000, 60_000)

    /** Exits in the failing streak ending at the newest entry of [recentExits] (times in ms, oldest first). */
    fun streak(recentExits: List<Long>, now: Long): Int {
        if (recentExits.isEmpty()) return 0
        var count = 1
        var newer = recentExits.last()
        if (now - newer > WINDOW_MS) return 0
        for (i in recentExits.size - 2 downTo 0) {
            val older = recentExits[i]
            if (newer - older > WINDOW_MS) break
            count++
            newer = older
        }
        return count
    }

    /** [recentExits] holds the failing exits so far including the one that just happened. */
    fun nextDelayMs(exitCode: Int, recentExits: List<Long>, now: Long): Long {
        if (exitCode == RESTART_NOW_EXIT || exitCode == APK_WAITING_EXIT) return 0
        val n = streak(recentExits, now)
        if (n < FAILING_STREAK) return BASE_DELAY_MS
        return STEPS_MS[minOf(n - FAILING_STREAK, STEPS_MS.size - 1)]
    }

    fun isFailing(recentExits: List<Long>, now: Long): Boolean = streak(recentExits, now) >= FAILING_STREAK
}
