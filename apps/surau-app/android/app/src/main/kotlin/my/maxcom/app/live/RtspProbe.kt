package my.maxcom.app.live

import java.net.URI
import java.net.URLDecoder

/* Camera address helpers (plan rev 4, 4.3 and 4.5): the address is split so the login never reaches a request line or a
   log, and every log line goes through [RtspMask]. The one-off DESCRIBE probe that used to live here had no caller (the
   connection test runs on the box); it was removed. */

/** Why a connection failed, in the words of the plan: login (401) or something else. */
enum class ProbeFailure {
    LOGIN,
    PATH,
    PORT_CLOSED,
    NO_ANSWER,
    OTHER,
}

/** Pure helpers that keep a camera password out of every log line. */
object RtspMask {
    /** `rtsp://user:secret@host/path` becomes `rtsp://user:***@host/path`; a URL with no password is unchanged. */
    fun maskUrl(url: String): String {
        val scheme = url.indexOf("://")
        if (scheme < 0) return url
        val at = url.indexOf('@', scheme + 3)
        val slash = url.indexOf('/', scheme + 3)
        if (at < 0 || (slash in 0 until at)) return url
        val info = url.substring(scheme + 3, at)
        val colon = info.indexOf(':')
        if (colon < 0) return url
        return url.substring(0, scheme + 3) + info.substring(0, colon) + ":***" + url.substring(at)
    }

    /** Removes the password, every Authorization line and any URL password from free text. */
    fun redact(text: String, password: String?): String {
        var out = text.replace(Regex("(?im)^(proxy-)?authorization:.*$"), "Authorization: ***")
        out = out.replace(Regex("(rtsps?://[^\\s:/@]*):[^\\s@/]*@"), "$1:***@")
        if (!password.isNullOrEmpty()) out = out.replace(password, "***")
        return out
    }
}

/** What the phone logs without Android: a one-line sink. K2 sends it to Diag; the default writes to logcat. */
object RtspLogger {
    val default: (String) -> Unit = { line ->
        try {
            android.util.Log.i("MaxcomLive", line)
        } catch (_: Throwable) {
            // plain JVM unit tests have no android.util.Log
        }
    }
}

/** Splits an RTSP address; the login is kept apart so it never reaches a request line or a log. */
object RtspProbe {
    class ParsedUrl(val host: String, val port: Int, val requestUri: String, val user: String?, val password: String?)

    /** `rtsp://[user[:password]@]host[:port]/path?query`; the request URI never carries the login. */
    fun parseUrl(url: String): ParsedUrl {
        val uri = URI(url.trim())
        require(uri.scheme.equals("rtsp", ignoreCase = true)) { "scheme" }
        val host = requireNotNull(uri.host) { "host" }
        val port = if (uri.port > 0) uri.port else 554
        val info = uri.rawUserInfo
        var user: String? = null
        var pass: String? = null
        if (info != null) {
            val c = info.indexOf(':')
            user = URLDecoder.decode(if (c >= 0) info.substring(0, c) else info, "UTF-8")
            if (c >= 0) pass = URLDecoder.decode(info.substring(c + 1), "UTF-8")
        }
        val path = (uri.rawPath ?: "").ifEmpty { "/" } + (uri.rawQuery?.let { "?$it" } ?: "")
        val hostPart = if (host.contains(':')) "[$host]" else host
        val portPart = if (uri.port > 0) ":${uri.port}" else ""
        return ParsedUrl(host, port, "rtsp://$hostPart$portPart$path", user, pass)
    }
}
