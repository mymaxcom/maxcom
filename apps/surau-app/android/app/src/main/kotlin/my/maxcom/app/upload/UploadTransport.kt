package my.maxcom.app.upload

import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL

/**
 * The only network door of the upload worker (2026.11.15, U7): a PUT to the Google upload address the app handed
 * over, with system trust. There is no client for the MAXCOM box here any more: the app itself asks the box for the
 * upload address (`upload/begin`) and tells it when the video is up (`upload/done`), so the worker holds no session
 * token, no box address and no certificate. An address that is not Google's is refused here as well as by the runner.
 */
class UrlConnectionTransport : PutTransport {
    override fun put(uri: String, contentRange: String, body: ByteArray): PutResponse {
        if (!UploadUri.isYoutube(uri)) throw IOException("bad_upload_uri")
        val c = URL(uri).openConnection() as HttpURLConnection
        try {
            c.requestMethod = "PUT"
            c.connectTimeout = 20_000
            c.readTimeout = 60_000
            // 308 is the protocol's "resume incomplete", not a redirect.
            c.instanceFollowRedirects = false
            c.setRequestProperty("Content-Type", "video/mp4")
            c.setRequestProperty("Content-Range", contentRange)
            c.doOutput = true
            c.setFixedLengthStreamingMode(body.size)
            c.outputStream.use { it.write(body) }
            val status = c.responseCode
            val range = c.getHeaderField("Range")
            val stream = if (status >= 400) c.errorStream else c.inputStream
            val text = if (status == 308) "" else (stream?.use { String(it.readBytes(), Charsets.UTF_8) } ?: "")
            return PutResponse(status, range, text)
        } finally {
            c.disconnect()
        }
    }
}
