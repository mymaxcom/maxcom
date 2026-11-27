package my.maxcom.app.live

import android.annotation.SuppressLint
import android.content.pm.ServiceInfo

/* The foreground-service types the live asks the system for (Play declaration risk 13). The manifest declares
   `camera|microphone|connectedDevice`; at run time the service starts with only what the live really uses: the CAMERA
   type only when the phone's own camera is the picture, the MICROPHONE type only when the phone's microphone is used,
   and CONNECTED_DEVICE when the live is the network camera alone (C7: until 2026.11.15 that case borrowed the
   MICROPHONE type on Android 14+, which no microphone justified). No Android class is loaded here besides the
   inlined integer constants, so the rules are unit tested on the JVM. */

/** What the running live uses of the phone, and whether its picture comes from the network camera. */
class ForegroundNeeds(val camera: Boolean, val microphone: Boolean, val external: Boolean = false) {
    companion object {
        /** The phone's own camera (and its microphone); the external camera, which uses the microphone only when the
         *  mix has the phone's microphone on. */
        fun of(video: VideoKind, mix: AudioMixCfg) = ForegroundNeeds(
            camera = video == VideoKind.PHONE,
            microphone = video == VideoKind.PHONE || mix.deviceMic.enabled,
            external = video == VideoKind.EXTERNAL,
        )

        /** No extras on the start intent (an older caller): both, as before. */
        val BOTH = ForegroundNeeds(camera = true, microphone = true)
    }
}

object LiveForeground {
    const val EXTRA_CAMERA = "camera"
    const val EXTRA_MICROPHONE = "microphone"
    const val EXTRA_EXTERNAL = "external"

    /** FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE (API 29); written out so the JVM test can compare it. */
    const val CONNECTED_DEVICE = 0x10

    /**
     * The `foregroundServiceType` bits for [needs] on API [sdk]. When neither the camera nor the microphone of the
     * phone is used (the network camera with its own sound) there is no type at all up to API 33; from API 34 a
     * foreground service must name at least one type, and the fitting one is CONNECTED_DEVICE (never CAMERA, never
     * MICROPHONE). It needs the FOREGROUND_SERVICE_CONNECTED_DEVICE permission and CHANGE_NETWORK_STATE in the manifest.
     */
    @SuppressLint("InlinedApi")
    fun types(needs: ForegroundNeeds, sdk: Int): Int {
        var t = 0
        if (needs.camera) t = t or ServiceInfo.FOREGROUND_SERVICE_TYPE_CAMERA
        if (needs.microphone) t = t or ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE
        if (t == 0 && sdk >= 34) t = CONNECTED_DEVICE
        return t
    }

    @SuppressLint("InlinedApi")
    fun hasCamera(types: Int) = types and ServiceInfo.FOREGROUND_SERVICE_TYPE_CAMERA != 0

    @SuppressLint("InlinedApi")
    fun hasMicrophone(types: Int) = types and ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE != 0

    fun hasConnectedDevice(types: Int) = types and CONNECTED_DEVICE != 0

    /** What the service does when the system refuses `startForeground`. */
    enum class Refused { KEEP, STOP }

    /**
     * C8: a refusal of the FIRST start leaves the live without the protection of a foreground service, so the service
     * stops and the engine is told. A refusal of a REFRESH (the source or the microphone changed while the app was in
     * the background, where Android does not let a service take the camera or microphone type) must not end a live
     * that is running: the service stays in the foreground with the types it already has.
     */
    fun onRefused(alreadyForeground: Boolean): Refused = if (alreadyForeground) Refused.KEEP else Refused.STOP

    /** A refresh is asked for only when the types really change (a volume change must not touch the service). */
    fun needsRefresh(currentTypes: Int?, wanted: Int): Boolean = currentTypes == null || currentTypes != wanted
}
