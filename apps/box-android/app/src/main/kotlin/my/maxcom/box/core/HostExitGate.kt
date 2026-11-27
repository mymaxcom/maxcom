package my.maxcom.box.core

/**
 * The decision behind the kiosk page's `MaxcomHost` calls (`exit()`, `videoStuck()`): the request is honoured only while the WebView
 * is showing the loopback kiosk page (per [UrlPolicy]). A page that somehow navigated elsewhere gets nothing.
 * Pure: the caller reads the current URL on the main thread and passes what to run.
 *
 * The bridge object is visible to every frame in the WebView, also to the video player's frame, which is not ours.
 * So the caller must also present [key], a random value the app hands to the kiosk page's main frame only; a frame
 * from another origin cannot read it.
 */
class HostExitGate(private val policy: UrlPolicy, private val key: String) {
    init {
        require(key.length >= MIN_KEY) { "key too short" }
    }

    /**
     * Runs [action] and returns true when [currentUrl] is the kiosk origin and [given] is the key; otherwise does
     * nothing and returns false.
     */
    fun exit(currentUrl: String?, given: String?, action: () -> Unit): Boolean = run(currentUrl, given, action)

    /** The same check for any bridge call: every call of the bridge passes through here, with the same key and URL rule. */
    fun run(currentUrl: String?, given: String?, action: () -> Unit): Boolean {
        if (given == null || !sameText(given, key)) return false
        if (currentUrl == null || !policy.allows(currentUrl)) return false
        action()
        return true
    }

    /** Compares without stopping at the first difference. */
    private fun sameText(a: String, b: String): Boolean {
        if (a.length != b.length) return false
        var diff = 0
        for (i in a.indices) diff = diff or (a[i].code xor b[i].code)
        return diff == 0
    }

    companion object {
        const val MIN_KEY = 32
    }
}
