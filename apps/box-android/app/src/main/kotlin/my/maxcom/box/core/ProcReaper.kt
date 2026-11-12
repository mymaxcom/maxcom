package my.maxcom.box.core

import java.io.File
import java.nio.file.Files

/**
 * Ends leftover children of an earlier run (a MediaMTX kept alive by a killed Node holds the media
 * ports). By PID only, never by name: for every numeric folder in [procDir] the `exe` link is read and
 * the process is signalled only when it resolves to one of [exeNames] directly inside [nativeLibDir].
 * TERM first, up to [termWaitMs], then KILL. The own PID is never touched; a PID that vanishes (or
 * cannot be read) is skipped without error.
 *
 * Only `exe` decides. `cmdline` is not required to match: how Android reports argv[0] for a `.so` run
 * directly is unproven until Task 1, and a wrong guess would leave the media ports held. A reused PID
 * that now runs something else has a different `exe` and is left alone.
 */
class ProcReaper(
    private val procDir: File = File("/proc"),
    private val exeNames: Set<String>,
    private val nativeLibDir: File,
    private val ownPid: Int,
    private val signal: (pid: Int, sig: Int) -> Unit,
    private val readExe: (pidDir: File) -> String? = ::readExeLink,
    private val sleep: (ms: Long) -> Unit = Thread::sleep,
    private val termWaitMs: Long = 3_000,
    private val pollMs: Long = 100,
) {
    /** PIDs that were sent TERM. */
    fun reap(): List<Int> {
        val libDir = canonical(nativeLibDir)
        val targets = mutableListOf<Int>()
        val entries = procDir.listFiles() ?: return emptyList()
        for (entry in entries.sortedBy { it.name }) {
            val pid = entry.name.toIntOrNull() ?: continue
            if (pid <= 0 || pid == ownPid || entry.name != pid.toString()) continue
            if (matches(entry, libDir)) targets.add(pid)
        }
        if (targets.isEmpty()) return emptyList()
        val signalled = mutableListOf<Int>()
        for (pid in targets) {
            if (send(pid, SIGTERM)) signalled.add(pid)
        }
        var waited = 0L
        var pending = signalled.toList()
        while (pending.isNotEmpty() && waited < termWaitMs) {
            sleep(pollMs)
            waited += pollMs
            pending = pending.filter { matches(File(procDir, it.toString()), libDir) }
        }
        for (pid in pending) send(pid, SIGKILL)
        return signalled
    }

    private fun matches(pidDir: File, libDir: File): Boolean {
        val exe = try {
            readExe(pidDir)
        } catch (e: Exception) {
            null
        } ?: return false
        val file = File(exe.removeSuffix(DELETED_SUFFIX))
        if (file.name !in exeNames) return false
        val parent = file.parentFile ?: return false
        return canonical(parent) == libDir
    }

    private fun send(pid: Int, sig: Int): Boolean = try {
        signal(pid, sig)
        true
    } catch (e: Exception) {
        false // the process went away between the read and the signal
    }

    private fun canonical(f: File): File = try {
        f.canonicalFile
    } catch (e: Exception) {
        f.absoluteFile
    }

    companion object {
        const val SIGTERM = 15
        const val SIGKILL = 9
        private const val DELETED_SUFFIX = " (deleted)"

        fun readExeLink(pidDir: File): String? = try {
            Files.readSymbolicLink(File(pidDir, "exe").toPath()).toString()
        } catch (e: Exception) {
            null
        }
    }
}
