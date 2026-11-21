package my.maxcom.app.live

import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** Play declaration risk 13: the foreground service holds the CAMERA type only when the phone's own camera is used. */
class LiveForegroundTest {
    private val camera = 0x40
    private val microphone = 0x80

    private fun mix(mic: Boolean, video: VideoKind): AudioMixCfg {
        val d = AudioMixCfg.default(video)
        return AudioMixCfg(d.camera, MixEntry(mic, 100), d.boxInput)
    }

    @Test
    fun theTypeConstantsAreTheSystemsBits() {
        assertEquals(camera, android.content.pm.ServiceInfo.FOREGROUND_SERVICE_TYPE_CAMERA)
        assertEquals(microphone, android.content.pm.ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE)
    }

    @Test
    fun thePhoneCameraLiveHoldsCameraAndMicrophone() {
        val needs = ForegroundNeeds.of(VideoKind.PHONE, mix(true, VideoKind.PHONE))
        assertTrue(needs.camera)
        assertTrue(needs.microphone)
        assertEquals(camera or microphone, LiveForeground.types(needs, 34))
        assertEquals(camera or microphone, LiveForeground.types(needs, 29))
    }

    @Test
    fun thePhoneCameraLiveStillHoldsTheMicrophoneWhenTheMixHasItOff() {
        // the phone live is today's Camera2Source + MicrophoneSource: the microphone is not given up by the mix
        val needs = ForegroundNeeds.of(VideoKind.PHONE, mix(false, VideoKind.PHONE))
        assertTrue(needs.camera)
        assertTrue(needs.microphone)
    }

    @Test
    fun anExternalCameraWithThePhoneMicrophoneHoldsTheMicrophoneAlone() {
        val needs = ForegroundNeeds.of(VideoKind.EXTERNAL, mix(true, VideoKind.EXTERNAL))
        assertFalse(needs.camera)
        assertTrue(needs.microphone)
        for (sdk in listOf(29, 33, 34, 36)) {
            val t = LiveForeground.types(needs, sdk)
            assertEquals("sdk $sdk", microphone, t)
            assertFalse(LiveForeground.hasCamera(t))
        }
    }

    @Test
    fun anExternalCameraWithNoPhoneMicrophoneHoldsNoCameraType() {
        val needs = ForegroundNeeds.of(VideoKind.EXTERNAL, mix(false, VideoKind.EXTERNAL))
        assertFalse(needs.camera)
        assertFalse(needs.microphone)
        // up to API 33 no type at all; from API 34 a type is required, so the microphone alone, never the camera
        assertEquals(0, LiveForeground.types(needs, 33))
        assertEquals(microphone, LiveForeground.types(needs, 34))
        assertFalse(LiveForeground.hasCamera(LiveForeground.types(needs, 36)))
    }

    @Test
    fun theDefaultExternalMixHoldsNoCameraType() {
        // first use of the external camera: its own sound, the phone microphone off
        val needs = ForegroundNeeds.of(VideoKind.EXTERNAL, AudioMixCfg.default(VideoKind.EXTERNAL))
        assertFalse(LiveForeground.hasCamera(LiveForeground.types(needs, 36)))
    }

    @Test
    fun aCallerThatSaysNothingGetsBothAsBefore() {
        assertTrue(ForegroundNeeds.BOTH.camera)
        assertTrue(ForegroundNeeds.BOTH.microphone)
        assertEquals(camera or microphone, LiveForeground.types(ForegroundNeeds.BOTH, 34))
    }

    @Test
    fun switchingTheSourceChangesTheTypes() {
        val phone = ForegroundNeeds.of(VideoKind.PHONE, AudioMixCfg.default(VideoKind.PHONE))
        val external = ForegroundNeeds.of(VideoKind.EXTERNAL, AudioMixCfg.default(VideoKind.EXTERNAL).let {
            AudioMixCfg(it.camera, MixEntry(true, 100), it.boxInput)
        })
        assertTrue(LiveForeground.hasCamera(LiveForeground.types(phone, 34)))
        assertFalse(LiveForeground.hasCamera(LiveForeground.types(external, 34)))
    }

    @Test
    fun theServiceTakesItsTypesFromTheRulesAndNeverHardCodesTheCameraType() {
        val src = listOf("src/main/kotlin/my/maxcom/app/live/LiveService.kt", "app/src/main/kotlin/my/maxcom/app/live/LiveService.kt")
            .map(::File).first { it.exists() }.readText()
        assertTrue(src.contains("LiveForeground.types("))
        assertFalse("the camera type must not be started unconditionally", src.contains("FOREGROUND_SERVICE_TYPE_CAMERA"))
    }

    @Test
    fun theManifestStillDeclaresBothTypes() {
        val m = listOf("src/main/AndroidManifest.xml", "app/src/main/AndroidManifest.xml").map(::File).first { it.exists() }.readText()
        assertTrue(m.contains("foregroundServiceType=\"camera|microphone\""))
        assertTrue(m.contains("FOREGROUND_SERVICE_CAMERA"))
        assertTrue(m.contains("FOREGROUND_SERVICE_MICROPHONE"))
    }
}
