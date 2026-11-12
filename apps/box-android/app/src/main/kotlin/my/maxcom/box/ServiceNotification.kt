package my.maxcom.box

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Context

/** The foreground notification: low importance, ongoing, Bahasa Malaysia text from strings.xml. */
object ServiceNotification {
    const val CHANNEL_ID = "maxcom_service"
    const val ID = 1

    fun ensureChannel(context: Context) {
        val nm = context.getSystemService(NotificationManager::class.java) ?: return
        if (nm.getNotificationChannel(CHANNEL_ID) != null) return
        val ch = NotificationChannel(CHANNEL_ID, context.getString(R.string.notif_channel_name), NotificationManager.IMPORTANCE_LOW)
        ch.description = context.getString(R.string.notif_channel_desc)
        ch.setShowBadge(false)
        nm.createNotificationChannel(ch)
    }

    fun build(context: Context, textRes: Int): Notification =
        Notification.Builder(context, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_foreground)
            .setContentTitle(context.getString(R.string.notif_title))
            .setContentText(context.getString(textRes))
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setCategory(Notification.CATEGORY_SERVICE)
            .build()

    fun update(context: Context, textRes: Int) {
        val nm = context.getSystemService(NotificationManager::class.java) ?: return
        nm.notify(ID, build(context, textRes))
    }

    /** The text for a state: only the state, never details. */
    fun textFor(status: BoxStatus): Int = when (status) {
        BoxStatus.Running -> R.string.notif_text_running
        BoxStatus.WaitingClock -> R.string.notif_text_waiting_clock
        is BoxStatus.Failing -> R.string.notif_text_failed
        else -> R.string.notif_text_starting
    }
}
