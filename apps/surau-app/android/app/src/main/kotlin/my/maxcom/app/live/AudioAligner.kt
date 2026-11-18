package my.maxcom.app.live

import kotlin.math.abs
import kotlin.math.ceil
import kotlin.math.max
import kotlin.math.min
import kotlin.math.sqrt

/* Automatic audio alignment, phone side (plan rev 4, 4.3a and section 8 task AL2).

   Twin of apps/box-server/src/live/align.ts. THE ALGORITHM (one description for both implementations: that file and
   this phone twin AudioAligner.kt copy it word for word; the constants below are part of it).

   Signals. The reference is the unit's own audio (camera sound). An added source (phone or iPad microphone, Mic-in) is
   mixed in through a delay. The combiner's monitor stream carries the reference and every added source AFTER its delay,
   so every measurement is the REMAINING gap (closed loop). The aligner never touches ffmpeg: it reads the monitor and
   calls apply(id, delayMs).

   Sign of a lag. lag > 0 means the added source is EARLY: src[n] is similar to ref[n + lag], so the source's delay must
   grow by lag. lag < 0 means the source is late: its delay must shrink. new delay = current delay + lag.

   estimateLag(ref, src, rate, maxLagMs): searches lag in [-maxLagMs, +maxLagMs], returns { lagMs, confidence } or null.
   1. Sound check: if the RMS of either signal is under 0.002 of full scale (about 65 of 32768) return null. Silence
      never gives a result, not a wrong one.
   2. Coarse search on envelopes, 100 Hz grid (CPU: no work at the full rate). Envelope = mean absolute value of each
      10 ms bin, the mean removed. Pearson correlation between the two envelopes at every lag of the 10 ms grid inside
      +-maxLagMs, using only lags whose overlap is at least a third of the window. The envelope is polarity-free and
      survives room filtering, a muffled microphone, noise and a different gain.
   3. Confidence = peak correlation minus half of the best correlation outside +-150 ms of the peak (negative values
      count as 0). A peak at the edge of the search range gives null. Confidence under 0.45 is "not confident".
   4. Fine search, only near the coarse peak: both signals box-averaged down to about 4 kHz and differenced (pre-emphasis),
      then the plain cross-correlation at every decimated lag within +-12 ms of the coarse peak (the coarse peak is first
      refined by a parabola), over the loudest 3 s of the added source that every tested lag covers. The strongest ABSOLUTE value wins (polarity-free: an inverted microphone still locks).
      The peak is refined by a parabola. If the normalised fine peak is under 0.05 the coarse lag is returned instead.

   Aligner (one per added source, ticking once every 2 s of monitor sound, on the last 8 s window):
   a. Only confident estimates count. Estimates are kept in a list of the last 3 since the last correction.
   b. Act on the MEDIAN of 3 estimates that agree (max - min <= 15 ms). Before the first lock the median is applied in
      full when it is over 5 ms. After a lock a correction happens only when the median passes 10 ms, and then in a small
      step of at most 5 ms (drift between the audio clocks is slow; a step this size is not heard).
   c. After a correction wait for a full 8 s window of new sound before measuring again (the window must not contain
      sound from before the correction), and clear the list.
   d. The delay never goes below 10 ms (adelay must never be 0, T0) nor above the maximum (default 10 s). Start the
      delay at a non-zero value (default 1000 ms, T0).
   e. A confident estimate inside the target (20 ms, ALIGN_TARGET_MS) that follows a correction (closed-loop proof), or 3
      agreeing in-target estimates, gives `locked`.
   f. `locked` becomes `holding` after 3 ticks (6 s) without a confident estimate (silence in the room); the last delay
      is kept; the next confident in-target estimate gives `locked` again.
   g. `searching` becomes `failed` after 60 s of counted time without a lock. Counted time is the monitor time in which
      the reference carries sound (silence in the room does not count). The search keeps running after `failed` and a
      lock gives `locked` by itself. reset(id) starts `searching` again (source or camera returned).
   h. Time is the monitor's own clock (samples received / sample rate), so a stalled stream stands still. */

/** Mirrors core AlignState ('searching' | 'locked' | 'holding' | 'failed' | 'manual'). [wire] is the core string. */
enum class AlignState(val wire: String) {
    SEARCHING("searching"),
    LOCKED("locked"),
    HOLDING("holding"),
    FAILED("failed"),
    MANUAL("manual"),
}

/** Result of [AudioAligner.estimateLag]. Positive lagMs: the added source is early (its delay must grow by this much). */
class LagEstimate(val lagMs: Double, val confidence: Double)

/**
 * One aligner for ONE added source (phone microphone), JVM-pure (no Android classes).
 *
 * The monitor of the phone mixer is the pair of channels this class is fed: [push] takes the reference (camera audio)
 * and the added source AFTER its delay, same length, 16-bit PCM. Corrections come out through [onChange] as
 * (state, delayMs); the mixer applies the new delay itself.
 *
 * Buffering: two ring buffers of one window (8 s = 128000 shorts each at 16 kHz) and two snapshot arrays of the same
 * size, all allocated once in the constructor; [push] copies into the ring without allocating. Every 2 s of sound one
 * analysis tick runs INSIDE the push call that crosses the step boundary (a few tens of ms of CPU at 16 kHz, plus
 * short-lived work arrays from [estimateLag]); the caller should therefore push from a worker thread, not from the
 * capture callback. Not thread-safe for push/reset/setManual (one caller); [state] and [delayMs] are volatile reads.
 */
class AudioAligner(
    private val sampleRate: Int,
    private val maxLagMs: Int,
    initialDelayMs: Int = DEFAULT_INITIAL_DELAY_MS,
    private val maxDelayMs: Int = MAX_DELAY_MS,
    windowMs: Int = WINDOW_MS,
    stepMs: Int = STEP_MS,
    private val failAfterMs: Int = FAIL_MS,
) {
    /** Called on every change of state or of the delay, with the new (state, delayMs). */
    var onChange: ((AlignState, Int) -> Unit)? = null

    @Volatile
    var state: AlignState = AlignState.SEARCHING
        private set

    /** The delay this aligner last asked for (or the initial one). */
    @Volatile
    var delayMs: Int = max(MIN_DELAY_MS, initialDelayMs)
        private set

    /** The last measured remaining gap (ms), or null before the first confident estimate. */
    @Volatile
    var residualMs: Double? = null
        private set

    var ticks: Int = 0
        private set

    /** Total and worst CPU time of one analysis tick, in ms. */
    var cpuMs: Double = 0.0
        private set
    var maxCpuMs: Double = 0.0
        private set

    private val winSamples = Math.round(windowMs / 1000.0 * sampleRate).toInt()
    private val stepSamples = Math.round(stepMs / 1000.0 * sampleRate).toInt()
    private val refRing = ShortArray(winSamples)
    private val srcRing = ShortArray(winSamples)
    private val refSnap = ShortArray(winSamples)
    private val srcSnap = ShortArray(winSamples)
    private var total = 0L
    private var sinceTick = 0
    private val recent = DoubleArray(3)
    private var recentN = 0
    private var settleUntil = 0L
    private var corrected = false
    private var lockedOnce = false
    private var quietTicks = 0
    private var searchSoundMs = 0.0
    private var manual = false

    /** Feed the same number of samples of both channels (the extra samples of a longer array are ignored). */
    fun push(reference: ShortArray, added: ShortArray) {
        val frames = min(reference.size, added.size)
        var f = 0
        while (f < frames) {
            val n = min(stepSamples - sinceTick, frames - f)
            var pos = (total % winSamples).toInt()
            val first = min(n, winSamples - pos)
            System.arraycopy(reference, f, refRing, pos, first)
            System.arraycopy(added, f, srcRing, pos, first)
            if (first < n) {
                System.arraycopy(reference, f + first, refRing, 0, n - first)
                System.arraycopy(added, f + first, srcRing, 0, n - first)
            }
            f += n
            total += n
            sinceTick += n
            if (sinceTick >= stepSamples) {
                sinceTick = 0
                tick()
            }
        }
    }

    /** The source or the camera returned: search again from `searching` (the delay is kept). */
    fun reset() {
        if (manual) return
        recentN = 0
        settleUntil = total + winSamples
        corrected = false
        lockedOnce = false
        quietTicks = 0
        searchSoundMs = 0.0
        setState(AlignState.SEARCHING)
    }

    /** The unit has no audio track: nothing to match against; the fixed offset applies. Stops analysis. */
    fun setManual(delayMs: Int? = null) {
        manual = true
        if (delayMs != null) this.delayMs = min(maxDelayMs, max(MIN_DELAY_MS, delayMs))
        if (state == AlignState.MANUAL) {
            if (delayMs != null) onChange?.invoke(state, this.delayMs)
        } else {
            setState(AlignState.MANUAL)
        }
    }

    private fun setState(st: AlignState) {
        if (state == st) return
        state = st
        onChange?.invoke(st, delayMs)
    }

    private fun tick() {
        val t0 = System.nanoTime()
        val stepMsF = stepSamples.toDouble() / sampleRate * 1000.0
        // Counted time: the reference carries sound over the last step (ring positions of that step).
        var e = 0.0
        for (i in 0 until stepSamples) {
            val v = refRing[((total - stepSamples + i) % winSamples).toInt()].toDouble()
            e += v * v
        }
        val refSound = sqrt(e / max(1, stepSamples)) / 32768.0 >= SOUND_RMS
        val full = total >= winSamples
        if (full) {
            val cut = (total % winSamples).toInt()
            System.arraycopy(refRing, cut, refSnap, 0, winSamples - cut)
            System.arraycopy(refRing, 0, refSnap, winSamples - cut, cut)
            System.arraycopy(srcRing, cut, srcSnap, 0, winSamples - cut)
            System.arraycopy(srcRing, 0, srcSnap, winSamples - cut, cut)
        }
        if (!manual) {
            if (state == AlignState.SEARCHING && refSound) {
                searchSoundMs += stepMsF
                if (searchSoundMs >= failAfterMs) setState(AlignState.FAILED)
            }
            if (full && total >= settleUntil) measure()
        }
        val dt = (System.nanoTime() - t0) / 1e6
        ticks++
        cpuMs += dt
        maxCpuMs = max(maxCpuMs, dt)
    }

    private fun measure() {
        val est = estimateLag(refSnap, srcSnap, sampleRate, maxLagMs)
        if (est == null || est.confidence < CONFIDENCE_MIN) {
            quietTicks++
            if (state == AlignState.LOCKED && quietTicks >= HOLD_TICKS) setState(AlignState.HOLDING)
            return
        }
        quietTicks = 0
        residualMs = est.lagMs
        if (recentN == 3) {
            recent[0] = recent[1]
            recent[1] = recent[2]
            recent[2] = est.lagMs
        } else {
            recent[recentN++] = est.lagMs
        }
        val inTarget = abs(est.lagMs) <= ALIGN_TARGET_MS
        var median = 0.0
        var agree = false
        if (recentN == 3) {
            val lo = min(recent[0], min(recent[1], recent[2]))
            val hi = max(recent[0], max(recent[1], recent[2]))
            agree = hi - lo <= AGREE_MS
            median = recent[0] + recent[1] + recent[2] - lo - hi
        }
        if (inTarget && (corrected || (agree && abs(median) <= ALIGN_TARGET_MS))) {
            lockedOnce = true
            setState(AlignState.LOCKED)
        }
        if (!agree) return
        val trigger = if (lockedOnce) ACT_DRIFT_MS else ACT_FIRST_MS
        if (abs(median) <= trigger) return
        val step = if (lockedOnce) max(-DRIFT_STEP_MS.toDouble(), min(DRIFT_STEP_MS.toDouble(), median)) else median
        val want = max(MIN_DELAY_MS, min(maxDelayMs, Math.round(delayMs + step).toInt()))
        recentN = 0
        corrected = true
        settleUntil = total + winSamples
        if (want == delayMs) return
        delayMs = want
        onChange?.invoke(state, want)
    }

    companion object {
        const val WINDOW_MS = 8000
        const val STEP_MS = 2000
        const val ENV_HZ = 100
        const val CONFIDENCE_MIN = 0.45
        const val AGREE_MS = 15
        const val ACT_FIRST_MS = 5
        const val ACT_DRIFT_MS = 10
        const val DRIFT_STEP_MS = 5
        const val HOLD_TICKS = 3
        const val FAIL_MS = 60_000
        const val MIN_DELAY_MS = 10
        const val MAX_DELAY_MS = 10_000
        const val DEFAULT_INITIAL_DELAY_MS = 1000

        /** Core ALIGN_TARGET_MS. */
        const val ALIGN_TARGET_MS = 20
        private const val SOUND_RMS = 0.002
        private const val FINE_RATE = 4000
        private const val FINE_HALF_MS = 12
        private const val FINE_SEG_MS = 3000
        private const val EXCLUDE_MS = 150
        private const val FINE_MIN_NORM = 0.05

        private fun rmsOf(x: ShortArray, n: Int): Double {
            var e = 0.0
            for (i in 0 until n) e += x[i].toDouble() * x[i].toDouble()
            return sqrt(e / max(1, n)) / 32768.0
        }

        /** Mean absolute value per bin, mean removed. */
        private fun envelope(x: ShortArray, bin: Int, nb: Int): DoubleArray {
            val e = DoubleArray(nb)
            var mean = 0.0
            for (b in 0 until nb) {
                var s = 0.0
                val o = b * bin
                for (k in 0 until bin) s += abs(x[o + k].toInt())
                e[b] = s / bin
                mean += s / bin
            }
            mean /= nb
            for (b in 0 until nb) e[b] = e[b] - mean
            return e
        }

        /** Box-average decimation by [dec], then a first difference. */
        private fun decimateDiff(x: ShortArray, n: Int, dec: Int): DoubleArray {
            val m = n / dec
            val y = DoubleArray(m)
            var prev = 0.0
            for (i in 0 until m) {
                var s = 0.0
                val o = i * dec
                for (k in 0 until dec) s += x[o + k]
                val v = s / dec
                y[i] = v - prev
                prev = v
            }
            return y
        }

        private fun parabola(a: Double, b: Double, c: Double): Double {
            val den = a - 2 * b + c
            return if (den < 0) max(-0.5, min(0.5, (0.5 * (a - c)) / den)) else 0.0
        }

        /** Pure. Sign convention and algorithm: see the header. Null on silence, no clear peak or a peak at the range edge. */
        fun estimateLag(ref: ShortArray, src: ShortArray, sampleRate: Int, maxLagMs: Int): LagEstimate? {
            val len = min(ref.size, src.size)
            val bin = max(1, Math.round(sampleRate.toDouble() / ENV_HZ).toInt())
            val nb = len / bin
            if (nb < 40 || sampleRate <= 0 || maxLagMs <= 0) return null
            if (rmsOf(ref, len) < SOUND_RMS || rmsOf(src, len) < SOUND_RMS) return null

            val ce = envelope(ref, bin, nb)
            val me = envelope(src, bin, nb)
            val pc = DoubleArray(nb + 1)
            val pm = DoubleArray(nb + 1)
            for (i in 0 until nb) {
                pc[i + 1] = pc[i] + ce[i] * ce[i]
                pm[i + 1] = pm[i] + me[i] * me[i]
            }
            val binMs = bin.toDouble() / sampleRate * 1000.0
            val maxBins = min(ceil(maxLagMs / binMs).toInt(), (nb * 2) / 3)
            val minOverlap = max(30, nb / 3)
            val width = 2 * maxBins + 1
            val r = DoubleArray(width) { -1.0 }
            var best = -2.0
            var bi = -1
            for (d in -maxBins..maxBins) {
                val lo = max(0, -d)
                val hi = min(nb, nb - d)
                if (hi - lo < minOverlap) continue
                var s = 0.0
                for (n in lo until hi) s += ce[n + d] * me[n]
                val e1 = pc[hi + d] - pc[lo + d]
                val e2 = pm[hi] - pm[lo]
                val v = s / sqrt(e1 * e2 + 1e-12)
                r[d + maxBins] = v
                if (v > best) {
                    best = v
                    bi = d + maxBins
                }
            }
            if (bi <= 0 || bi >= width - 1 || best <= 0) return null
            val excl = ceil(EXCLUDE_MS / binMs).toInt()
            var second = 0.0
            for (i in 0 until width) if (abs(i - bi) > excl && r[i] > second) second = r[i]
            val confidence = max(0.0, min(1.0, best - 0.5 * second))

            val frac = parabola(r[bi - 1], best, r[bi + 1])
            val coarseSamples = (bi - maxBins + frac) * bin
            val coarseMs = coarseSamples / sampleRate * 1000.0

            // Fine search, on a segment of at most FINE_SEG_MS (the loudest part of the source that every tested lag covers).
            val dec = max(1, sampleRate / FINE_RATE)
            val fr = sampleRate.toDouble() / dec
            val fc = decimateDiff(ref, len, dec)
            val fm = decimateDiff(src, len, dec)
            val center = Math.round(coarseSamples / dec).toInt()
            val half = max(2, ceil(FINE_HALF_MS / 1000.0 * fr).toInt())
            val bigL = fc.size
            val lo = max(0, half - center)
            val hi = min(bigL, bigL - center - half)
            if (hi - lo < 100) return LagEstimate(coarseMs, confidence)
            val segLen = min(hi - lo, Math.round(FINE_SEG_MS / 1000.0 * fr).toInt())
            val pe = DoubleArray(bigL + 1)
            for (i in 0 until bigL) pe[i + 1] = pe[i] + fm[i] * fm[i]
            var a0 = lo
            var bestE = -1.0
            val stride = max(1, Math.round(fr / 20).toInt())
            var st = lo
            while (st + segLen <= hi) {
                val e = pe[st + segLen] - pe[st]
                if (e > bestE) {
                    bestE = e
                    a0 = st
                }
                st += stride
            }
            var e1 = 0.0
            var e2 = 0.0
            for (n in a0 until a0 + segLen) {
                e1 += fm[n] * fm[n]
                e2 += fc[n + center] * fc[n + center]
            }
            val norm = sqrt(e1 * e2 + 1e-12)
            val sv = DoubleArray(2 * half + 1)
            var bestAbs = -1.0
            var bj = half
            for (j in -half..half) {
                val d = center + j
                var s = 0.0
                for (n in a0 until a0 + segLen) s += fc[n + d] * fm[n]
                sv[j + half] = s
                if (abs(s) > bestAbs) {
                    bestAbs = abs(s)
                    bj = j + half
                }
            }
            if (bestAbs / norm < FINE_MIN_NORM || bj == 0 || bj == 2 * half) return LagEstimate(coarseMs, confidence)
            val sign = if (sv[bj] < 0) -1.0 else 1.0
            val ffrac = parabola(sign * sv[bj - 1], sign * sv[bj], sign * sv[bj + 1])
            val lagSamples = (center + (bj - half) + ffrac) * dec
            return LagEstimate(lagSamples / sampleRate * 1000.0, confidence)
        }
    }
}
