package my.maxcom.box.core

import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

class BoxConfigTest {
    @get:Rule
    val tmp = TemporaryFolder()

    private fun invalid(text: String): String {
        val r = BoxConfig.parse(text)
        assertTrue("expected Invalid for $text but got $r", r is BoxConfigRead.Invalid)
        val msg = (r as BoxConfigRead.Invalid).message
        assertTrue(msg, msg.startsWith("GAGAL:"))
        return msg
    }

    private fun ok(text: String): BoxConfig {
        val r = BoxConfig.parse(text)
        assertTrue("expected Ok for $text but got $r", r is BoxConfigRead.Ok)
        return (r as BoxConfigRead.Ok).config
    }

    @Test
    fun missingFileIsEmpty() {
        val r = BoxConfig.read(File(tmp.root, "none.json"))
        assertEquals(BoxConfigRead.Ok(BoxConfig.EMPTY), r)
        assertTrue(BoxConfig.EMPTY.env.isEmpty())
    }

    @Test
    fun readsAllowlistedValuesFromFile() {
        val f = tmp.newFile("box-config.json")
        f.writeText("""{"v":1,"env":{"SURAU_ALLOWED_HOSTS":"a.example","SURAU_ASSETS_MAX_MB":"50"}}""")
        val c = (BoxConfig.read(f) as BoxConfigRead.Ok).config
        assertEquals(mapOf("SURAU_ALLOWED_HOSTS" to "a.example", "SURAU_ASSETS_MAX_MB" to "50"), c.env)
    }

    @Test
    fun vOnlyIsEmptyConfig() {
        assertTrue(ok("""{"v":1}""").env.isEmpty())
    }

    @Test
    fun versionMustBeOne() {
        invalid("""{"env":{}}""")
        invalid("""{"v":2,"env":{}}""")
        invalid("""{"v":"1","env":{}}""")
        invalid("""{"v":1.5,"env":{}}""")
        invalid("""{"v":true}""")
    }

    @Test
    fun forbiddenKeysAreErrors() {
        for (k in listOf("SURAU_ROLE", "SURAU_KIOSK_TOKEN", "NODE_OPTIONS", "LD_LIBRARY_PATH")) {
            val msg = invalid("""{"v":1,"env":{"$k":"x"}}""")
            assertTrue(msg, msg.contains(k))
        }
    }

    @Test
    fun keysThatAreComputedOrUnknownAreErrors() {
        for (k in ChildEnv.COMPUTED_KEYS + listOf("SURAU_PORT", "SURAU_DEBUG", "FOO", "")) {
            invalid("""{"v":1,"env":{"$k":"x"}}""")
        }
    }

    @Test
    fun unknownTopLevelKeyIsAnError() {
        invalid("""{"v":1,"env":{},"extra":1}""")
    }

    @Test
    fun valueWithNewlineOrNulIsAnError() {
        invalid("{\"v\":1,\"env\":{\"SURAU_CLOUD_URL\":\"a\\nb\"}}")
        invalid("{\"v\":1,\"env\":{\"SURAU_CLOUD_URL\":\"a\\rb\"}}")
        invalid("{\"v\":1,\"env\":{\"SURAU_CLOUD_URL\":\"a\\u0000b\"}}")
    }

    @Test
    fun nonStringOrHugeValueIsAnError() {
        invalid("""{"v":1,"env":{"SURAU_ASSETS_MAX_MB":50}}""")
        invalid("""{"v":1,"env":{"SURAU_ASSETS_MAX_MB":null}}""")
        invalid("""{"v":1,"env":{"SURAU_CLOUD_URL":"${"x".repeat(BoxConfig.MAX_VALUE_CHARS + 1)}"}}""")
        invalid("""{"v":1,"env":[]}""")
    }

    @Test
    fun brokenOrOversizedFileIsAnError() {
        invalid("not json")
        invalid("")
        val big = tmp.newFile("big.json")
        big.writeText(" ".repeat(BoxConfig.MAX_FILE_BYTES + 1))
        assertTrue(BoxConfig.read(big) is BoxConfigRead.Invalid)
        assertTrue(BoxConfig.read(tmp.newFolder("dir")) is BoxConfigRead.Invalid)
    }

    @Test
    fun longOrBinaryKeyIsNotEchoed() {
        val msg = invalid("{\"v\":1,\"env\":{\"" + "A".repeat(100) + "\":\"x\"}}")
        assertTrue(msg, !msg.contains("AAAAAAAAAA"))
    }
}
