package my.maxcom.box.core

/**
 * The decision behind the kiosk page's `MaxcomHost.exit()`: the request is honoured only while the WebView
 * is showing the loopback kiosk page (per [UrlPolicy]). A page that somehow navigated elsewhere gets nothing.
 * Pure: the caller reads the current URL on the main thread and passes what to run.
 */
class HostExitGate(private val policy: UrlPolicy) {
    /** Runs [action] and returns true when [currentUrl] is the kiosk origin; otherwise does nothing and returns false. */
    fun exit(currentUrl: String?, action: () -> Unit): Boolean {
        if (currentUrl == null || !policy.allows(currentUrl)) return false
        action()
        return true
    }
}
