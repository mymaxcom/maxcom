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
        assertTrue(UploadPlan.fitsInput("{}", "https://cloud", "tok", "ca"))
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
        assertFalse(BegunUpload("u", "https://secret.example/x").toString().contains("secret.example"))
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
