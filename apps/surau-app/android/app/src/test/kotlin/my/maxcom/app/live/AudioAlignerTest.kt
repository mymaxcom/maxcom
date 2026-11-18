package my.maxcom.app.live

import java.io.File
import java.nio.ByteBuffer
import java.nio.ByteOrder
import kotlin.math.PI
import kotlin.math.abs
import kotlin.math.cos
import kotlin.math.exp
import kotlin.math.floor
import kotlin.math.max
import kotlin.math.min
import kotlin.math.pow
import kotlin.math.roundToInt
import kotlin.math.sin
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Twin of apps/box-server/test/align.test.ts. The shared fixtures are NOT copied: they are read from
 * apps/box-server/test/fixtures/align (made by scripts/test/make-align-vectors.mjs), found by walking up from the
 * Gradle test working directory (the module dir), so both implementations always test against the same bytes.
 */
class AudioAlignerTest {
    private val rate = 16000

    private fun fixtureDir(): File {
        var d: File? = File(System.getProperty("user.dir")).absoluteFile
        while (d != null) {
            val c = File(d, "apps/box-server/test/fixtures/align")
            if (c.isDirectory) return c
            d = d.parentFile
        }
        throw IllegalStateException("align fixtures not found above ${System.getProperty("user.dir")}")
    }

    private fun load(name: String): ShortArray {
        val b = File(fixtureDir(), "$name.s16").readBytes()
        val s = ShortArray(b.size / 2)
        ByteBuffer.wrap(b).order(ByteOrder.LITTLE_ENDIAN).asShortBuffer().get(s)
        return s
    }

    private fun toS16(x: DoubleArray): ShortArray = ShortArray(x.size) { (x[it] * 32767).roundToInt().coerceIn(-32768, 32767).toShort() }

    // ---- synthetic speech (port of makeMaster in make-align-vectors.mjs; same algorithm, own PRNG stream is fine) ----
    private class Rng(seed: Int) {
        private var a = seed
        fun next(): Double {
            a += 0x6d2b79f5
            var t = a
            t = (t xor (t ushr 15)) * (t or 1)
            t = t xor (t + (t xor (t ushr 7)) * (t or 61))
            return ((t xor (t ushr 14)).toLong() and 0xffffffffL) / 4294967296.0
        }
    }

    private fun makeMaster(seconds: Int, seed: Int): DoubleArray {
        val rand = Rng(seed)
        val n = seconds * rate
        val out = DoubleArray(n)
        var i = 0
        var f0 = 120.0
        while (i < n) {
            i += ((0.04 + rand.next() * 0.46) * rate).roundToInt()
            val len = ((0.08 + rand.next() * 0.17) * rate).roundToInt()
            val end = min(n, i + len)
            val voiced = rand.next() < 0.8
            val f0End = 100 + rand.next() * 90
            val formants = doubleArrayOf(300 + rand.next() * 500, 900 + rand.next() * 1300, 2300 + rand.next() * 600)
            val bw = doubleArrayOf(90.0, 120.0, 160.0)
            val gain = 0.4 + rand.next() * 0.6
            val a1 = DoubleArray(3)
            val a2 = DoubleArray(3)
            val g = DoubleArray(3)
            val y1 = DoubleArray(3)
            val y2 = DoubleArray(3)
            for (k in 0 until 3) {
                val r = exp(-PI * bw[k] / rate)
                a1[k] = 2 * r * cos(2 * PI * formants[k] / rate)
                a2[k] = -r * r
                g[k] = 1 - r
            }
            var phase = 0.0
            var hp = 0.0
            for (s in i until end) {
                val u = (s - i).toDouble() / max(1, end - i)
                val env = sin(PI * u).pow(1.5)
                val f = f0 + (f0End - f0) * u
                if (voiced) {
                    phase += f / rate
                    if (phase >= 1) phase -= 1
                    val x = if (phase < 0.08) 1 - phase / 0.08 else -0.12
                    var y = 0.0
                    for (k in 0 until 3) {
                        val v = g[k] * x + a1[k] * y1[k] + a2[k] * y2[k]
                        y2[k] = y1[k]
                        y1[k] = v
                        y += v
                    }
                    out[s] = y * env * gain * 6
                } else {
                    val w = rand.next() * 2 - 1
                    hp = w - hp * 0.6
                    out[s] = hp * env * gain * 0.35
                }
            }
            f0 = f0End
            i = end
        }
        var peak = 1e-9
        for (k in 0 until n) peak = max(peak, abs(out[k]))
        for (k in 0 until n) out[k] = out[k] / peak * 0.7
        return out
    }

    // ---- estimateLag on the shared fixtures ----
    private val expected = listOf(
        "lag-37" to 37, "lag-480" to 480, "lag-1250" to 1250, "lag-2900" to 2900,
        "noise-480" to 480, "echo-1250" to 1250, "invert-480" to 480, "drift-480" to 480,
    )

    @Test
    fun everyFixtureIsFoundWithin20Ms() {
        val ref = load("ref")
        for ((name, lag) in expected) {
            val est = AudioAligner.estimateLag(ref, load(name), rate, 4000)
            assertNotNull(name, est)
            assertTrue("$name: got ${est!!.lagMs}, want $lag", abs(est.lagMs - lag) <= 20)
            assertTrue("$name confidence ${est.confidence}", est.confidence >= 0.45)
        }
    }

    @Test
    fun silenceGivesNoResult() {
        val ref = load("ref")
        val sil = load("silence")
        assertNull(AudioAligner.estimateLag(ref, sil, rate, 4000))
        assertNull(AudioAligner.estimateLag(sil, ref, rate, 4000))
    }

    @Test
    fun unrelatedSoundIsNotConfident() {
        val other = toS16(makeMaster(9, 99))
        val est = AudioAligner.estimateLag(load("ref"), other, rate, 4000)
        assertTrue(est == null || est.confidence < 0.45)
    }

    @Test
    fun accurateOnACleanCopyAndNegativeWhenTheSourceIsLate() {
        val m = makeMaster(14, 5)
        val refc = toS16(m.copyOfRange(0, 9 * rate))
        val s0 = (0.9 * rate).roundToInt()
        val early = toS16(m.copyOfRange(s0, s0 + 9 * rate))
        assertTrue(abs(AudioAligner.estimateLag(refc, early, rate, 4000)!!.lagMs - 900) < 3)
        val s1 = (0.6 * rate).roundToInt()
        val refLate = toS16(m.copyOfRange(s1, s1 + 9 * rate))
        val late = toS16(m.copyOfRange(0, 9 * rate))
        assertTrue(abs(AudioAligner.estimateLag(refLate, late, rate, 4000)!!.lagMs + 600) < 3)
    }

    // ---- closed-loop simulator: plays the mixer. Residual = early - delay. ----
    private class Sim(
        val ref: DoubleArray,
        val source: DoubleArray,
        val earlyMs: Double,
        val ppm: Double = 0.0,
        initialDelayMs: Int = 1000,
        val rate: Int = 16000,
    ) {
        val states = ArrayList<AlignState>().apply { add(AlignState.SEARCHING) }
        val applied = ArrayList<Int>()
        var delay = initialDelayMs
        var n = 0
        var lockedAt: Double? = null
        val al = AudioAligner(rate, 4000, initialDelayMs = initialDelayMs)

        init {
            al.onChange = { st, d ->
                if (st != states.last()) {
                    states.add(st)
                    if (st == AlignState.LOCKED && lockedAt == null) lockedAt = n.toDouble() / rate
                }
                if (d != delay) {
                    applied.add(d)
                    delay = d
                }
            }
        }

        private fun at(p: Double): Double {
            if (p < 0) return 0.0
            val j = floor(p).toInt()
            val f = p - j
            return source.getOrElse(j) { 0.0 } * (1 - f) + source.getOrElse(j + 1) { 0.0 } * f
        }

        fun residual() = earlyMs + ppm * 1e-6 * (n.toDouble() / rate) * 1000 - delay

        fun run(seconds: Int, mute: Boolean = false, src2: DoubleArray? = null) {
            val chunk = rate / 2
            val k = 1 + ppm * 1e-6
            var done = 0
            while (done < seconds * rate) {
                val r = ShortArray(chunk)
                val s = ShortArray(chunk)
                for (i in 0 until chunk) {
                    val nn = n + i
                    if (!mute) {
                        val rv = ref.getOrElse(nn) { 0.0 }
                        val sv = if (src2 != null) src2.getOrElse(nn) { 0.0 } else at(nn * k + ((earlyMs - delay) / 1000) * rate)
                        r[i] = (rv * 32767).roundToInt().toShort()
                        s[i] = (sv * 32767).roundToInt().toShort()
                    }
                }
                n += chunk
                al.push(r, s)
                done += chunk
            }
        }
    }

    private val master by lazy { makeMaster(206, 31) }

    @Test
    fun searchingLockedHoldingWithinTarget() {
        val sim = Sim(master, master, 1730.0)
        sim.run(45)
        assertEquals(listOf(AlignState.SEARCHING, AlignState.LOCKED), sim.states)
        assertTrue("residual ${sim.residual()}", abs(sim.residual()) <= 20)
        assertTrue(sim.lockedAt!! < 40)
        sim.run(20, mute = true)
        assertEquals(listOf(AlignState.SEARCHING, AlignState.LOCKED, AlignState.HOLDING), sim.states)
        assertEquals(AlignState.HOLDING, sim.al.state)
        sim.run(20)
        assertEquals(AlignState.LOCKED, sim.al.state)
        assertTrue(sim.applied[0] > 1000)
        assertTrue("corrections ${sim.applied.size}", sim.applied.size <= 3)
        println("bench: ${sim.al.ticks} ticks, ${"%.1f".format(sim.al.cpuMs / sim.al.ticks)} ms per tick (worst ${"%.1f".format(sim.al.maxCpuMs)} ms)")
    }

    private fun degraded(kind: String): DoubleArray {
        val x = master.copyOfRange(0, 60 * rate)
        return when (kind) {
            "noise" -> {
                val rng = Rng(77)
                var e = 0.0
                for (v in x) e += v * v
                val sigma = sqrt(e / x.size) * 10.0.pow(-6.0 / 20) / 0.577
                DoubleArray(x.size) { x[it] + (rng.next() + rng.next() + rng.next() + rng.next() - 2) * sigma }
            }
            "echo" -> {
                val taps = arrayOf(23 to 0.5, 47 to 0.38, 91 to 0.27, 140 to 0.18, 210 to 0.1)
                val o = DoubleArray(x.size)
                for (i in x.indices) {
                    var v = x[i]
                    for ((ms, g) in taps) {
                        val j = i - (ms / 1000.0 * rate).roundToInt()
                        if (j >= 0) v += g * x[j]
                    }
                    o[i] = v
                }
                var y = 0.0
                for (i in o.indices) {
                    y += 0.55 * (o[i] - y)
                    o[i] = y
                }
                o
            }
            else -> DoubleArray(x.size) { -x[it] }
        }
    }

    private fun sqrt(v: Double) = kotlin.math.sqrt(v)

    @Test
    fun locksThroughNoiseEchoAndInvertedPolarity() {
        for (kind in listOf("noise", "echo", "inverted")) {
            val sim = Sim(master, degraded(kind), 2500.0)
            sim.run(55)
            assertEquals(kind, AlignState.LOCKED, sim.al.state)
            assertTrue("$kind residual ${sim.residual()}", abs(sim.residual()) <= 20)
        }
    }

    @Test
    fun delayNeverBelowTheMinimum() {
        val sim = Sim(master, master, -800.0, initialDelayMs = 100)
        sim.run(50)
        assertTrue(sim.applied.isNotEmpty())
        for (d in sim.applied) assertTrue(d >= AudioAligner.MIN_DELAY_MS)
        assertEquals(AudioAligner.MIN_DELAY_MS, sim.applied.min())
        assertTrue(sim.al.state != AlignState.LOCKED)
    }

    @Test
    fun neverStartedAtZero() {
        val al = AudioAligner(rate, 4000, initialDelayMs = 0)
        assertTrue(al.delayMs >= AudioAligner.MIN_DELAY_MS)
    }

    @Test
    fun failedAfter60SecondsKeepsSearchingAndLocksWhenSoundMatches() {
        val unrelated = makeMaster(206, 1234)
        val sim = Sim(master, master, 500.0)
        sim.run(57, src2 = unrelated)
        assertEquals(listOf(AlignState.SEARCHING), sim.states)
        sim.run(6, src2 = unrelated)
        assertEquals(listOf(AlignState.SEARCHING, AlignState.FAILED), sim.states)
        assertEquals(0, sim.applied.size)
        sim.run(50)
        assertEquals(listOf(AlignState.SEARCHING, AlignState.FAILED, AlignState.LOCKED), sim.states)
        assertTrue(abs(sim.residual()) <= 20)
    }

    @Test
    fun silenceAloneNeverFailsOrLocks() {
        val sim = Sim(master, master, 500.0)
        sim.run(90, mute = true)
        assertEquals(listOf(AlignState.SEARCHING), sim.states)
        assertTrue(sim.applied.isEmpty())
    }

    @Test
    fun slowDriftIsCorrectedInSmallSteps() {
        val sim = Sim(master, master, 1200.0, ppm = 300.0)
        sim.run(40)
        assertEquals(listOf(AlignState.SEARCHING, AlignState.LOCKED), sim.states)
        val before = sim.applied.size
        var prev = sim.applied.last()
        var worst = 0.0
        for (i in 0 until 24) {
            sim.run(5)
            worst = max(worst, abs(sim.residual()))
        }
        val drift = sim.applied.drop(before)
        assertTrue("drift corrections ${drift.size}", drift.size > 2)
        for (d in drift) {
            assertTrue("step ${d - prev}", abs(d - prev) <= 5)
            prev = d
        }
        assertTrue("worst $worst", worst <= 20)
        assertEquals(AlignState.LOCKED, sim.al.state)
    }

    @Test
    fun resetSearchesAgainAndManualStopsAnalysis() {
        val sim = Sim(master, master, 900.0)
        sim.run(40)
        assertEquals(AlignState.LOCKED, sim.al.state)
        sim.al.reset()
        assertEquals(AlignState.SEARCHING, sim.al.state)
        sim.al.setManual()
        assertEquals(AlignState.MANUAL, sim.al.state)
        val n = sim.applied.size
        sim.run(30)
        assertEquals(n, sim.applied.size)
    }

    @Test
    fun oddChunkSizesGiveTheSameResultAsRegularOnes() {
        val ref = toS16(master.copyOfRange(0, 30 * rate))
        val a = AudioAligner(rate, 4000)
        val b = AudioAligner(rate, 4000)
        var ca = 0
        var cb = 0
        a.onChange = { _, _ -> ca++ }
        b.onChange = { _, _ -> cb++ }
        a.push(ref, ref)
        var p = 0
        var size = 777
        while (p < ref.size) {
            val e = min(ref.size, p + size)
            b.push(ref.copyOfRange(p, e), ref.copyOfRange(p, e))
            p = e
            size = size % 5000 + 913
        }
        assertEquals(a.state, b.state)
        assertEquals(a.delayMs, b.delayMs)
        assertEquals(ca, cb)
    }
}
