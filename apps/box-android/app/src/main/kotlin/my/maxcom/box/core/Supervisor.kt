package my.maxcom.box.core

import java.io.File
import java.io.InputStream

interface RunningProcess {
    val pid: Int
    val output: InputStream
    fun waitFor(): Int
    fun terminate()
    fun kill()
}

interface ProcessStarter {
    fun start(command: List<String>, env: Map<String, String>, cwd: File): RunningProcess
}

fun interface Clock {
    fun nowMs(): Long
}

fun interface Sleeper {
    /** Throws [InterruptedException] when [Supervisor.stop] wakes it. */
    fun sleep(ms: Long)
}

sealed class BoxRunState {
    object Starting : BoxRunState()
    data class Running(val pid: Int, val since: Long) : BoxRunState()
    data class Waiting(val delayMs: Long, val lastExit: Int) : BoxRunState()
    data class Failing(val lastLines: List<String>) : BoxRunState()
    object Stopped : BoxRunState()
}

/**
 * Runs the box server with the launcher.mjs contract: exit 75 restarts at once, any other exit waits
 * 5 s (growing after 5 quick failures, see [Backoff]); exit 76 is treated as 75 and calls [selfUpdate].
 * One child at a time: a second [start] while running does nothing. Command, environment and working
 * directory are asked for again at every start; [reaper] runs before each start. Child output goes to
 * [log] line by line; values of environment keys that look secret are redacted from it.
 */
class Supervisor(
    private val starter: ProcessStarter,
    private val clock: Clock,
    private val sleeper: Sleeper,
    private val log: LogFile,
    private val reaper: ProcReaper,
    private val commandProvider: () -> List<String>,
    private val envProvider: () -> Map<String, String>,
    private val onState: (BoxRunState) -> Unit,
    private val cwdProvider: () -> File = { File(".") },
    private val selfUpdate: SelfUpdate = NoSelfUpdate,
    private val graceMs: Long = STOP_GRACE_MS,
) {
    private val lock = Object()
    private var thread: Thread? = null
    private var current: RunningProcess? = null
    private var stopping = false
    private var sleeping = false
    private var restarting = false
    private var shutDown = false
    private var generation = 0
    private val lastLines = ArrayDeque<String>()

    /** True while a loop thread runs and nobody asked it to stop, or while [restart] is between its stop and its start. */
    fun isActive(): Boolean = synchronized(lock) {
        if (restarting) return true
        val t = thread
        t != null && t.isAlive && !stopping
    }

    /**
     * Starts a loop. False when none was started: after [shutdown], while a loop is running, or while an old loop
     * thread is still alive (stuck after a stop); a new loop never runs beside an old thread, the watchdog retries.
     */
    fun start(): Boolean {
        synchronized(lock) {
            if (shutDown) {
                note("penyelia: start ditolak, penyelia telah ditutup")
                return false
            }
            val t = thread
            if (t != null && t.isAlive) {
                if (stopping) note("penyelia: gelung lama masih hidup, cuba semula")
                else note("penyelia: start diminta, sudah berjalan (diabaikan)")
                return false
            }
            stopping = false
            sleeping = false
            val mine = ++generation
            val nt = Thread({ loop(mine) }, "box-supervisor")
            nt.isDaemon = true
            thread = nt
            note("penyelia: start diminta, gelung baharu dimulakan")
            nt.start()
            return true
        }
    }

    /** Refuses every later [start], [restart] and [ensureRunning]; does not stop a running loop. */
    fun refuseStarts() {
        synchronized(lock) { shutDown = true }
    }

    /** For service destruction: [refuseStarts], then [stop]. The supervisor cannot be started again. */
    fun shutdown() {
        refuseStarts()
        stop()
    }

    /** Terminate, wait [graceMs], then kill. Returns when the loop has ended. */
    fun stop() {
        val t: Thread
        synchronized(lock) {
            val existing = thread
            if (existing == null || !existing.isAlive) {
                note("penyelia: henti diminta, tiada gelung berjalan")
                return
            }
            t = existing
            stopping = true
            note("penyelia: henti diminta, SIGTERM dihantar")
            current?.terminate()
            if (sleeping) t.interrupt()
        }
        t.join(graceMs)
        if (t.isAlive) {
            note("penyelia: pelayan tidak berhenti dalam masa, dibunuh (SIGKILL)")
            synchronized(lock) { current?.kill() }
            t.join(graceMs)
            if (t.isAlive) {
                note("penyelia: gelung masih hidup selepas SIGKILL, diganggu")
                t.interrupt()
            }
        }
    }

    /** Stop then start. The start always happens, even when the stop fails; [isActive] stays true in between. */
    fun restart() {
        synchronized(lock) { restarting = true }
        note("penyelia: mula semula diminta")
        try {
            try {
                stop()
            } catch (e: Throwable) {
                note("penyelia: GAGAL henti semasa mula semula: " + e.javaClass.simpleName)
            }
        } finally {
            synchronized(lock) { restarting = false }
            start()
        }
    }

    /** Starts the loop when it is not active (a watchdog calls this); true when it had to start it. */
    fun ensureRunning(): Boolean {
        if (isActive()) return false
        synchronized(lock) { if (shutDown) return false }
        note("penyelia: gelung tidak aktif, dimulakan semula oleh pengawas")
        return start()
    }

    private fun note(text: String) {
        try {
            log.appendLine(text)
        } catch (e: Exception) {
            // the log must never stop the box
        }
    }

    private fun emit(state: BoxRunState) {
        try {
            onState(state)
        } catch (e: Exception) {
            // a faulty observer must not stop the box
        }
    }

    private fun isStopping(mine: Int): Boolean = synchronized(lock) { stopping || generation != mine }

    private fun loop(mine: Int) {
        val exits = ArrayList<Long>()
        try {
            while (!isStopping(mine)) {
                emit(BoxRunState.Starting)
                try {
                    reaper.reap()
                } catch (e: Exception) {
                    log.appendLine("GAGAL bersihkan proses lama: " + e.javaClass.simpleName)
                }
                var startedAt = clock.nowMs()
                var exit: Int
                try {
                    val command = commandProvider()
                    val env = envProvider()
                    for ((k, v) in env) if (looksSecret(k)) log.addSecret(v)
                    val proc = starter.start(command, env, cwdProvider())
                    synchronized(lock) {
                        if (generation == mine) current = proc
                        if (stopping || generation != mine) proc.terminate()
                    }
                    startedAt = clock.nowMs()
                    emit(BoxRunState.Running(proc.pid, startedAt))
                    log.appendLine("MAXCOM: pelayan bermula (PID " + proc.pid + ")")
                    pump(proc.output)
                    exit = proc.waitFor()
                } catch (e: InterruptedException) {
                    break
                } catch (e: Exception) {
                    log.appendLine("GAGAL mula: " + e.javaClass.simpleName + ": " + (e.message ?: ""))
                    exit = 1
                } finally {
                    synchronized(lock) { if (generation == mine) current = null }
                }
                log.appendLine("MAXCOM: pelayan berhenti (kod $exit)")
                if (isStopping(mine)) break

                val now = clock.nowMs()
                val immediate = exit == Backoff.RESTART_NOW_EXIT || exit == Backoff.APK_WAITING_EXIT
                if (exit == Backoff.APK_WAITING_EXIT) {
                    try {
                        selfUpdate.onApkWaiting()
                    } catch (e: Exception) {
                        log.appendLine("GAGAL kemas kini sendiri: " + e.javaClass.simpleName)
                    }
                }
                if (!immediate) {
                    if (now - startedAt > Backoff.RESET_RUN_MS) exits.clear()
                    exits.add(now)
                    while (exits.size > MAX_EXITS_KEPT) exits.removeAt(0)
                }
                val delay = Backoff.nextDelayMs(exit, exits, now)
                if (!immediate && Backoff.isFailing(exits, now)) {
                    emit(BoxRunState.Failing(snapshotLines()))
                } else {
                    emit(BoxRunState.Waiting(delay, exit))
                }
                if (delay > 0 && !pause(delay, mine)) break
            }
        } catch (e: Throwable) {
            note("GAGAL: gelung penyelia terhenti tanpa jangka: " + e.javaClass.simpleName)
        } finally {
            Thread.interrupted()
            note("penyelia: gelung tamat")
            if (synchronized(lock) { generation == mine }) emit(BoxRunState.Stopped)
        }
    }

    /** False when stop() woke the wait. */
    private fun pause(ms: Long, mine: Int): Boolean {
        synchronized(lock) {
            if (stopping || generation != mine) return false
            sleeping = true
        }
        try {
            sleeper.sleep(ms)
        } catch (e: InterruptedException) {
            return false
        } finally {
            synchronized(lock) { sleeping = false }
        }
        return !isStopping(mine)
    }

    private fun pump(output: InputStream) {
        val reader = output.bufferedReader(Charsets.UTF_8)
        while (true) {
            val line = reader.readLine() ?: break
            val clipped = if (line.length > MAX_LINE) line.substring(0, MAX_LINE) + "..." else line
            log.appendLine(clipped)
            synchronized(lastLines) {
                lastLines.addLast(log.redact(clipped))
                while (lastLines.size > LAST_LINES) lastLines.removeFirst()
            }
        }
    }

    private fun snapshotLines(): List<String> = synchronized(lastLines) { lastLines.toList() }

    companion object {
        const val STOP_GRACE_MS = 5_000L
        const val LAST_LINES = 20
        private const val MAX_LINE = 8_192
        private const val MAX_EXITS_KEPT = 64
        private val SECRET_KEY = Regex("TOKEN|KEY|SECRET|PASSWORD", RegexOption.IGNORE_CASE)

        private fun looksSecret(key: String) = SECRET_KEY.containsMatchIn(key)
    }
}
