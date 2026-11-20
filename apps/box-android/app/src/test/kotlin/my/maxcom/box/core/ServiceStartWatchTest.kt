package my.maxcom.box.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class ServiceStartWatchTest {
    @Test
    fun disarmedWatchNeverAsksAndNeverShowsTheMessage() {
        val w = ServiceStartWatch()
        assertFalse(w.armed)
        assertFalse(w.retryDue(1_000_000))
        assertFalse(w.messageDue(1_000_000))
    }

    @Test
    fun firstRetryAfterFiveSecondsThenEveryFifteen() {
        val w = ServiceStartWatch()
        w.arm(100_000)
        assertFalse(w.retryDue(100_000))
        assertFalse(w.retryDue(104_999))
        assertTrue(w.retryDue(105_000))
        w.tried(105_000)
        assertFalse(w.retryDue(105_001))
        assertFalse(w.retryDue(119_999))
        assertTrue(w.retryDue(120_000))
        w.tried(120_000)
        assertFalse(w.retryDue(134_999))
        assertTrue(w.retryDue(135_000))
        assertEquals(2, w.retryCount)
    }

    @Test
    fun aLateTickStillAsksOnceAndTheNextRetryCountsFromThatTry() {
        val w = ServiceStartWatch()
        w.arm(0)
        assertTrue(w.retryDue(9_000)) // the tick was late
        w.tried(9_000)
        assertFalse(w.retryDue(23_999))
        assertTrue(w.retryDue(24_000))
    }

    @Test
    fun messageAppearsAfterAboutAMinuteAndRetriesContinueUnderIt() {
        val w = ServiceStartWatch()
        w.arm(0)
        assertFalse(w.messageDue(59_999))
        assertTrue(w.messageDue(60_000))
        w.tried(60_000)
        assertTrue(w.messageDue(61_000))
        assertTrue(w.retryDue(75_000))
    }

    @Test
    fun armingAgainKeepsTheOriginalStart() {
        val w = ServiceStartWatch()
        w.arm(1_000)
        w.arm(50_000) // a second render while still silent
        assertTrue(w.retryDue(6_000))
        assertTrue(w.messageDue(61_000))
    }

    @Test
    fun disarmStopsEverythingAndAFreshArmStartsOver() {
        val w = ServiceStartWatch()
        w.arm(0)
        w.tried(5_000)
        assertTrue(w.messageDue(70_000))
        w.disarm() // the service reported
        assertFalse(w.armed)
        assertFalse(w.retryDue(500_000))
        assertFalse(w.messageDue(500_000))
        assertEquals(0, w.retryCount)
        w.arm(500_000)
        assertFalse(w.retryDue(504_999))
        assertTrue(w.retryDue(505_000))
        assertFalse(w.messageDue(559_999))
    }

    @Test
    fun theTimeoutsAreTheAgreedOnes() {
        assertEquals(5_000L, ServiceStartWatch.FIRST_RETRY_MS)
        assertEquals(15_000L, ServiceStartWatch.RETRY_EVERY_MS)
        assertEquals(60_000L, ServiceStartWatch.MESSAGE_AFTER_MS)
    }
}
