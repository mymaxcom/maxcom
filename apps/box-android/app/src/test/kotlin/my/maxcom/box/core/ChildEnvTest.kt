package my.maxcom.box.core

import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class ChildEnvTest {
    private val files = File("/data/user/0/my.maxcom.box/files")
    private val nativeDir = File("/data/app/x/my.maxcom.box-1/lib/arm")
    private val paths = BoxPaths(files, nativeDir)
    private val token = "ab".repeat(32)
    private val leave = "cd".repeat(32)

    /** The Launcher contract table of the plan, key by key. Add a key to ChildEnv and this test fails. */
    private fun contract(): Map<String, String> = mapOf(
        "SURAU_DB" to paths.db.path,
        "SURAU_DATA_DIR" to paths.data.path,
        "SURAU_LIVE_TOOLS" to paths.toolsLive.path,
        "SURAU_PORT" to "8787",
        "SURAU_HTTPS_PORT" to "8443",
        "SURAU_KIOSK_TOKEN" to token,
        "SURAU_LEAVE_SECRET" to leave,
        "LD_LIBRARY_PATH" to paths.runtimeLib.path + ":" + nativeDir.path,
        "SSL_CERT_FILE" to paths.certPem.path,
        "TMPDIR" to paths.tmp.path,
        "HOME" to files.path,
        "PATH" to "/system/bin",
        "TZ" to "Asia/Kuala_Lumpur",
    )

    private fun cfg(vararg kv: Pair<String, String>): BoxConfig {
        val json = org.json.JSONObject().put("v", 1).put("env", org.json.JSONObject(mapOf(*kv)))
        return (BoxConfig.parse(json.toString()) as BoxConfigRead.Ok).config
    }

    @Test
    fun keySetAndValuesEqualTheContractExactly() {
        val env = ChildEnv.build(paths, BoxConfig.EMPTY, token, "Asia/Kuala_Lumpur", leave)
        assertEquals(contract(), env)
        assertEquals(ChildEnv.COMPUTED_KEYS.toSet(), env.keys)
        assertEquals(13, env.size)
    }

    @Test
    fun nothingInheritedAndNoNodeOptionsOrRole() {
        val env = ChildEnv.build(paths, BoxConfig.EMPTY, token, "UTC", leave)
        for (k in listOf("NODE_OPTIONS", "SURAU_ROLE", "LD_PRELOAD", "SURAU_INSTALL_ROOT", "ANDROID_ROOT", "BOOTCLASSPATH", "LANG")) {
            assertFalse(k, env.containsKey(k))
        }
        assertEquals("/system/bin", env["PATH"])
    }

    @Test
    fun configPassesOnlyAllowlistedKeys() {
        val env = ChildEnv.build(
            paths,
            cfg("SURAU_ALLOWED_HOSTS" to "box.example", "SURAU_WORKER_URL" to "https://w.example"),
            token,
            "UTC",
            leave,
        )
        assertEquals(15, env.size)
        assertEquals("box.example", env["SURAU_ALLOWED_HOSTS"])
        assertEquals(ChildEnv.COMPUTED_KEYS.toSet() + setOf("SURAU_ALLOWED_HOSTS", "SURAU_WORKER_URL"), env.keys)
    }

    @Test
    fun configCannotOverrideComputedKeys() {
        // The allowlist and the computed set must never intersect.
        assertTrue(BoxConfig.ALLOWED.intersect(ChildEnv.COMPUTED_KEYS.toSet()).isEmpty())
        val env = ChildEnv.build(paths, cfg("SURAU_CLOUD_URL" to "https://c.example"), token, "UTC", leave)
        assertEquals(token, env["SURAU_KIOSK_TOKEN"])
        assertEquals("8787", env["SURAU_PORT"])
    }

    @Test
    fun tokenMustBe64Hex() {
        for (bad in listOf("", "ab", "ab".repeat(31), "ab".repeat(33), "zz".repeat(32), "ab".repeat(31) + "a\n", " " + "a".repeat(63))) {
            assertThrows(IllegalArgumentException::class.java) { ChildEnv.build(paths, BoxConfig.EMPTY, bad, "UTC", leave) }
        }
        // upper case hex is still hex
        ChildEnv.build(paths, BoxConfig.EMPTY, "AB".repeat(32), "UTC", leave)
    }

    @Test
    fun leaveSecretMustBe64HexAndIsOwnKeyNotTheKioskToken() {
        for (bad in listOf("", "ab", "cd".repeat(31), "cd".repeat(33), "zz".repeat(32), "cd".repeat(31) + "c\n", " " + "c".repeat(63))) {
            assertThrows(IllegalArgumentException::class.java) { ChildEnv.build(paths, BoxConfig.EMPTY, token, "UTC", bad) }
        }
        val env = ChildEnv.build(paths, BoxConfig.EMPTY, token, "UTC", leave)
        assertEquals(leave, env["SURAU_LEAVE_SECRET"])
        assertEquals(token, env["SURAU_KIOSK_TOKEN"])
        assertTrue("SURAU_LEAVE_SECRET" in ChildEnv.COMPUTED_KEYS)
        // the config file can never set it
        assertFalse("SURAU_LEAVE_SECRET" in BoxConfig.ALLOWED)
    }

    @Test
    fun timeZoneMustBePlain() {
        for (bad in listOf("", "Asia/Kuala Lumpur", "../etc", "A\nB", "UTC\u0000", ":Asia/Tokyo", "/Asia", "A/B/C/D", "x".repeat(65))) {
            assertThrows(bad, IllegalArgumentException::class.java) { ChildEnv.build(paths, BoxConfig.EMPTY, token, bad, leave) }
        }
        for (good in listOf("UTC", "Asia/Kuala_Lumpur", "Etc/GMT+8", "America/Argentina/Buenos_Aires", "GMT-3")) {
            assertEquals(good, ChildEnv.build(paths, BoxConfig.EMPTY, token, good, leave)["TZ"])
        }
    }

    @Test
    fun nativeLibDirIsLastInLibraryPathSoLinksWinAndOnlyThoseTwoFolders() {
        val ld = ChildEnv.build(paths, BoxConfig.EMPTY, token, "UTC", leave)["LD_LIBRARY_PATH"]!!
        assertEquals(listOf(paths.runtimeLib.path, nativeDir.path), ld.split(":"))
    }
}
