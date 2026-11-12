package my.maxcom.box.core

import java.io.ByteArrayOutputStream
import java.io.InputStream
import java.net.HttpURLConnection
import java.net.URL
import org.json.JSONObject

/** Asks the box server on loopback whether it is up: `GET /api/health` answering `{"ok":true}`. */
class HealthClient(private val host: String = "127.0.0.1", private val timeoutMs: Int = 2000) {
    fun check(port: Int): Boolean {
        var conn: HttpURLConnection? = null
        return try {
            conn = (URL("http", host, port, "/api/health").openConnection() as HttpURLConnection).apply {
                connectTimeout = timeoutMs
                readTimeout = timeoutMs
                instanceFollowRedirects = false
                useCaches = false
                requestMethod = "GET"
            }
            if (conn.responseCode != 200) return false
            val body = conn.inputStream.use { readCapped(it, MAX_BODY) }
            JSONObject(String(body, Charsets.UTF_8)).optBoolean("ok", false)
        } catch (_: Exception) {
            false
        } finally {
            try {
                conn?.disconnect()
            } catch (_: Exception) {
            }
        }
    }

    private fun readCapped(input: InputStream, max: Int): ByteArray {
        val out = ByteArrayOutputStream()
        val buf = ByteArray(2048)
        while (out.size() < max) {
            val n = input.read(buf, 0, minOf(buf.size, max - out.size()))
            if (n < 0) break
            out.write(buf, 0, n)
        }
        return out.toByteArray()
    }

    private companion object {
        const val MAX_BODY = 64 * 1024
    }
}
