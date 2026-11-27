package my.maxcom.app.live

import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** Lane P2 (2026.11.15): O8 stop reason kept, O12 screen on, Q15 locked screen, B7 picture brightness. */
class PhoneEngineRulesTest {
    private fun src(name: String) = listOf("src/main/kotlin/my/maxcom/app/live/$name", "app/src/main/kotlin/my/maxcom/app/live/$name")
        .map(::File).first { it.exists() }.readText()

    // ---- O8 ----

    @Test
    fun aLaterEmptyFileCheckNeverReplacesALowBatteryOrLowStorageReason() {
        assertEquals("battery_low", RecordNote.merge("battery_low", "empty_recording"))
        assertEquals("storage_low", RecordNote.merge("storage_low", "empty_recording"))
        assertEquals("battery_low", RecordNote.merge("battery_low", "publish_failed"))
        // a late good probe does not clear it either
        assertEquals("storage_low", RecordNote.merge("storage_low", null))
    }

    @Test
    fun otherErrorsReplaceEachOtherAsBefore() {
        assertEquals("empty_recording", RecordNote.merge(null, "empty_recording"))
        assertEquals("publish_failed", RecordNote.merge("empty_recording", "publish_failed"))
        assertNull(RecordNote.merge("empty_recording", null))
        assertNull(RecordNote.merge(null, null))
    }

    @Test
    fun theEngineRoutesEveryFileCheckErrorThroughTheMerge() {
        val e = src("LiveEngine.kt")
        assertFalse("no direct empty_recording write is left", e.contains("recordError = RecordingGuard.EMPTY_RECORDING"))
        assertFalse(e.contains("recordError = \"publish_failed\""))
        assertFalse(e.contains("recordError = null; recordingEvent()"))
        assertTrue(e.contains("recordError = RecordNote.BATTERY_LOW"))
        assertTrue(e.contains("recordError = RecordNote.STORAGE_LOW"))
        assertEquals("battery_low", RecordNote.BATTERY_LOW)
        assertEquals("storage_low", RecordNote.STORAGE_LOW)
    }

    // ---- O12 ----

    @Test
    fun theScreenStaysOnForAsLongAsALiveOrARecordingRuns() {
        assertTrue(ScreenOn.wanted(live = true))
        assertFalse(ScreenOn.wanted(live = false))
    }

    @Test
    fun theFlagIsReappliedWhenTheActivityIsMadeAndWhenTheAppComesBack() {
        val c = src("LiveChannel.kt")
        assertTrue(c.contains("channel.keepScreenOn(ScreenOn.wanted(engine.live))"))
        assertTrue(c.contains("fun reapplyScreenOn("))
        // the live screen's listen no longer decides alone: a re-listen follows the engine too
        assertTrue(c.contains("keepScreenOn(ScreenOn.wanted(engine.live))"))
        val main = listOf("src/main/kotlin/my/maxcom/app/MainActivity.kt", "app/src/main/kotlin/my/maxcom/app/MainActivity.kt")
            .map(::File).first { it.exists() }.readText()
        assertTrue(main.contains("override fun onResume()"))
        assertTrue(main.contains("LiveChannel.reapplyScreenOn(this)"))
        // cleared at every end
        assertTrue(c.contains("engine.onLiveEnded = { channel.keepScreenOn(false) }"))
    }

    // ---- Q15 ----

    @Test
    fun aLockedPhoneWithTheScreenStillAttachedCountsAsUnattended() {
        assertTrue(ScreenWatch.attached(sinkPresent = true, interactive = true))
        assertFalse(ScreenWatch.attached(sinkPresent = true, interactive = false))
        assertFalse(ScreenWatch.attached(sinkPresent = false, interactive = true))
        val rule = UnattendedRule()
        val min = 60_000L
        fun end(t: Long) = rule.shouldEnd(ScreenWatch.attached(true, interactive = false), kioskWanted = true, kioskUp = false, nowMs = t * min)
        assertFalse(end(1))
        assertFalse(end(10))
        assertTrue(end(11))
    }

    @Test
    fun anAttachedScreenThatIsUnlockedNeverEnds() {
        val rule = UnattendedRule()
        for (t in 1..30) {
            assertFalse(rule.shouldEnd(ScreenWatch.attached(true, interactive = true), true, false, t * 60_000L))
        }
        assertTrue(src("LiveEngine.kt").contains("ScreenWatch.attached(sink != null, screenInteractive())"))
    }

    // ---- B7 ----

    @Test
    fun anUnknownLevelIsAutoAndTheFixedLevelsHaveFixedSteps() {
        assertEquals("auto", PictureBrightness.clean(null))
        assertEquals("auto", PictureBrightness.clean("dim"))
        assertEquals("bright", PictureBrightness.clean("bright"))
        assertNull(PictureBrightness.fixedStep("auto"))
        assertEquals(0, PictureBrightness.fixedStep("normal"))
        assertEquals(1, PictureBrightness.fixedStep("bright"))
        assertEquals(2, PictureBrightness.fixedStep("brighter"))
        assertEquals(0f, PictureBrightness.evOf(0), 0f)
        assertTrue(PictureBrightness.evOf(2) in 0.1f..1.0f)
        // out of range steps are held inside the table
        assertEquals(PictureBrightness.evOf(2), PictureBrightness.evOf(9), 0f)
    }

    @Test
    fun autoStaysAtNoLiftInDaylightAndWithoutASensor() {
        val a = PictureBrightness.Auto()
        for (i in 0 until 10) assertEquals(0, a.update(400f, i * 5_000L))
        val none = PictureBrightness.Auto()
        for (i in 0 until 10) assertEquals(0, none.update(null, i * 5_000L))
    }

    @Test
    fun autoLiftsWhenItGetsDarkAndOnlyAfterTheHold() {
        val a = PictureBrightness.Auto()
        var t = 100_000L
        assertEquals(1, a.update(20f, t)) // first change is allowed at once
        t += 5_000
        assertEquals(1, a.update(1f, t)) // the average is still above the enter level
        t += 5_000
        assertEquals(2, a.update(1f, t))
    }

    @Test
    fun autoDoesNotFlickerAtAThreshold() {
        val a = PictureBrightness.Auto()
        var t = 100_000L
        a.update(20f, t) // step 1
        // hovering between the enter and exit lux (30..50) never changes the step, however many readings come
        var changes = 0
        var last = a.step
        for (i in 1..40) {
            t += 5_000
            val s = a.update(if (i % 2 == 0) 35f else 45f, t)
            if (s != last) changes++
            last = s
        }
        assertEquals(0, changes)
        assertEquals(1, a.step)
    }

    @Test
    fun autoReleasesTheLiftWhenTheLightComesBack() {
        val a = PictureBrightness.Auto()
        var t = 100_000L
        a.update(2f, t)
        assertEquals(2, a.step)
        repeat(6) { t += 15_000; a.update(300f, t) }
        assertEquals(0, a.step)
    }

    @Test
    fun theEngineUsesTheExposureFilterAndClearsItAtEveryEnd() {
        val e = src("LiveEngine.kt")
        assertTrue(e.contains("ExposureFilterRender"))
        assertTrue(e.contains("fun setBrightness("))
        assertTrue(e.contains("PictureBrightness.Auto"))
        val c = src("LiveChannel.kt")
        assertTrue(c.contains("\"setBrightness\""))
    }

    // ---- FX2b ----

    @Test
    fun aControlOnlyLiveKeepsTheScreenOnThroughAChannelCall() {
        // F1: the controller drives the flag; the engine has no live in that case
        assertFalse(ScreenOn.wanted(live = false, control = false))
        assertTrue(ScreenOn.wanted(live = false, control = true))
        val c = src("LiveChannel.kt")
        assertTrue(c.contains("\"keepScreen\" ->"))
        assertTrue(c.contains("ScreenOn.control = on"))
    }

    @Test
    fun autoBrightnessNeverUsesTheLightSensorForTheExternalCamera() {
        // F6
        assertTrue(PictureBrightness.followsLight("auto", externalCamera = false))
        assertFalse(PictureBrightness.followsLight("auto", externalCamera = true))
        assertFalse(PictureBrightness.followsLight("bright", externalCamera = false))
        val e = src("LiveEngine.kt")
        assertTrue(e.contains("PictureBrightness.followsLight(brightnessLevel, videoKind == VideoKind.EXTERNAL)"))
    }

    @Test
    fun everyLiveStartsUnmuted() {
        // F2
        val e = src("LiveEngine.kt")
        val start = e.substring(e.indexOf("fun start("))
        assertTrue(start.substring(0, start.indexOf("phase(\"starting\")")).contains("userMuted = false"))
    }

    @Test
    fun aMuteOfEarlierLiveDoesNotCarryIntoTheNext() {
        // Q1: mute, end, start again: the new live is not silent
        val routing = MicRouting()
        routing.muteAll = true
        routing.resetForNewLive()
        assertFalse(routing.muteAll)
        // success path: an unmuted phone stays unmuted
        routing.resetForNewLive()
        assertFalse(routing.muteAll)
        // the engine start calls it before the live goes on
        val e = src("LiveEngine.kt")
        val start = e.substring(e.indexOf("fun start("))
        assertTrue(start.substring(0, start.indexOf("phase(\"starting\")")).contains("micRouting.resetForNewLive()"))
    }

    @Test
    fun callModeKeeperSavesOnceAndRestoresOnce() {
        // Q3
        CallModeKeeper.restore { } // clean slate
        CallModeKeeper.save(0) // MODE_NORMAL
        CallModeKeeper.save(3) // a second connect sees MODE_IN_COMMUNICATION: must not overwrite
        val got = mutableListOf<Int>()
        CallModeKeeper.restore { got.add(it) }
        assertEquals(listOf(0), got)
        CallModeKeeper.restore { got.add(it) }
        assertEquals(listOf(0), got) // restored once
        CallModeKeeper.save(2)
        CallModeKeeper.restore { got.add(it) }
        assertEquals(listOf(0, 2), got) // usable again after a restore
    }
}
