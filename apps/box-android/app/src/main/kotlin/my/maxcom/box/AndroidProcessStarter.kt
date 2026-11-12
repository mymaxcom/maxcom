package my.maxcom.box

import android.os.Process as AndroidProcess
import java.io.File
import java.io.InputStream
import my.maxcom.box.core.ProcessStarter
import my.maxcom.box.core.RunningProcess

/**
 * The one place a process is started. Nothing is executed from app-writable storage: the first element of the
 * command must resolve (symlinks followed) to a file directly inside [nativeLibDir]. The environment is
 * cleared before the given map is set, so nothing is inherited from the app process.
 */
class AndroidProcessStarter(private val nativeLibDir: File) : ProcessStarter {

    override fun start(command: List<String>, env: Map<String, String>, cwd: File): RunningProcess {
        require(command.isNotEmpty()) { "empty command" }
        checkExecutable(nativeLibDir, command[0])
        val builder = ProcessBuilder(command)
        builder.environment().clear()
        builder.environment().putAll(env)
        builder.directory(cwd)
        builder.redirectErrorStream(true)
        return Wrapped(builder.start())
    }

    private class Wrapped(private val process: Process) : RunningProcess {
        override val pid: Int = pidOf(process)
        override val output: InputStream get() = process.inputStream
        override fun waitFor(): Int = process.waitFor()

        // SIGTERM so main.ts closes the database; destroy() on Android would send SIGKILL.
        override fun terminate() {
            if (pid > 0) AndroidProcess.sendSignal(pid, SIGTERM) else process.destroy()
        }

        override fun kill() {
            if (pid > 0) AndroidProcess.sendSignal(pid, SIGKILL) else process.destroy()
        }
    }

    companion object {
        private const val SIGTERM = 15
        private const val SIGKILL = 9

        /** Throws when [exe] is not a regular file whose real path is directly inside [nativeLibDir]. */
        fun checkExecutable(nativeLibDir: File, exe: String) {
            val lib = nativeLibDir.canonicalFile
            val real = File(exe).canonicalFile
            val parent = real.parentFile
            check(real.isFile && parent != null && parent == lib) { "executable is outside the native library folder" }
        }

        /** Android's process class keeps the PID in a private field; 0 when it cannot be read. */
        private fun pidOf(p: Process): Int = try {
            val f = p.javaClass.getDeclaredField("pid")
            f.isAccessible = true
            f.getInt(p)
        } catch (e: Exception) {
            0
        }
    }
}
