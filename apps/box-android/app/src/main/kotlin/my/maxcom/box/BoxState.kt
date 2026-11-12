package my.maxcom.box

import java.util.concurrent.CopyOnWriteArrayList

/** What the start screen shows. [Failing] carries Bahasa Malaysia lines, never a secret. */
sealed class BoxStatus {
    object Idle : BoxStatus()
    data class Preparing(val step: String, val done: Int, val total: Int) : BoxStatus()
    object WaitingClock : BoxStatus()
    object Starting : BoxStatus()
    object Running : BoxStatus()
    data class Failing(val lines: List<String>) : BoxStatus()
}

/** One state of the box as the activities read it. [toString] never includes the token. */
class BoxSnapshot(val status: BoxStatus, val kioskToken: String?, val port: Int) {
    override fun toString(): String = "BoxSnapshot(status=$status, port=$port, token=" + (if (kioskToken == null) "none" else "set") + ")"
}

sealed class BoxEvent {
    /** The service was started: the token is replaced, whatever the old state was. */
    data class ServiceStarted(val newToken: String) : BoxEvent()
    data class Step(val step: String, val done: Int, val total: Int) : BoxEvent()
    object ClockWait : BoxEvent()
    object ServerStarting : BoxEvent()
    object ServerRunning : BoxEvent()
    data class Failed(val lines: List<String>) : BoxEvent()
    object ServiceStopped : BoxEvent()
}

/** Pure transition function; [BoxState] holds the process-wide value. */
object BoxReducer {
    const val PORT = 8787

    val INITIAL = BoxSnapshot(BoxStatus.Idle, null, PORT)

    fun reduce(s: BoxSnapshot, e: BoxEvent): BoxSnapshot = when (e) {
        is BoxEvent.ServiceStarted -> BoxSnapshot(BoxStatus.Preparing("Memulakan", 0, 0), e.newToken, PORT)
        is BoxEvent.Step -> BoxSnapshot(BoxStatus.Preparing(e.step, e.done, e.total), s.kioskToken, s.port)
        BoxEvent.ClockWait -> BoxSnapshot(BoxStatus.WaitingClock, s.kioskToken, s.port)
        BoxEvent.ServerStarting -> BoxSnapshot(BoxStatus.Starting, s.kioskToken, s.port)
        BoxEvent.ServerRunning -> BoxSnapshot(BoxStatus.Running, s.kioskToken, s.port)
        is BoxEvent.Failed -> BoxSnapshot(BoxStatus.Failing(e.lines.takeLast(MAX_LINES)), s.kioskToken, s.port)
        // The token goes with the service: nothing can use it once the server is gone.
        BoxEvent.ServiceStopped -> BoxSnapshot(BoxStatus.Idle, null, s.port)
    }

    const val MAX_LINES = 20
}

/** Process-wide observable. Listeners run on the thread that sent the event. */
object BoxState {
    @Volatile
    private var current: BoxSnapshot = BoxReducer.INITIAL
    private val listeners = CopyOnWriteArrayList<(BoxSnapshot) -> Unit>()

    fun get(): BoxSnapshot = current

    @Synchronized
    fun send(e: BoxEvent) {
        current = BoxReducer.reduce(current, e)
        val snap = current
        for (l in listeners) {
            try {
                l(snap)
            } catch (_: Exception) {
                // a faulty observer must not stop the box
            }
        }
    }

    fun addListener(l: (BoxSnapshot) -> Unit) {
        listeners.add(l)
    }

    fun removeListener(l: (BoxSnapshot) -> Unit) {
        listeners.remove(l)
    }
}
