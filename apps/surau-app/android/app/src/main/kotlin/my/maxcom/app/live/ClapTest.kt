package my.maxcom.app.live

import android.graphics.SurfaceTexture
import android.media.MediaPlayer
import android.os.Handler
import android.view.Surface
import java.io.File

/* "Uji tepukan", the fallback for a camera with NO audio track (plan 4.3a, task K2). The engine records about five
   seconds of the camera picture and the phone microphone with the offset at 0 (the picture is late, the sound early);
   this class replays that clip in a loop with the sound started [offsetMs] after the picture, so the user moves the
   stepper until the clap is seen and heard together. Two players on the same file: one muted for the picture, one for
   the sound, started later. The pure rule (the start delay) is [ClapPlan]. Never used for a camera that has audio. */
class ClapReplay(private val file: File, private val main: Handler) {
    private var video: MediaPlayer? = null
    private var audio: MediaPlayer? = null
    private var surface: Surface? = null

    @Volatile private var offsetMs = 0
    @Volatile var playing = false
        private set

    private val soundStart = Runnable { try { audio?.start() } catch (_: Exception) {} }

    /** Plays the clip in a loop onto [texture]. Returns false when the clip or a player cannot be opened. */
    fun start(texture: SurfaceTexture, offsetMs: Int): Boolean {
        stop()
        if (!file.exists() || file.length() == 0L) return false
        this.offsetMs = ClapPlan.clampOffset(offsetMs)
        return try {
            val surf = Surface(texture)
            surface = surf
            val v = MediaPlayer()
            v.setDataSource(file.path)
            v.setSurface(surf)
            v.setVolume(0f, 0f)
            v.setOnCompletionListener { if (playing) restart() }
            v.prepare()
            val a = MediaPlayer()
            a.setDataSource(file.path)
            a.prepare()
            video = v
            audio = a
            playing = true
            restart()
            true
        } catch (_: Exception) {
            stop()
            false
        }
    }

    /** The stepper moved: the next pass of the loop uses the new value, and this one restarts at once. */
    fun setOffset(ms: Int) {
        offsetMs = ClapPlan.clampOffset(ms)
        if (playing) restart()
    }

    private fun restart() {
        main.removeCallbacks(soundStart)
        try {
            audio?.pause()
            audio?.seekTo(0)
            video?.seekTo(0)
            video?.start()
        } catch (_: Exception) {
        }
        main.postDelayed(soundStart, ClapPlan.soundStartDelayMs(offsetMs))
    }

    fun stop() {
        playing = false
        main.removeCallbacks(soundStart)
        try { video?.release() } catch (_: Exception) {}
        try { audio?.release() } catch (_: Exception) {}
        try { surface?.release() } catch (_: Exception) {}
        video = null
        audio = null
        surface = null
    }
}
