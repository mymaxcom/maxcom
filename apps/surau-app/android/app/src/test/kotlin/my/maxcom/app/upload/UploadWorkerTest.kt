package my.maxcom.app.upload

import androidx.work.NetworkType
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The decisions behind [UploadWorker] and [UploadChannel] that need no Android framework:
 * constraints, notification text, input size, the job and state JSON. The scheduling itself
 * (`WorkManagerTestInitHelper`) needs Robolectric, which this project does not use; the device
 * proof is Task 12.
 */
class UploadWorkerTest {
    @Test
    fun theDefaultNeedsAnUnmeteredNetwork() {
        assertEquals(NetworkType.UNMETERED, UploadPlan.networkType(false))
    }

    @Test
    fun allowingMobileDataNeedsAnyConnection() {
        assertEquals(NetworkType.CONNECTED, UploadPlan.networkType(true))
    }

    @Test
    fun theNotificationTextIsNumbersAndNeverAUri() {
        val uri = "https://upload.example/session/SECRET"
        // The function takes numbers only; nothing else can get in.
        val text = UploadPlan.notificationText(2, 4, 35, 100)
        assertEquals("Bahagian 2 daripada 4: 35%", text)
        assertFalse(text.contains(uri))
        assertEquals("50%", UploadPlan.notificationText(1, 1, 50, 100))
        assertEquals("MAXCOM memuat naik rakaman", UploadPlan.TITLE)
        assertFalse(UploadPlan.TITLE.contains("http"))
    }

    @Test
    fun percentIsClamped() {
        assertEquals(0, UploadPlan.percent(5, 0))
        assertEquals(100, UploadPlan.percent(500, 100))
        assertEquals(0, UploadPlan.percent(-5, 100))
    }

    @Test
    fun aJobTooBigForWorkManagersInputIsRefused() {
        assertTrue(UploadPlan.fitsInput("{}"))
        assertFalse(UploadPlan.fitsInput("x".repeat(UploadPlan.MAX_INPUT_BYTES)))
    }

    @Test
    fun theJobParsesFromWhatDartSends() {
        val json = """
            {"id":"01J","sessionId":"s","kuliahId":"k1","joined":false,"allowMobile":true,
             "replaceLiveVideoId":"live1","joinSegments":true,"createdAt":"2026-11-06T10:00:00.000Z",
             "parts":[
               {"index":1,"source":"android:content://media/external/video/media/7","bytes":1000,
                "uploadId":null,"uploadUri":"https://upload.example/s/1","offset":10,"videoId":null,"state":"queued"},
               {"index":2,"source":"android:content://media/external/video/media/8","bytes":2000,
                "state":"done","videoId":"v2"}]}
        """.trimIndent()
        val j = JobSpec.parse(json)
        assertEquals("01J", j.id)
        assertEquals("k1", j.kuliahId)
        assertTrue(j.allowMobile && j.joinSegments && !j.joined)
        assertEquals("live1", j.replaceLiveVideoId)
        assertEquals(2, j.parts.size)
        assertEquals(1000L, j.parts[0].bytes)
        assertEquals(10L, j.parts[0].offset)
        assertNull(j.parts[0].uploadId)
        assertTrue(j.parts[1].done)
        assertEquals("v2", j.parts[1].videoId)
    }

    @Test
    fun theJobAndEventDescriptionsLeaveTheUriOut() {
        val p = PartSpec(1, "android:content://x", 100, uploadId = "u", uploadUri = "https://secret.example/x", offset = 5)
        assertFalse(p.toString().contains("secret.example"))
        val e = UploadEvent("J", 1, "uploading", uploadUri = "https://secret.example/x")
        assertFalse(e.toString().contains("secret.example"))
    }

    // ---- U7: the work request holds the job and nothing else ----

    private fun dartJob(): Map<String, Any?> = mapOf(
        "id" to "01J", "sessionId" to "s1", "kuliahId" to "k1", "joined" to false, "allowMobile" to false,
        "joinSegments" to true, "replaceLiveVideoId" to "live1", "createdAt" to "2026-11-23T10:00:00.000Z",
        // what must never get through, should a caller ever put it on a job
        "token" to "SESSION-TOKEN-SECRET", "base" to "https://192.0.2.10", "ca" to "CERT",
        "auth" to mapOf("token" to "SESSION-TOKEN-SECRET"),
        "parts" to listOf(
            mapOf(
                "index" to 1, "source" to "android:content://media/external/video/media/7", "bytes" to 1000,
                "uploadId" to "up1", "uploadUri" to "https://www.googleapis.com/upload/youtube/s/1", "offset" to 0,
                "videoId" to null, "state" to "queued", "token" to "SESSION-TOKEN-SECRET",
            ),
        ),
    )

    @Test
    fun theWorkDataHoldsNoToken() {
        val json = UploadPlan.workJob(dartJob())
        val data = UploadPlan.inputValues(json)
        assertEquals(setOf("job"), data.keys)
        val all = data.values.joinToString()
        for (secret in listOf("SESSION-TOKEN-SECRET", "192.0.2.10", "CERT", "token", "auth", "base", "live1", "k1")) {
            assertFalse("work data must not hold $secret", all.contains(secret))
        }
    }

    @Test
    fun theWorkJobStillCarriesWhatTheWorkerNeeds() {
        // success path: the sanitised job parses to the same parts, with the Google address the app got
        val j = JobSpec.parse(UploadPlan.workJob(dartJob()))
        assertEquals("01J", j.id)
        assertTrue(j.joinSegments)
        assertFalse(j.allowMobile)
        val p = j.parts.single()
        assertEquals(1000L, p.bytes)
        assertEquals("android:content://media/external/video/media/7", p.source)
        assertEquals("up1", p.uploadId)
        assertEquals("https://www.googleapis.com/upload/youtube/s/1", p.uploadUri)
        assertNull(p.videoId)
    }

    @Test
    fun aJoinedJobKeepsItsOriginalSegments() {
        val job = dartJob() + mapOf(
            "joined" to true,
            "segments" to listOf(mapOf("source" to "android:content://v/1", "bytes" to 10, "secret" to "x")),
        )
        val j = JobSpec.parse(UploadPlan.workJob(job))
        assertTrue(j.joined)
        assertEquals(listOf("android:content://v/1"), j.segments!!.map { it.source })
        assertFalse(UploadPlan.workJob(job).contains("secret"))
    }

    @Test
    fun aJobWithNoIdOrPartsIsRefused() {
        for (bad in listOf(mapOf("parts" to emptyList<Any>()), mapOf<String, Any?>("id" to "J"))) {
            try {
                UploadPlan.workJob(bad)
                throw AssertionError("must refuse")
            } catch (e: IllegalArgumentException) {
                assertEquals("bad_args", e.message)
            }
        }
    }

    @Test
    fun theWorkerReadsNothingButTheJobFromItsInput() {
        val src = listOf("src/main/kotlin/my/maxcom/app/upload/UploadWorker.kt", "app/src/main/kotlin/my/maxcom/app/upload/UploadWorker.kt")
            .map { java.io.File(it) }.first { it.exists() }.readText()
        val reads = Regex("inputData\\.getString\\(([A-Z_a-z.]+)\\)").findAll(src).map { it.groupValues[1] }.toSet()
        assertEquals(setOf("KEY_JOB"), reads)
    }

    // ---- U8: queueing the same job again does not cancel the worker ----

    @Test
    fun theSameJobAgainKeepsTheRunningWork() {
        val a = UploadPlan.jobDigest(UploadPlan.workJob(dartJob()))
        // the offset and the state moved (the worker is sending): still the same work
        val moved = dartJob().toMutableMap()
        @Suppress("UNCHECKED_CAST")
        moved["parts"] = (moved["parts"] as List<Map<String, Any?>>).map { it + mapOf("offset" to 500, "state" to "uploading") }
        val b = UploadPlan.jobDigest(UploadPlan.workJob(moved))
        assertEquals(a, b)
        assertTrue(UploadPlan.keepExisting(a, b))
        assertFalse("the first request of a job is never held back", UploadPlan.keepExisting(null, a))
    }

    @Test
    fun aNewUploadAddressOrNetworkRuleReplacesTheWork() {
        val a = UploadPlan.jobDigest(UploadPlan.workJob(dartJob()))
        val begun = dartJob().toMutableMap()
        @Suppress("UNCHECKED_CAST")
        begun["parts"] = (begun["parts"] as List<Map<String, Any?>>).map { it + mapOf("uploadUri" to "https://www.googleapis.com/upload/youtube/s/2") }
        assertFalse(UploadPlan.keepExisting(a, UploadPlan.jobDigest(UploadPlan.workJob(begun))))
        val mobile = dartJob() + mapOf("allowMobile" to true)
        assertFalse(UploadPlan.keepExisting(a, UploadPlan.jobDigest(UploadPlan.workJob(mobile))))
        assertFalse("the digest is a hash, not the address", a.contains("googleapis"))
    }

    // ---- B1c: a metered Wi-Fi is not "wifi" for a Wi-Fi-only job ----

    @Test
    fun theNetworkWordMatchesWhatWorkManagerWillRunOn() {
        assertEquals("wifi", UploadPlan.networkKind(internet = true, wifiOrEthernet = true, cellular = false, unmetered = true))
        assertEquals("cellular", UploadPlan.networkKind(internet = true, wifiOrEthernet = true, cellular = false, unmetered = false))
        assertEquals("cellular", UploadPlan.networkKind(internet = true, wifiOrEthernet = false, cellular = true, unmetered = false))
        assertEquals("none", UploadPlan.networkKind(internet = false, wifiOrEthernet = true, cellular = false, unmetered = true))
    }

    @Test
    fun theSavedStateKeepsTheReasonOfTheLastEvent() {
        val s = JobState()
        s.parts[1] = PartState(state = "queued", error = "needs_begin")
        assertEquals("needs_begin", JobState.fromJson(s.toJson()).parts[1]!!.error)
        // a state saved by an older build has no reason: read as none
        val old = JobState.fromJson("""{"parts":{"1":{"state":"queued","offset":0}},"joined":false,"joinedBytes":0}""")
        assertNull(old.parts[1]!!.error)
    }

    @Test
    fun theSavedStateRoundTrips() {
        val s = JobState(joined = true, joinedPath = "/cache/J.mp4", joinedBytes = 42)
        s.parts[1] = PartState("uploading", 8_388_608, "up1", "https://upload.example/s", null)
        val back = JobState.fromJson(s.toJson())
        assertTrue(back.joined)
        assertEquals(42L, back.joinedBytes)
        val p = back.parts[1]!!
        assertEquals("uploading", p.state)
        assertEquals(8_388_608L, p.offset)
        assertEquals("up1", p.uploadId)
        assertEquals("https://upload.example/s", p.uploadUri)
        assertNull(p.videoId)
    }

    @Test
    fun theProtocolReadsTheRangeHeader() {
        assertEquals(0L, ResumableProtocol.nextOffset(null))
        assertEquals(8_388_608L, ResumableProtocol.nextOffset("bytes=0-8388607"))
        assertEquals("bytes 0-99/200", ResumableProtocol.contentRange(0, 100, 200))
        assertEquals("bytes */200", ResumableProtocol.probeRange(200))
    }

    @Test
    fun theEventMapIsWhatDartReads() {
        val m = UploadEvent("J", 2, "uploading", offset = 5, total = 10, videoId = "v").toMap()
        assertEquals("J", m["jobId"])
        assertEquals(2, m["partIndex"])
        assertEquals("uploading", m["state"])
        assertEquals(5L, m["offset"])
        assertEquals(10L, m["total"])
        assertEquals("v", m["videoId"])
        assertEquals(false, m["clearSession"])
    }

    // ---- Q-M3: a purged joined file is made again from the original segments ----

    @Test
    fun theJobCarriesTheOriginalSegmentsOnceJoined() {
        val json = """
            {"id":"J","kuliahId":null,"joined":true,"allowMobile":false,"joinSegments":true,
             "parts":[{"index":1,"source":"android:joined","bytes":3000,"state":"queued"}],
             "segments":[{"source":"android:content://media/external/video/media/7","bytes":1000},
                         {"source":"android:content://media/external/video/media/8","bytes":2000}]}
        """.trimIndent()
        val j = JobSpec.parse(json)
        assertTrue(j.joined)
        assertEquals(listOf("android:content://media/external/video/media/7", "android:content://media/external/video/media/8"), j.segments!!.map { it.source })
        assertEquals(listOf(1, 2), j.segments.map { it.index })
        assertEquals(listOf(1000L, 2000L), j.segments.map { it.bytes })
        // before the join Dart sends none
        val before = JobSpec.parse("""{"id":"J","joined":false,"parts":[{"index":1,"source":"android:content://a","bytes":1}]}""")
        assertNull(before.segments)
    }

    @Test
    fun aMissingJoinedFileIsRejoinedWhenTheSegmentsAreKnown() {
        val segs = listOf(PartSpec(1, "android:content://v/1", 10), PartSpec(2, "android:content://v/2", 20))
        assertTrue(UploadPlan.canRejoin(segs))
        // the file is there, or the video is already up: use it, no join
        assertEquals(UploadPlan.JoinedFilePlan.USE_FILE, UploadPlan.joinedFilePlan(true, false, true))
        assertEquals(UploadPlan.JoinedFilePlan.USE_FILE, UploadPlan.joinedFilePlan(false, true, true))
        // purged: join again from the segments
        assertEquals(UploadPlan.JoinedFilePlan.REJOIN, UploadPlan.joinedFilePlan(false, false, true))
        // purged and the segments are not known (an older job): fails as before
        assertEquals(UploadPlan.JoinedFilePlan.MISSING, UploadPlan.joinedFilePlan(false, false, false))
    }

    @Test
    fun onlyAndroidSegmentsOtherThanTheJoinedFileCanBeRejoined() {
        assertFalse(UploadPlan.canRejoin(null))
        assertFalse(UploadPlan.canRejoin(emptyList()))
        assertFalse(UploadPlan.canRejoin(listOf(PartSpec(1, "android:joined", 10))))
        assertFalse(UploadPlan.canRejoin(listOf(PartSpec(1, "web:abc", 10))))
        assertFalse(UploadPlan.canRejoin(listOf(PartSpec(1, "android:content://v/1", 10), PartSpec(2, "web:x", 10))))
    }
}
