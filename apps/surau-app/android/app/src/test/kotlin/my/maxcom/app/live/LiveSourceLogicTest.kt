package my.maxcom.app.live

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** Pure rules of the source wiring (K2): the mix, the lost camera, the letterbox, the SPS size, the events. */
class LiveSourceLogicTest {
    // ---- helpers ----

    private fun mix(
        cam: Pair<Boolean, Int>? = null,
        mic: Pair<Boolean, Int>? = null,
        box: Pair<Boolean, Int>? = null,
        video: VideoKind = VideoKind.EXTERNAL,
    ): AudioMixCfg {
        val d = AudioMixCfg.default(video)
        return AudioMixCfg(
            cam?.let { MixEntry(it.first, it.second) } ?: d.camera,
            mic?.let { MixEntry(it.first, it.second) } ?: d.deviceMic,
            box?.let { MixEntry(it.first, it.second) } ?: d.boxInput,
        )
    }

    // ---- the mix from the channel ----

    @Test
    fun defaultMixIsTodaysFlowForThePhoneAndTheCameraSoundForTheCamera() {
        val phone = AudioMixCfg.default(VideoKind.PHONE)
        assertTrue(phone.deviceMic.enabled)
        assertFalse(phone.camera.enabled)
        val ext = AudioMixCfg.default(VideoKind.EXTERNAL)
        assertTrue(ext.camera.enabled)
        assertFalse(ext.deviceMic.enabled)
        assertFalse(ext.boxInput.enabled)
        assertEquals(100, ext.camera.volume)
    }

    @Test
    fun mixFromMapClampsVolumesToStepsOfFiveAndKeepsDefaultsForBadParts() {
        val m = AudioMixCfg.fromMap(
            mapOf(
                "camera" to mapOf("enabled" to true, "volume" to 42),
                "deviceMic" to mapOf("enabled" to true, "volume" to 250),
                "boxInput" to "garbage",
            ),
            VideoKind.EXTERNAL,
        )
        assertEquals(40, m.camera.volume)
        assertEquals(100, m.deviceMic.volume)
        assertTrue(m.deviceMic.enabled)
        assertFalse(m.boxInput.enabled)
        assertEquals(100, m.boxInput.volume)
        val none = AudioMixCfg.fromMap(null, VideoKind.PHONE)
        assertTrue(none.deviceMic.enabled)
    }

    @Test
    fun specFromReadsKindUrlTransportMixAndOffset() {
        val spec = SourceLogic.specFrom(
            mapOf("kind" to "external", "url" to " rtsp://u:p@10.168.1.20:554/s ", "transport" to "udp"),
            mapOf("camera" to mapOf("enabled" to true, "volume" to 60)),
            730,
        )
        assertEquals(VideoKind.EXTERNAL, spec.video)
        assertEquals("rtsp://u:p@10.168.1.20:554/s", spec.camera?.url)
        assertEquals(TransportMode.UDP, spec.camera?.transport)
        assertEquals(60, spec.mix.camera.volume)
        assertEquals(750, spec.avOffsetMs) // steps of 50
    }

    @Test
    fun specFromWithNoAddressHasNoCameraAndAPhoneKindIgnoresTheAddress() {
        assertNull(SourceLogic.specFrom(mapOf("kind" to "external"), null, null).camera)
        val phone = SourceLogic.specFrom(mapOf("kind" to "phone", "url" to "rtsp://10.168.1.20/s"), null, null)
        assertEquals(VideoKind.PHONE, phone.video)
        assertNull(phone.camera)
        assertEquals(VideoKind.PHONE, SourceLogic.specFrom(null, null, null).video)
    }

    @Test
    fun theCameraAddressNeverPrintsItsPassword() {
        val c = ExternalCamera("rtsp://admin:s3cret@10.168.1.20:554/s", TransportMode.AUTO)
        val text = c.toString()
        assertFalse(text, text.contains("s3cret"))
        assertTrue(text.contains("10.168.1.20"))
    }

    // ---- the phone mixer settings and "Mic-in only" ----

    @Test
    fun cameraAndMicVolumesPassThroughWhenSomethingIsAudible() {
        val s = SourceLogic.mixSettings(mix(cam = true to 40, mic = true to 80))
        assertEquals(40, s.cameraVolume)
        assertEquals(80, s.micVolume)
        assertTrue(s.micEnabled)
        assertFalse(s.referenceForced)
    }

    @Test
    fun micOnlyIsCameraVolumeZeroAndStaysZeroWithoutMicIn() {
        val s = SourceLogic.mixSettings(mix(cam = true to 0, mic = true to 100))
        assertEquals(0, s.cameraVolume)
        assertFalse(s.referenceForced)
    }

    @Test
    fun micInOnlySendsTheReferenceAtFullLevel() {
        // every phone-side sound at 0, Mic-in added: the camera sound (the reference) is sent at 100 for the box to align
        val s = SourceLogic.mixSettings(mix(cam = true to 0, mic = false to 100, box = true to 100))
        assertTrue(s.referenceForced)
        assertEquals(100, s.cameraVolume)
        assertFalse(s.micEnabled)
    }

    @Test
    fun micInOnlyKeepsAnAddedPhoneMicAtItsOwnZero() {
        val s = SourceLogic.mixSettings(mix(cam = true to 0, mic = true to 0, box = true to 100))
        assertTrue(s.referenceForced)
        assertEquals(100, s.cameraVolume)
        assertEquals(0, s.micVolume) // only the reference is lifted
    }

    @Test
    fun micInWithAnAudiblePhoneSideIsNotForced() {
        assertFalse(SourceLogic.mixSettings(mix(cam = true to 0, mic = true to 60, box = true to 100)).referenceForced)
        assertFalse(SourceLogic.mixSettings(mix(cam = true to 30, mic = false to 100, box = true to 100)).referenceForced)
    }

    @Test
    fun aCameraWithNoAudioHasNoReferenceToForce() {
        val s = SourceLogic.mixSettings(mix(cam = true to 0, mic = false to 100, box = true to 100), cameraHasAudio = false)
        assertFalse(s.referenceForced)
        assertEquals(0, s.cameraVolume)
    }

    @Test
    fun noMicInNeverForcesAnything() {
        val s = SourceLogic.mixSettings(mix(cam = true to 0, mic = false to 100))
        assertFalse(s.referenceForced)
        assertEquals(0, s.cameraVolume)
    }

    @Test
    fun phoneCameraMuteIsLiftedOnlyWhileMicInIsAdded() {
        val withBox = mix(box = true to 100, video = VideoKind.PHONE)
        val without = mix(video = VideoKind.PHONE)
        assertTrue(SourceLogic.effectiveMuted(true, without))
        assertFalse(SourceLogic.effectiveMuted(true, withBox))
        assertFalse(SourceLogic.effectiveMuted(false, withBox))
        assertFalse(SourceLogic.effectiveMuted(false, without))
    }

    // ---- lost camera ----

    @Test
    fun lostCameraWithAnUnalignedMicPlaysTheMicByMutingTheAbsentCameraSound() {
        assertEquals(0, SourceLogic.effectiveCameraVolume(70, linkLost = true, micEnabled = true, micAligned = false))
        // aligned before: the camera volume is kept (the camera sound is just absent) and rejoins by itself
        assertEquals(70, SourceLogic.effectiveCameraVolume(70, linkLost = true, micEnabled = true, micAligned = true))
        assertEquals(70, SourceLogic.effectiveCameraVolume(70, linkLost = false, micEnabled = true, micAligned = false))
        assertEquals(70, SourceLogic.effectiveCameraVolume(70, linkLost = true, micEnabled = false, micAligned = false))
    }

    @Test
    fun tenMinutesLostEndsTheLiveAndNothingBeforeThat() {
        val t0 = 1_000_000L
        assertFalse(SourceLogic.lostExpired(0, t0 + 99_999_999))
        assertFalse(SourceLogic.lostExpired(t0, t0 + SourceLogic.LOST_STOP_MS - 1))
        assertTrue(SourceLogic.lostExpired(t0, t0 + SourceLogic.LOST_STOP_MS))
        assertEquals(600_000L, SourceLogic.LOST_STOP_MS)
    }

    @Test
    fun theTenMinutesNeverStartBeforeTheLiveDid() {
        val liveStart = 5_000_000L
        // the camera was already lost 12 minutes before the live was started
        val base = SourceLogic.lostBase(liveStart - 12 * 60_000L, liveStart)
        assertEquals(liveStart, base)
        assertFalse(SourceLogic.lostExpired(base, liveStart + 60_000L))
        assertTrue(SourceLogic.lostExpired(base, liveStart + SourceLogic.LOST_STOP_MS))
        assertEquals(0L, SourceLogic.lostBase(0, liveStart))
        // lost during the live: from the loss
        assertEquals(liveStart + 30_000L, SourceLogic.lostBase(liveStart + 30_000L, liveStart))
    }

    @Test
    fun lostSecondsCountsFromTheLoss() {
        assertEquals(0, SourceLogic.lostSeconds(0, 10_000))
        assertEquals(120, SourceLogic.lostSeconds(10_000, 130_500))
        assertEquals(0, SourceLogic.lostSeconds(10_000, 9_000))
    }

    @Test
    fun theLostMessageIsTheAcceptedWording() {
        assertEquals("Siaran akan bersambung sebentar lagi", SourceLogic.LOST_MESSAGE)
        assertEquals("camera_lost", SourceLogic.ENDED_CAMERA_LOST)
    }

    // ---- letterbox ----

    @Test
    fun aSixteenNineCameraNeedsNoLetterbox() {
        assertNull(SourceLogic.letterbox(1920, 1080, 1280, 720))
        assertNull(SourceLogic.letterbox(2560, 1440, 1280, 720))
    }

    @Test
    fun aFourThreeCameraGetsBarsAtTheSides() {
        val v = SourceLogic.letterbox(1440, 1080, 1280, 720)
        assertNotNull(v)
        assertArrayEquals(intArrayOf(160, 0, 960, 720), v)
    }

    @Test
    fun aTallerCameraGetsBarsAtTheTopAndBottom() {
        val v = SourceLogic.letterbox(1280, 1280, 1280, 720)!!
        assertArrayEquals(intArrayOf(280, 0, 720, 720), v)
        // wider than 16:9: bars above and below
        val w = SourceLogic.letterbox(2560, 720, 1280, 720)!!
        assertEquals(1280, w[2])
        assertEquals(360, w[3])
        assertEquals(180, w[1])
    }

    @Test
    fun letterboxKeepsTheCameraShapeInsideThePreview() {
        val v = SourceLogic.letterbox(1280, 960, 411, 231)!!
        assertEquals(231, v[3])
        assertEquals(308, v[2]) // 4:3 of 231
        assertEquals((411 - 308) / 2, v[0])
    }

    @Test
    fun letterboxWithAnUnknownSizeIsNull() {
        assertNull(SourceLogic.letterbox(0, 0, 1280, 720))
        assertNull(SourceLogic.letterbox(1440, 1080, 0, 0))
    }

    // ---- SPS size ----

    /** Builds a parameter set bit by bit (with the 00 00 03 emulation prevention) so the parser is checked against what it must read. */
    private class Bits {
        private val bits = ArrayList<Int>()

        fun u(v: Int, n: Int): Bits {
            for (i in n - 1 downTo 0) bits.add((v shr i) and 1)
            return this
        }

        fun ue(v: Int): Bits {
            val x = v + 1
            val len = 32 - Integer.numberOfLeadingZeros(x)
            u(0, len - 1)
            u(x, len)
            return this
        }

        fun se(v: Int): Bits = ue(if (v > 0) 2 * v - 1 else -2 * v)

        fun bytes(vararg header: Int): ByteArray {
            val raw = java.io.ByteArrayOutputStream()
            header.forEach { raw.write(it) }
            val body = ArrayList<Int>(bits)
            body.add(1) // rbsp stop bit
            while (body.size % 8 != 0) body.add(0)
            val payload = ByteArray(body.size / 8) { i -> var b = 0; for (k in 0 until 8) b = (b shl 1) or body[i * 8 + k]; b.toByte() }
            var zeros = 0
            for (b in payload) {
                val v = b.toInt() and 0xFF
                if (zeros >= 2 && v <= 3) {
                    raw.write(3)
                    zeros = 0
                }
                raw.write(v)
                zeros = if (v == 0) zeros + 1 else 0
            }
            return raw.toByteArray()
        }
    }

    private fun h264(profile: Int, wMbs: Int, hMapUnits: Int, frameMbsOnly: Int, crop: IntArray? = null, chroma: Int = 1): ByteArray {
        val b = Bits().u(profile, 8).u(0, 8).u(40, 8).ue(0)
        if (profile in setOf(100, 110, 122, 244)) {
            b.ue(chroma)
            if (chroma == 3) b.u(0, 1)
            b.ue(0).ue(0).u(0, 1).u(0, 1)
        }
        b.ue(0) // log2_max_frame_num_minus4
        b.ue(2) // poc type 2
        b.ue(1).u(0, 1)
        b.ue(wMbs - 1).ue(hMapUnits - 1).u(frameMbsOnly, 1)
        if (frameMbsOnly == 0) b.u(0, 1)
        b.u(1, 1)
        if (crop != null) {
            b.u(1, 1)
            crop.forEach { b.ue(it) }
        } else {
            b.u(0, 1)
        }
        b.u(0, 1) // vui
        return b.bytes(0x67)
    }

    @Test
    fun h264FullHdWithTheBottomCropped() {
        val sps = h264(100, 120, 68, 1, crop = intArrayOf(0, 0, 0, 4))
        assertEquals(1920 to 1080, SpsSize.parse(sps, false))
    }

    @Test
    fun h264BaselineFourThree() {
        assertEquals(640 to 480, SpsSize.parse(h264(66, 40, 30, 1), false))
    }

    @Test
    fun h264FourThreeHighProfile() {
        assertEquals(1440 to 1080, SpsSize.parse(h264(100, 90, 68, 1, crop = intArrayOf(0, 0, 0, 4)), false))
    }

    @Test
    fun h264InterlacedFieldsDoubleTheHeight() {
        // 34 map units of 16 lines, two fields each: 1088 coded lines, 4 crop units of 4 lines = 16... use 2 units = 8
        assertEquals(1920 to 1080, SpsSize.parse(h264(100, 120, 34, 0, crop = intArrayOf(0, 0, 0, 2)), false))
    }

    @Test
    fun h264With422ChromaCropsInItsOwnUnits() {
        assertEquals(1920 to 1080, SpsSize.parse(h264(122, 120, 68, 1, crop = intArrayOf(0, 0, 0, 8), chroma = 2), false))
    }

    @Test
    fun aStartCodeInFrontOfTheSpsIsSkipped() {
        val sps = h264(100, 120, 68, 1, crop = intArrayOf(0, 0, 0, 4))
        assertEquals(1920 to 1080, SpsSize.parse(byteArrayOf(0, 0, 0, 1) + sps, false))
        assertEquals(1920 to 1080, SpsSize.parse(byteArrayOf(0, 0, 1) + sps, false))
    }

    @Test
    fun emulationPreventionBytesDoNotShiftTheFields() {
        // A hand-made run of zero bits: the writer inserts the 03 byte, the parser must take it out again.
        val raw = Bits().u(0, 16).u(0, 8).u(0x21, 8).bytes(0x67)
        assertTrue("writer inserted 00 00 03", raw.toList().windowed(3).any { it == listOf<Byte>(0, 0, 3) })
        val sps = h264(100, 256, 135, 1)
        assertEquals(4096 to 2160, SpsSize.parse(sps, false))
    }

    private fun h265(maxSub: Int, w: Int, h: Int, crop: IntArray? = null, chroma: Int = 1, subProfile: BooleanArray = BooleanArray(8), subLevel: BooleanArray = BooleanArray(8)): ByteArray {
        val b = Bits().u(0, 4).u(maxSub, 3).u(1, 1)
        b.u(1, 8) // profile space, tier, idc
        b.u(0x60000000, 32)
        b.u(0, 4)
        b.u(0, 32).u(0, 12) // 43 reserved bits + 1 flag
        b.u(93, 8) // level
        for (i in 0 until maxSub) b.u(if (subProfile[i]) 1 else 0, 1).u(if (subLevel[i]) 1 else 0, 1)
        if (maxSub > 0) for (i in maxSub until 8) b.u(0, 2)
        for (i in 0 until maxSub) {
            if (subProfile[i]) { b.u(0, 32).u(0, 32).u(0, 24) }
            if (subLevel[i]) b.u(0, 8)
        }
        b.ue(0).ue(chroma)
        if (chroma == 3) b.u(0, 1)
        b.ue(w).ue(h)
        if (crop != null) {
            b.u(1, 1)
            crop.forEach { b.ue(it) }
        } else {
            b.u(0, 1)
        }
        return b.bytes(0x42, 0x01)
    }

    @Test
    fun h265FullHdWithTheBottomCropped() {
        assertEquals(1920 to 1080, SpsSize.parse(h265(0, 1920, 1088, crop = intArrayOf(0, 0, 0, 4)), true))
    }

    @Test
    fun h265FourThreeWithSubLayers() {
        val sp = BooleanArray(8).also { it[0] = true }
        val sl = BooleanArray(8).also { it[1] = true }
        assertEquals(1440 to 1080, SpsSize.parse(h265(2, 1440, 1080, subProfile = sp, subLevel = sl), true))
    }

    @Test
    fun anUnreadableSpsGivesNull() {
        assertNull(SpsSize.parse(null, false))
        assertNull(SpsSize.parse(ByteArray(3), false))
        assertNull(SpsSize.parse(byteArrayOf(0x67, 100, 0, 40), false))
        assertNull(SpsSize.parse(byteArrayOf(0x42, 0x01, 0, 0, 0, 0, 0), true))
    }

    // ---- events ----

    @Test
    fun anAudioEventCarriesRowsLevelsAlignmentAndTheCameraLink() {
        val rows = listOf(
            SourceLogic.sourceRow("camera", true, 40, 0.333f, SourceLogic.sourceState(lost = false, silent = false)),
            SourceLogic.sourceRow(
                "deviceMic", true, 100, 0.5f, SourceLogic.sourceState(lost = false, silent = true),
                SourceLogic.alignInfo(AlignState.LOCKED, 640, 4.26),
            ),
        )
        val cam = SourceLogic.cameraStatus(CameraLinkState.PLAYING, true, 0, RtspTransport.TCP, 1440, 1080)
        val e = SourceLogic.audioEvent(rows, 0.61f, cam, micFailed = false)
        assertEquals("audio", e["type"])
        assertEquals(0.61, e["mixed"])
        @Suppress("UNCHECKED_CAST")
        val r = e["sources"] as List<Map<String, Any?>>
        assertEquals("camera", r[0]["id"])
        assertEquals(0.33, r[0]["level"])
        assertEquals("ok", r[0]["state"])
        assertFalse(r[0].containsKey("align"))
        assertEquals("silent", r[1]["state"])
        @Suppress("UNCHECKED_CAST")
        val align = r[1]["align"] as Map<String, Any?>
        assertEquals("locked", align["state"])
        assertEquals(640, align["delayMs"])
        assertEquals(4.3, align["residualMs"])
        @Suppress("UNCHECKED_CAST")
        val c = e["camera"] as Map<String, Any?>
        assertEquals("playing", c["link"])
        assertEquals("tcp", c["transport"])
        assertEquals(1440, c["width"])
    }

    @Test
    fun theAlignStatesUseTheCoreWords() {
        assertEquals(
            listOf("searching", "locked", "holding", "failed", "manual"),
            AlignState.values().map { SourceLogic.alignInfo(it, 0, null)["state"] },
        )
        assertEquals("lost", SourceLogic.sourceState(lost = true, silent = true))
    }

    @Test
    fun theEventNeverCarriesTheCameraAddress() {
        val cam = SourceLogic.cameraStatus(CameraLinkState.LOST, null, 5, null, 0, 0)
        val e = SourceLogic.audioEvent(emptyList(), 0f, cam, micFailed = true)
        val text = e.toString()
        assertFalse(text.contains("rtsp"))
        assertFalse(text.contains("@"))
        assertEquals("lost", (cam["link"]))
        assertNull(cam["hasAudio"])
    }

    @Test
    fun silenceIsReportedOnlyAfterAWhileWithoutSound() {
        val t = SilenceTracker(threshold = 0.01f, silentAfterMs = 3000)
        assertFalse(t.update(0.0f, 0))
        assertFalse(t.update(0.0f, 2900))
        assertTrue(t.update(0.0f, 3000))
        assertFalse(t.update(0.2f, 3100)) // sound again
        assertFalse(t.update(0.0f, 5000))
        assertTrue(t.update(0.0f, 6100))
        t.reset()
        assertFalse(t.update(0.0f, 7000))
    }

    // ---- clap test ----

    @Test
    fun theFallbackOffsetIsClampedToSteps() {
        assertEquals(0, ClapPlan.clampOffset(-5))
        assertEquals(0, ClapPlan.clampOffset(24))
        assertEquals(50, ClapPlan.clampOffset(25))
        assertEquals(2000, ClapPlan.clampOffset(9999))
        assertEquals(650L, ClapPlan.soundStartDelayMs(640))
        assertEquals(5000L, ClapPlan.CAPTURE_MS)
    }
}
