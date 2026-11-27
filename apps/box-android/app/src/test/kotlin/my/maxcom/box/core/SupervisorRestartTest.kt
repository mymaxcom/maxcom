package my.maxcom.box.core

import java.io.ByteArrayInputStream
import java.io.File
import java.io.IOException
import java.io.InputStream
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

/** Field bug 2026-11-14: after a restart the server never came back. The restart must always start again. */
class SupervisorRestartTest {
    @get:Rule
    val tmp = TemporaryFolder()

    private class Proc(override val pid: Int, private val exitOnTerm: Int, private val ignoresTerm: Boolean = false) : RunningProcess {
        override val output: InputStream = ByteArrayInputStream(ByteArray(0))
        private val ended = CountDownLatch(1)
        private var code = 0
        override fun waitFor(): Int { ended.await(); return code }
        override fun terminate() { if (!ignoresTerm) { code = exitOnTerm; ended.countDown() } }
        override fun kill() { code = 137; ended.countDown() }
    }

    private inner class Rig(val makeProc: (Int) -> RunningProcess, graceMs: Long = 300) {
        val starts = AtomicInteger()
        val running = LinkedHashSet<Int>()
        val logFile = File(tmp.root, "box.log")
        val sup = Supervisor(
            starter = object : ProcessStarter {
                override fun start(command: List<String>, env: Map<String, String>, cwd: File): RunningProcess {
                    val n = starts.incrementAndGet()
                    return makeProc(n)
                }
            },
            clock = Clock { System.currentTimeMillis() },
            sleeper = Sleeper { Thread.sleep(it) },
            log = LogFile(logFile),
            reaper = ProcReaper(File(tmp.root, "noproc"), setOf("libnode.so"), tmp.root, 1, { _, _ -> }, { null }, {}),
            commandProvider = { listOf("x") },
            envProvider = { emptyMap() },
            onState = { s -> if (s is BoxRunState.Running) synchronized(running) { running.add(s.pid) } },
            graceMs = graceMs,
        )

        fun awaitStarts(n: Int) {
            val end = System.currentTimeMillis() + 5000
            while (starts.get() < n) { check(System.currentTimeMillis() < end) { "only ${starts.get()} starts" }; Thread.sleep(10) }
        }
    }

    @Test
    fun restartAfterACleanExit0StartsTheServerAgain() {
        val r = Rig({ Proc(it, exitOnTerm = 0) })
        r.sup.start(); r.awaitStarts(1)
        r.sup.restart(); r.awaitStarts(2)
        assertTrue(r.sup.isActive())
        r.sup.restart(); r.awaitStarts(3)
        assertTrue(r.sup.isActive())
        r.sup.stop()
        val log = r.logFile.readText()
        assertTrue(log, log.contains("penyelia: mula semula diminta"))
        assertTrue(log, log.contains("(kod 0)"))
    }

    @Test
    fun restartOfAServerThatIgnoresTermKillsItAndStartsAgain() {
        val r = Rig({ Proc(it, 0, ignoresTerm = it == 1) }, graceMs = 200)
        r.sup.start(); r.awaitStarts(1)
        r.sup.restart(); r.awaitStarts(2)
        assertTrue(r.sup.isActive())
        assertTrue(r.logFile.readText().contains("(kod 137)"))
        r.sup.stop()
    }

    @Test
    fun ensureRunningStartsALoopThatEndedAndLogsIt() {
        val r = Rig({ Proc(it, 0) })
        assertFalse(r.sup.isActive())
        assertTrue(r.sup.ensureRunning()); r.awaitStarts(1)
        assertTrue(r.sup.isActive())
        assertFalse("already active: nothing to do", r.sup.ensureRunning())
        r.sup.stop()
        // stopped on purpose, thread gone: the watchdog path starts it again
        val end = System.currentTimeMillis() + 3000
        while (r.sup.isActive() && System.currentTimeMillis() < end) Thread.sleep(10)
        assertTrue(r.sup.ensureRunning()); r.awaitStarts(2)
        assertTrue(r.logFile.readText().contains("dimulakan semula oleh pengawas"))
        r.sup.stop()
    }

    @Test
    fun aStartThatThrowsAnErrorIsLoggedNotSwallowed() {
        val r = Rig({ throw NoClassDefFoundError("boom") })
        r.sup.start(); r.awaitStarts(1)
        val end = System.currentTimeMillis() + 3000
        while (!r.logFile.exists() || !r.logFile.readText().contains("gelung tamat")) {
            check(System.currentTimeMillis() < end) { "no log" }; Thread.sleep(10)
        }
        assertTrue(r.logFile.readText().contains("gelung penyelia terhenti"))
        assertFalse(r.sup.isActive())
        assertTrue(r.sup.ensureRunning())
        r.sup.stop()
    }

    @Test
    fun theCertificateLockWaitIsBounded() {
        val held = CountDownLatch(1)
        val done = CountDownLatch(1)
        val t = Thread { CertLock.held { held.countDown(); done.await() } }
        t.start()
        assertTrue(held.await(2, TimeUnit.SECONDS))
        try {
            assertThrows(CertLockBusy::class.java) { CertLock.held(waitMs = 100) { 1 } }
        } finally {
            done.countDown(); t.join()
        }
        assertEquals(5, CertLock.held(waitMs = 100) { 5 })
    }

    /** A child whose output read blocks until [release], and which ignores TERM and KILL (a stuck loop thread). */
    private class StuckProc(override val pid: Int) : RunningProcess {
        val release = CountDownLatch(1)
        /** Counted down once the loop thread is inside the blocking read: only then is the thread really stuck. */
        val blocked = CountDownLatch(1)
        override val output: InputStream = object : InputStream() {
            override fun read(): Int { blocked.countDown(); try { release.await() } catch (_: InterruptedException) { release.await() }; return -1 }
        }
        override fun waitFor(): Int = 0
        override fun terminate() {}
        override fun kill() {}
    }

    @Test
    fun aStuckOldLoopNeverYieldsASecondLiveChild() {
        val stuck = StuckProc(1)
        val r = Rig({ if (it == 1) stuck else Proc(it, 0) }, graceMs = 100)
        assertTrue(r.sup.start()); r.awaitStarts(1)
        // wait until the old loop thread is inside its blocking read: a stop (and its later interrupt) sent before that
        // could end the thread, and the test would then see a free slot instead of a stuck one (a timing flake under load)
        assertTrue("old loop never reached its blocking read", stuck.blocked.await(10, TimeUnit.SECONDS))
        r.sup.stop() // old thread stays alive in its blocking read
        assertFalse("old thread alive: no new loop", r.sup.start())
        assertFalse(r.sup.ensureRunning())
        r.sup.restart()
        Thread.sleep(150)
        assertEquals(1, r.starts.get())
        assertTrue(r.logFile.readText().contains("gelung lama masih hidup, cuba semula"))
        stuck.release.countDown()
        val end = System.currentTimeMillis() + 3000
        while (r.sup.isActive() && System.currentTimeMillis() < end) Thread.sleep(10)
        // the old loop ended; the watchdog path starts a fresh one
        var started = false
        while (!started && System.currentTimeMillis() < end + 3000) { started = r.sup.ensureRunning(); if (!started) Thread.sleep(20) }
        assertTrue(started); r.awaitStarts(2)
        // the new loop owns `current`: stop must terminate its child (exit by TERM) and finish
        r.sup.stop()
        assertFalse(r.sup.isActive())
        assertEquals(2, r.starts.get())
    }

    @Test
    fun noStartAfterShutdown() {
        val r = Rig({ Proc(it, 0) })
        assertTrue(r.sup.start()); r.awaitStarts(1)
        r.sup.shutdown()
        assertFalse(r.sup.isActive())
        assertFalse(r.sup.start())
        assertFalse(r.sup.ensureRunning())
        r.sup.restart()
        Thread.sleep(100)
        assertEquals(1, r.starts.get())
    }

    @Test
    fun refuseStartsBlocksAWatchdogTickBeforeTheStopFinishes() {
        val r = Rig({ Proc(it, 0) })
        assertTrue(r.sup.start()); r.awaitStarts(1)
        r.sup.refuseStarts()
        r.sup.stop()
        assertFalse(r.sup.ensureRunning())
        assertEquals(1, r.starts.get())
    }

    @Test
    fun stuckLogGateLogsOncePerStagePerTenMinutesAndNeverAfterFailure() {
        val g = StuckLogGate(600_000)
        assertFalse("preparation ended (failed): not stuck", g.shouldLog("langkah 3", false, 0))
        assertTrue(g.shouldLog("langkah 3", true, 1_000))
        assertFalse(g.shouldLog("langkah 3", true, 31_000))
        assertFalse(g.shouldLog("langkah 3", true, 590_000))
        assertTrue(g.shouldLog("langkah 3", true, 601_001))
        assertTrue("another stage logs at once", g.shouldLog("langkah 4", true, 602_000))
    }
}
