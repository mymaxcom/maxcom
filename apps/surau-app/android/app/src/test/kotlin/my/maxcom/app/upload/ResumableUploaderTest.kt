package my.maxcom.app.upload

import java.io.IOException
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/** The Kotlin twin of test/upload/resumable_client_test.dart: same protocol, same answers. */
class ResumableUploaderTest {
    private val uri = "https://upload.example/session/abc"
    private val mb8 = 8L * 1024 * 1024

    private class Script(private val answers: MutableList<Any>) : PutTransport {
        val seen = ArrayList<Pair<String, Int>>() // content-range, body length
        override fun put(uri: String, contentRange: String, body: ByteArray): PutResponse {
            seen.add(contentRange to body.size)
            check(answers.isNotEmpty()) { "unscripted request" }
            return when (val a = answers.removeAt(0)) {
                is PutResponse -> a
                is IOException -> throw a
                else -> error("bad script")
            }
        }
    }

    private fun r308(range: String? = null) = PutResponse(308, range, "")
    private fun done(id: String) = PutResponse(200, null, """{"kind":"youtube#video","id":"$id"}""")
    private fun err(status: Int, reason: String = "") =
        PutResponse(status, null, """{"error":{"code":$status,"errors":[{"reason":"$reason"}]}}""")

    private fun uploader(s: Script, slept: MutableList<Long> = ArrayList(), chunk: Long = mb8) =
        ResumableUploader(s, chunkBytes = chunk, sleep = { slept.add(it) })

    /** A source that only reports a length (reads are never looked at). */
    private class FakeSource(override val length: Long) : ByteSource {
        override fun read(start: Long, endExclusive: Long) = ByteArray((endExclusive - start).toInt())
    }

    @Test
    fun firstPutCarriesTheContentRangeOfTheFirstChunk() {
        val total = 20L * 1024 * 1024
        val s = Script(mutableListOf(r308("bytes=0-${mb8 - 1}"), r308("bytes=0-${2 * mb8 - 1}"), done("vid1")))
        val out = uploader(s).upload(uri, FakeSource(total))
        assertEquals("bytes 0-${mb8 - 1}/$total", s.seen[0].first)
        assertEquals(mb8.toInt(), s.seen[0].second)
        assertEquals("bytes $mb8-${2 * mb8 - 1}/$total", s.seen[1].first)
        assertEquals("bytes ${2 * mb8}-${total - 1}/$total", s.seen[2].first)
        assertEquals(UploadResult.Complete("vid1"), out)
    }

    @Test
    fun a308ContinuesAfterTheLastReceivedByte() {
        val total = 3 * mb8
        val s = Script(mutableListOf(r308("bytes=0-99"), r308("bytes=0-${mb8 + 99}"), r308("bytes=0-${total - 1}"), done("v")))
        uploader(s).upload(uri, FakeSource(total))
        assertTrue(s.seen[1].first.startsWith("bytes 100-"))
        assertTrue(s.seen[2].first.startsWith("bytes ${mb8 + 100}-"))
    }

    @Test
    fun probeAsksStarSlashTotalWithAnEmptyBody() {
        val s = Script(mutableListOf(r308("bytes=0-4194303")))
        val out = uploader(s).probe(uri, 10_000_000)
        assertEquals("bytes */10000000" to 0, s.seen.single())
        assertEquals(UploadResult.Offset(4194304), out)
    }

    @Test
    fun probeWithNoRangeMeansNothingWasReceived() {
        assertEquals(UploadResult.Offset(0), uploader(Script(mutableListOf(r308()))).probe(uri, 50))
    }

    @Test
    fun afterAnIoErrorItProbesAndResumesFromTheServersOffset() {
        val total = 3 * mb8
        val s = Script(
            mutableListOf(
                r308("bytes=0-${mb8 - 1}"),
                IOException("reset"),
                r308("bytes=0-${mb8 - 1}"), // probe
                r308("bytes=0-${2 * mb8 - 1}"),
                done("after"),
            ),
        )
        val slept = ArrayList<Long>()
        val out = uploader(s, slept).upload(uri, FakeSource(total))
        assertEquals(listOf(5_000L), slept)
        assertEquals("bytes */$total", s.seen[2].first)
        assertEquals("bytes $mb8-${2 * mb8 - 1}/$total", s.seen[3].first)
        assertEquals(UploadResult.Complete("after"), out)
    }

    @Test
    fun a404AndA410AreSessionLost() {
        for (code in listOf(404, 410)) {
            assertEquals(UploadResult.SessionLost, uploader(Script(mutableListOf(err(code)))).upload(uri, FakeSource(100)))
        }
        assertEquals(UploadResult.SessionLost, uploader(Script(mutableListOf(err(410)))).probe(uri, 100))
    }

    @Test
    fun a403QuotaReasonIsQuotaAndAnotherIsARefusal() {
        for (reason in listOf("uploadLimitExceeded", "quotaExceeded")) {
            assertEquals(UploadResult.Quota(reason), uploader(Script(mutableListOf(err(403, reason)))).upload(uri, FakeSource(100)))
        }
        val s = Script(mutableListOf(err(403, "forbidden")))
        assertEquals(UploadResult.Rejected(403, "forbidden"), uploader(s).upload(uri, FakeSource(100)))
        assertEquals(1, s.seen.size)
    }

    @Test
    fun a201WithTheVideoJsonFinishes() {
        val s = Script(mutableListOf(PutResponse(201, null, """{"id":"abc123"}""")))
        assertEquals(UploadResult.Complete("abc123"), uploader(s).upload(uri, FakeSource(100)))
    }

    @Test
    fun fiveXxWaitsFiveSecondsThenFifteenThenSixtyThenFiveMinutes() {
        val s = Script(mutableListOf(err(503), err(500), err(502), err(503), err(503), r308(), done("late")))
        val slept = ArrayList<Long>()
        val out = uploader(s, slept).upload(uri, FakeSource(100))
        assertEquals(listOf(5_000L, 15_000L, 60_000L, 300_000L, 300_000L), slept)
        assertEquals(UploadResult.Complete("late"), out)
    }

    @Test
    fun shouldStopEndsTheLoopAtTheOffsetReached() {
        val s = Script(mutableListOf(r308("bytes=0-${mb8 - 1}")))
        var calls = 0
        val out = uploader(s).upload(uri, FakeSource(3 * mb8), shouldStop = { ++calls > 1 })
        assertEquals(UploadResult.Stopped(mb8), out)
    }

    @Test
    fun resumingFromAnOffsetStartsTheRangeThere() {
        val s = Script(mutableListOf(done("v")))
        uploader(s).upload(uri, FakeSource(1000), offset = 600)
        assertEquals("bytes 600-999/1000" to 400, s.seen.single())
    }
}
