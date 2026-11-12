package my.maxcom.box.core

import java.net.URI

/**
 * The only page the kiosk WebView may show: `http://127.0.0.1:<port>/...`. Everything else
 * (other scheme, host, port, user info, unparsable text) is refused. Pure and strict: the
 * authority must be exactly `127.0.0.1:<port>`.
 */
class UrlPolicy(private val port: Int) {
    fun allows(url: String): Boolean {
        if (url.isEmpty() || url.length > MAX_URL) return false
        val uri = try {
            URI(url)
        } catch (_: Exception) {
            return false
        }
        if (uri.scheme != "http") return false
        if (uri.rawUserInfo != null) return false
        if (uri.host != "127.0.0.1") return false
        if (uri.port != port) return false
        return uri.rawAuthority == "127.0.0.1:$port"
    }

    private companion object {
        const val MAX_URL = 8192
    }
}
