package my.maxcom.box.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.ByteArrayInputStream
import java.io.File
import java.io.InputStream
import java.util.concurrent.CountDownLatch
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicLong

class SupervisorTest {
    @get:Rule
    val tmp = TemporaryFolder()

    private val clock = AtomicLong(1_700_000_000_000L)
    private val fakeClock = Clock { clock.get() }

    /** Records waits and moves the fake clock instead of waiting. */
    private class FakeSleeper(val clock: AtomicLong) : Sleeper {
        val waits = mutableListOf<Long>()
        override fun sleep(ms: Long) {
            synchronized(waits) { waits.add(ms) }
            clock.addAndGet(ms)
        }
    }

    private class FakeProc(
        override val pid: Int,
        text: String,
        private val exitCode: Int?, // null: stays up until terminate (or kill)
        private val clock: AtomicLong,
        private val runMs: Long = 1_000,
        private val ignoresTerminate: Boolean = false,
    ) : RunningProcess {
        override val output: InputStream = ByteArrayInputStream(text.toByteArray())
        private val ended = CountDownLatch(1)
        @Volatile var terminated = false
        @Volatile var killed = false
        override fun waitFor(): Int {
            if (exitCode != null) {
                clock.addAndGet(runMs)
                return exitCode
            }
            ended.await()
            return 143
        }
        override fun terminate() { terminated = true; if (!ignoresTerminate) ended.countDown() }
        override fun kill() { killed = true; ended.countDown() }
    }

    private class Call(val command: List<String>, val env: Map<String, String>, val cwd: File)

    private inner class Rig(val procs: MutableList<FakeProc>, graceMs: Long = 5_000) {
        val calls = mutableListOf<Call>()
        val states = LinkedBlockingQueue<BoxRunState>()
        val sleeper = FakeSleeper(clock)
        var commandCalls = 0
        var envCalls = 0
        val logFile = File(tmp.root, "data/logs/box.log")
        val log = LogFile(logFile, nowMs = { clock.get() })
        val reaps = mutableListOf<Int>()
        var order = mutableListOf<String>()
        val starter = object : ProcessStarter {
            override fun start(command: List<String>, env: Map<String, String>, cwd: File): RunningProcess {
                synchronized(order) { order.add("start") }
                calls.add(Call(command, env, cwd))
                return procs.removeAt(0)
            }
        }
        val reaper = ProcReaper(File(tmp.root, "noproc"), setOf("libnode.so"), tmp.root, 1, { _, _ -> }, { null }, {})
        val sup = Supervisor(
            starter, fakeClock, sleeper, log, reaper,
            commandProvider = { commandCalls++; listOf("/lib/libnode.so", "main.ts") },
            envProvider = { envCalls++; mapOf("SURAU_KIOSK_TOKEN" to "tok-${envCalls}-0123456789abcdef", "TZ" to "Asia/Kuala_Lumpur") },
            onState = { states.add(it) },
            cwdProvider = { File("/files/box/current") },
            graceMs = graceMs,
        )

        fun awaitState(timeoutMs: Long = 5000, test: (BoxRunState) -> Boolean): BoxRunState {
            val end = System.currentTimeMillis() + timeoutMs
            while (true) {
                val left = end - System.currentTimeMillis()
                val s = states.poll(maxOf(left, 1), TimeUnit.MILLISECONDS) ?: error("state not reached")
                if (test(s)) return s
                if (left <= 0) error("state not reached")
            }
        }

        fun awaitRunning(n: Int) { repeat(n) { awaitState { it is BoxRunState.Running } } }
        fun awaitLog(needle: String) {
            val end = System.currentTimeMillis() + 5000
            while (!(logFile.exists() && logFile.readText().contains(needle))) {
                check(System.currentTimeMillis() < end) { "log lacks $needle" }
                Thread.sleep(10)
            }
        }
        fun awaitStopped() { awaitState { it === BoxRunState.Stopped } }
        fun logText(): String = logFile.readText()
    }

    private fun proc(pid: Int, exit: Int?, text: String = "out-$pid", runMs: Long = 1_000, ignores: Boolean = false) =
        FakeProc(pid, text, exit, clock, runMs, ignores)

    @Test
    fun exit75ThenExit1ThenStayUpFollowsTheContract() {
        val r = Rig(mutableListOf(proc(1, 75), proc(2, 1), proc(3, null)))
        r.sup.start()
        r.awaitRunning(3)
        r.awaitLog("out-3")
        // 75 restarts at once (no wait), 1 waits 5000
        assertEquals(listOf(5000L), r.sleeper.waits)
        assertEquals(3, r.commandCalls)
        assertEquals(3, r.envCalls)
        // the three outputs are in the log in order
        val text = r.logText()
        assertTrue(text.indexOf("out-1") in 0 until text.indexOf("out-2"))
        assertTrue(text.indexOf("out-2") in 0 until text.indexOf("out-3"))
        assertTrue(text.contains("(kod 75)"))
        assertTrue(text.contains("(kod 1)"))
        // the environment is asked for again: a new token per start, and none of them is in the log
        assertEquals(3, r.calls.map { it.env["SURAU_KIOSK_TOKEN"] }.toSet().size)
        assertFalse(text.contains("0123456789abcdef"))
        assertEquals(File("/files/box/current"), r.calls[0].cwd)
        r.sup.stop()
        r.awaitStopped()
    }

    @Test
    fun exit76IsHandledLikeAndCallsTheHook() {
        var hooked = 0
        val r = Rig(mutableListOf(proc(1, 76), proc(2, null)))
        val sup = Supervisor(
            r.starter, fakeClock, r.sleeper, r.log, r.reaper, { listOf("x") }, { emptyMap() },
            { r.states.add(it) }, selfUpdate = object : SelfUpdate { override fun onApkWaiting(): Boolean { hooked++; return false } },
        )
        sup.start()
        r.awaitRunning(2)
        assertEquals(1, hooked)
        assertTrue(r.sleeper.waits.isEmpty())
        sup.stop()
    }

    @Test
    fun quickExitsGrowTheWaitAndEndInFailingWithTheLastTwentyLines() {
        val lines = (1..25).joinToString("\n") { "line $it" }
        val procs = (1..9).map { proc(it, 1, lines) }.toMutableList<FakeProc>()
        procs.add(proc(10, null))
        val r = Rig(procs)
        r.sup.start()
        val failing = r.awaitState { it is BoxRunState.Failing } as BoxRunState.Failing
        assertEquals(20, failing.lastLines.size)
        assertEquals("line 6", failing.lastLines.first())
        assertEquals("line 25", failing.lastLines.last())
        r.awaitState { it is BoxRunState.Running && it.pid == 10 }
        assertEquals(listOf(5000L, 5000, 5000, 5000, 5000, 10000, 20000, 40000, 60000), r.sleeper.waits)
        r.sup.stop()
    }

    @Test
    fun aLongRunResetsTheStreak() {
        val procs = mutableListOf<FakeProc>()
        repeat(4) { procs.add(proc(it + 1, 1)) }
        procs.add(proc(5, 1, runMs = Backoff.RESET_RUN_MS + 1))
        repeat(4) { procs.add(proc(it + 6, 1)) }
        procs.add(proc(10, null))
        val r = Rig(procs)
        r.sup.start()
        r.awaitRunning(10)
        assertTrue(r.states.none { it is BoxRunState.Failing })
        assertTrue(r.sleeper.waits.all { it == 5000L })
        r.sup.stop()
    }

    @Test
    fun stopDuringAWaitStartsNothingMore() {
        val release = CountDownLatch(1)
        val r = Rig(mutableListOf(proc(1, 1), proc(2, null)))
        val sup = Supervisor(
            r.starter, fakeClock, Sleeper { release.await() }, r.log, r.reaper, { listOf("x") }, { emptyMap() },
            { r.states.add(it) },
        )
        sup.start()
        r.awaitState { it is BoxRunState.Waiting }
        sup.stop()
        r.awaitStopped()
        assertEquals(1, r.calls.size)
    }

    @Test
    fun stopKillsAProcessThatIgnoresTerminate() {
        val p = proc(1, null, ignores = true)
        val r = Rig(mutableListOf(p), graceMs = 300)
        r.sup.start()
        r.awaitRunning(1)
        val t0 = System.nanoTime()
        r.sup.stop()
        r.awaitStopped()
        assertTrue(p.terminated)
        assertTrue(p.killed)
        assertTrue("waited for the grace", (System.nanoTime() - t0) / 1_000_000 >= 280)
        assertEquals(5_000L, Supervisor.STOP_GRACE_MS)
    }

    @Test
    fun stopOfACooperativeProcessDoesNotKill() {
        val p = proc(1, null)
        val r = Rig(mutableListOf(p))
        r.sup.start()
        r.awaitRunning(1)
        r.sup.stop()
        r.awaitStopped()
        assertTrue(p.terminated)
        assertFalse(p.killed)
    }

    @Test
    fun aSecondStartWhileRunningDoesNothing() {
        val r = Rig(mutableListOf(proc(1, null), proc(2, null)))
        r.sup.start()
        r.awaitRunning(1)
        r.sup.start()
        r.sup.start()
        Thread.sleep(150)
        assertEquals(1, r.calls.size)
        assertEquals(1, r.commandCalls)
        r.sup.stop()
    }

    @Test
    fun restartStopsThenStartsAgainWithFreshProviders() {
        val r = Rig(mutableListOf(proc(1, null), proc(2, null)))
        r.sup.start()
        r.awaitRunning(1)
        r.sup.restart()
        r.awaitRunning(1)
        assertEquals(2, r.calls.size)
        assertEquals(2, r.commandCalls)
        assertTrue(r.sleeper.waits.isEmpty())
        r.sup.stop()
    }

    @Test
    fun aStartFailureIsLoggedAndRetried() {
        val r = Rig(mutableListOf(proc(1, null)))
        var first = true
        val sup = Supervisor(
            object : ProcessStarter {
                override fun start(command: List<String>, env: Map<String, String>, cwd: File): RunningProcess {
                    if (first) { first = false; throw java.io.IOException("no such file") }
                    return r.procs.removeAt(0)
                }
            },
            fakeClock, r.sleeper, r.log, r.reaper, { listOf("x") }, { emptyMap() }, { r.states.add(it) },
        )
        sup.start()
        r.awaitRunning(1)
        assertTrue(r.logText().contains("GAGAL mula: IOException"))
        assertEquals(listOf(5000L), r.sleeper.waits)
        sup.stop()
    }

    @Test
    fun theReaperRunsBeforeEveryStart() {
        val r = Rig(mutableListOf(proc(1, 75), proc(2, null)))
        val events = mutableListOf<String>()
        val procDir = File(tmp.root, "p").apply { mkdirs() }
        File(procDir, "55").mkdirs()
        val reaper = ProcReaper(procDir, setOf("libnode.so"), tmp.root, 1, { _, _ -> }, { events.add("reap"); null }, {})
        val sup = Supervisor(
            object : ProcessStarter {
                override fun start(command: List<String>, env: Map<String, String>, cwd: File): RunningProcess {
                    events.add("start"); return r.procs.removeAt(0)
                }
            },
            fakeClock, r.sleeper, r.log, reaper, { listOf("x") }, { emptyMap() }, { r.states.add(it) },
        )
        sup.start()
        r.awaitRunning(2)
        sup.stop()
        assertEquals(listOf("reap", "start", "reap", "start"), events)
    }
}
