package my.maxcom.box.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** Reads like launcher.test.ts: the contract table first, then the Android growth steps. */
class BackoffTest {
    @Test
    fun contractTableExitCodeAndWait() {
        val table = listOf(
            75 to 0L,
            76 to 0L, // reserved: an APK is waiting, handled as 75 today
            0 to 5000L,
            1 to 5000L,
            2 to 5000L,
            137 to 5000L,
            -1 to 5000L,
        )
        for ((code, wait) in table) {
            assertEquals("exit $code", wait, Backoff.nextDelayMs(code, listOf(1_000L), 1_000L))
        }
    }

    @Test
    fun exit75IsImmediateEvenInsideAFailingStreak() {
        val exits = (0 until 8).map { it * 6_000L }
        assertEquals(0L, Backoff.nextDelayMs(75, exits, exits.last()))
    }

    @Test
    fun fiveExitsInARowGiveTheGrowingSteps() {
        val exits = ArrayList<Long>()
        val delays = ArrayList<Long>()
        var now = 0L
        repeat(9) {
            now += 3_000
            exits.add(now)
            val d = Backoff.nextDelayMs(1, exits, now)
            delays.add(d)
            now += d // the wait itself passes before the next exit
        }
        assertEquals(listOf(5000L, 5000, 5000, 5000, 5000, 10000, 20000, 40000, 60000), delays)
        // the step stays at 60 s afterwards
        now += 3_000
        exits.add(now)
        assertEquals(60_000L, Backoff.nextDelayMs(1, exits, now))
    }

    @Test
    fun failingStartsAtTheFifthExit() {
        val four = listOf(0L, 10_000, 20_000, 30_000)
        assertFalse(Backoff.isFailing(four, 30_000))
        assertTrue(Backoff.isFailing(four + 40_000L, 40_000))
    }

    @Test
    fun aGapOverTheWindowBreaksTheStreak() {
        val exits = listOf(0L, 1_000, 2_000, 3_000, 3_000 + 120_001L)
        assertEquals(1, Backoff.streak(exits, exits.last()))
        assertEquals(5000L, Backoff.nextDelayMs(1, exits, exits.last()))
    }

    @Test
    fun anOldStreakDoesNotCountForNow() {
        assertEquals(0, Backoff.streak(listOf(0L, 1_000L), 1_000L + 120_001L))
    }

    @Test
    fun noExitsMeansNoStreak() {
        assertEquals(0, Backoff.streak(emptyList(), 5L))
        assertEquals(5000L, Backoff.nextDelayMs(1, emptyList(), 5L))
    }
}
