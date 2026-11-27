package my.maxcom.box.core

import org.junit.Assert.assertEquals
import org.junit.Test

class VideoRecoveryTest {
    private val min = 60_000L
    private val hour = 60 * min

    @Test
    fun constants() {
        assertEquals(10 * min, VideoRecovery.ESCALATE_WINDOW_MS)
        assertEquals(15_000L, VideoRecovery.ESCALATE_MIN_MS)
        assertEquals(6 * hour, VideoRecovery.APP_MIN_GAP_MS)
    }

    @Test
    fun firstReportRestartsTheRenderer() {
        assertEquals(VideoRecovery.Action.RestartRenderer, VideoRecovery(0L).onStuck(5_000L))
    }

    @Test
    fun aReportRightAfterARendererRestartRestartsTheApp() {
        val r = VideoRecovery(0L)
        assertEquals(VideoRecovery.Action.RestartRenderer, r.onStuck(1_000_000L))
        assertEquals(VideoRecovery.Action.RestartApp, r.onStuck(1_000_000L + 3 * min))
    }

    @Test
    fun aReportSoonAfterTheRestartIsIgnoredThenEscalates() {
        val r = VideoRecovery(0L)
        assertEquals(VideoRecovery.Action.RestartRenderer, r.onStuck(1_000_000L))
        assertEquals(VideoRecovery.Action.Ignore, r.onStuck(1_000_000L + 5_000L))
        assertEquals(VideoRecovery.Action.Ignore, r.onStuck(1_000_000L + 15_000L - 1))
        assertEquals(VideoRecovery.Action.RestartApp, r.onStuck(1_000_000L + 15_000L))
    }

    @Test
    fun aReportThirtySecondsAfterTheRestartRestartsTheApp() {
        val r = VideoRecovery(0L)
        r.onStuck(1_000_000L)
        assertEquals(VideoRecovery.Action.RestartApp, r.onStuck(1_000_000L + 30_000L))
    }

    @Test
    fun aRefusedAppRestartDoesNotMoveTheRendererTime() {
        val now = 100 * hour
        val r = VideoRecovery(now - hour)
        assertEquals(VideoRecovery.Action.RestartRenderer, r.onStuck(now))
        assertEquals(VideoRecovery.Action.Ignore, r.onStuck(now + 30_000L))
        assertEquals(VideoRecovery.Action.Ignore, r.onStuck(now + 5 * min))
        assertEquals(now - hour, r.lastAppRestartMs)
        // After the window it is a fresh renderer restart, and the timer was not moved by the refusals.
        assertEquals(VideoRecovery.Action.RestartRenderer, r.onStuck(now + VideoRecovery.ESCALATE_WINDOW_MS + 1))
    }

    @Test
    fun aReportLongAfterTheRendererRestartStartsOverWithTheRenderer() {
        val r = VideoRecovery(0L)
        assertEquals(VideoRecovery.Action.RestartRenderer, r.onStuck(1_000_000L))
        val later = 1_000_000L + VideoRecovery.ESCALATE_WINDOW_MS + 1
        assertEquals(VideoRecovery.Action.RestartRenderer, r.onStuck(later))
    }

    @Test
    fun theEscalationWindowEdge() {
        val r = VideoRecovery(0L)
        r.onStuck(1_000_000L)
        // Exactly at the window end still counts as "within".
        assertEquals(VideoRecovery.Action.RestartApp, r.onStuck(1_000_000L + VideoRecovery.ESCALATE_WINDOW_MS))
    }

    @Test
    fun theAppIsRestartedAtMostOnceEverySixHours() {
        val now = 100 * hour
        val r = VideoRecovery(0L)
        assertEquals(VideoRecovery.Action.RestartRenderer, r.onStuck(now))
        assertEquals(VideoRecovery.Action.RestartApp, r.onStuck(now + 3 * min))
        // After the app restart the policy object is new (the process is new) but remembers the time.
        val after = VideoRecovery(1_000_000_000L)
        val t = 1_000_000_000L + hour
        assertEquals(VideoRecovery.Action.RestartRenderer, after.onStuck(t))
        assertEquals(VideoRecovery.Action.Ignore, after.onStuck(t + 3 * min))
    }

    @Test
    fun aClockThatWentBackwardStartsOverWithTheRenderer() {
        val r = VideoRecovery(0L)
        assertEquals(VideoRecovery.Action.RestartRenderer, r.onStuck(10 * hour))
        assertEquals(VideoRecovery.Action.RestartRenderer, r.onStuck(5 * hour))
    }

    @Test
    fun theAppRestartIsAllowedAgainAfterTheGap() {
        val stored = 50 * hour
        val r = VideoRecovery(stored)
        val t = stored + VideoRecovery.APP_MIN_GAP_MS
        assertEquals(VideoRecovery.Action.RestartRenderer, r.onStuck(t))
        assertEquals(VideoRecovery.Action.RestartApp, r.onStuck(t + 3 * min))
    }

    @Test
    fun justInsideTheAppGapIsIgnored() {
        val stored = 50 * hour
        val r = VideoRecovery(stored)
        val t = stored + VideoRecovery.APP_MIN_GAP_MS - 10 * min
        assertEquals(VideoRecovery.Action.RestartRenderer, r.onStuck(t))
        assertEquals(VideoRecovery.Action.Ignore, r.onStuck(t + 3 * min))
    }

    @Test
    fun theAppRestartTimeIsExposedAfterRestartApp() {
        val r = VideoRecovery(0L)
        r.onStuck(1_000_000L)
        assertEquals(VideoRecovery.Action.RestartApp, r.onStuck(1_000_000L + 3 * min))
        assertEquals(0L, r.lastAppRestartMs)
        r.appRestarted(1_000_000L + 3 * min)
        assertEquals(1_000_000L + 3 * min, r.lastAppRestartMs)
    }

    @Test
    fun aStoredTimeInTheFutureCountsAsJustRestarted() {
        val now = 10 * hour
        val r = VideoRecovery(now + 10 * hour)
        assertEquals(VideoRecovery.Action.RestartRenderer, r.onStuck(now))
        assertEquals(VideoRecovery.Action.Ignore, r.onStuck(now + 3 * min))
    }

    @Test
    fun aDeclinedAppRestartDoesNotUseUpTheAllowance() {
        val now = 100 * hour
        val r = VideoRecovery(0L)
        assertEquals(VideoRecovery.Action.RestartRenderer, r.onStuck(now))
        // The caller declines each time (no stamp): the policy keeps answering RestartApp, never anything worse.
        assertEquals(VideoRecovery.Action.RestartApp, r.onStuck(now + 30_000L))
        assertEquals(VideoRecovery.Action.RestartApp, r.onStuck(now + 2 * min))
        assertEquals(0L, r.lastAppRestartMs)
        // Once the caller confirms, the limit holds.
        r.appRestarted(now + 3 * min)
        assertEquals(VideoRecovery.Action.Ignore, r.onStuck(now + 4 * min))
    }

    @Test
    fun theAppIsEndedOnlyAsDefaultHomeWithTheRelaunchArmed() {
        assertEquals(true, VideoRecovery.mayRestartApp(isDefaultHome = true, relaunchArmed = true))
        assertEquals(false, VideoRecovery.mayRestartApp(isDefaultHome = true, relaunchArmed = false))
        assertEquals(false, VideoRecovery.mayRestartApp(isDefaultHome = false, relaunchArmed = true))
        assertEquals(false, VideoRecovery.mayRestartApp(isDefaultHome = false, relaunchArmed = false))
    }

    @Test
    fun neverIsZeroOrNegative() {
        for (stored in listOf(0L, -5L)) {
            val r = VideoRecovery(stored)
            assertEquals(VideoRecovery.Action.RestartRenderer, r.onStuck(1_000L))
            assertEquals(VideoRecovery.Action.RestartApp, r.onStuck(1_000L + 3 * min))
        }
    }
}
