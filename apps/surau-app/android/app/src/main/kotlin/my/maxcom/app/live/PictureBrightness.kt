package my.maxcom.app.live

/**
 * B7: "Kecerahan gambar" of the live (`liveCamera.brightness`). The phone lifts the picture with one exposure filter in
 * the GL chain. Fixed levels apply a fixed lift; `auto` follows how dark the room is and lifts only when it is dark.
 *
 * The darkness signal of `auto` is the phone's ambient light sensor, not a measure of the picture: reading pixels back
 * from the GL chain every few seconds would cost a copy of the frame on a mid-range phone, the sensor costs nothing.
 * The rules here are pure so they can be tested without a phone.
 */
object PictureBrightness {
    const val AUTO = "auto"
    const val NORMAL = "normal"
    const val BRIGHT = "bright"
    const val BRIGHTER = "brighter"

    /** Exposure lift in stops for each step; step 0 is no filter at all. Capped at 1.0 for every level. */
    val STEP_EV = floatArrayOf(0f, 0.4f, 0.8f)

    /** An unknown or missing value is `auto`, the default. */
    fun clean(level: String?): String = when (level) {
        NORMAL, BRIGHT, BRIGHTER -> level
        else -> AUTO
    }

    /** The fixed step of a level; null for `auto` (it follows the light). */
    fun fixedStep(level: String): Int? = when (level) {
        NORMAL -> 0
        BRIGHT -> 1
        BRIGHTER -> 2
        else -> null
    }

    /**
     * F6: `auto` follows the phone's light sensor only when the picture is the phone's own camera. With the external
     * camera the phone may lie face down or sit in a pocket while the picture is well lit, so `auto` lifts nothing there
     * (a fixed level still applies).
     */
    fun followsLight(level: String, externalCamera: Boolean): Boolean = level == AUTO && !externalCamera

    fun evOf(step: Int): Float = STEP_EV[step.coerceIn(0, STEP_EV.size - 1)]

    // Auto: dark enough to lift (enter) and bright enough to let go (exit); the gap between them is the hysteresis.
    const val STEP1_ENTER_LUX = 30f
    const val STEP1_EXIT_LUX = 50f
    const val STEP2_ENTER_LUX = 8f
    const val STEP2_EXIT_LUX = 15f

    /** The lift is never changed twice within this time: no flicker when the light hovers at a threshold. */
    const val HOLD_MS = 10_000L

    /** Readings kept for the average (a sensor that reports on change, read every few seconds). */
    const val WINDOW = 3

    /**
     * Holds the step `auto` has chosen. [update] is called every few seconds with the newest lux reading (null when the
     * phone has no light sensor) and answers the step to use now.
     */
    class Auto {
        var step = 0
            private set
        private var lastChangeMs = Long.MIN_VALUE / 2
        private val window = ArrayDeque<Float>()

        fun reset() {
            step = 0
            lastChangeMs = Long.MIN_VALUE / 2
            window.clear()
        }

        fun update(lux: Float?, nowMs: Long): Int {
            if (lux == null || lux < 0f) return step
            window.addLast(lux)
            while (window.size > WINDOW) window.removeFirst()
            val avg = window.sum() / window.size
            val target = when (step) {
                0 -> if (avg < STEP2_ENTER_LUX) 2 else if (avg < STEP1_ENTER_LUX) 1 else 0
                1 -> if (avg < STEP2_ENTER_LUX) 2 else if (avg > STEP1_EXIT_LUX) 0 else 1
                else -> if (avg > STEP1_EXIT_LUX) 0 else if (avg > STEP2_EXIT_LUX) 1 else 2
            }
            if (target != step && nowMs - lastChangeMs >= HOLD_MS) {
                step = target
                lastChangeMs = nowMs
            }
            return step
        }
    }
}
