package my.maxcom.app.live

import android.annotation.SuppressLint
import android.content.pm.ServiceInfo

/* The foreground-service types the live asks the system for (Play declaration risk 13). The manifest keeps declaring
   `camera|microphone`; at run time the service starts with only what the live really uses: the CAMERA type only when
   the phone's own camera is the picture, the MICROPHONE type only when the phone's microphone is used. An external
   (IP) camera with the microphone on starts with MICROPHONE alone. No Android class is loaded here besides the two
   inlined integer constants, so the rules are unit tested on the JVM. */

/** What the running live uses of the phone. */
class ForegroundNeeds(val camera: Boolean, val microphone: Boolean) {
    companion object {
        /** The phone's own camera (and its microphone); the external camera, which uses the microphone only when the
         *  mix has the phone's microphone on. */
        fun of(video: VideoKind, mix: AudioMixCfg) = ForegroundNeeds(
            camera = video == VideoKind.PHONE,
            microphone = video == VideoKind.PHONE || mix.deviceMic.enabled,
        )

        /** No extras on the start intent (an older caller): both, as before. */
        val BOTH = ForegroundNeeds(camera = true, microphone = true)
    }
}

object LiveForeground {
    const val EXTRA_CAMERA = "camera"
    const val EXTRA_MICROPHONE = "microphone"

    /**
     * The `foregroundServiceType` bits for [needs] on API [sdk]. When neither is needed (an external camera with no
     * phone microphone) there is no type at all up to API 33; from API 34 a foreground service must name at least one
     * type, so MICROPHONE alone is used then (never CAMERA).
     */
    @SuppressLint("InlinedApi")
    fun types(needs: ForegroundNeeds, sdk: Int): Int {
        var t = 0
        if (needs.camera) t = t or ServiceInfo.FOREGROUND_SERVICE_TYPE_CAMERA
        if (needs.microphone) t = t or ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE
        if (t == 0 && sdk >= 34) t = ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE
        return t
    }

    @SuppressLint("InlinedApi")
    fun hasCamera(types: Int) = types and ServiceInfo.FOREGROUND_SERVICE_TYPE_CAMERA != 0

    @SuppressLint("InlinedApi")
    fun hasMicrophone(types: Int) = types and ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE != 0
}
