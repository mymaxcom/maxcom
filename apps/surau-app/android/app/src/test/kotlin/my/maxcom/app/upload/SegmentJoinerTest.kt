package my.maxcom.app.upload

import java.nio.ByteBuffer
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

/**
 * The join logic (timestamps shifted by the running duration, no re-encode) is tested on synthetic
 * samples through [SegmentSource]/[JoinSink]. The MediaExtractor/MediaMuxer plumbing around it is
 * Android framework code that a plain JVM test cannot run (Robolectric is not part of this
 * project); it is proven on the vivo in Task 12.
 */
class SegmentJoinerTest {
    private val frameUs = 33_333L

    /** A segment of [videoFrames] video samples and the same span of audio, one sample per frame. */
    private class FakeSegment(
        videoFrames: Int,
        private val frameUs: Long,
        mimes: List<String> = listOf("video/avc", "audio/mp4a-latm"),
    ) : SegmentSource {
        override val tracks: List<Pair<String, Any?>> = mimes.map { it to null }
        private val samples = ArrayDeque<JoinSample>()
        var closed = false

        init {
            // Decode order: video, then audio, interleaved by time.
            val all = ArrayList<JoinSample>()
            for (i in 0 until videoFrames) all.add(JoinSample(0, i * frameUs, if (i == 0) 1 else 0, 100))
            if (mimes.size > 1) {
                val span = videoFrames * frameUs
                var t = 0L
                while (t < span) { all.add(JoinSample(1, t, 0, 20)); t += frameUs }
            }
            samples.addAll(all.sortedBy { it.ptsUs })
        }

        override fun next(buf: ByteBuffer): JoinSample? = samples.removeFirstOrNull()
        override fun close() { closed = true }
    }

    private class RecordingSink : JoinSink {
        val mimes = ArrayList<String>()
        val written = ArrayList<Triple<Int, Long, Int>>() // track, pts, flags
        var started = false
        var stopped = false
        override fun addTrack(mime: String, format: Any?): Int { mimes.add(mime); return mimes.size - 1 }
        override fun start() { started = true }
        override fun write(track: Int, buf: ByteBuffer, size: Int, ptsUs: Long, flags: Int) {
            written.add(Triple(track, ptsUs, flags))
        }
        override fun stop() { stopped = true }
    }

    @Test
    fun theJoinedDurationIsTheSumOfTheSegments() {
        val sink = RecordingSink()
        val total = JoinCore.join(listOf(FakeSegment(30, frameUs), FakeSegment(45, frameUs)), sink)
        assertEquals(75 * frameUs, total)
        assertTrue(sink.started && sink.stopped)
        assertEquals(listOf("video/avc", "audio/mp4a-latm"), sink.mimes)
    }

    @Test
    fun theSecondSegmentIsShiftedByTheFirstOnesDuration() {
        val sink = RecordingSink()
        JoinCore.join(listOf(FakeSegment(30, frameUs), FakeSegment(30, frameUs)), sink)
        val video = sink.written.filter { it.first == 0 }.map { it.second }
        assertEquals(60, video.size)
        assertEquals(0L, video[0])
        assertEquals(30 * frameUs, video[30])
        assertEquals(59 * frameUs, video[59])
        // Never goes backwards inside a track.
        assertEquals(video.sorted(), video)
        val audio = sink.written.filter { it.first == 1 }.map { it.second }
        assertEquals(audio.sorted(), audio)
    }

    @Test
    fun flagsAreCopiedAndNothingIsReEncoded() {
        val sink = RecordingSink()
        JoinCore.join(listOf(FakeSegment(3, frameUs)), sink)
        // The first video sample is a sync frame (flag 1) and stays one.
        assertEquals(1, sink.written.first { it.first == 0 }.third)
    }

    @Test
    fun everySourceIsClosed() {
        val a = FakeSegment(5, frameUs)
        val b = FakeSegment(5, frameUs)
        JoinCore.join(listOf(a, b), RecordingSink())
        assertTrue(a.closed && b.closed)
    }

    @Test
    fun segmentsWithDifferentTracksAreRefused() {
        val a = FakeSegment(5, frameUs)
        val b = FakeSegment(5, frameUs, mimes = listOf("video/avc"))
        try {
            JoinCore.join(listOf(a, b), RecordingSink())
            fail("expected JoinMismatch")
        } catch (_: JoinMismatch) {
        }
    }

    @Test
    fun aSingleSegmentJoinsToItself() {
        val sink = RecordingSink()
        val total = JoinCore.join(listOf(FakeSegment(10, frameUs)), sink)
        assertEquals(10 * frameUs, total)
        assertEquals(10, sink.written.count { it.first == 0 })
    }
}
