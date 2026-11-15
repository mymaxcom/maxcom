package my.maxcom.box

import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** Source scans for the local-name wiring: order of the boot steps, lock release, re-key under the lock. */
class NameSourceScanTest {
    private val dir = File("src/main/kotlin/my/maxcom/box")

    private fun code(name: String): String =
        File(dir, name).readLines().joinToString("\n") { it.substringBefore("//") }

    private fun body(src: String, signature: String): String {
        val at = src.indexOf(signature)
        assertTrue("$signature not found", at >= 0)
        return src.substring(at)
    }

    @Test
    fun theNameIsClaimedBeforeTheLeafIsCertified() {
        val svc = code("BoxService.kt")
        val prepare = body(svc, "private fun prepareCertificate()")
        val claim = prepare.indexOf("startNameService()")
        val certify = prepare.indexOf("certify(currentIps()")
        assertTrue("startNameService must come first", claim in 0 until certify)
        // and the server is still started before the certificate step (the screen must not wait for the clock)
        val p = body(svc, "private fun prepare()")
        assertTrue(p.indexOf("startSupervisor(config)") in 1 until p.indexOf("prepareCertificate()"))
    }

    @Test
    fun certifyRunsUnderTheCertificateLockAndTheNameReachesThePolicyAndTheLeaf() {
        val svc = code("BoxService.kt")
        assertTrue(Regex("""CertLock\.held\s*\{\s*certifyLocked""").containsMatchIn(svc))
        assertTrue(svc.contains("wantedName = name"))
        assertTrue(svc.contains("boxName = leafName"))
        // a legacy root never gets the numbered name
        assertTrue(svc.contains("BoxCa.rootPermitsSubtree(rootDer)"))
    }

    @Test
    fun theMulticastLockAndTheNodeAreReleasedOnStopAndOnServiceDestroy() {
        val r = code("MdnsResponder.kt")
        val stop = body(r, "fun stop()")
        assertTrue(stop.indexOf("engine.stop()") in 0 until stop.indexOf("release()"))
        assertTrue(r.contains("lock?.let { if (it.isHeld) it.release() }"))
        val svc = code("BoxService.kt")
        assertTrue(body(svc, "override fun onDestroy()").contains("responder?.stop()"))
    }

    @Test
    fun theReKeyStopsTheServiceThenRunsUnderTheLockAndStartsItAgain() {
        val m = code("MaintenanceActivity.kt")
        val fn = body(m, "private fun rekeyRoot()")
        val stop = fn.indexOf("app.stopService")
        val lock = fn.indexOf("CertLock.held")
        val run = fn.indexOf("RootRekey.run")
        val start = fn.indexOf("app.startForegroundService")
        assertTrue(stop in 0 until lock && lock < run && run < start)
        // the action is behind the maintenance screen (PIN gate) and a confirmation that defaults to "Tidak"
        assertTrue(body(m, "private fun confirmRekey()").contains("BUTTON_NEGATIVE).requestFocus()"))
        assertTrue(m.contains("if (hasLegacyRoot()) button("))
    }

    @Test
    fun theResponderNeverLogsKeysTokensOrSecretPaths() {
        for (name in listOf("MdnsResponder.kt")) {
            for (line in code(name).lines().filter { Regex("""(?<![A-Za-z])Log\.""").containsMatchIn(it) }) {
                assertFalse(line, Regex("token|secret|paths\\.", RegexOption.IGNORE_CASE).containsMatchIn(line))
            }
        }
        // the engine takes a log callback and only ever passes exception class names and fixed words
        val engine = File("src/main/kotlin/my/maxcom/box/core/mdns/MdnsEngine.kt").readText()
        for (line in engine.lines().filter { it.contains("log(") }) {
            assertFalse(line, line.contains("boxId") || line.contains("caShort") || line.contains("key"))
        }
    }

    @Test
    fun noExtraPermissionBeyondTheMulticastLock() {
        val manifest = File("src/main/AndroidManifest.xml").readText()
        assertEquals(1, Regex("CHANGE_WIFI_MULTICAST_STATE").findAll(manifest).count())
        assertFalse(manifest.contains("CHANGE_NETWORK_STATE"))
        assertFalse(manifest.contains("NEARBY_WIFI_DEVICES"))
    }

    @Test
    fun theKeystoreAliasIsNeverDeletedByTheReKey() {
        // old keys are kept (the old root is archived, never destroyed): no deleteEntry in any source
        for (f in dir.walkTopDown().filter { it.isFile && it.extension == "kt" }) {
            assertFalse(f.name, f.readText().contains("deleteEntry"))
        }
    }
}
