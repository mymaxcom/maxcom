package my.maxcom.box.core

/**
 * What the app does when the kiosk page reports that the WebView cannot decode video (a lost graphics context after
 * memory pressure leaves every live without a picture). Pure: the caller passes the clock as [nowMs] (wall-clock
 * milliseconds, because the last app restart must outlive the process that made it).
 *
 * First report: restart the WebView's renderer process. A report that follows soon after means that did not cure it:
 * restart the whole app, so the WebView's graphics state is new. Below API 29 the renderer step is only a WebView
 * rebuild, which may not give new graphics state, so there the app step is the cure. The renderer is restarted at
 * most once per [ESCALATE_WINDOW_MS] and the app at most once per [APP_MIN_GAP_MS], so a page that keeps reporting (or
 * a frame that got hold of the bridge key) cannot make the box restart in a loop.
 *
 * The page reports once per live connection, so an [Action.Ignore] is not retried until the next connection.
 * [ESCALATE_MIN_MS] only guards against a duplicate report of the old page.
 *
 * [onStuck] never records an app restart: the caller may decline (see [mayRestartApp]). It calls [appRestarted] when
 * it really is restarting, and stores [lastAppRestartMs].
 *
 * [lastAppRestartMs] is the time of the last app restart, read from storage at start (0 or less means never). A time
 * in the future (the clock was changed) counts as a restart just now, so the app is not restarted on it.
 */
class VideoRecovery(lastAppRestartMs: Long) {
    enum class Action { RestartRenderer, RestartApp, Ignore }

    /** Time of the last app restart, as given at start or as recorded by [appRestarted]; the caller stores it. */
    var lastAppRestartMs: Long = lastAppRestartMs
        private set

    private var lastRendererMs: Long? = null

    fun onStuck(nowMs: Long): Action {
        val last = lastRendererMs
        val since = if (last == null) -1L else nowMs - last
        if (last != null && since in 0..ESCALATE_WINDOW_MS) {
            // Too soon after the restart: the old page or a duplicate, not the new page reporting.
            if (since < ESCALATE_MIN_MS) return Action.Ignore
            // Refused by the app limit: lastRendererMs stays, so this is Ignore until the window has passed.
            if (!appRestartAllowed(nowMs)) return Action.Ignore
            return Action.RestartApp
        }
        // First report, a long time after the last restart, or a clock that went backward: start with the renderer.
        lastRendererMs = nowMs
        return Action.RestartRenderer
    }

    /** The caller confirms that it is restarting the app now: the 6 h allowance starts. */
    fun appRestarted(nowMs: Long) {
        lastAppRestartMs = nowMs
    }

    private fun appRestartAllowed(nowMs: Long): Boolean {
        val t = lastAppRestartMs
        if (t <= 0L) return true
        if (t > nowMs) return false
        return nowMs - t >= APP_MIN_GAP_MS
    }

    companion object {
        /**
         * The app may be ended only when MAXCOM is the default Home app (the system always brings that app back) and
         * the relaunch alarm was armed; otherwise the box could stay dead.
         */
        fun mayRestartApp(isDefaultHome: Boolean, relaunchArmed: Boolean): Boolean = isDefaultHome && relaunchArmed

        /** A report this soon after a renderer restart means the restart did not help. */
        const val ESCALATE_WINDOW_MS = 10 * 60_000L

        /** A report sooner than this after a renderer restart comes from the old page or is a duplicate. */
        const val ESCALATE_MIN_MS = 15_000L

        /** The whole app is restarted at most this often. */
        const val APP_MIN_GAP_MS = 6 * 60 * 60_000L
    }
}
