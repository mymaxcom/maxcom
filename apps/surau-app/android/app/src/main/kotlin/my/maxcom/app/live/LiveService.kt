package my.maxcom.app.live

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.net.wifi.WifiManager
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat

/**
 * Keeps the process, the camera and the microphone alive while a live runs, also with the screen locked, the app in
 * the background or its task swiped away. Since 2026.11.15 (3.2, B9) the service also OWNS the session facts
 * ([session]): which live the engine was started for, since when, with which outputs. The channel reads them for
 * `status`, so a screen that was closed and opened again finds its own live. The engine itself stays a process
 * singleton ([LiveEngine.get]).
 *
 * `START_NOT_STICKY` on purpose: a process the system killed cannot rebuild a live (the targets are gone with it), so
 * an empty restarted service would only be a lie in the notification bar. What keeps the live alive instead: the
 * service outlives the task ([onTaskRemoved]), holds a wake lock and a Wi-Fi lock, and is never stopped because a
 * type refresh was refused ([LiveForeground.onRefused]). The notification names the app, nothing about the stream,
 * and carries one action, "Hentikan siaran".
 */
class LiveService : Service() {
    companion object {
        private const val CHANNEL = "maxcom_live"
        private const val NOTIFICATION_ID = 4107
        // A kuliah is short; the locks are released at stop and, as a backstop, after 8 hours.
        private const val WAKE_LOCK_MS = 8L * 60 * 60 * 1000
        const val ACTION_STOP = "my.maxcom.app.live.STOP"
        const val STOP_LABEL = "Hentikan siaran"

        /** The live the engine was started for; null facts when there is none. Owned here, read by the channel. */
        val session = LiveSessionHolder()

        /** The types the running service holds (null while it is not in the foreground). Main thread. */
        @Volatile
        var foregroundTypes: Int? = null
            private set

        /**
         * Starts the foreground service with only the types the live uses: see [LiveForeground].
         */
        fun start(context: Context, needs: ForegroundNeeds = ForegroundNeeds.BOTH) {
            ContextCompat.startForegroundService(context, intentFor(context, needs))
        }

        /**
         * A source or microphone change during the live: the service takes the types of what is in use now. Nothing
         * is sent when the types stay the same (C8: a volume change must not touch a running service).
         */
        fun refresh(context: Context, needs: ForegroundNeeds) {
            val wanted = LiveForeground.types(needs, Build.VERSION.SDK_INT)
            if (!LiveForeground.needsRefresh(foregroundTypes, wanted)) return
            ContextCompat.startForegroundService(context, intentFor(context, needs))
        }

        private fun intentFor(context: Context, needs: ForegroundNeeds) = Intent(context, LiveService::class.java)
            .putExtra(LiveForeground.EXTRA_CAMERA, needs.camera)
            .putExtra(LiveForeground.EXTRA_MICROPHONE, needs.microphone)
            .putExtra(LiveForeground.EXTRA_EXTERNAL, needs.external)

        /** Called (main thread) when the system refused the foreground state; the argument is the exception name. */
        @Volatile
        var onForegroundFailed: ((String) -> Unit)? = null

        fun stop(context: Context) {
            context.stopService(Intent(context, LiveService::class.java))
        }
    }

    private var wakeLock: PowerManager.WakeLock? = null
    private var wifiLock: WifiManager.WifiLock? = null

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        Diag.init(this)
        if (intent?.action == ACTION_STOP) {
            stopFromNotification()
            return START_NOT_STICKY
        }
        Diag.log("service_start")
        val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            nm.createNotificationChannel(
                NotificationChannel(CHANNEL, "Siaran langsung", NotificationManager.IMPORTANCE_LOW),
            )
        }
        val notification = buildNotification()
        val already = foregroundTypes != null
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            val needs = ForegroundNeeds(
                camera = intent?.getBooleanExtra(LiveForeground.EXTRA_CAMERA, true) ?: true,
                microphone = intent?.getBooleanExtra(LiveForeground.EXTRA_MICROPHONE, true) ?: true,
                external = intent?.getBooleanExtra(LiveForeground.EXTRA_EXTERNAL, false) ?: false,
            )
            val types = LiveForeground.types(needs, Build.VERSION.SDK_INT)
            Diag.log(
                "service_types",
                "camera=${LiveForeground.hasCamera(types)} mic=${LiveForeground.hasMicrophone(types)} " +
                    "device=${LiveForeground.hasConnectedDevice(types)} refresh=$already",
            )
            if (!enterForeground(already, types) { startForeground(NOTIFICATION_ID, notification, types) }) return START_NOT_STICKY
        } else {
            if (!enterForeground(already, 0) { startForeground(NOTIFICATION_ID, notification) }) return START_NOT_STICKY
        }
        holdLocks()
        return START_NOT_STICKY
    }

    private fun buildNotification(): Notification {
        val open = packageManager.getLaunchIntentForPackage(packageName)?.let {
            PendingIntent.getActivity(this, 0, it, PendingIntent.FLAG_IMMUTABLE)
        }
        val stop = PendingIntent.getService(
            this, 1, Intent(this, LiveService::class.java).setAction(ACTION_STOP),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        return NotificationCompat.Builder(this, CHANNEL)
            .setContentTitle("MAXCOM sedang bersiaran")
            .setSmallIcon(applicationInfo.icon)
            .setOngoing(true)
            .setContentIntent(open)
            .setCategory(NotificationCompat.CATEGORY_SERVICE)
            .addAction(android.R.drawable.ic_media_pause, STOP_LABEL, stop)
            .build()
    }

    /** The wake lock keeps the processor, the Wi-Fi lock keeps the radio from dozing with the screen off. */
    private fun holdLocks() {
        if (wakeLock == null) {
            val pm = getSystemService(Context.POWER_SERVICE) as PowerManager
            wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "maxcom:live").apply {
                setReferenceCounted(false)
                acquire(WAKE_LOCK_MS)
            }
        }
        if (wifiLock == null) {
            try {
                val wm = applicationContext.getSystemService(Context.WIFI_SERVICE) as? WifiManager
                @Suppress("DEPRECATION") // the high-performance lock is the one that holds with the screen off
                wifiLock = wm?.createWifiLock(WifiManager.WIFI_MODE_FULL_HIGH_PERF, "maxcom:live")?.apply {
                    setReferenceCounted(false)
                    acquire()
                }
                Diag.log("service_wifi_lock", "held=${wifiLock?.isHeld == true}")
            } catch (e: RuntimeException) {
                Diag.error("service_wifi_lock_failed", e)
            }
        }
    }

    /**
     * Goes to the foreground, or changes the types it holds. The system can refuse (a missing permission, the app not
     * allowed to take this type now): that must not crash the live, and a refused REFRESH must not end it either
     * (C8). Only a refused first start stops the service; [onForegroundFailed] then tells the engine, so the screen
     * warns that a locked screen may stop the live.
     */
    private fun enterForeground(already: Boolean, types: Int, go: () -> Unit): Boolean = try {
        go()
        foregroundTypes = types
        true
    } catch (e: RuntimeException) {
        // SecurityException, ForegroundServiceStartNotAllowedException, IllegalStateException
        when (LiveForeground.onRefused(already)) {
            LiveForeground.Refused.KEEP -> {
                Diag.log("service_refresh_refused", e.javaClass.simpleName)
                true
            }
            LiveForeground.Refused.STOP -> {
                Diag.log("service_foreground_failed", e.javaClass.simpleName)
                onForegroundFailed?.invoke(e.javaClass.simpleName)
                stopSelf()
                false
            }
        }
    }

    /** "Hentikan siaran" in the notification: the same ordered stop as the screen's, then the service goes. */
    private fun stopFromNotification() {
        Diag.log("service_stop_action")
        val engine = LiveEngine.get(applicationContext)
        if (!engine.live) {
            // A notification left over with no live behind it: just go.
            stopSelf()
            return
        }
        engine.stopFromSystem(StopPath.NOTIFICATION, StopPath.REASON_NOTIFICATION) { stopSelf() }
    }

    /** The task was swiped away: the live goes on (3.2 item 2). The notification is how the person comes back or stops it. */
    override fun onTaskRemoved(rootIntent: Intent?) {
        Diag.log("service_task_removed", "live=${session.facts != null}")
        super.onTaskRemoved(rootIntent)
    }

    override fun onDestroy() {
        Diag.log("service_destroy")
        foregroundTypes = null
        wakeLock?.let { if (it.isHeld) it.release() }
        wakeLock = null
        try { wifiLock?.let { if (it.isHeld) it.release() } } catch (_: RuntimeException) {}
        wifiLock = null
        super.onDestroy()
    }
}
