package my.maxcom.app.live

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat

/**
 * Keeps the process, the camera and the microphone alive while a live runs,
 * also with the screen locked. The engine itself is a process singleton
 * ([LiveEngine.get]); this service only holds the foreground state, the
 * notification and a partial wake lock. The notification names the app and
 * nothing about the stream.
 */
class LiveService : Service() {
    companion object {
        private const val CHANNEL = "maxcom_live"
        private const val NOTIFICATION_ID = 4107
        // A kuliah is short; the lock is released at stop and, as a backstop, after 8 hours.
        private const val WAKE_LOCK_MS = 8L * 60 * 60 * 1000

        /**
         * Starts (or, when the source or the microphone changes during the live, refreshes) the foreground service
         * with only the types the live uses: see [LiveForeground].
         */
        fun start(context: Context, needs: ForegroundNeeds = ForegroundNeeds.BOTH) {
            val intent = Intent(context, LiveService::class.java)
                .putExtra(LiveForeground.EXTRA_CAMERA, needs.camera)
                .putExtra(LiveForeground.EXTRA_MICROPHONE, needs.microphone)
            ContextCompat.startForegroundService(context, intent)
        }

        /** Called (main thread) when the system refused the foreground state; the argument is the exception name. */
        @Volatile
        var onForegroundFailed: ((String) -> Unit)? = null

        fun stop(context: Context) {
            context.stopService(Intent(context, LiveService::class.java))
        }
    }

    private var wakeLock: PowerManager.WakeLock? = null

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        Diag.init(this)
        Diag.log("service_start")
        val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            nm.createNotificationChannel(
                NotificationChannel(CHANNEL, "Siaran langsung", NotificationManager.IMPORTANCE_LOW),
            )
        }
        val open = packageManager.getLaunchIntentForPackage(packageName)?.let {
            PendingIntent.getActivity(this, 0, it, PendingIntent.FLAG_IMMUTABLE)
        }
        val notification: Notification = NotificationCompat.Builder(this, CHANNEL)
            .setContentTitle("MAXCOM sedang bersiaran")
            .setSmallIcon(applicationInfo.icon)
            .setOngoing(true)
            .setContentIntent(open)
            .setCategory(NotificationCompat.CATEGORY_SERVICE)
            .build()
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            val needs = ForegroundNeeds(
                camera = intent?.getBooleanExtra(LiveForeground.EXTRA_CAMERA, true) ?: true,
                microphone = intent?.getBooleanExtra(LiveForeground.EXTRA_MICROPHONE, true) ?: true,
            )
            val types = LiveForeground.types(needs, Build.VERSION.SDK_INT)
            Diag.log("service_types", "camera=${LiveForeground.hasCamera(types)} mic=${LiveForeground.hasMicrophone(types)}")
            if (!enterForeground { startForeground(NOTIFICATION_ID, notification, types) }) return START_NOT_STICKY
        } else {
            if (!enterForeground { startForeground(NOTIFICATION_ID, notification) }) return START_NOT_STICKY
        }
        if (wakeLock == null) {
            val pm = getSystemService(Context.POWER_SERVICE) as PowerManager
            wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "maxcom:live").apply {
                setReferenceCounted(false)
                acquire(WAKE_LOCK_MS)
            }
        }
        return START_NOT_STICKY
    }

    /**
     * Goes to the foreground. The system can refuse (a missing permission, the app not allowed to start a service of
     * this type now): that must not crash the live. The reason is logged, the service stops, and [onForegroundFailed]
     * tells the engine, so the stream is not left running without the protection of a foreground service.
     */
    private fun enterForeground(go: () -> Unit): Boolean = try {
        go()
        true
    } catch (e: RuntimeException) {
        // SecurityException, ForegroundServiceStartNotAllowedException, IllegalStateException
        Diag.log("service_foreground_failed", e.javaClass.simpleName)
        onForegroundFailed?.invoke(e.javaClass.simpleName)
        stopSelf()
        false
    }

    override fun onDestroy() {
        Diag.log("service_destroy")
        wakeLock?.let { if (it.isHeld) it.release() }
        wakeLock = null
        super.onDestroy()
    }
}
