package my.maxcom.box

import java.io.File
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** Source scans for the field bug 2026-11-14 (server not restarted after a network change). */
class ServerRestartScanTest {
    private val dir = File("src/main/kotlin/my/maxcom/box")
    private fun code(name: String) = File(dir, name).readLines().joinToString("\n") { it.substringBefore("//") }

    @Test
    fun everyLeafReissueGoesThroughTheCheckedRestartAndNoneRestartsQuietly() {
        val svc = code("BoxService.kt")
        assertFalse("silent supervisor?.restart()", svc.contains("supervisor?.restart()"))
        assertTrue(svc.contains("restartServer(\"sijil baharu dikeluarkan\")"))
        assertTrue(svc.contains("restartServer(\"sijil awal dikeluarkan\")"))
        val fn = svc.substring(svc.indexOf("private fun restartServer("))
        assertTrue(fn.indexOf("sup.restart()") in 0 until fn.indexOf("sup.ensureRunning()"))
    }

    @Test
    fun aSecondStartNeverLeavesADeadSupervisorSilently() {
        val svc = code("BoxService.kt")
        val p = svc.substring(svc.indexOf("private fun prepare()"), svc.indexOf("private fun step("))
        assertTrue(p.contains("existing.ensureRunning()"))
        assertTrue(p.contains("blog(\"persediaan: sudah berjalan"))
    }

    @Test
    fun aWatchdogOnItsOwnThreadAndDecisionsInTheBoxLog() {
        val svc = code("BoxService.kt")
        assertTrue(svc.contains("startWatchdog()"))
        assertTrue(svc.contains("box-watchdog"))
        assertTrue(svc.contains("onDestroy, pelayan akan dihentikan"))
        assertTrue(svc.contains("onStartCommand (startId"))
        assertTrue(code("MaintenanceActivity.kt").contains("Mula semula diminta dari Penyelenggaraan"))
    }

    @Test
    fun certificateLockWaitsAreBounded() {
        assertTrue(File(dir, "core/CertLock.kt").readText().contains("tryLock(waitMs"))
    }
}
