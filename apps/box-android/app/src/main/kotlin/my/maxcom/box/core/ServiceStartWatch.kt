package my.maxcom.box.core

/**
 * Decides when the kiosk screen asks the system to start the box service again, and when it tells the person
 * the service never came up. Some vendor firmware drops `startForegroundService` without an error, so a screen
 * that only asks once can wait for ever. Pure and clock-free: the caller passes a monotonic time in
 * milliseconds. The watch is armed while the screen is active and the service has never reported anything.
 */
class ServiceStartWatch(
    private val firstRetryMs: Long = FIRST_RETRY_MS,
    private val retryEveryMs: Long = RETRY_EVERY_MS,
    private val messageAfterMs: Long = MESSAGE_AFTER_MS,
) {
    private var since = NONE
    private var lastTry = NONE
    private var tries = 0

    val armed: Boolean get() = since != NONE

    /** Number of retries made since the watch was armed. */
    val retryCount: Int get() = tries

    /** Starts counting at [now]. Arming an armed watch keeps the original start. */
    fun arm(now: Long) {
        if (since == NONE) since = now
    }

    /** Stops the watch (the service reported, or the screen went away) and forgets the count. */
    fun disarm() {
        since = NONE
        lastTry = NONE
        tries = 0
    }

    /** True when the caller should ask for the service to start now. Never true while disarmed. */
    fun retryDue(now: Long): Boolean {
        if (since == NONE) return false
        val next = if (lastTry == NONE) since + firstRetryMs else lastTry + retryEveryMs
        return now >= next
    }

    /** Records that the caller asked at [now]; the next retry is [retryEveryMs] later. */
    fun tried(now: Long) {
        lastTry = now
        tries++
    }

    /** True once the service has been silent for [messageAfterMs]; retries go on under the message. */
    fun messageDue(now: Long): Boolean = since != NONE && now - since >= messageAfterMs

    companion object {
        const val FIRST_RETRY_MS = 5_000L
        const val RETRY_EVERY_MS = 15_000L
        const val MESSAGE_AFTER_MS = 60_000L
        private const val NONE = Long.MIN_VALUE
    }
}
