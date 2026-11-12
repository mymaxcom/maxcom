package my.maxcom.app.upload

import java.io.ByteArrayInputStream
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL
import java.security.KeyStore
import java.security.cert.CertificateFactory
import javax.net.ssl.HttpsURLConnection
import javax.net.ssl.SSLContext
import javax.net.ssl.TrustManagerFactory
import org.json.JSONObject

class BegunUpload(val uploadId: String, val uploadUri: String) {
    override fun toString() = "BegunUpload($uploadId)"
}

/** The cloud answered 429 `youtube_quota`. */
class CloudQuota(val resetsAt: String?) : Exception("youtube_quota")

/** 401: the session in the work request has expired; the app must enqueue again. */
class CloudNeedsUnlock : Exception("needs_unlock")

/** A refusal with a reason code (`youtube_reauthorise`...). */
class CloudRefused(val code: String) : Exception(code)

/** The cloud's catch-up routes. Network failures and 5xx are [IOException]. */
interface CloudApi {
    @Throws(IOException::class)
    fun begin(kuliahId: String?, partIndex: Int?, partCount: Int?, bytes: Long, replaceLiveVideoId: String?): BegunUpload

    @Throws(IOException::class)
    fun done(uploadId: String, videoId: String)

    /** ISO reset time, or null when the quota route does not answer. */
    fun quotaResetsAt(): String?
}

/**
 * Plain HttpsURLConnection to the cloud. When [caDer] is given (the cloud is reached by IP with a
 * leaf from the surau's own root CA) only that root is trusted, as the Dart client does. The token
 * goes in the Authorization header and nowhere else; no message here carries it or an upload URI.
 */
class HttpCloudApi(
    private val base: String,
    private val token: String,
    caDer: ByteArray?,
) : CloudApi {
    private val tls: SSLContext? = caDer?.let { pinned(it) }

    override fun begin(
        kuliahId: String?, partIndex: Int?, partCount: Int?, bytes: Long, replaceLiveVideoId: String?,
    ): BegunUpload {
        val body = JSONObject()
            .put("kuliahId", kuliahId ?: JSONObject.NULL)
            .put("part", if (partIndex == null || partCount == null) JSONObject.NULL
                else JSONObject().put("index", partIndex).put("count", partCount))
            .put("bytes", bytes)
            .put("replaceLiveVideoId", replaceLiveVideoId ?: JSONObject.NULL)
        val (status, text) = call("POST", "/api/youtube/upload/begin", body.toString())
        when {
            status == 401 -> throw CloudNeedsUnlock()
            status == 429 -> throw CloudQuota(quotaResetsAt())
            status in 200..299 -> {
                val j = JSONObject(text)
                return BegunUpload(j.getString("uploadId"), j.getString("uploadUri"))
            }
            status >= 500 && codeOf(text) == null -> throw IOException("begin_$status")
            else -> throw CloudRefused(codeOf(text) ?: "begin_$status")
        }
    }

    override fun done(uploadId: String, videoId: String) {
        val body = JSONObject().put("uploadId", uploadId).put("videoId", videoId)
        val (status, text) = call("POST", "/api/youtube/upload/done", body.toString())
        when {
            status == 401 -> throw CloudNeedsUnlock()
            status in 200..299 -> return
            status >= 500 && codeOf(text) == null -> throw IOException("done_$status")
            else -> throw CloudRefused(codeOf(text) ?: "done_$status")
        }
    }

    override fun quotaResetsAt(): String? = try {
        val (status, text) = call("GET", "/api/youtube/quota", null)
        if (status in 200..299) JSONObject(text).optString("resetsAt").ifEmpty { null } else null
    } catch (_: Exception) {
        null
    }

    private fun codeOf(text: String): String? = try {
        JSONObject(text).optString("code").ifEmpty { null }
    } catch (_: Exception) {
        null
    }

    private fun call(method: String, path: String, body: String?): Pair<Int, String> {
        val c = URL(base.trimEnd('/') + path).openConnection() as HttpURLConnection
        try {
            if (c is HttpsURLConnection && tls != null) c.sslSocketFactory = tls.socketFactory
            c.requestMethod = method
            c.connectTimeout = 15_000
            c.readTimeout = 30_000
            c.instanceFollowRedirects = false
            c.setRequestProperty("Authorization", "Bearer $token")
            if (body != null) {
                val bytes = body.toByteArray(Charsets.UTF_8)
                c.doOutput = true
                c.setRequestProperty("Content-Type", "application/json")
                c.setFixedLengthStreamingMode(bytes.size)
                c.outputStream.use { it.write(bytes) }
            }
            val status = c.responseCode
            val stream = if (status >= 400) c.errorStream else c.inputStream
            val text = stream?.use { String(it.readBytes(), Charsets.UTF_8) } ?: ""
            return status to text
        } finally {
            c.disconnect()
        }
    }

    companion object {
        /** An [SSLContext] whose only trust anchor is the DER certificate [der]. */
        fun pinned(der: ByteArray): SSLContext {
            val cert = CertificateFactory.getInstance("X.509").generateCertificate(ByteArrayInputStream(der))
            val ks = KeyStore.getInstance(KeyStore.getDefaultType()).apply {
                load(null, null)
                setCertificateEntry("maxcom-root", cert)
            }
            val tmf = TrustManagerFactory.getInstance(TrustManagerFactory.getDefaultAlgorithm())
            tmf.init(ks)
            return SSLContext.getInstance("TLS").apply { init(null, tmf.trustManagers, null) }
        }
    }
}

/** The PUT to YouTube (system trust; the URI carries the session). */
class UrlConnectionTransport : PutTransport {
    override fun put(uri: String, contentRange: String, body: ByteArray): PutResponse {
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
