package my.maxcom.app.upload

import java.io.File
import java.io.IOException
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The upload worker's runner since 2026.11.15 (B1 native half, U3, U7): it sends to the Google upload address the app
 * handed over and to nothing else. There is no box client to fake any more.
 */
class UploadJobRunnerTest {
    private class Mem(override val length: Long) : OpenSource {
        override fun read(start: Long, endExclusive: Long) = ByteArray((endExclusive - start).toInt())
        override fun close() {}
    }

    private fun ok(id: String) = PutResponse(200, null, """{"id":"$id"}""")
    private val fresh = PutResponse(308, null, "") // the probe of a session nothing was sent to yet

    private class Puts(val answer: (Int, String) -> PutResponse) : PutTransport {
        var n = 0
        val ranges = ArrayList<String>()
        val uris = ArrayList<String>()
        override fun put(uri: String, contentRange: String, body: ByteArray): PutResponse {
            ranges.add(contentRange)
            uris.add(uri)
            return answer(++n, contentRange)
        }
    }

    private fun google(n: Int) = "https://www.googleapis.com/upload/youtube/session/$n"

    /** Parts as the app queues them: each with the upload address it got from the box. */
    private fun parts(n: Int) = (1..n).map { PartSpec(it, "android:content://v/$it", 100, uploadId = "up$it", uploadUri = google(it)) }

    private fun stateOf(parts: List<PartSpec>) = JobState().also { s ->
        for (p in parts) s.parts[p.index] = PartState(offset = p.offset, uploadId = p.uploadId, uploadUri = p.uploadUri, videoId = p.videoId)
    }

    private class Run(val end: RunEnd, val events: List<UploadEvent>, val store: MemoryStateStore, val state: JobState, val logs: List<String>)

    private fun run(
        parts: List<PartSpec>,
        state: JobState = stateOf(parts),
        put: PutTransport,
        open: (String) -> OpenSource = { Mem(100) },
        stop: () -> Boolean = { false },
    ): Run {
        val events = ArrayList<UploadEvent>()
        val logs = ArrayList<String>()
        val store = MemoryStateStore()
        val r = UploadJobRunner(
            spec = JobSpec(id = "J", parts = parts), state = state, uploader = ResumableUploader(put, sleep = {}),
            openSource = open, store = store, emit = { events.add(it) }, shouldStop = stop,
            log = { e, t -> logs.add("$e $t") },
        )
        return Run(r.run(parts), events, store, state, logs)
    }

    // ---- success path ----

    @Test
    fun theFullPutSequenceEndsInUploaded() {
        // B1: probe, then the bytes, then YouTube's answer with the video id
        val puts = Puts { n, _ -> if (n == 1) fresh else ok("v1") }
        val r = run(parts(1), put = puts)
        assertEquals(RunEnd.DONE, r.end)
        assertEquals(listOf("bytes */100", "bytes 0-99/100"), puts.ranges)
        assertTrue("only the address the app gave is used", puts.uris.all { it == google(1) })
        val last = r.events.last()
        assertEquals("uploaded", last.state)
        assertEquals("v1", last.videoId)
        assertEquals("up1", last.uploadId) // what the app needs to tell the box
        assertEquals(100L, last.offset)
        assertNull(last.error)
        assertEquals(listOf("uploading", "uploaded"), r.events.map { it.state }.distinct())
        val saved = r.store.load("J")!!.parts[1]!!
        assertEquals("uploaded", saved.state)
        assertEquals("v1", saved.videoId)
    }

    @Test
    fun everyPartIsSentToItsOwnAddressInOrder() {
        val puts = Puts { n, _ -> if (n % 2 == 1) fresh else ok("v${n / 2}") }
        val r = run(parts(2), put = puts)
        assertEquals(RunEnd.DONE, r.end)
        assertEquals(listOf(google(1), google(1), google(2), google(2)), puts.uris)
        assertEquals(listOf("v1", "v2"), r.events.filter { it.state == "uploaded" }.map { it.videoId })
    }

    @Test
    fun aSavedSessionIsProbedBeforeSendingAndResumesThere() {
        val ps = parts(1)
        val st = stateOf(ps).also { it.parts[1]!!.offset = 10 }
        val puts = Puts { n, _ -> if (n == 1) PutResponse(308, "bytes=0-59", "") else ok("v3") }
        val r = run(ps, state = st, put = puts)
        assertEquals(RunEnd.DONE, r.end)
        assertEquals(listOf("bytes */100", "bytes 60-99/100"), puts.ranges)
        assertEquals("v3", r.events.last().videoId)
    }

    @Test
    fun aPartAlreadyOnYoutubeIsNotSentAgainAndIsReportedAgain() {
        // the app was closed when the worker finished: the next run says `uploaded` again without one request
        val ps = parts(1)
        val st = stateOf(ps).also { it.parts[1]!!.videoId = "v9"; it.parts[1]!!.state = "uploaded"; it.parts[1]!!.uploadUri = null }
        val puts = Puts { _, _ -> ok("x") }
        val r = run(ps, state = st, put = puts)
        assertEquals(RunEnd.DONE, r.end)
        assertEquals(0, puts.n)
        assertEquals("uploaded", r.events.single().state)
        assertEquals("v9", r.events.single().videoId)
    }

    // ---- the worker has no way to the box: what it says instead ----

    @Test
    fun aPartWithNoUploadAddressAsksTheAppForOneAndSendsNothing() {
        val puts = Puts { _, _ -> ok("v") }
        val ps = listOf(PartSpec(1, "android:content://v/1", 100))
        val r = run(ps, put = puts)
        assertEquals(RunEnd.WAIT, r.end)
        assertEquals(0, puts.n)
        assertEquals("queued", r.events.last().state)
        assertEquals("needs_begin", r.events.last().error)
        assertEquals("needs_begin", r.store.load("J")!!.parts[1]!!.error) // replayed after a restart
    }

    @Test
    fun aDeadSessionIsDroppedAndTheAppIsAskedForANewOne() {
        val puts = Puts { _, _ -> PutResponse(410, null, "") }
        val r = run(parts(1), put = puts)
        assertEquals(RunEnd.WAIT, r.end)
        val last = r.events.last()
        assertEquals("queued", last.state)
        assertEquals("needs_begin", last.error)
        assertTrue(last.clearSession)
        assertNull(r.state.parts[1]!!.uploadUri)
        assertEquals(1, puts.n) // the probe only; nothing is retried against a dead address
    }

    @Test
    fun aSessionThatDiesMidUploadIsDroppedToo() {
        val puts = Puts { n, _ -> if (n == 1) fresh else PutResponse(404, null, "") }
        val r = run(parts(1), put = puts)
        assertEquals(RunEnd.WAIT, r.end)
        assertTrue(r.events.last().clearSession)
        assertEquals("needs_begin", r.events.last().error)
    }

    @Test
    fun aMidUploadQuotaAnswerWaits() {
        val quota = PutResponse(403, null, """{"error":{"errors":[{"reason":"uploadLimitExceeded"}]}}""")
        val r = run(parts(2), put = Puts { n, _ -> if (n == 1) fresh else quota })
        assertEquals(RunEnd.WAIT, r.end)
        assertEquals("quota", r.events.last().state)
        assertEquals(1, r.events.last().partIndex)
    }

    @Test
    fun aRefusalFromYoutubeIsAVisibleFailure() {
        val r = run(parts(1), put = Puts { n, _ -> if (n == 1) fresh else PutResponse(400, null, "{}") })
        assertEquals(RunEnd.FAILED, r.end)
        assertEquals("failed", r.events.last().state)
        assertEquals("rejected_400", r.events.last().error)
    }

    @Test
    fun theSavedStateKeepsTheSessionSoARetryResumes() {
        var stop = false
        val puts = Puts { n, _ -> if (n == 1) fresh else { stop = true; PutResponse(308, "bytes=0-49", "") } }
        val r = run(parts(1), put = puts, stop = { stop })
        assertEquals(RunEnd.STOPPED, r.end)
        val saved = r.store.load("J")!!.parts[1]!!
        assertEquals(50L, saved.offset)
        assertNotNull(saved.uploadUri)
        assertEquals("queued", saved.state)
    }

    // ---- U3: nothing ends the worker silently ----

    @Test
    fun aJsonErrorBecomesAVisibleFailureAndItsClassIsLogged() {
        val puts = PutTransport { _, _, _ -> throw org.json.JSONException("boom https://secret.example/x") }
        val r = run(parts(1), put = puts)
        assertEquals(RunEnd.FAILED, r.end)
        assertEquals("failed", r.events.last().state)
        assertEquals("runner_error", r.events.last().error)
        assertEquals(listOf("upload_part_failed JSONException"), r.logs)
        assertFalse("the message never leaves", r.logs.joinToString().contains("secret"))
        assertEquals("runner_error", r.store.load("J")!!.parts[1]!!.error)
    }

    @Test
    fun anyOtherExceptionIsAVisibleFailureToo() {
        val r = run(parts(1), put = PutTransport { _, _, _ -> throw IllegalStateException("x") })
        assertEquals(RunEnd.FAILED, r.end)
        assertEquals("runner_error", r.events.last().error)
        assertEquals(listOf("upload_part_failed IllegalStateException"), r.logs)
    }

    @Test
    fun aFileThatCannotBeReadMidWayIsRetriedAndSaysWhy() {
        val broken = object : OpenSource {
            override val length = 100L
            override fun read(start: Long, endExclusive: Long): ByteArray = throw IOException("gone")
            override fun close() {}
        }
        val r = run(parts(1), put = Puts { _, _ -> fresh }, open = { broken })
        assertEquals(RunEnd.RETRY, r.end)
        assertEquals("queued", r.events.last().state)
        assertEquals("network", r.events.last().error)
    }

    @Test
    fun aMissingFileFailsThePart() {
        val r = run(parts(1), put = Puts { _, _ -> ok("v") }, open = { throw IOException("open") })
        assertEquals(RunEnd.FAILED, r.end)
        assertEquals("source_missing", r.events.last().error)
    }

    @Test
    fun anEmptyRecordingIsNeverSent() {
        // B3: a 0-byte file that reached the queue is refused before the first request
        val puts = Puts { _, _ -> ok("v") }
        val r = run(parts(1), put = puts, open = { Mem(0) })
        assertEquals(RunEnd.FAILED, r.end)
        assertEquals("empty_file", r.events.last().error)
        assertEquals(0, puts.n)
    }

    // ---- S1: the address must be Google ----

    @Test
    fun onlyTheYoutubeUploadAddressOfWwwGoogleapisPasses() {
        for (ok in listOf(
            "https://www.googleapis.com/upload/youtube/v3/videos?upload_id=x",
            "https://WWW.GOOGLEAPIS.COM/upload/youtube/v3/videos?uploadType=resumable&upload_id=a..b",
            "https://www.googleapis.com:443/upload/youtube/v3/videos?upload_id=x",
        )) assertTrue(ok, UploadUri.isYoutube(ok))
        for (bad in listOf(
            // S3: any other Google host, and any other path of the right host
            "https://upload.googleapis.com/x", "https://a.b.googleapis.com/x", "https://WWW.GOOGLEAPIS.COM/x",
            "https://bucket.storage.googleapis.com/upload/youtube/v3/videos?upload_id=x",
            "https://storage.googleapis.com/upload/youtube/v3/videos", "https://www.googleapis.com/upload/storage/v1/b/x/o",
            "https://www.googleapis.com/upload/youtube", "https://www.googleapis.com/upload/youtubex/v3/videos",
            "https://www.googleapis.com/upload/youtube/../storage/v1/b/x/o",
            "https://www.googleapis.com/upload/youtube/%2e%2e/storage/v1/b/x/o",
            "https://www.googleapis.com/upload/youtube/%2E%2E/storage/v1/b/x/o",
            "https://www.googleapis.com:8443/upload/youtube/v3/videos", "https://www.googleapis.com./upload/youtube/v3/videos",
            "http://www.googleapis.com/x", "https://evil.example/x", "https://googleapis.com.evil.example/x",
            "https://evilgoogleapis.com/x", "https://googleapis.com/x", "https://www.googleapis.com@evil.example/x",
            "https://user:pw@www.googleapis.com/x", "ftp://www.googleapis.com/x", "//www.googleapis.com/x",
            "/upload/x", "", "not a uri", "https://192.0.2.10/api/youtube/upload/begin", "https://maxcom.local/x",
        )) assertFalse(bad, UploadUri.isYoutube(bad))
    }

    @Test
    fun anAddressThatIsNotGoogleIsNeverProbedOrSentTo() {
        for (bad in listOf("https://evil.example/steal", "https://192.0.2.10/api/youtube/upload/begin")) {
            val ps = listOf(PartSpec(1, "android:content://v/1", 100, uploadId = "upX", uploadUri = bad))
            val puts = Puts { _, _ -> ok("v") }
            val r = run(ps, put = puts)
            assertEquals(RunEnd.FAILED, r.end)
            assertEquals(0, puts.n)
            val last = r.events.last()
            assertEquals("bad_upload_uri", last.error)
            assertTrue(last.clearSession)
            assertNull(r.state.parts[1]!!.uploadUri)
            assertFalse(r.events.joinToString { it.toString() + it.uploadUri }.contains("evil"))
        }
    }

    @Test
    fun theRealTransportRefusesAnAddressThatIsNotGoogleBeforeAnyConnection() {
        try {
            UrlConnectionTransport().put("https://192.0.2.10/api/youtube/upload/done", "bytes */1", ByteArray(0))
            throw AssertionError("must refuse")
        } catch (e: IOException) {
            assertEquals("bad_upload_uri", e.message)
        }
    }

    @Test
    fun nothingTheRunnerPrintsOrEmitsCarriesTheUri() {
        val r = run(parts(1), put = Puts { n, _ -> if (n == 1) fresh else ok("v") })
        for (e in r.events) assertFalse(e.toString().contains("googleapis.com"))
        // once the video is up the address is no longer kept
        assertNull(r.store.load("J")!!.parts[1]!!.uploadUri)
    }

    // ---- U7: the worker has no client for the box at all ----

    @Test
    fun theUploadPackageHoldsNoBoxClientAndNoToken() {
        val dir = listOf("src/main/kotlin/my/maxcom/app/upload", "app/src/main/kotlin/my/maxcom/app/upload")
            .map(::File).first { it.isDirectory }
        val barred = listOf(
            "Authorization", "Bearer", "KEY_TOKEN", "KEY_BASE", "KEY_CA", "/api/youtube", "SSLContext", "TrustManager",
            "HttpCloudApi", "sslSocketFactory", "\"token\"",
        )
        for (f in dir.listFiles()!!.filter { it.extension == "kt" }) {
            val src = f.readText()
            for (b in barred) assertFalse("${f.name} must not contain $b", src.contains(b))
        }
        assertFalse(File(dir, "CloudApi.kt").exists())
    }
}
