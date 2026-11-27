package my.maxcom.app.live

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Assert.assertNull
import org.junit.Test

class LiveLogicTest {
    @Test
    fun aPreparedEngineIsReleasedOnRequestOnlyWhenNoLiveRunsOrStops() {
        // B11: with the box pulling the camera the phone lets its own camera go, but never under a live
        assertTrue(LiveLogic.mayReleasePrepared(live = false, stopping = false))
        assertFalse(LiveLogic.mayReleasePrepared(live = true, stopping = false))
        assertFalse(LiveLogic.mayReleasePrepared(live = false, stopping = true))
        assertFalse(LiveLogic.mayReleasePrepared(live = true, stopping = true))
    }

    @Test
    fun theReleaseChannelMethodGoesThroughTheGuardedEngineCall() {
        val channel = java.io.File("src/main/kotlin/my/maxcom/app/live/LiveChannel.kt").readText()
        assertTrue(channel.contains("\"release\" -> result.success(engine.releasePrepared())"))
        val engine = java.io.File("src/main/kotlin/my/maxcom/app/live/LiveEngine.kt").readText()
        val body = engine.substringAfter("fun releasePrepared(): Boolean {").substringBefore("fun release() {")
        assertTrue(body.trimStart().startsWith("if (!LiveLogic.mayReleasePrepared(live, stopping)) return false"))
    }

    @Test
    fun backoffDoublesFromTwoAndStopsAtThirty() {
        val seq = (1..9).map { LiveLogic.backoffSeconds(it) }
        assertEquals(listOf(2, 4, 8, 16, 30, 30, 30, 30, 30), seq)
        assertEquals(2, LiveLogic.backoffSeconds(0))
        assertEquals(30, LiveLogic.backoffSeconds(1000))
    }

    @Test
    fun segmentNameIsMaxcomDateTimePrefixIndex() {
        assertEquals("MAXCOM-2026-11-05-1830-maghrib-01.mp4", LiveLogic.segmentName("2026-11-05", "1830", "maghrib", 1))
        assertEquals("MAXCOM-2026-11-05-0905-maghrib-12.mp4", LiveLogic.segmentName("2026-11-05", "0905", "maghrib", 12))
    }

    @Test
    fun twoLivesOfTheSameDayAndPrefixGetDifferentNames() {
        val a = LiveLogic.segmentName("2026-11-06", "1015", null, 1)
        val b = LiveLogic.segmentName("2026-11-06", "1140", null, 1)
        assertNotEquals(a, b)
    }

    @Test
    fun aTakenNameMovesTheIndexUpAndNothingIsReused() {
        // a live in the same minute as an earlier one: -01 and -02 exist, so this one starts at -03
        val taken = setOf(
            "MAXCOM-2026-11-06-1015-siaran-01.mp4",
            "MAXCOM-2026-11-06-1015-siaran-02.mp4",
        )
        val (name, n) = LiveLogic.freeSegmentName("2026-11-06", "1015", null, 1) { it in taken }
        assertEquals("MAXCOM-2026-11-06-1015-siaran-03.mp4", name)
        assertEquals(3, n)
        // nothing taken: the asked index is used
        assertEquals("MAXCOM-2026-11-06-1015-k1-04.mp4" to 4, LiveLogic.freeSegmentName("2026-11-06", "1015", "k1", 4) { false })
    }

    @Test
    fun everyNameTheLiveWritesPassesTheRecordingGuard() {
        val (name, _) = LiveLogic.freeSegmentName("2026-11-06", "2359", "kuliah_maghrib", 1) { false }
        assertTrue(my.maxcom.app.upload.RecordingGuard.isRecordingName(name))
    }

    @Test
    fun prefixCannotCarryAPathOrBeEmpty() {
        assertEquals("siaran", LiveLogic.sanitizePrefix(null))
        assertEquals("siaran", LiveLogic.sanitizePrefix(""))
        assertFalse(LiveLogic.sanitizePrefix("../etc/passwd").contains('/'))
        assertFalse(LiveLogic.sanitizePrefix("a/b\\c:d").contains('\\'))
        assertEquals(40, LiveLogic.sanitizePrefix("x".repeat(100)).length)
    }

    @Test
    fun srtUrlKeepsLiteralColonsInStreamId() {
        val u = LiveLogic.srtUrl("10.168.1.10", 8890, "publish:surau:pub-ab12:Pw0rdAlnum", "Passphrase24Alnum00000000")
        assertEquals("srt://10.168.1.10:8890?streamid=publish:surau:pub-ab12:Pw0rdAlnum&passphrase=Passphrase24Alnum00000000", u)
        assertFalse(u.contains("%3A"))
        assertTrue(LiveLogic.srtUrl("h", 1, "s", null).endsWith("streamid=s"))
        assertFalse(LiveLogic.srtUrl("h", 1, "s", "").contains("passphrase"))
    }

    @Test
    fun outputIsAlways1280x720AndNeverSwapped() {
        assertEquals(1280, LiveLogic.STREAM_WIDTH)
        assertEquals(720, LiveLogic.STREAM_HEIGHT)
        // 90 and 270 would swap RootEncoder's encoder to 9:16; it is always prepared as 0.
        assertEquals(0, LiveLogic.PREPARE_ROTATION)
    }

    @Test
    fun surfaceRotationMapsToDegrees() {
        assertEquals(listOf(0, 90, 180, 270), (0..3).map { LiveLogic.displayDegrees(it) })
    }

    @Test
    fun onlyDisplay0And180ArePortrait() {
        assertEquals(listOf(true, false, true, false), listOf(0, 90, 180, 270).map { LiveLogic.isPortrait(it) })
        assertTrue(LiveLogic.isPortrait(360))
        assertFalse(LiveLogic.isPortrait(-90))
    }

    @Test
    fun portraitCropsACentred16x9Band() {
        // stream: the 9:16 frame scaled to 1280 wide is 2275 tall, centred on 720
        val enc = LiveLogic.cropViewport(1280, 720, true)!!
        assertEquals(listOf(0, -777, 1280, 2275), enc.toList())
        // the band is always the full surface width and centred
        assertEquals(0, enc[1] + (enc[3] - 720) / 2)
    }

    @Test
    fun landscapeAndEmptySurfaceUseTheDefaultViewport() {
        assertNull(LiveLogic.cropViewport(1280, 720, false))
        assertNull(LiveLogic.cropViewport(0, 0, true))
    }

    @Test
    fun orientationLineCarriesOnlyOrientationFacts() {
        val l = LiveLogic.orientationLine(270, 90, 90, false, "Fill", 1280, 720)
        assertEquals("orientation display=270 camera=90 sensor=90 facing=back aspect=Fill enc=1280x720", l)
        assertTrue(LiveLogic.orientationLine(0, 0, 270, true, "Fill", 1280, 720).contains("facing=front"))
    }

    @Test
    fun guardIgnoresOrientationWorkOutsideAnActiveSession() {
        val g = OrientationGuard()
        assertFalse(g.allows()) // nothing prepared yet
        g.open()
        assertTrue(g.allows())
        g.pause() // stop begins
        assertFalse(g.allows())
        g.open() // prepared and idle again
        assertTrue(g.allows())
        g.close() // released
        assertFalse(g.allows())
        g.pause()
        assertFalse(g.allows())
    }

    @Test
    fun guardOnlyReopensOnAnExplicitOpen() {
        val g = OrientationGuard()
        g.open(); g.close()
        assertFalse(g.allows())
        g.resume() // resume after a stop must not undo a release
        assertFalse(g.allows())
        g.open()
        g.pause()
        g.resume()
        assertTrue(g.allows())
    }

    // ---- K2: the engine's source wiring must never leak the camera address ----

    private val engineFiles = listOf("LiveEngine.kt", "LiveChannel.kt", "LiveService.kt", "ClapTest.kt", "LiveSourceLogic.kt")
        .map { java.io.File("src/main/kotlin/my/maxcom/app/live/$it") }

    @Test
    fun noLogLineOfTheEngineOrChannelMentionsTheCameraAddress() {
        val offenders = engineFiles.flatMap { f ->
            f.readLines().withIndex().filter { (_, line) ->
                val logs = line.contains("Log.") || line.contains("Diag.log") || line.contains("Diag.error")
                logs && (line.contains(".url") || line.contains("extCam") || line.contains("camera?.url") || line.contains("\$url"))
            }.map { "${f.name}:${it.index + 1}" }
        }
        assertTrue("a log line names the camera address: $offenders", offenders.isEmpty())
    }

    @Test
    fun theChannelAnswersEveryNewCallWithReasonCodesOnly() {
        val src = java.io.File("src/main/kotlin/my/maxcom/app/live/LiveChannel.kt").readText()
        for (m in listOf("setSource", "setMix", "setAvOffset", "clapCapture", "clapReplay", "clapOffset", "clapStop")) {
            assertTrue("channel handles $m", src.contains("\"$m\""))
        }
        // the address is read in one place and handed on; it is never put into a reply
        assertFalse(src.contains("result.success(mapOf(\"url\""))
    }

    // ---- 2026.11.15, D2: the recorder never saves or lists an empty file (B3, D5, U2, U9) ----

    private val engineSrc: String by lazy {
        listOf("src/main/kotlin/my/maxcom/app/live/LiveEngine.kt", "app/src/main/kotlin/my/maxcom/app/live/LiveEngine.kt")
            .map { java.io.File(it) }.first { it.exists() }.readText()
    }

    @Test
    fun aSegmentNameIsListedOnlyAfterTheFileWasProbed() {
        // B3: the name used to join the list at record start, before one byte existed
        val start = engineSrc.substringAfter("private fun startSegment()").substringBefore("private fun stopRecordBounded")
        assertFalse("startSegment must not list the name", start.contains("sessionNames.add"))
        val fin = engineSrc.substringAfter("private fun finalizeSegment(").substringBefore("fun awaitPublished")
        val probe = fin.indexOf("probeRecording(file)")
        val judge = fin.indexOf("RecordingGuard.judgeSegment(")
        val add = fin.indexOf("sessionNames.add(file.name)")
        val publish = fin.indexOf("publishToGallery(file)")
        assertTrue("probe, then judge, then list, then publish", probe in 0 until judge && judge < add && add < publish)
        // only the KEEP branch lists or publishes
        val discard = fin.substringAfter("SegmentVerdict.DISCARD ->")
        assertFalse(discard.contains("sessionNames.add"))
        assertFalse(discard.contains("publishToGallery"))
    }

    @Test
    fun theExternalCameraIsRenderedAtASteadyRateAndThePhoneCameraIsNot() {
        // B3, D5: without force render no decoded frame meant no encoded frame: an empty file and no lost overlay
        assertTrue(engineSrc.contains("setForceRender(videoKind == VideoKind.EXTERNAL, 30)"))
        val prepare = engineSrc.substringAfter("fun prepare(front: Boolean").substringBefore("fun reframe()")
        assertTrue(prepare.contains("applyForceRender()"))
        val switch = engineSrc.substringAfter("fun setSource(spec: SourceSpec)").substringBefore("private fun releaseQuietly")
        assertTrue(switch.contains("applyForceRender()"))
    }

    @Test
    fun aSegmentIsNeverClosedOnTheMainThreadWhileTheLiveRuns() {
        // U9: the rotation and the battery/storage halts used to block the main thread for up to ten seconds
        val rotate = engineSrc.substringAfter("private val rotate = Runnable {").substringBefore("private fun segmentSourceFrames")
        assertTrue(rotate.contains("finishSegmentAsync("))
        assertFalse(rotate.contains("finishSegmentBlocking("))
        val device = engineSrc.substringAfter("private fun checkDevice()")
        assertFalse(device.contains("finishSegmentBlocking("))
        assertEquals(2, Regex("finishSegmentAsync\\(s\\)").findAll(device).count())
        // the one blocking close left is the synchronous stop (a failed start, a release)
        assertEquals(1, Regex("finishSegmentBlocking\\(s\\)").findAll(engineSrc.substringBefore("private fun finishSegmentBlocking")).count())
    }

    @Test
    fun theStopIsAnsweredOnlyAfterTheLastFileWasJudged() {
        // U2: the app asks for the names of the live right after stop
        val complete = engineSrc.substringAfter("private fun completeStop(").substringBefore("private fun settleStop")
        val finalize = complete.indexOf("finalizeSegment(file, frames)")
        val settle = complete.indexOf("settleStop(")
        assertTrue(finalize in 0 until settle)
        val settleBody = engineSrc.substringAfter("private fun settleStop(").substringBefore("/** Synchronous stop")
        assertTrue(settleBody.contains("stopWaiters"))
    }
}
