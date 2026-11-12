package my.maxcom.box.core

import java.net.InetAddress
import java.net.ServerSocket
import org.junit.After
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class HealthClientTest {
    private var server: ServerSocket? = null

    @After
    fun stop() {
        server?.close()
    }

    private fun serve(status: Int, body: String, delayMs: Long = 0): Int {
        val s = ServerSocket(0, 5, InetAddress.getByName("127.0.0.1"))
        server = s
        Thread {
            try {
                while (true) {
                    val c = s.accept()
                    Thread {
                        try {
                            c.use {
                                val r = it.getInputStream().bufferedReader()
                                while (true) { val l = r.readLine() ?: break; if (l.isEmpty()) break }
                                if (delayMs > 0) Thread.sleep(delayMs)
                                val b = body.toByteArray()
                                val crlf = "\r\n"
                                val head = "HTTP/1.1 $status X" + crlf + "Content-Type: application/json" + crlf +
                                    "Content-Length: " + b.size + crlf + "Connection: close" + crlf + crlf
                                it.getOutputStream().write(head.toByteArray() + b)
                                it.getOutputStream().flush()
                            }
                        } catch (_: Exception) {
                        }
                    }.start()
                }
            } catch (_: Exception) {
            }
        }.also { it.isDaemon = true }.start()
        return s.localPort
    }

    @Test
    fun okTrue() {
        assertTrue(HealthClient().check(serve(200, """{"ok":true,"version":"1"}""")))
    }

    @Test
    fun okFalse() {
        assertFalse(HealthClient().check(serve(200, """{"ok":false}""")))
    }

    @Test
    fun notJsonAndErrorStatus() {
        assertFalse(HealthClient().check(serve(200, "hello")))
        server?.close()
        assertFalse(HealthClient().check(serve(503, """{"ok":true}""")))
    }

    @Test
    fun closedPort() {
        val port = ServerSocket(0, 1, InetAddress.getByName("127.0.0.1")).use { it.localPort }
        assertFalse(HealthClient().check(port))
    }

    @Test
    fun slowAnswerTimesOut() {
        val port = serve(200, """{"ok":true}""", delayMs = 1500)
        val t0 = System.currentTimeMillis()
        assertFalse(HealthClient(timeoutMs = 300).check(port))
        assertTrue(System.currentTimeMillis() - t0 < 1400)
    }
}
