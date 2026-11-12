package my.maxcom.box

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class BoxStateTest {
    private val tokenA = "a".repeat(64)
    private val tokenB = "b".repeat(64)

    private fun run(vararg events: BoxEvent): BoxSnapshot =
        events.fold(BoxReducer.INITIAL) { s, e -> BoxReducer.reduce(s, e) }

    @Test
    fun stepsFollowEachOtherAndEndRunning() {
        val s1 = run(BoxEvent.ServiceStarted(tokenA), BoxEvent.Step("Membuka keluaran", 1, 4))
        assertEquals(BoxStatus.Preparing("Membuka keluaran", 1, 4), s1.status)
        val s2 = BoxReducer.reduce(s1, BoxEvent.Step("Menyusun pustaka", 2, 4))
        assertEquals(BoxStatus.Preparing("Menyusun pustaka", 2, 4), s2.status)
        val s3 = BoxReducer.reduce(s2, BoxEvent.ClockWait)
        assertEquals(BoxStatus.WaitingClock, s3.status)
        val s4 = BoxReducer.reduce(s3, BoxEvent.ServerStarting)
        assertEquals(BoxStatus.Starting, s4.status)
        val s5 = BoxReducer.reduce(s4, BoxEvent.ServerRunning)
        assertEquals(BoxStatus.Running, s5.status)
        assertEquals(tokenA, s5.kioskToken)
        assertEquals(8787, s5.port)
    }

    @Test
    fun failureInReleaseStepShowsFailingWithMessage() {
        val s = run(
            BoxEvent.ServiceStarted(tokenA),
            BoxEvent.Step("Membuka keluaran", 1, 4),
            BoxEvent.Failed(listOf("GAGAL: keluaran MAXCOM tidak dapat dibuka atau gagal disemak.")),
        )
        val st = s.status as BoxStatus.Failing
        assertEquals("GAGAL: keluaran MAXCOM tidak dapat dibuka atau gagal disemak.", st.lines.single())
    }

    @Test
    fun failingKeepsOnlyTheLastTwentyLines() {
        val lines = (1..50).map { "line $it" }
        val st = run(BoxEvent.Failed(lines)).status as BoxStatus.Failing
        assertEquals(20, st.lines.size)
        assertEquals("line 50", st.lines.last())
    }

    @Test
    fun tokenIsReplacedAtEveryStart() {
        val first = run(BoxEvent.ServiceStarted(tokenA), BoxEvent.ServerRunning)
        val second = BoxReducer.reduce(first, BoxEvent.ServiceStarted(tokenB))
        assertEquals(tokenB, second.kioskToken)
        assertNotEquals(first.kioskToken, second.kioskToken)
        assertTrue(second.status is BoxStatus.Preparing)
    }

    @Test
    fun stoppedClearsTheToken() {
        val s = run(BoxEvent.ServiceStarted(tokenA), BoxEvent.ServerRunning, BoxEvent.ServiceStopped)
        assertEquals(BoxStatus.Idle, s.status)
        assertNull(s.kioskToken)
    }

    @Test
    fun toStringNeverHoldsTheToken() {
        val s = run(BoxEvent.ServiceStarted(tokenA))
        assertFalse(s.toString().contains(tokenA))
        assertFalse(s.toString().contains("aaaa"))
        assertTrue(s.toString().contains("token=set"))
    }
}
