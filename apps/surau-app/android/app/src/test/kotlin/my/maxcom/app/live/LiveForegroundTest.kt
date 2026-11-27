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
    private val connectedDevice = 0x10

    private fun mix(mic: Boolean, video: VideoKind): AudioMixCfg {
        val d = AudioMixCfg.default(video)
        return AudioMixCfg(d.camera, MixEntry(mic, 100), d.boxInput)
    }

    @Test
    fun theTypeConstantsAreTheSystemsBits() {
        assertEquals(camera, android.content.pm.ServiceInfo.FOREGROUND_SERVICE_TYPE_CAMERA)
        assertEquals(microphone, android.content.pm.ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE)
        assertEquals(connectedDevice, android.content.pm.ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE)
        assertEquals(connectedDevice, LiveForeground.CONNECTED_DEVICE)
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
        // up to API 33 no type at all; from API 34 a type is required: connectedDevice (C7), never the camera
        assertEquals(0, LiveForeground.types(needs, 33))
        assertEquals(connectedDevice, LiveForeground.types(needs, 34))
        assertFalse(LiveForeground.hasCamera(LiveForeground.types(needs, 36)))
    }

    /** C7: an external-only live used to borrow the MICROPHONE type on Android 14+, with no microphone in use. */
    @Test
    fun externalOnlyOnApi34PicksConnectedDevice() {
        val needs = ForegroundNeeds.of(VideoKind.EXTERNAL, mix(false, VideoKind.EXTERNAL))
        assertTrue(needs.external)
        for (sdk in listOf(34, 35, 36)) {
            val t = LiveForeground.types(needs, sdk)
            assertEquals("sdk $sdk", connectedDevice, t)
            assertTrue(LiveForeground.hasConnectedDevice(t))
            assertFalse("no microphone is used, so its type is not claimed", LiveForeground.hasMicrophone(t))
            assertFalse(LiveForeground.hasCamera(t))
        }
    }

    @Test
    fun thePhoneSourcesNeverClaimConnectedDevice() {
        // success path of the other sources: unchanged types
        val phone = ForegroundNeeds.of(VideoKind.PHONE, mix(true, VideoKind.PHONE))
        assertFalse(LiveForeground.hasConnectedDevice(LiveForeground.types(phone, 34)))
        val externalWithMic = ForegroundNeeds.of(VideoKind.EXTERNAL, mix(true, VideoKind.EXTERNAL))
        assertEquals(microphone, LiveForeground.types(externalWithMic, 34))
    }

    @Test
    fun theManifestDeclaresConnectedDeviceAndKeepsDataSync() {
        val m = listOf("src/main/AndroidManifest.xml", "app/src/main/AndroidManifest.xml").map(::File).first { it.exists() }.readText()
        assertTrue(m.contains("foregroundServiceType=\"camera|microphone|connectedDevice\""))
        assertTrue(m.contains("android.permission.FOREGROUND_SERVICE_CONNECTED_DEVICE"))
        // the type needs one of the network-change permissions on Android 14+
        assertTrue(m.contains("android.permission.CHANGE_NETWORK_STATE"))
        // operator decision 5: the upload keeps its dataSync declaration
        assertTrue(m.contains("android.permission.FOREGROUND_SERVICE_DATA_SYNC"))
        assertTrue(m.contains("android:foregroundServiceType=\"dataSync\""))
        // the service outlives the task
        assertTrue(m.contains("android:stopWithTask=\"false\""))
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
        // both are still declared (the connectedDevice type joined them in 2026.11.15, see below)
        assertTrue(m.contains("foregroundServiceType=\"camera|microphone|"))
        assertTrue(m.contains("FOREGROUND_SERVICE_CAMERA"))
        assertTrue(m.contains("FOREGROUND_SERVICE_MICROPHONE"))
    }
}
