package my.maxcom.box.core

/**
 * Hook for the APK self-update (plan "What the Android update inherits", item 2). The supervisor calls
 * [onApkWaiting] when the child exits with code 76 ("an APK is waiting in files/box/apk-inbox/") and then
 * restarts at once, exactly as for 75. Today the only implementation does nothing.
 */
interface SelfUpdate {
    /** Returns true when the app took over the waiting APK. */
    fun onApkWaiting(): Boolean
}

object NoSelfUpdate : SelfUpdate {
    override fun onApkWaiting(): Boolean = false
}
