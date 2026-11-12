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
    private val lastLines = ArrayDeque<String>()

    fun start() {
        synchronized(lock) {
            val t = thread
            if (t != null && t.isAlive && !stopping) return
            stopping = false
            sleeping = false
            val nt = Thread({ loop() }, "box-supervisor")
            nt.isDaemon = true
            thread = nt
            nt.start()
        }
    }

    /** Terminate, wait [graceMs], then kill. Returns when the loop has ended. */
    fun stop() {
        val t: Thread
        synchronized(lock) {
            val existing = thread
            if (existing == null || !existing.isAlive) return
            t = existing
            stopping = true
            current?.terminate()
            if (sleeping) t.interrupt()
        }
        t.join(graceMs)
        if (t.isAlive) {
            synchronized(lock) { current?.kill() }
            t.join(graceMs)
            if (t.isAlive) t.interrupt()
        }
    }

    fun restart() {
        stop()
        start()
    }

    private fun emit(state: BoxRunState) {
        try {
            onState(state)
        } catch (e: Exception) {
            // a faulty observer must not stop the box
        }
    }

    private fun isStopping(): Boolean = synchronized(lock) { stopping }

    private fun loop() {
        val exits = ArrayList<Long>()
        try {
            while (!isStopping()) {
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
                        current = proc
                        if (stopping) proc.terminate()
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
                    synchronized(lock) { current = null }
                }
                log.appendLine("MAXCOM: pelayan berhenti (kod $exit)")
                if (isStopping()) break

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
                if (delay > 0 && !pause(delay)) break
            }
        } finally {
            Thread.interrupted()
            emit(BoxRunState.Stopped)
        }
    }

    /** False when stop() woke the wait. */
    private fun pause(ms: Long): Boolean {
        synchronized(lock) {
            if (stopping) return false
            sleeping = true
        }
        try {
            sleeper.sleep(ms)
        } catch (e: InterruptedException) {
            return false
        } finally {
            synchronized(lock) { sleeping = false }
        }
        return !isStopping()
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
