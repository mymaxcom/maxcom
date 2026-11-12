package my.maxcom.app.live

import java.util.concurrent.ExecutorService
import java.util.concurrent.TimeUnit
import java.util.concurrent.TimeoutException

/**
 * The order of a live stop: the recorder is finished (the MP4 gets its moov)
 * BEFORE the outputs close, and both BEFORE anything is released (the
 * preview, GL, camera). The recorder step is bounded: if it hangs, the
 * outputs still close and the box is still answered. Pure, so it is unit
 * tested; the engine runs it on a worker thread, never on the main thread.
 */
object StopSequence {
    const val STOP_RECORD_TIMEOUT_MS = 10_000L

    /** True when the recorder step finished in time (or there was none). */
    fun run(
        stopRecord: (() -> Unit)?,
        stopOutputs: () -> Unit,
        release: () -> Unit,
        timeoutMs: Long,
        recordExecutor: ExecutorService,
        log: (String, String) -> Unit,
    ): Boolean {
        var finished = true
        if (stopRecord != null) {
            log("stop_record_begin", "")
            val f = recordExecutor.submit(stopRecord)
            try {
                f.get(timeoutMs, TimeUnit.MILLISECONDS)
                log("stop_record_end", "ok")
            } catch (e: TimeoutException) {
                finished = false
                log("stop_record_timeout", "ms=$timeoutMs")
            } catch (e: Exception) {
                finished = false
                log("stop_record_failed", "type=" + (e.cause ?: e).javaClass.simpleName)
            }
        }
        try {
            stopOutputs()
        } catch (e: Exception) {
            log("stop_outputs_failed", "type=" + e.javaClass.simpleName)
        }
        log("stop_release", "")
        try {
            release()
        } catch (e: Exception) {
            log("stop_release_failed", "type=" + e.javaClass.simpleName)
        }
        return finished
    }
}
