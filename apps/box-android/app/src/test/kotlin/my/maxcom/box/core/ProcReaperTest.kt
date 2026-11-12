package my.maxcom.box.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeFalse
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File
import java.nio.file.Files

class ProcReaperTest {
    @get:Rule
    val tmp = TemporaryFolder()

    private val names = setOf("libnode.so", "libmediamtx.so", "libffmpeg.so")

    private fun lib() = File(tmp.root, "lib").apply { mkdirs() }
    private fun proc() = File(tmp.root, "proc").apply { mkdirs() }

    private fun fakeProc(vararg pids: String) = pids.forEach { File(proc(), it).mkdirs() }

    private class Signals {
        val sent = mutableListOf<Pair<Int, Int>>()
        fun send(pid: Int, sig: Int) { sent.add(pid to sig) }
    }

    @Test
    fun signalsOnlyMatchingExecutablesInTheLibFolder() {
        val lib = lib()
        fakeProc("100", "200", "300", "400", "500", "600", "700", "800", "self", "12x", "net")
        val exe = mapOf(
            "100" to File(lib, "libnode.so").path,
            "200" to File(lib, "libmediamtx.so").path,
            "300" to File(tmp.root, "other/libnode.so").path, // same name, wrong folder
            "400" to File(lib, "libnode.so").path, // the own PID
            "500" to File(lib, "libffmpeg.so").path + " (deleted)", // replaced by an update
            // 600: unreadable (vanished)
            "700" to File(lib, "sub/libnode.so").path, // not directly inside
            "800" to File(lib, "libother.so").path, // not in the names
        )
        val sig = Signals()
        val sleeps = mutableListOf<Long>()
        val gone = mutableSetOf<String>()
        val reaper = ProcReaper(
            procDir = proc(), exeNames = names, nativeLibDir = lib, ownPid = 400,
            signal = { pid, s -> sig.send(pid, s); if (s == 15) gone.add(pid.toString()) },
            readExe = { dir -> if (dir.name in gone) null else exe[dir.name] },
            sleep = { sleeps.add(it) },
        )
        assertEquals(listOf(100, 200, 500), reaper.reap())
        // all three exited after TERM: no KILL, and the wait loop ended at the first check
        assertEquals(listOf(100 to 15, 200 to 15, 500 to 15), sig.sent)
        assertEquals(listOf(100L), sleeps)
    }

    @Test
    fun killsWhatSurvivesTermForThreeSeconds() {
        val lib = lib()
        fakeProc("100", "200")
        val exe = mapOf("100" to File(lib, "libnode.so").path, "200" to File(lib, "libmediamtx.so").path)
        val sig = Signals()
        var slept = 0L
        val gone = mutableSetOf<String>()
        val reaper = ProcReaper(
            procDir = proc(), exeNames = names, nativeLibDir = lib, ownPid = 1,
            // 100 dies on TERM, 200 ignores it
            signal = { pid, s -> sig.send(pid, s); if (pid == 100) gone.add("100") },
            readExe = { dir -> if (dir.name in gone) null else exe[dir.name] },
            sleep = { slept += it },
        )
        reaper.reap()
        assertEquals(listOf(100 to 15, 200 to 15, 200 to 9), sig.sent)
        assertTrue("waited $slept", slept in 3_000L..3_100L)
    }

    @Test
    fun aPidThatVanishesInBetweenIsNotAnError() {
        val lib = lib()
        fakeProc("100", "200")
        val exe = mapOf("100" to File(lib, "libnode.so").path, "200" to File(lib, "libffmpeg.so").path)
        val sig = Signals()
        val reaper = ProcReaper(
            procDir = proc(), exeNames = names, nativeLibDir = lib, ownPid = 1,
            signal = { pid, s -> if (pid == 100) throw IllegalStateException("ESRCH") else { sig.send(pid, s) } },
            readExe = { dir -> if (dir.name == "200" && sig.sent.isNotEmpty()) null else exe[dir.name] },
            sleep = {},
        )
        assertEquals(listOf(200), reaper.reap())
        assertEquals(listOf(200 to 15), sig.sent)
    }

    @Test
    fun readerThatThrowsIsTreatedAsGone() {
        val lib = lib()
        fakeProc("100")
        val sig = Signals()
        val reaper = ProcReaper(
            procDir = proc(), exeNames = names, nativeLibDir = lib, ownPid = 1,
            signal = { pid, s -> sig.send(pid, s) },
            readExe = { throw java.io.IOException("gone") },
            sleep = {},
        )
        assertEquals(emptyList<Int>(), reaper.reap())
        assertTrue(sig.sent.isEmpty())
    }

    @Test
    fun missingProcFolderIsEmpty() {
        val reaper = ProcReaper(File(tmp.root, "nope"), names, lib(), 1, { _, _ -> error("no") }, { null }, {})
        assertEquals(emptyList<Int>(), reaper.reap())
    }

    /** Needs a real /proc and symlinks: skipped on Windows. */
    @Test
    fun defaultReaderFollowsTheExeLink() {
        assumeFalse(System.getProperty("os.name").lowercase().contains("win"))
        val pidDir = File(proc(), "123").apply { mkdirs() }
        val target = File(lib(), "libnode.so").apply { writeText("x") }
        Files.createSymbolicLink(File(pidDir, "exe").toPath(), target.toPath())
        assertEquals(target.path, ProcReaper.readExeLink(pidDir))
        assertEquals(null, ProcReaper.readExeLink(File(proc(), "999")))
        val own = File("/proc/self")
        if (own.exists()) assertTrue(ProcReaper.readExeLink(own)!!.isNotEmpty())
    }
}
