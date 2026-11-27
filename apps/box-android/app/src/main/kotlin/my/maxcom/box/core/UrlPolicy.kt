package my.maxcom.box.core

import java.net.URI

/**
 * The only page the kiosk WebView may show: `http://localhost:<port>/...` (the kiosk origin, a host name so the
 * YouTube player accepts the page), and `http://127.0.0.1:<port>/...`, the same loopback server under its old origin.
 * Everything else (other scheme, host, port, user info, unparsable text) is refused. Pure and strict: the authority
 * must be exactly `localhost:<port>` or `127.0.0.1:<port>`, lower case, no trailing dot, no user info.
 *
 * One exception, below the page: a Video item's player. A frame may load the player document ([allowsPlayerFrame]) and
 * that frame may fetch from the player's hosts ([allowsPlayerResource]): the YouTube/Google video domains and their
 * subdomains, plus exactly `www.google.com` (a player script). The main frame never leaves [allows].
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

    /**
     * The one document a frame inside the kiosk page may load: the embedded video player,
     * `https://www.youtube-nocookie.com/embed/<11-character id>` (the page's own CSP names the same origin in
     * `frame-src`). Never the main frame.
     */
    fun allowsPlayerFrame(url: String): Boolean {
        val uri = playerUri(url) ?: return false
        if (uri.host != PLAYER_FRAME_HOST) return false
        return PLAYER_FRAME_PATH.matches(uri.rawPath ?: "")
    }

    /**
     * What the player frame itself may fetch (its script, pictures and the video stream): HTTPS on the default port to
     * the player's own hosts, nothing else. Only for requests that are not the main frame; the kiosk page cannot use
     * this, its CSP keeps it on its own origin.
     */
    fun allowsPlayerResource(url: String): Boolean {
        val host = playerUri(url)?.host ?: return false
        return host in PLAYER_EXACT_HOSTS || PLAYER_HOSTS.any { host == it || host.endsWith(".$it") }
    }

    /** A strict HTTPS address: no user info, no explicit port, a plain lower-case DNS host name. */
    private fun playerUri(url: String): URI? {
        if (url.isEmpty() || url.length > MAX_URL) return null
        val uri = try {
            URI(url)
        } catch (_: Exception) {
            return null
        }
        if (uri.scheme != "https") return null
        if (uri.rawUserInfo != null) return null
        if (uri.port != -1) return null
        val host = uri.host ?: return null
        if (uri.rawAuthority != host) return null
        if (!PLAYER_HOST_SHAPE.matches(host)) return null
        return uri
    }

    companion object {
        private const val PLAYER_FRAME_HOST = "www.youtube-nocookie.com"
        private val PLAYER_FRAME_PATH = Regex("^/embed/[A-Za-z0-9_-]{11}$")
        private val PLAYER_HOST_SHAPE = Regex("^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$")

        /** The player's hosts: the frame, its script, the video stream, the pictures and static files. */
        private val PLAYER_HOSTS = listOf("youtube-nocookie.com", "youtube.com", "googlevideo.com", "ytimg.com", "ggpht.com", "gstatic.com")

        /**
         * Hosts allowed by exact match only, no subdomains: the player loads one script from `www.google.com`, but
         * `google.com` also serves accounts, mail and more, so a suffix match would open far too much.
         */
        private val PLAYER_EXACT_HOSTS = setOf("www.google.com")

        /** The page origin the kiosk loads: a loopback host name, so embedded players see a named origin, not a bare IP. */
        const val KIOSK_HOST = "localhost"
        private val HOSTS = setOf(KIOSK_HOST, "127.0.0.1")
        private const val MAX_URL = 8192

        /** The kiosk page address for [port]. */
        fun kioskUrl(port: Int): String = "http://$KIOSK_HOST:$port/"
    }
}
