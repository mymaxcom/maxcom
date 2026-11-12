package my.maxcom.box.core

/** The environment of the box server child, exactly the table "Launcher contract". Nothing is inherited. */
object ChildEnv {
    /** The computed keys, in the order of the contract. A test pins this set. */
    val COMPUTED_KEYS: List<String> = listOf(
        "SURAU_DB", "SURAU_DATA_DIR", "SURAU_LIVE_TOOLS", "SURAU_PORT", "SURAU_HTTPS_PORT",
        "SURAU_KIOSK_TOKEN", "LD_LIBRARY_PATH", "SSL_CERT_FILE", "TMPDIR", "HOME", "PATH", "TZ",
    )

    const val PORT = 8787
    const val HTTPS_PORT = 8443

    private val TOKEN = Regex("^[0-9a-fA-F]{64}$")
    private val TZ_ID = Regex("^[A-Za-z0-9_+\\-]+(/[A-Za-z0-9_+\\-]+){0,2}$")

    /** Throws [IllegalArgumentException] for a token that is not 64 hex or a time zone id that is not plain. */
    fun build(paths: BoxPaths, config: BoxConfig, token: String, timeZoneId: String): Map<String, String> {
        require(TOKEN.matches(token)) { "token must be 64 hex characters" }
        require(timeZoneId.length <= 64 && TZ_ID.matches(timeZoneId)) { "invalid time zone id" }
        val env = LinkedHashMap<String, String>()
        env["SURAU_DB"] = paths.db.path
        env["SURAU_DATA_DIR"] = paths.data.path
        env["SURAU_LIVE_TOOLS"] = paths.toolsLive.path
        env["SURAU_PORT"] = PORT.toString()
        env["SURAU_HTTPS_PORT"] = HTTPS_PORT.toString()
        env["SURAU_KIOSK_TOKEN"] = token
        env["LD_LIBRARY_PATH"] = paths.runtimeLib.path + ":" + paths.nativeLibDir.path
        env["SSL_CERT_FILE"] = paths.certPem.path
        env["TMPDIR"] = paths.tmp.path
        env["HOME"] = paths.filesDir.path
        env["PATH"] = "/system/bin"
        env["TZ"] = timeZoneId
        for ((k, v) in config.env) {
            // BoxConfig cannot hold anything else; checked again because this is the boundary to the child.
            require(k in BoxConfig.ALLOWED) { "config key not allowed: $k" }
            check(k !in env) { "config key would override a computed key: $k" }
            env[k] = v
        }
        for ((k, v) in env) {
            require(v.none { it == '\n' || it == '\r' || it == '\u0000' }) { "bad character in value of $k" }
        }
        return env
    }
}
