package my.maxcom.box.core

import java.net.URI

/**
 * The only page the kiosk WebView may show: `http://localhost:<port>/...` (the kiosk origin, a host name so the
 * YouTube player accepts the page), and `http://127.0.0.1:<port>/...`, the same loopback server under its old origin.
 * Everything else (other scheme, host, port, user info, unparsable text) is refused. Pure and strict: the authority
 * must be exactly `localhost:<port>` or `127.0.0.1:<port>`, lower case, no trailing dot, no user info.
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
        val host = uri.host ?: return false
        if (host !in HOSTS) return false
        if (uri.port != port) return false
        return uri.rawAuthority == "$host:$port"
    }

    companion object {
        /** The page origin the kiosk loads: a loopback host name, so embedded players see a named origin, not a bare IP. */
        const val KIOSK_HOST = "localhost"
        private val HOSTS = setOf(KIOSK_HOST, "127.0.0.1")
        private const val MAX_URL = 8192

        /** The kiosk page address for [port]. */
        fun kioskUrl(port: Int): String = "http://$KIOSK_HOST:$port/"
    }
}
