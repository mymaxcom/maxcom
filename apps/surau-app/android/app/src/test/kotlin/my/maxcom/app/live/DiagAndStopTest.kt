package my.maxcom.app.live

import java.util.concurrent.Executors
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class DiagAndStopTest {
    @Test
    fun ringCapsAtTwoHundredAndKeepsTheNewest() {
        val ring = DiagRing()
        for (i in 1..350) ring.add(1_000L * i, "tick", "n=$i")
        val lines = ring.snapshot()
        assertEquals(200, lines.size)
        assertTrue(lines.first().endsWith("n=151"))
        assertTrue(lines.last().endsWith("n=350"))
    }

    @Test
    fun lineIsIsoTimeEventFacts() {
        val l = DiagRing.line(0L, "Stop_Begin", "live=true")
        assertEquals("1970-01-01T00:00:00.000Z stop_begin live=true", l)
    }

    @Test
    fun noLineCarriesAUrlOrASecret() {
        val ring = DiagRing()
        val bad = listOf(
            "srt://host:9000?streamid=abc", "rtmps://a.rtmp.youtube.com/live2/xxxx",
            "passphrase=hunter2", "StreamId=live/1", "token=abc",
        )
        for (b in bad) ring.add(0L, "start", b)
        for (l in ring.snapshot()) {
            val low = l.lowercase()
            assertFalse(low.contains("srt://"))
            assertFalse(low.contains("rtmps://"))
            assertFalse(low.contains("passphrase"))
            assertFalse(low.contains("streamid"))
            assertTrue(low.endsWith("redacted"))
        }
    }

    @Test
    fun recorderStopsBeforeOutputsAndOutputsBeforeRelease() {
        val order = java.util.Collections.synchronizedList(mutableListOf<String>())
        val ex = Executors.newSingleThreadExecutor()
        val ok = StopSequence.run(
            stopRecord = { order.add("record") },
            stopOutputs = { order.add("outputs") },
            release = { order.add("release") },
            timeoutMs = 2_000, recordExecutor = ex, log = { _, _ -> },
        )
        ex.shutdownNow()
        assertTrue(ok)
        assertEquals(listOf("record", "outputs", "release"), order)
    }

    @Test
    fun aHungRecorderTimesOutAndTheRestStillRuns() {
        val order = java.util.Collections.synchronizedList(mutableListOf<String>())
        val events = mutableListOf<String>()
        val ex = Executors.newSingleThreadExecutor()
        val t0 = System.currentTimeMillis()
        val ok = StopSequence.run(
            stopRecord = { try { Thread.sleep(5_000) } catch (_: InterruptedException) {} },
            stopOutputs = { order.add("outputs") },
            release = { order.add("release") },
            timeoutMs = 150, recordExecutor = ex, log = { e, _ -> events.add(e) },
        )
        ex.shutdownNow()
        assertFalse(ok)
        assertTrue(System.currentTimeMillis() - t0 < 2_000)
        assertEquals(listOf("outputs", "release"), order)
        assertTrue(events.contains("stop_record_timeout"))
    }

    @Test
    fun aThrowingRecorderDoesNotBlockTheRest() {
        val order = mutableListOf<String>()
        val ex = Executors.newSingleThreadExecutor()
        val ok = StopSequence.run(
            stopRecord = { throw IllegalStateException("x") },
            stopOutputs = { order.add("outputs") },
            release = { order.add("release") },
            timeoutMs = 1_000, recordExecutor = ex, log = { _, _ -> },
        )
        ex.shutdownNow()
        assertFalse(ok)
        assertEquals(listOf("outputs", "release"), order)
    }
}
