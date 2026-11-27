package my.maxcom.box.core

import java.net.InetAddress
import java.net.ServerSocket
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Test

class FollowerInfoTest {
    private var server: ServerSocket? = null

    @After
    fun stop() {
        server?.close()
    }

    @Test
    fun aFollowerAnswerGivesTheMasterName() {
        val i = FollowerInfoParser.parse("""{"mode":"follower","state":"active","master":{"name":"Dewan Utama"},"connected":true,"awayMinutes":0}""")
        assertEquals("Dewan Utama", i!!.masterName)
    }

    @Test
    fun aMainBoxAnOldServerAndNoiseGiveNull() {
        assertNull(FollowerInfoParser.parse("""{"mode":"main","state":"active"}"""))
        assertNull(FollowerInfoParser.parse("""{"state":"active"}"""))
        assertNull(FollowerInfoParser.parse("not json"))
        assertNull(FollowerInfoParser.parse(""))
        assertNull(FollowerInfoParser.parse("""[1,2]"""))
    }

    @Test
    fun aFollowerWithoutAMasterNameStillCounts() {
        assertEquals("", FollowerInfoParser.parse("""{"mode":"follower"}""")!!.masterName)
        assertEquals("", FollowerInfoParser.parse("""{"mode":"follower","master":{"name":""}}""")!!.masterName)
        assertEquals("", FollowerInfoParser.parse("""{"mode":"follower","master":{}}""")!!.masterName)
    }

    @Test
    fun theNameIsOneShortPrintableLine() {
        assertEquals("Ruang Muslimat", FollowerInfoParser.cleanName("  Ruang\n\tMuslimat  "))
        assertEquals(60, FollowerInfoParser.cleanName("x".repeat(200)).length)
    }

    private fun serve(status: Int, body: String): Int {
        val s = ServerSocket(0, 5, InetAddress.getByName("127.0.0.1"))
        server = s
        Thread {
            try {
                while (true) {
                    val c = s.accept()
                    c.use {
                        val r = it.getInputStream().bufferedReader()
                        val request = r.readLine()
                        while (true) { val l = r.readLine() ?: break; if (l.isEmpty()) break }
                        val b = (if (request.contains("/api/box/state")) body else "{}").toByteArray()
                        val crlf = "\r\n"
                        val head = "HTTP/1.1 $status X" + crlf + "Content-Type: application/json" + crlf +
                            "Content-Length: " + b.size + crlf + "Connection: close" + crlf + crlf
                        it.getOutputStream().write(head.toByteArray() + b)
                        it.getOutputStream().flush()
                    }
                }
            } catch (_: Exception) {
            }
        }.also { it.isDaemon = true }.start()
        return s.localPort
    }

    @Test
    fun theClientReadsAFollowerFromTheStateRoute() {
        val port = serve(200, """{"mode":"follower","master":{"name":"Surau Al-Hidayah"}}""")
        assertEquals("Surau Al-Hidayah", FollowerClient().read(port)!!.masterName)
    }

    @Test
    fun theClientGivesNullForAMainBoxAnErrorAndNoServer() {
        assertNull(FollowerClient().read(serve(200, """{"mode":"main"}""")))
        server?.close()
        assertNull(FollowerClient().read(serve(500, """{"mode":"follower"}""")))
        val port = serve(200, "{}")
        server?.close()
        assertNull(FollowerClient(timeoutMs = 300).read(port))
        assertNotNull(FollowerInfo("x"))
    }
}
