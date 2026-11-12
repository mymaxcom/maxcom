package my.maxcom.box

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/** Starts the box service after the device has booted. Any other action, and every extra, is ignored. */
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != Intent.ACTION_BOOT_COMPLETED) return
        try {
            context.startForegroundService(Intent(context, BoxService::class.java))
        } catch (e: Exception) {
            android.util.Log.w("MAXCOM", "boot start refused: " + e.javaClass.simpleName)
        }
    }
}
