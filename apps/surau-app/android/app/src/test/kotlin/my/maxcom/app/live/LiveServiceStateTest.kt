package my.maxcom.app.live

import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 2026.11.15, D1 (B9 native half, C8, N1, B12): the service owns the session, answers `status`, replays the present
 * state to a screen that attaches later, survives a refused refresh and ends a live nobody watches.
 */
class LiveServiceStateTest {
    private fun facts(id: String = "S1", youtube: Boolean = false, video: VideoKind = VideoKind.EXTERNAL) =
        LiveSessionFacts(id, 1_700_000_000_000, kiosk = true, youtube = youtube, video = video, recording = true)

    private fun src(name: String) = listOf("src/main/kotlin/my/maxcom/app/live/$name", "app/src/main/kotlin/my/maxcom/app/live/$name")
        .map(::File).first { it.exists() }.readText()

    // ---- status ----

    @Test
    fun statusAfterAChannelReattachReturnsTheRunningSession() {
        // B9: the facts live in the holder, not in the channel; a new channel (a new screen) reads the same live
        val holder = LiveSessionHolder()
        holder.begin(facts())
        // ... the screen goes away, the engine keeps sending, a new screen asks:
        val st = holder.status(streaming = true, recordings = listOf("MAXCOM-2026-11-23-2000-siaran-01.mp4"))
        assertNotNull(st)
        assertEquals("S1", st!!["sessionId"])
        assertEquals(1_700_000_000_000, st["startedAt"])
        assertEquals(true, st["streaming"])
        assertEquals(true, st["kiosk"])
        assertEquals(false, st["youtube"])
        assertEquals("external", st["video"])
        assertEquals(true, st["recording"])
        assertEquals(listOf("MAXCOM-2026-11-23-2000-siaran-01.mp4"), st["recordings"])
    }

    @Test
    fun statusIsNullWithNoLiveAndAfterTheLiveEnded() {
        val holder = LiveSessionHolder()
        assertNull(holder.status(false, emptyList()))
        holder.begin(facts())
        holder.end()
        assertNull(holder.status(false, emptyList()))
    }

    @Test
    fun theFactsFollowTheLive() {
        val holder = LiveSessionHolder()
        holder.begin(facts(id = ""))
        assertEquals("", holder.status(true, emptyList())!!["sessionId"])
        holder.setSessionId("S9") // the app learned the id after the engine started
        holder.youtubeOpened()
        holder.videoChanged(VideoKind.PHONE)
        val st = holder.status(true, emptyList())!!
        assertEquals("S9", st["sessionId"])
        assertEquals(true, st["youtube"])
        assertEquals("phone", st["video"])
        // with no live held nothing is invented
        holder.end()
        holder.setSessionId("S10")
        holder.youtubeOpened()
        assertNull(holder.facts)
    }

    @Test
    fun theStatusAnswerCarriesNoSecret() {
        val holder = LiveSessionHolder()
        holder.begin(facts())
        val st = holder.status(true, emptyList())!!
        assertEquals(setOf("sessionId", "startedAt", "streaming", "youtube", "kiosk", "video", "recording", "recordings"), st.keys)
        assertFalse(facts().toString().contains("S1"))
        // an id that is not a plain handle (an address, a key) is not kept
        assertEquals("", LiveSessionHolder.cleanId("srt://192.0.2.1:8890?passphrase=x"))
        assertEquals("", LiveSessionHolder.cleanId("a".repeat(101)))
        assertEquals("", LiveSessionHolder.cleanId(null))
        assertEquals("01JABC-def_9", LiveSessionHolder.cleanId(" 01JABC-def_9 "))
    }

    // ---- replay on attach ----

    @Test
    fun aScreenThatAttachesDuringALiveIsToldThePresentState() {
        val r = EventReplay()
        r.onPhase("starting")
        r.onOutput(mapOf("type" to "output", "name" to "kiosk", "state" to "connecting"))
        r.onPhase("live")
        r.onOutput(mapOf("type" to "output", "name" to "kiosk", "state" to "up"))
        r.onOutput(mapOf("type" to "output", "name" to "youtube", "state" to "retrying", "retryInSec" to 4))
        r.onMicRouted(mapOf("type" to "micRouted", "id" to "own"))
        val rec = mapOf("type" to "recording", "segments" to 2, "bytes" to 10L, "lastError" to null)
        val ev = r.events(listOf("lowBattery"), rec)
        assertEquals(mapOf("type" to "phase", "value" to "live"), ev.first())
        assertEquals(listOf("phase", "output", "output", "recording", "warning", "micRouted"), ev.map { it["type"] })
        assertEquals("up", ev[1]["state"]) // the LAST word about each leg, once
        assertEquals("youtube", ev[2]["name"])
        assertEquals(mapOf("type" to "warning", "kind" to "lowBattery", "active" to true), ev[4])
        assertTrue(r.isUp("kiosk"))
        assertFalse(r.isUp("youtube"))
    }

    @Test
    fun afterAStopTheLegsAreForgotten() {
        val r = EventReplay()
        r.onPhase("live")
        r.onOutput(mapOf("type" to "output", "name" to "kiosk", "state" to "up"))
        r.onPhase("stopped")
        assertFalse(r.isUp("kiosk"))
        assertEquals(listOf(mapOf("type" to "phase", "value" to "stopped")), r.events(emptyList(), null))
    }

    @Test
    fun theChannelReplaysOnListenAndAnswersStatusFromTheService() {
        val ch = src("LiveChannel.kt")
        assertTrue(ch.contains("engine.replayState()"))
        assertTrue(ch.contains("\"status\" -> result.success(LiveService.session.status("))
        assertTrue(ch.contains("\"setSession\""))
    }

    // ---- C8: a refused refresh keeps the service ----

    @Test
    fun aRefusedRefreshKeepsTheService() {
        assertEquals(LiveForeground.Refused.KEEP, LiveForeground.onRefused(alreadyForeground = true))
        assertEquals(LiveForeground.Refused.STOP, LiveForeground.onRefused(alreadyForeground = false))
    }

    @Test
    fun theServiceIsOnlyTouchedWhenTheTypesChange() {
        val mic = LiveForeground.types(ForegroundNeeds(camera = false, microphone = true, external = true), 34)
        val device = LiveForeground.types(ForegroundNeeds(camera = false, microphone = false, external = true), 34)
        assertFalse("a volume change sends nothing", LiveForeground.needsRefresh(mic, mic))
        assertTrue("the microphone was taken out of the mix", LiveForeground.needsRefresh(mic, device))
        assertTrue("not in the foreground yet", LiveForeground.needsRefresh(null, mic))
    }

    @Test
    fun theServiceDoesNotStopItselfOnARefusedRefreshAndIsNotSticky() {
        val s = src("LiveService.kt")
        // the one stopSelf() of the foreground path sits under the STOP verdict
        val keep = s.substringAfter("LiveForeground.Refused.KEEP ->").substringBefore("LiveForeground.Refused.STOP ->")
        assertFalse(keep.contains("stopSelf"))
        assertTrue(s.substringAfter("LiveForeground.Refused.STOP ->").contains("stopSelf()"))
        assertFalse("a restarted empty process cannot rebuild a live", s.contains("return START_STICKY"))
        assertTrue(s.contains("override fun onTaskRemoved"))
        assertTrue(s.contains("createWifiLock"))
    }

    @Test
    fun theNotificationOffersToStopTheLiveInMalay() {
        assertEquals("Hentikan siaran", LiveService.STOP_LABEL)
        val s = src("LiveService.kt")
        assertTrue(s.contains(".addAction("))
        assertTrue(s.contains("StopPath.NOTIFICATION"))
        assertEquals("notification_stop", StopPath.REASON_NOTIFICATION)
    }

    // ---- 3.2 item 4: a live nobody watches ends by itself ----

    @Test
    fun anUnattendedLiveEndsAfterTenMinutesWithoutTheBox() {
        val rule = UnattendedRule()
        val min = 60_000L
        assertFalse(rule.shouldEnd(uiAttached = false, kioskWanted = true, kioskUp = false, nowMs = 1 * min))
        assertFalse(rule.shouldEnd(false, true, false, 10 * min))
        assertTrue(rule.shouldEnd(false, true, false, 11 * min))
        // said once: the count starts again
        assertFalse(rule.shouldEnd(false, true, false, 11 * min + 2000))
    }

    @Test
    fun aScreenALegThatIsUpOrALiveWithoutTheBoxLegNeverEnds() {
        val min = 60_000L
        val attached = UnattendedRule()
        for (t in 1..30) assertFalse(attached.shouldEnd(uiAttached = true, kioskWanted = true, kioskUp = false, nowMs = t * min))
        val up = UnattendedRule()
        for (t in 1..30) assertFalse(up.shouldEnd(false, true, kioskUp = true, nowMs = t * min))
        val youtubeOnly = UnattendedRule()
        for (t in 1..30) assertFalse(youtubeOnly.shouldEnd(false, kioskWanted = false, kioskUp = false, nowMs = t * min))
    }

    @Test
    fun aLegThatComesBackStartsTheCountAgain() {
        val rule = UnattendedRule()
        val min = 60_000L
        assertFalse(rule.shouldEnd(false, true, false, 1 * min))
        assertFalse(rule.shouldEnd(false, true, false, 9 * min))
        assertFalse(rule.shouldEnd(false, true, true, 10 * min)) // the box is reached again
        assertFalse(rule.shouldEnd(false, true, false, 11 * min))
        assertFalse(rule.shouldEnd(false, true, false, 20 * min))
        assertTrue(rule.shouldEnd(false, true, false, 21 * min))
    }

    // ---- B12, N1: every stop has a path name, the engine is released ----

    @Test
    fun everyStopPathWritesItsNameAndEndsTheSession() {
        val e = src("LiveEngine.kt")
        assertTrue(e.contains("Diag.log(\"stop_path\", \"path=\$path\")"))
        for (p in listOf("StopPath.CAMERA_LOST", "StopPath.UNATTENDED", "StopPath.START_FAILED", "StopPath.RELEASE")) {
            assertTrue("$p is named", e.contains(p))
        }
        assertEquals(
            setOf("screen", "notification", "camera_lost", "unattended", "start_failed", "release"),
            setOf(StopPath.SCREEN, StopPath.NOTIFICATION, StopPath.CAMERA_LOST, StopPath.UNATTENDED, StopPath.START_FAILED, StopPath.RELEASE),
        )
        // N1: release() has a caller now, and the screen-on flag is cleared on every end
        assertTrue(e.contains("fun releaseIfIdle()"))
        assertTrue(Regex("releaseIfIdle\\(\\)").findAll(e).count() >= 3)
        assertTrue(src("LiveChannel.kt").contains("engine.onLiveEnded = { channel.keepScreenOn(false) }"))
    }

    // ---- C9: what a live asks the person for ----

    @Test
    fun anExternalOnlyLiveAsksForNoCameraPermission() {
        assertEquals(emptyList<LivePermission>(), SourceLogic.permissionsFor(VideoKind.EXTERNAL, phoneMicInMix = false))
        assertEquals(listOf(LivePermission.MICROPHONE), SourceLogic.permissionsFor(VideoKind.EXTERNAL, phoneMicInMix = true))
        // success path unchanged: the phone camera still asks for both
        assertEquals(listOf(LivePermission.CAMERA, LivePermission.MICROPHONE), SourceLogic.permissionsFor(VideoKind.PHONE, false))
    }

    @Test
    fun aSecondStartNeverStopsTheServiceOfTheRunningLive() {
        val ch = src("LiveChannel.kt")
        val start = ch.substringAfter("private fun start(call: MethodCall")
        val guard = start.indexOf("if (engine.live)")
        val service = start.indexOf("LiveService.start(")
        assertTrue("the live check comes before the service is touched", guard in 0 until service)
    }
}
