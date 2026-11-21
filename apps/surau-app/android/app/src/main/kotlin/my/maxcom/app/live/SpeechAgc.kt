package my.maxcom.app.live

import kotlin.math.abs
import kotlin.math.exp
import kotlin.math.log10
import kotlin.math.pow
import kotlin.math.sqrt

/**
 * A gain-reduction peak limiter on a float signal (+-32768 scale): instant attack (the output never passes
 * [CEILING_INT]), ~100 ms release. Linear (gain exactly 1) while the input stays under the ceiling, so clean loud
 * input is not distorted. One instance per signal, one thread.
 */
class PeakLimiter(sampleRate: Int, releaseMs: Double = SpeechAgc.LIMITER_RELEASE_MS) {
    private val releaseCoef = 1.0 - exp(-1.0 / (releaseMs / 1000.0 * sampleRate))
    private var g = 1.0

    fun reset() {
        g = 1.0
    }

    fun process(y: Float): Float {
        val a = abs(y)
        if (a > CEILING) {
            val need = (CEILING / a).toDouble()
            if (need < g) g = need
        } else if (g < 1.0) {
            g += (1.0 - g) * releaseCoef
            if (g > 0.99999) g = 1.0
        }
        val o = (y * g).toFloat()
        // Guard only (rounding): never above the ceiling.
        return if (o > CEILING) CEILING else if (o < -CEILING) -CEILING else o
    }

    companion object {
        private const val CEILING = SpeechAgc.CEILING_INT.toFloat()
    }
}

/**
 * Speech automatic gain control on 16-bit mono PCM. JVM-pure (no Android), one instance per signal, one thread.
 *
 * A phone or tablet microphone records speech quietly (measured about -31 dBFS RMS; clear speech is about -18).
 * This stage is the ONLY one that levels the phone microphone (the box lifts only what is still quiet and leaves a
 * normal level alone). Per sample:
 *  1. RMS envelope: mean square over ATTACK_MS, followed up at once and released over RELEASE_MS;
 *  2. modulation: the mean-square level of every MOD_BLOCK_MS block is kept for the last MOD_WINDOW_BLOCKS blocks (about
 *     1 s). A signal whose block levels span more than MOD_RANGE_DB is "modulated" (speech: syllable dips of many dB
 *     several times a second); a steady one (room noise, a fan, a held tone) is not;
 *  3. adaptive noise floor (the first WARM_MS after a start only fill the envelope; no gain yet): the minimum of the
 *     envelope, which falls at once. While the signal is steady it rises at most FLOOR_RISE_DB_PER_S
 *     (FLOOR_RISE_ACTIVE_DB_PER_S while active), so steady noise stops being lifted. While it is modulated the floor
 *     can never be above the recent block minimum (the dips between syllables are the room), so continuous speech
 *     cannot push the floor up and close the gate, and speech present at the start is not taken for the room;
 *  4. gate: speech is "active" when the envelope is at least GATE_OPEN_DB above the floor (it closes below
 *     GATE_CLOSE_DB). Gain is raised only while active and not falling into a pause; wanted gain = TARGET_DBFS - level,
 *     limited to 0..MAX_GAIN_DB;
 *  5. hold: through a pause the last speech gain is held for HOLD_MS counted from the last non-falling speech level
 *     (the countdown also runs while the level falls into the pause), then eased to 0 dB (room noise is never
 *     raised more than the speech gain was, and the gain never swells in a pause);
 *  6. the gain in dB is smoothed (falls fast, rises over GAIN_RISE_MS);
 *  7. a [PeakLimiter] with ceiling CEILING_DBFS (-1 dBFS): linear below the ceiling, gain reduction above it.
 * The user's volume is applied AFTER this stage (see MixerCore), so 0% stays exact silence.
 */
class SpeechAgc(private val sampleRate: Int) {
    private val attackCoef = coef(ATTACK_MS)
    private val releaseCoef = coef(RELEASE_MS)
    private val gainFallCoef = coef(GAIN_FALL_MS)
    private val gainRiseCoef = coef(GAIN_RISE_MS)
    private val gainEaseCoef = coef(GAIN_EASE_MS)
    private val holdSamples = (HOLD_MS.toLong() * sampleRate / 1000).toInt()
    private val floorRiseIdle = FLOOR_RISE_DB_PER_S / sampleRate
    private val floorRiseActive = FLOOR_RISE_ACTIVE_DB_PER_S / sampleRate
    private val limiter = PeakLimiter(sampleRate)
    private val warmSamples = (WARM_MS.toLong() * sampleRate / 1000).toInt()

    private var shortPower = 0.0 // mean square over about ATTACK_MS (float, +-32768 scale)
    private var power = 0.0 // the envelope: follows shortPower up at once, down over RELEASE_MS
    private var floorDb = FLOOR_INIT_DBFS
    private var active = false
    private var holdLeft = 0
    private var gainDb = 0.0
    private var warmLeft = warmSamples

    // Block levels for the modulation test (no allocation per sample).
    private val blockSamples = (MOD_BLOCK_MS.toLong() * sampleRate / 1000).toInt().coerceAtLeast(1)
    private val blockDbs = DoubleArray(MOD_WINDOW_BLOCKS)
    private var blockFilled = 0
    private var blockPos = 0
    private var blockN = 0
    private var blockAcc = 0.0
    private var modulated = false
    private var recentMinDb = FLOOR_MIN_DBFS

    private fun coef(ms: Double): Double = 1.0 - exp(-1.0 / (ms / 1000.0 * sampleRate))

    /** The gain now applied, in dB (for tests and diagnostics). */
    val currentGainDb: Double get() = gainDb

    /** The noise floor now tracked, in dBFS (for tests and diagnostics). */
    val noiseFloorDb: Double get() = floorDb

    /** A new start (start, unmute, re-open, the microphone coming back): no stale gain, floor, hold or limiter state. */
    fun reset() {
        shortPower = 0.0
        power = 0.0
        floorDb = FLOOR_INIT_DBFS
        active = false
        holdLeft = 0
        gainDb = 0.0
        warmLeft = warmSamples
        blockFilled = 0
        blockPos = 0
        blockN = 0
        blockAcc = 0.0
        modulated = false
        recentMinDb = FLOOR_MIN_DBFS
        limiter.reset()
    }

    /** Closes one block: stores its level, then refreshes the 1 s min/max and the modulated flag. */
    private fun endBlock() {
        val ms = blockAcc / blockN
        blockDbs[blockPos] = if (ms < 1.0) -120.0 else 10.0 * log10(ms / (32768.0 * 32768.0))
        blockPos = (blockPos + 1) % MOD_WINDOW_BLOCKS
        if (blockFilled < MOD_WINDOW_BLOCKS) blockFilled++
        blockAcc = 0.0
        blockN = 0
        var mn = Double.MAX_VALUE
        var mx = -Double.MAX_VALUE
        for (i in 0 until blockFilled) {
            val v = blockDbs[i]
            if (v < mn) mn = v
            if (v > mx) mx = v
        }
        modulated = blockFilled >= MOD_MIN_BLOCKS && mx - mn > MOD_RANGE_DB
        recentMinDb = mn.coerceAtLeast(FLOOR_MIN_DBFS)
    }

    /** One sample in (+-32768 scale), one sample out (never above [CEILING_INT] in magnitude). */
    fun processSample(x: Float): Float {
        val p = x.toDouble() * x.toDouble()
        blockAcc += p
        if (++blockN >= blockSamples) endBlock()
        // A symmetric short window first (a fast attack on the raw square would sit on the peaks of noise and read it high).
        shortPower += (p - shortPower) * attackCoef
        val falling = shortPower < power * FALLING_RATIO
        power = if (shortPower > power) shortPower else power + (shortPower - power) * releaseCoef
        val rms = sqrt(power)
        val levelDb = if (rms < 1.0) -120.0 else 20.0 * log10(rms / 32768.0)

        if (warmLeft > 0) {
            // The envelope is still filling after a start: no gain yet. What is heard at the end is the room if it is
            // steady and not louder than a room. A modulated signal is speech: the floor is the recent dip level, not
            // the speech. A steady loud one keeps the quiet-room start value (speech is levelled at once).
            warmLeft--
            if (warmLeft == 0) {
                if (modulated) {
                    if (recentMinDb < floorDb) floorDb = recentMinDb
                } else if (levelDb < WARM_ROOM_MAX_DBFS) {
                    floorDb = levelDb.coerceAtLeast(FLOOR_MIN_DBFS)
                }
            }
            active = false
        } else {
            var f = if (levelDb < floorDb) levelDb.coerceAtLeast(FLOOR_MIN_DBFS) else floorDb + (if (active) floorRiseActive else floorRiseIdle)
            if (modulated && f > recentMinDb) f = recentMinDb
            floorDb = f
            val above = levelDb - floorDb
            active = if (active) above >= GATE_CLOSE_DB else above >= GATE_OPEN_DB
        }

        var easing = false
        val goal: Double
        if (active) {
            val want = (TARGET_DBFS - levelDb).coerceIn(0.0, MAX_GAIN_DB)
            if (falling) {
                if (holdLeft > 0) holdLeft-- // the hold runs from the last speech level, also while it falls into the pause
                goal =if (want < gainDb) want else gainDb // never raise while the level falls into a pause
            } else {
                holdLeft = holdSamples
                goal = want
            }
        } else if (holdLeft > 0) {
            holdLeft--
            goal = gainDb
        } else {
            goal = 0.0
            easing = true
        }
        val c = if (easing) gainEaseCoef else if (goal < gainDb) gainFallCoef else gainRiseCoef
        gainDb += (goal - gainDb) * c
        val y = x * 10.0.pow(gainDb / 20.0).toFloat()
        return limiter.process(y)
    }

    /** In place over [len] samples from [off]. */
    fun process(buf: ShortArray, off: Int = 0, len: Int = buf.size - off) {
        for (i in off until off + len) {
            // The final clamp is a guard only: the limiter already holds the ceiling.
            buf[i] = Math.round(processSample(buf[i].toFloat())).coerceIn(-CEILING_INT, CEILING_INT).toShort()
        }
    }

    companion object {
        const val TARGET_DBFS = -18.0
        const val MAX_GAIN_DB = 12.0
        const val ATTACK_MS = 10.0
        const val RELEASE_MS = 400.0
        const val GAIN_FALL_MS = 20.0
        const val GAIN_RISE_MS = 60.0
        const val GAIN_EASE_MS = 500.0
        const val HOLD_MS = 1500
        const val LIMITER_RELEASE_MS = 100.0
        const val CEILING_DBFS = -1.0

        /** Speech is active when the level is this far above the noise floor (closes below [GATE_CLOSE_DB]). */
        const val GATE_OPEN_DB = 8.0
        const val GATE_CLOSE_DB = 5.0

        /** The floor before anything is heard: a quiet room. It falls at once to the real level. */
        const val FLOOR_INIT_DBFS = -45.0
        const val FLOOR_MIN_DBFS = -62.0
        const val WARM_MS = 300
        const val WARM_ROOM_MAX_DBFS = -35.0
        const val FLOOR_RISE_DB_PER_S = 3.0
        const val FLOOR_RISE_ACTIVE_DB_PER_S = 1.5

        /** Modulation test: block length, blocks kept (about 1 s), blocks needed before it can judge, range that means speech. */
        const val MOD_BLOCK_MS = 20
        const val MOD_WINDOW_BLOCKS = 50
        const val MOD_MIN_BLOCKS = 10
        const val MOD_RANGE_DB = 6.0

        /** The short power is under this share of the envelope (3 dB): the level is falling into a pause. */
        private const val FALLING_RATIO = 0.5

        /** -1 dBFS in 16-bit units, rounded down so the ceiling is never above -1 dBFS. */
        const val CEILING_INT = 29204
    }
}
