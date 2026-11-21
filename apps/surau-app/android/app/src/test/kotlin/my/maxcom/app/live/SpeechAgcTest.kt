package my.maxcom.app.live

import kotlin.math.PI
import kotlin.math.abs
import kotlin.math.log10
import kotlin.math.sin
import kotlin.math.sqrt
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class SpeechAgcTest {
    private val rate = 16000

    private fun amp(dbfsRms: Double): Double = 32768.0 * Math.pow(10.0, dbfsRms / 20.0) * sqrt(2.0)

    private fun tone(dbfsRms: Double, n: Int, startPhase: Int = 0): ShortArray {
        val a = amp(dbfsRms)
        return ShortArray(n) { Math.round(a * sin(2 * PI * 1000.0 * (it + startPhase) / rate)).coerceIn(-32768, 32767).toShort() }
    }

    private fun noise(dbfsRms: Double, n: Int, seed: Long = 7): ShortArray {
        val r = java.util.Random(seed)
        val sigma = 32768.0 * Math.pow(10.0, dbfsRms / 20.0)
        return ShortArray(n) { Math.round(r.nextGaussian() * sigma).coerceIn(-32768, 32767).toShort() }
    }

    private fun secs(s: Double) = (rate * s).toInt()

    private fun cat(vararg parts: ShortArray): ShortArray {
        val o = ShortArray(parts.sumOf { it.size })
        var p = 0
        for (a in parts) {
            a.copyInto(o, p)
            p += a.size
        }
        return o
    }

    private fun rmsDb(b: ShortArray, from: Int = 0, to: Int = b.size): Double {
        var s = 0.0
        for (i in from until to) s += b[i].toDouble() * b[i]
        return 20 * log10(sqrt(s / (to - from)).coerceAtLeast(1e-9) / 32768.0)
    }

    private fun peakDb(b: ShortArray): Double = 20 * log10(b.maxOf { abs(it.toInt()) }.coerceAtLeast(1) / 32768.0)

    /** Runs [input] through a fresh AGC, returns the output (a copy). */
    private fun run(input: ShortArray, agc: SpeechAgc = SpeechAgc(rate)): ShortArray {
        val b = input.copyOf()
        agc.process(b)
        return b
    }

    @Test
    fun quietSpeechToneIsBroughtToTarget() {
        // 1.5 s of room tone, then a -32 dBFS speech-like tone (clear speech is -18; the gain is capped at 12 dB).
        val inp = cat(noise(-50.0, secs(1.5)), tone(-32.0, secs(3.0)))
        val out = run(inp)
        assertEquals(-18.0, rmsDb(out, secs(3.5), secs(4.5)), 3.0)
    }

    @Test
    fun speechFromTheFirstSampleIsLevelled() {
        val out = run(tone(-32.0, secs(4.0)))
        assertEquals(-18.0, rmsDb(out, secs(3.0), secs(4.0)), 3.0)
    }

    @Test
    fun steadyRoomNoiseIsNotRaisedBeyondThreeDb() {
        for (level in doubleArrayOf(-38.0, -40.0, -50.0)) {
            val inp = noise(level, secs(8.0))
            val out = run(inp)
            for (w in 1..7) {
                val from = secs(w.toDouble())
                val to = secs(w + 1.0)
                assertTrue("level $level window $w: in ${rmsDb(inp, from, to)} out ${rmsDb(out, from, to)}", rmsDb(out, from, to) - rmsDb(inp, from, to) <= 3.0)
            }
        }
    }

    @Test
    fun roomNoiseAfterASpeechBurstSettlesWithinThreeDb() {
        for (level in doubleArrayOf(-38.0, -40.0)) {
            val agc = SpeechAgc(rate)
            val inp = cat(noise(level, secs(2.0), 1), tone(-26.0, secs(1.0)), noise(level, secs(7.0), 2))
            val out = run(inp, agc)
            // 1.5 s hold, then an ease to 0 dB: the last 2 s are back at the room level.
            val from = secs(8.0)
            val to = secs(10.0)
            assertTrue("level $level: in ${rmsDb(inp, from, to)} out ${rmsDb(out, from, to)}", rmsDb(out, from, to) - rmsDb(inp, from, to) <= 3.0)
            assertTrue(agc.currentGainDb < 1.0)
        }
    }

    @Test
    fun noSwellInAPauseAndTheSecondPhraseIsNotFadedIn() {
        val agc = SpeechAgc(rate)
        val phrase1 = tone(-30.0, secs(1.0))
        val pause = noise(-50.0, secs(1.0), 3)
        val phrase2 = tone(-30.0, secs(1.0))
        val room = noise(-50.0, secs(1.5), 4)
        val inp = cat(room, phrase1, pause, phrase2)
        val out = ShortArray(inp.size)
        val gains = DoubleArray(inp.size)
        for (i in inp.indices) {
            out[i] = Math.round(agc.processSample(inp[i].toFloat())).toShort()
            gains[i] = agc.currentGainDb
        }
        val p1End = room.size + phrase1.size
        val p2Start = p1End + pause.size
        val gainAtEnd = gains[p1End - 1]
        assertTrue("speech gain $gainAtEnd", gainAtEnd > 8.0)
        for (i in p1End until p2Start) assertTrue("gain swelled in the pause at $i: ${gains[i]} > $gainAtEnd", gains[i] <= gainAtEnd + 0.05)
        // The pause is held, not faded: the first 50 ms of phrase 2 already carry (nearly) the speech gain.
        val first50 = secs(0.05)
        val gain = rmsDb(out, p2Start, p2Start + first50) - rmsDb(inp, p2Start, p2Start + first50)
        assertTrue("start of phrase 2 only +$gain dB", gain >= gainAtEnd - 2.0)
    }

    @Test
    fun fullScaleCleanInputAtZeroGainIsNotDistorted() {
        // -9 dBFS RMS (peak -6): already louder than the target, so no gain; the output must equal the input.
        val inp = cat(noise(-50.0, secs(1.0)), tone(-9.0, secs(2.0)))
        val out = run(inp)
        val from = secs(1.5)
        var maxDiff = 0
        for (i in from until inp.size) maxDiff = maxOf(maxDiff, abs(out[i] - inp[i]))
        assertTrue("max diff $maxDiff", maxDiff <= 1)
        assertEquals(rmsDb(inp, from, inp.size), rmsDb(out, from, out.size), 0.5)
    }

    @Test
    fun overCeilingInputIsLimitedNeverWrapped() {
        val agc = SpeechAgc(rate)
        val b = ShortArray(rate * 2) { if ((it / 8) % 2 == 0) Short.MAX_VALUE else Short.MIN_VALUE }
        val sine = tone(-3.0, rate * 2)
        agc.process(b)
        SpeechAgc(rate).process(sine)
        for (s in b) assertTrue(abs(s.toInt()) <= SpeechAgc.CEILING_INT)
        for (s in sine) assertTrue(abs(s.toInt()) <= SpeechAgc.CEILING_INT)
        assertTrue(peakDb(b) <= -1.0)
        assertTrue(peakDb(sine) <= -1.0)
        assertTrue(b.withIndex().all { (i, v) -> (i / 8) % 2 != 0 || v > 0 })
    }

    @Test
    fun silenceStaysSilent() {
        val b = run(ShortArray(rate))
        assertTrue(b.all { it.toInt() == 0 })
    }

    @Test
    fun resetClearsGainAndStartsClean() {
        val agc = SpeechAgc(rate)
        run(cat(noise(-50.0, secs(1.0)), tone(-30.0, secs(2.0))), agc)
        assertTrue(agc.currentGainDb > 8.0)
        agc.reset()
        assertEquals(0.0, agc.currentGainDb, 0.0)
        val burst = tone(-20.0, secs(0.1))
        val out = run(burst, agc)
        assertEquals(rmsDb(burst), rmsDb(out), 0.5) // no stale gain burst
    }

    /**
     * Speech-like: gaussian noise with a syllabic (4 Hz) raised-cosine amplitude; the dips are 18 dB under the peaks
     * and no gap is longer than 250 ms. [meanDbfs] is the RMS over the whole signal.
     */
    private fun speechLike(meanDbfs: Double, n: Int, seed: Long = 11): ShortArray {
        val f = Math.pow(10.0, -18.0 / 20.0)
        val meanSq = f * f + f * (1 - f) + (1 - f) * (1 - f) * 0.375
        val sigma = 32768.0 * Math.pow(10.0, meanDbfs / 20.0) / sqrt(meanSq)
        val r = java.util.Random(seed)
        return ShortArray(n) {
            val env = f + (1 - f) * 0.5 * (1 + Math.cos(2 * PI * 4.0 * it / rate))
            Math.round(r.nextGaussian() * sigma * env).coerceIn(-32768, 32767).toShort()
        }
    }

    private fun mixSum(a: ShortArray, b: ShortArray): ShortArray = ShortArray(a.size) { (a[it] + b[it]).coerceIn(-32768, 32767).toShort() }

    /** The applied gain (dB) after every sample of [input] through a fresh AGC. */
    private fun gainsOf(input: ShortArray): DoubleArray {
        val agc = SpeechAgc(rate)
        return DoubleArray(input.size) {
            agc.processSample(input[it].toFloat())
            agc.currentGainDb
        }
    }

    private fun minGain(g: DoubleArray, fromSec: Double, toSec: Double = g.size.toDouble() / rate): Double {
        var m = Double.MAX_VALUE
        for (i in secs(fromSec) until minOf(g.size, secs(toSec))) if (g[i] < m) m = g[i]
        return m
    }

    private fun maxGain(g: DoubleArray, fromSec: Double): Double {
        var m = -Double.MAX_VALUE
        for (i in secs(fromSec) until g.size) if (g[i] > m) m = g[i]
        return m
    }

    @Test
    fun quietSpeechPresentFromTheFirstSampleIsLifted() {
        for (mean in doubleArrayOf(-36.0, -38.0)) {
            val len = secs(10.0)
            val g = gainsOf(mixSum(speechLike(mean, len), noise(-55.0, len, 5)))
            assertTrue("mean $mean: min gain after 3 s ${minGain(g, 3.0)}", minGain(g, 3.0) >= 8.0)
        }
    }

    @Test
    fun sixtySecondsOfContinuousSpeechKeepsItsGain() {
        val len = secs(60.0)
        val g = gainsOf(mixSum(speechLike(-31.0, len), noise(-50.0, len, 6)))
        assertTrue("min gain after 2 s ${minGain(g, 2.0)}", minGain(g, 2.0) >= 8.0)
    }

    @Test
    fun sixtySecondsOfContinuousSpeechInANoisyHallKeepsItsGain() {
        val len = secs(60.0)
        val g = gainsOf(mixSum(speechLike(-31.0, len), noise(-42.0, len, 8)))
        assertTrue("min gain after 2 s ${minGain(g, 2.0)}", minGain(g, 2.0) >= 6.0)
    }

    @Test
    fun aSteadyNoiseStepIsNotLiftedForLong() {
        // A fan turning on: -50 for 5 s, then steady -40.
        val g = gainsOf(cat(noise(-50.0, secs(5.0), 9), noise(-40.0, secs(20.0), 10)))
        assertTrue("max gain from 10 s after the step ${maxGain(g, 15.0)}", maxGain(g, 15.0) <= 3.0)
    }

    @Test
    fun noiseInALongPauseAfterSpeechIsNotLeftLifted() {
        val g = gainsOf(
            cat(
                mixSum(speechLike(-31.0, secs(10.0)), noise(-45.0, secs(10.0), 12)),
                noise(-45.0, secs(10.0), 13),
            ),
        )
        assertTrue("gain at the end of speech ${g[secs(10.0) - 1]}", g[secs(10.0) - 1] >= 8.0)
        assertTrue("max gain from 3 s into the pause ${maxGain(g, 13.0)}", maxGain(g, 13.0) <= 3.0)
    }

    private fun core(): MixerCore {
        val c = MixerCore(rate, maxDelayMs = 100, initialDelayMs = 0)
        c.micAgc = SpeechAgc(rate)
        c.sumLimiter = PeakLimiter(rate)
        c.micEnabled = true
        c.hasCamera = false
        return c
    }

    /** Mixes [mic] (320-sample chunks) with [cam] and returns the output. */
    private fun mixAll(c: MixerCore, mic: ShortArray, cam: ShortArray = ShortArray(mic.size)): ShortArray {
        val out = ShortArray(mic.size)
        val o = ShortArray(320)
        val d = ShortArray(320)
        var p = 0
        while (p + 320 <= mic.size) {
            c.mix(cam.copyOfRange(p, p + 320), cam.any { it.toInt() != 0 }, mic.copyOfRange(p, p + 320), o, d, null)
            o.copyInto(out, p)
            p += 320
        }
        return out
    }

    @Test
    fun volumeZeroGivesExactSilenceThroughTheMixer() {
        val c = core()
        c.micVolume = 0
        val out = mixAll(c, cat(noise(-50.0, secs(1.0)), tone(-20.0, secs(1.0))))
        assertTrue(out.all { it.toInt() == 0 })
    }

    @Test
    fun theVolumeSliderStillWorksAfterTheAgc() {
        val inp = cat(noise(-50.0, secs(1.6)), tone(-32.0, secs(3.2)))
        val c100 = core()
        c100.micVolume = 100
        val c50 = core()
        c50.micVolume = 50
        val o100 = mixAll(c100, inp)
        val o50 = mixAll(c50, inp)
        val from = secs(3.5)
        val to = secs(4.6)
        assertEquals(-18.0, rmsDb(o100, from, to), 3.0)
        assertEquals(6.0, rmsDb(o100, from, to) - rmsDb(o50, from, to), 1.0)
    }

    @Test
    fun loudCameraPlusLoudMicNeverPassesTheCeilingAndNeverWraps() {
        val c = core()
        val cam = tone(-6.0, secs(2.0))
        val mic = tone(-8.0, secs(2.0)) // in phase with the camera: the sum would be about +2 dBFS
        val out = mixAll(c, mic, cam)
        for (s in out) assertTrue(abs(s.toInt()) <= SpeechAgc.CEILING_INT)
        assertTrue(peakDb(out) <= -1.0)
        // no wrap: where both inputs are positive the output is positive
        for (i in out.indices) if (cam[i] > 1000 && mic[i] > 1000) assertTrue("wrapped at $i: ${out[i]}", out[i] > 0)
        assertTrue(rmsDb(out, secs(1.0), secs(2.0)) > -8.0) // and it is still loud
    }

    @Test
    fun muteIsExactSilenceAndUnmuteHasNoStaleGainBurst() {
        val c = core()
        val speech = cat(noise(-50.0, secs(1.0)), tone(-30.0, secs(2.0)))
        mixAll(c, speech)
        assertTrue(c.micAgc!!.currentGainDb > 8.0)
        // mic off (muted): exact silence out, and the AGC is reset when it comes back
        val o = ShortArray(320)
        val d = ShortArray(320)
        repeat(10) { c.mix(ShortArray(320), false, null, o, d, null) }
        assertTrue(o.all { it.toInt() == 0 })
        val loud = tone(-14.0, 320)
        c.mix(ShortArray(320), false, loud, o, d, null)
        assertEquals(0.0, c.micAgc!!.currentGainDb, 0.0)
        assertTrue(rmsDb(o) <= rmsDb(loud) + 1.0) // the first chunk is not boosted by the old gain
    }
}
