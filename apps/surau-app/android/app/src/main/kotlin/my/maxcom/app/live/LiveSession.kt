package my.maxcom.app.live

/* What the foreground service keeps of the running live (2026.11.15 revamp, 3.2; B9 native half). Until now the
   session lived only in Dart memory, so a screen that was closed and opened again could not see, resume or stop its
   own live. These are the facts the service owns instead. Pure: no Android class, so the rules are unit tested on the
   JVM. Never a stream key, a passphrase or an address: only what the screen needs to re-attach. */

/** The live the engine was started for. */
class LiveSessionFacts(
    /** The box's session id, as the app gave it at start; empty when the app gave none. */
    val sessionId: String,
    /** Epoch ms of the engine start. */
    val startedAtMs: Long,
    val kiosk: Boolean,
    val youtube: Boolean,
    val video: VideoKind,
    val recording: Boolean,
) {
    // The id is the box's own handle, not a secret, but nothing here needs to print it.
    override fun toString() = "LiveSessionFacts(kiosk=$kiosk youtube=$youtube video=${video.wire})"
}

/**
 * The one session of the process. Written on the main thread (start, stop, a source change, the YouTube leg opening);
 * read from the channel. [status] is what crosses the channel as the answer to `status`.
 */
class LiveSessionHolder {
    @Volatile var facts: LiveSessionFacts? = null
        private set

    fun begin(f: LiveSessionFacts) {
        facts = f
    }

    /** The app learned the id after the engine started (or corrects it). Ignored when no live is held. */
    fun setSessionId(id: String) {
        val f = facts ?: return
        facts = LiveSessionFacts(cleanId(id), f.startedAtMs, f.kiosk, f.youtube, f.video, f.recording)
    }

    fun youtubeOpened() {
        val f = facts ?: return
        if (!f.youtube) facts = LiveSessionFacts(f.sessionId, f.startedAtMs, f.kiosk, true, f.video, f.recording)
    }

    fun videoChanged(kind: VideoKind) {
        val f = facts ?: return
        if (f.video != kind) facts = LiveSessionFacts(f.sessionId, f.startedAtMs, f.kiosk, f.youtube, kind, f.recording)
    }

    fun end() {
        facts = null
    }

    /**
     * The answer to the channel's `status`: null when no live is held, else the facts plus what is true right now.
     * [streaming]: the picture is being sent to the box at this moment. [recordings]: the names this live wrote so far.
     */
    fun status(streaming: Boolean, recordings: List<String>): Map<String, Any?>? {
        val f = facts ?: return null
        return mapOf(
            "sessionId" to f.sessionId,
            "startedAt" to f.startedAtMs,
            "streaming" to streaming,
            "youtube" to f.youtube,
            "kiosk" to f.kiosk,
            "video" to f.video.wire,
            "recording" to f.recording,
            "recordings" to recordings,
        )
    }

    companion object {
        /** A session id is a short handle of letters, digits, dash and underscore; anything else is not kept. */
        fun cleanId(id: String?): String {
            val s = id?.trim().orEmpty()
            return if (s.length in 1..100 && s.all { it.isLetterOrDigit() || it == '-' || it == '_' }) s else ""
        }
    }
}

/**
 * The self-end of an unattended live (3.2 item 4): when no screen is attached and the leg to the box has been down
 * without a break for [limitMs], the service stops the engine and keeps the recording. A box that ended the session
 * (or a phone that left the surau) must not leave a phone sending to YouTube for ever. A screen that is attached, a leg
 * that is up, or a live with no leg to the box at all, starts the count again.
 */
class UnattendedRule(private val limitMs: Long = LIMIT_MS) {
    private var downSinceMs = 0L

    fun reset() {
        downSinceMs = 0L
    }

    /** Call on every engine tick. True once: the live should end now. */
    fun shouldEnd(uiAttached: Boolean, kioskWanted: Boolean, kioskUp: Boolean, nowMs: Long): Boolean {
        if (uiAttached || !kioskWanted || kioskUp) {
            downSinceMs = 0L
            return false
        }
        if (downSinceMs == 0L) {
            downSinceMs = nowMs
            return false
        }
        if (nowMs - downSinceMs < limitMs) return false
        downSinceMs = 0L
        return true
    }

    companion object {
        const val LIMIT_MS = 10L * 60 * 1000
        /** The `ended` reason the screen gets (when one attaches later, through the diag file). */
        const val REASON = "unattended"
    }
}

/**
 * O8: the reason a recording was halted by the phone itself (battery or storage low) is the one the admin must see.
 * A later check of the closed file (empty, unreadable, published late) must not replace it, and a late good probe must
 * not clear it. Other errors replace each other as before.
 */
object RecordNote {
    const val BATTERY_LOW = "battery_low"
    const val STORAGE_LOW = "storage_low"

    fun isHalt(reason: String?): Boolean = reason == BATTERY_LOW || reason == STORAGE_LOW

    /** The error to show after [next] was reported while [current] was set; [next] null means "clear". */
    fun merge(current: String?, next: String?): String? = if (isHalt(current)) current else next
}

/** Q15: a screen that is attached but locked (not interactive) is not somebody watching. */
object ScreenWatch {
    fun attached(sinkPresent: Boolean, interactive: Boolean): Boolean = sinkPresent && interactive
}

/** O12: the screen stays on, on every app screen, for as long as a live or a recording runs on this phone. */
object ScreenOn {
    /** F1: a live this phone only controls (the box pulls the camera) also keeps the screen on; the app sets it. */
    @Volatile var control: Boolean = false

    fun wanted(live: Boolean, control: Boolean = this.control): Boolean = live || control
}

/** Why a live stopped without the Berhenti button of the screen (B12): each path has a name, written to the diag file. */
object StopPath {
    const val SCREEN = "screen"
    const val NOTIFICATION = "notification"
    const val CAMERA_LOST = "camera_lost"
    const val UNATTENDED = "unattended"
    const val START_FAILED = "start_failed"
    const val RELEASE = "release"

    /** The `ended` reason for the person who tapped "Hentikan siaran" in the notification. */
    const val REASON_NOTIFICATION = "notification_stop"
}

/**
 * What the engine last said, kept so a screen that attaches later is told the present state at once (3.2 item 1:
 * replay on `onListen`). Main thread only.
 */
class EventReplay {
    private var phase: String? = null
    private val outputs = LinkedHashMap<String, Map<String, Any?>>()
    private var micRouted: Map<String, Any?>? = null

    fun onPhase(v: String) {
        phase = v
        if (v == "stopped" || v == "idle") outputs.clear()
    }

    fun onOutput(e: Map<String, Any?>) {
        val name = e["name"] as? String ?: return
        outputs[name] = e
    }

    fun onMicRouted(e: Map<String, Any?>) {
        micRouted = e
    }

    /** True while the last word about [name] was "up". */
    fun isUp(name: String): Boolean = outputs[name]?.get("state") == "up"

    /** The events a new listener gets, in the order they make sense: phase, legs, warnings, the routed microphone. */
    fun events(warnings: Collection<String>, recording: Map<String, Any?>?): List<Map<String, Any?>> {
        val out = ArrayList<Map<String, Any?>>()
        phase?.let { out.add(mapOf("type" to "phase", "value" to it)) }
        out.addAll(outputs.values)
        if (recording != null) out.add(recording)
        for (w in warnings) out.add(mapOf("type" to "warning", "kind" to w, "active" to true))
        micRouted?.let { out.add(it) }
        return out
    }
}
