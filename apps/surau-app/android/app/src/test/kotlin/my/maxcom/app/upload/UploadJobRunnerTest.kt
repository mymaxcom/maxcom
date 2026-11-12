package my.maxcom.app.upload

import java.io.IOException
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** The Kotlin twin of test/upload/upload_loop_test.dart. */
class UploadJobRunnerTest {
    private class FakeCloud : CloudApi {
        val begins = ArrayList<List<Any?>>() // kuliahId, partIndex, partCount, bytes, replace
        val dones = ArrayList<Pair<String, String>>()
        var beginError: Exception? = null
        var doneError: Exception? = null
        var n = 0

        override fun begin(kuliahId: String?, partIndex: Int?, partCount: Int?, bytes: Long, replaceLiveVideoId: String?): BegunUpload {
            begins.add(listOf(kuliahId, partIndex, partCount, bytes, replaceLiveVideoId))
            beginError?.let { throw it }
            n++
            return BegunUpload("up$n", "https://www.googleapis.com/upload/session/$n")
        }

        override fun done(uploadId: String, videoId: String) {
            doneError?.let { throw it }
            dones.add(uploadId to videoId)
        }

        override fun quotaResetsAt() = "2026-11-07T08:00:00.000Z"
    }

    private class Mem(override val length: Long) : OpenSource {
        override fun read(start: Long, endExclusive: Long) = ByteArray((endExclusive - start).toInt())
        override fun close() {}
    }

    private fun ok(id: String) = PutResponse(200, null, """{"id":"$id"}""")

    private class Puts(val answer: (Int, String) -> PutResponse) : PutTransport {
        var n = 0
        val ranges = ArrayList<String>()
        override fun put(uri: String, contentRange: String, body: ByteArray): PutResponse {
            ranges.add(contentRange)
            return answer(++n, contentRange)
        }
    }

    private fun spec(parts: List<PartSpec>, replace: String? = null) =
        JobSpec("J", "k", parts, joined = false, allowMobile = false, replaceLiveVideoId = replace, joinSegments = false)

    private fun parts(n: Int) = (1..n).map { PartSpec(it, "android:content://v/$it", 100) }

    private class Run(val end: RunEnd, val events: List<UploadEvent>, val store: MemoryStateStore, val cloud: FakeCloud)

    private fun run(
        parts: List<PartSpec>,
        cloud: FakeCloud = FakeCloud(),
        replace: String? = null,
        state: JobState = JobState(),
        put: PutTransport,
    ): Run {
        val events = ArrayList<UploadEvent>()
        val store = MemoryStateStore()
        val up = ResumableUploader(put, sleep = {})
        val r = UploadJobRunner(
            spec = spec(parts, replace), state = state, cloud = cloud, uploader = up,
            openSource = { Mem(100) }, store = store, emit = { events.add(it) }, shouldStop = { false },
        )
        return Run(r.run(parts), events, store, cloud)
    }

    @Test
    fun aSinglePartIsBegunWithoutAPartRefAndDoneIsCalledOnce() {
        val r = run(parts(1), replace = "live1", put = Puts { _, _ -> ok("v1") })
        assertEquals(RunEnd.DONE, r.end)
        assertEquals(listOf("k", null, null, 100L, "live1"), r.cloud.begins.single())
        assertEquals(listOf("up1" to "v1"), r.cloud.dones)
    }

    @Test
    fun onlyTheLastPartCarriesReplaceLiveVideoId() {
        val r = run(parts(2), replace = "live1", put = Puts { _, _ -> ok("v") })
        assertEquals(listOf<Any?>(null, "live1"), r.cloud.begins.map { it[4] })
        assertEquals(listOf<Any?>(1, 2), r.cloud.begins.map { it[1] })
        assertEquals(listOf<Any?>(2, 2), r.cloud.begins.map { it[2] })
    }

    @Test
    fun a410StartsAFreshSessionFromTheCloud() {
        val r = run(parts(1), put = Puts { n, _ -> if (n == 1) PutResponse(410, null, "") else ok("v2") })
        assertEquals(2, r.cloud.begins.size)
        assertEquals(listOf("up2" to "v2"), r.cloud.dones)
        assertTrue(r.events.any { it.clearSession && it.state == "queued" })
    }

    @Test
    fun aSavedSessionIsProbedBeforeSendingAndResumesThere() {
        val st = JobState()
        st.parts[1] = PartState(offset = 10, uploadId = "upX", uploadUri = "https://www.googleapis.com/upload/session/X")
        val puts = Puts { n, _ -> if (n == 1) PutResponse(308, "bytes=0-59", "") else ok("v3") }
        val r = run(parts(1), state = st, put = puts)
        assertTrue(r.cloud.begins.isEmpty())
        assertEquals(listOf("bytes */100", "bytes 60-99/100"), puts.ranges)
        assertEquals(listOf("upX" to "v3"), r.cloud.dones)
    }

    @Test
    fun aMidUploadQuotaAnswerStopsWithTheCloudsResetTime() {
        val quota = PutResponse(403, null, """{"error":{"errors":[{"reason":"uploadLimitExceeded"}]}}""")
        val r = run(parts(2), put = Puts { _, _ -> quota })
        assertEquals(RunEnd.WAIT, r.end)
        val q = r.events.last { it.state == "quota" }
        assertEquals("2026-11-07T08:00:00.000Z", q.resetsAt)
        assertEquals(1, r.cloud.begins.size)
        assertTrue(r.cloud.dones.isEmpty())
    }

    @Test
    fun beginAnsweringYoutubeQuotaStopsWithItsResetsAt() {
        val c = FakeCloud().apply { beginError = CloudQuota("2026-11-07T07:00:00.000Z") }
        val r = run(parts(1), cloud = c, put = Puts { _, _ -> ok("v") })
        assertEquals(RunEnd.WAIT, r.end)
        assertEquals("2026-11-07T07:00:00.000Z", r.events.last().resetsAt)
    }

    @Test
    fun beginAnsweringReauthoriseFailsWithItsCode() {
        val c = FakeCloud().apply { beginError = CloudRefused("youtube_reauthorise") }
        val r = run(parts(1), cloud = c, put = Puts { _, _ -> ok("v") })
        assertEquals(RunEnd.FAILED, r.end)
        assertEquals("failed", r.events.last().state)
        assertEquals("youtube_reauthorise", r.events.last().error)
    }

    @Test
    fun anExpiredSessionIsNeedsUnlockNotARetryLoop() {
        val c = FakeCloud().apply { beginError = CloudNeedsUnlock() }
        val r = run(parts(1), cloud = c, put = Puts { _, _ -> ok("v") })
        assertEquals(RunEnd.FAILED, r.end)
        assertEquals("needs_unlock", r.events.last().error)
    }

    @Test
    fun aNetworkErrorOnBeginRetriesLater() {
        val c = FakeCloud().apply { beginError = IOException("down") }
        val r = run(parts(1), cloud = c, put = Puts { _, _ -> ok("v") })
        assertEquals(RunEnd.RETRY, r.end)
    }

    @Test
    fun ifDoneFailsTheVideoIdIsKeptSoARetryOnlyCallsDone() {
        val c = FakeCloud().apply { doneError = IOException("down") }
        val st = JobState()
        val r1 = run(parts(1), cloud = c, state = st, put = Puts { _, _ -> ok("v9") })
        assertEquals(RunEnd.RETRY, r1.end)
        assertEquals("v9", st.parts[1]!!.videoId)
        assertEquals("v9", r1.store.load("J")!!.parts[1]!!.videoId)

        c.doneError = null
        val puts = Puts { _, _ -> ok("x") }
        val r2 = run(parts(1), cloud = c, state = st, put = puts)
        assertEquals(RunEnd.DONE, r2.end)
        assertEquals(0, puts.n)
        assertEquals(listOf("up1" to "v9"), c.dones)
    }

    @Test
    fun theSavedStateKeepsTheSessionSoARetryResumes() {
        val st = JobState()
        // The first put succeeds for one chunk then the worker is stopped.
        var stop = false
        val events = ArrayList<UploadEvent>()
        val store = MemoryStateStore()
        val put = Puts { n, _ -> stop = true; PutResponse(308, "bytes=0-49", "") }
        val r = UploadJobRunner(
            spec = spec(parts(1)), state = st, cloud = FakeCloud(),
            uploader = ResumableUploader(put, sleep = {}), openSource = { Mem(100) },
            store = store, emit = { events.add(it) }, shouldStop = { stop },
        )
        assertEquals(RunEnd.STOPPED, r.run(parts(1)))
        val saved = store.load("J")!!.parts[1]!!
        assertEquals(50L, saved.offset)
        assertNotNull(saved.uploadUri)
    }

    @Test
    fun nothingTheRunnerPrintsOrEmitsCarriesTheUri() {
        val r = run(parts(1), put = Puts { _, _ -> ok("v") })
        for (e in r.events) {
            assertFalse(e.toString().contains("googleapis.com"))
        }
        // The done event no longer has a URI to keep.
        assertNull(r.store.load("J")!!.parts[1]!!.uploadUri)
    }

    // ---- S1: the address must be Google ----

    @Test
    fun onlyHttpsGoogleapisAddressesPass() {
        for (ok in listOf(
            "https://www.googleapis.com/upload/youtube/v3/videos?upload_id=x",
            "https://upload.googleapis.com/x", "https://a.b.googleapis.com/x", "https://WWW.GOOGLEAPIS.COM/x",
        )) assertTrue(ok, UploadUri.isYoutube(ok))
        for (bad in listOf(
            "http://www.googleapis.com/x", "https://evil.example/x", "https://googleapis.com.evil.example/x",
            "https://evilgoogleapis.com/x", "https://googleapis.com/x", "https://www.googleapis.com@evil.example/x",
            "https://user:pw@www.googleapis.com/x", "ftp://www.googleapis.com/x", "//www.googleapis.com/x",
            "/upload/x", "", "not a uri",
        )) assertFalse(bad, UploadUri.isYoutube(bad))
    }

    @Test
    fun aBeginAnswerPointingElsewhereFailsThePartAndNothingIsSent() {
        val evil = object : CloudApi {
            override fun begin(kuliahId: String?, partIndex: Int?, partCount: Int?, bytes: Long, replaceLiveVideoId: String?) =
                BegunUpload("upBad", "https://evil.example/steal")
            override fun done(uploadId: String, videoId: String) {}
            override fun quotaResetsAt() = "x"
        }
        val events = ArrayList<UploadEvent>()
        val puts = Puts { _, _ -> ok("v") }
        val r = UploadJobRunner(
            spec = spec(parts(1)), state = JobState(), cloud = evil, uploader = ResumableUploader(puts, sleep = {}),
            openSource = { Mem(100) }, store = MemoryStateStore(), emit = { events.add(it) }, shouldStop = { false },
        )
        assertEquals(RunEnd.FAILED, r.run(parts(1)))
        assertEquals(0, puts.n)
        val last = events.last()
        assertEquals("failed", last.state)
        assertEquals("bad_upload_uri", last.error)
        assertTrue(last.clearSession)
        assertFalse(events.joinToString { it.toString() + it.uploadUri }.contains("evil"))
    }

    @Test
    fun aStoredAddressThatIsNotGoogleIsNeverProbedOrSentTo() {
        val st = JobState()
        st.parts[1] = PartState(offset = 10, uploadId = "upX", uploadUri = "https://evil.example/resume")
        val puts = Puts { _, _ -> ok("v") }
        val r = run(parts(1), state = st, put = puts)
        assertEquals(RunEnd.FAILED, r.end)
        assertEquals(0, puts.n)
        assertTrue(r.cloud.begins.isEmpty())
        assertEquals("bad_upload_uri", r.events.last().error)
        assertNull(st.parts[1]!!.uploadUri)
    }
}
