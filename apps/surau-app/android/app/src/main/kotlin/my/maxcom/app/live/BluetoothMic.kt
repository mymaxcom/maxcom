package my.maxcom.app.live

import android.annotation.SuppressLint
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.media.AudioManager
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/* Bluetooth microphones (2026.11.15, O2/5). A Bluetooth headset records over the call link (SCO or LE Audio): the
   link has to be brought up before the recording opens, the sound is telephone quality (8 or 16 kHz) and is resampled
   to the engine rate. The Bluetooth permission (Android 12 and later) is asked by LiveChannel only when a Bluetooth
   input is chosen; without it [AndroidScoLink.connect] is false and the live goes on with the default microphone. */

/**
 * The audio mode the phone had before any Bluetooth link switched it to a call. One place for every link object
 * (each mixer source makes its own): a second connect, or a link made after another one, never saves the call mode as
 * the "previous" one, and the mode is put back once.
 */
object CallModeKeeper {
    private var saved: Int? = null

    /** Saves [mode] only when none is saved yet. */
    @Synchronized
    fun save(mode: Int) {
        if (saved == null) saved = mode
    }

    /** Hands the saved mode to [apply] once and forgets it; nothing when none is saved. */
    @Synchronized
    fun restore(apply: (Int) -> Unit) {
        val m = saved ?: return
        saved = null
        apply(m)
    }
}

/**
 * The Bluetooth call link for a microphone. Android 12 and later: the device is made the communication device and
 * cleared again at [disconnect]. Before that: `startBluetoothSco` and a wait for `SCO_AUDIO_STATE_CONNECTED` (a sticky
 * broadcast, so a link that is already up answers at once).
 */
class AndroidScoLink(
    private val am: AudioManager?,
    private val routing: MicRouting?,
    private val waitMs: Long = 4000,
    private val sdk: Int = android.os.Build.VERSION.SDK_INT,
) : ScoLink {
    private var viaScoStart = false
    private var viaDevice = false

    @SuppressLint("MissingPermission")
    override fun connect(id: String): Boolean {
        val a = am ?: return false
        return try {
            if (sdk >= 31) {
                val d = a.availableCommunicationDevices.firstOrNull { AudioRecordPort.routeOf(it).id == id } ?: return false
                CallModeKeeper.save(a.mode)
                a.mode = AudioManager.MODE_IN_COMMUNICATION
                viaDevice = a.setCommunicationDevice(d)
                // The switch is asynchronous: open the recorder only when the device is really the active one.
                if (viaDevice && !awaitCondition(waitMs) { a.communicationDevice?.id == d.id }) {
                    disconnect()
                    return false
                }
                if (!viaDevice) restoreMode(a)
                viaDevice
            } else {
                val up = startSco(a)
                // A start that timed out must not stay pending: it could hold the headset in call mode.
                if (!up) disconnect()
                up
            }
        } catch (_: Exception) {
            false
        }
    }

    @Suppress("DEPRECATION")
    private fun startSco(a: AudioManager): Boolean {
        val ctx: Context? = routing?.context
        if (ctx == null) {
            // No context for the broadcast: poll the link instead.
            a.startBluetoothSco()
            viaScoStart = true
            val end = System.currentTimeMillis() + waitMs
            while (System.currentTimeMillis() < end) {
                if (a.isBluetoothScoOn) return true
                try { Thread.sleep(50) } catch (_: InterruptedException) { break }
            }
            return a.isBluetoothScoOn
        }
        val latch = CountDownLatch(1)
        val receiver = object : BroadcastReceiver() {
            override fun onReceive(c: Context?, i: Intent?) {
                val st = i?.getIntExtra(AudioManager.EXTRA_SCO_AUDIO_STATE, -1) ?: return
                if (st == AudioManager.SCO_AUDIO_STATE_CONNECTED) latch.countDown()
            }
        }
        try {
            ctx.registerReceiver(receiver, IntentFilter(AudioManager.ACTION_SCO_AUDIO_STATE_UPDATED))
            a.startBluetoothSco()
            viaScoStart = true
            return latch.await(waitMs, TimeUnit.MILLISECONDS) || a.isBluetoothScoOn
        } finally {
            try { ctx.unregisterReceiver(receiver) } catch (_: Exception) {}
        }
    }

    private fun restoreMode(a: AudioManager) {
        CallModeKeeper.restore { try { a.mode = it } catch (_: Exception) {} }
    }

    @Suppress("DEPRECATION")
    override fun disconnect() {
        val a = am ?: return
        if (viaDevice) {
            try { a.clearCommunicationDevice() } catch (_: Exception) {}
            viaDevice = false
            restoreMode(a)
        }
        if (viaScoStart) {
            try { a.stopBluetoothSco() } catch (_: Exception) {}
            viaScoStart = false
        }
    }
}

/**
 * Waits until [check] is true, looking every [pollMs], for at most [timeoutMs]. True when it became true in time.
 * [sleep] and [now] are replaceable for tests.
 */
fun awaitCondition(
    timeoutMs: Long,
    pollMs: Long = 50,
    now: () -> Long = System::currentTimeMillis,
    sleep: (Long) -> Unit = { Thread.sleep(it) },
    check: () -> Boolean,
): Boolean {
    val end = now() + timeoutMs
    while (true) {
        if (check()) return true
        if (now() >= end) return false
        try { sleep(pollMs) } catch (_: InterruptedException) { return check() }
    }
}

/**
 * Reads from a recorder that runs at [fromRate] and hands out samples at [toRate] (linear interpolation). Unused
 * input is kept for the next call, so no sample is dropped and the position stays continuous across calls.
 */
class ResampledReader(
    private val fromRate: Int,
    private val toRate: Int,
    /** Fills the array with up to `len` samples (blocking); returns the count, or <= 0 on an error. */
    private val source: (ShortArray, Int) -> Int,
) {
    private var buf = ShortArray(0)
    private var len = 0
    private var pos = 0.0
    private var tmp = ShortArray(0)
    private val step = fromRate.toDouble() / toRate

    /** Fills [out] completely. Returns [out].size, a short count when the source failed after some samples, or <= 0. */
    fun read(out: ShortArray): Int {
        var w = 0
        while (w < out.size) {
            val idx = Math.floor(pos).toInt()
            if (idx + 1 >= len) {
                // drop what is behind the position (keep one sample for the interpolation), then read more
                val drop = idx.coerceIn(0, len)
                if (drop > 0) {
                    System.arraycopy(buf, drop, buf, 0, len - drop)
                    len -= drop
                    pos -= drop
                }
                val want = ((out.size - w) * step).toInt() + 2
                if (tmp.size < want) tmp = ShortArray(want)
                val n = source(tmp, want)
                if (n <= 0) return if (w > 0) w else n
                if (buf.size < len + n) buf = buf.copyOf(len + n)
                System.arraycopy(tmp, 0, buf, len, n)
                len += n
                continue
            }
            val frac = pos - idx
            val a = buf[idx].toInt()
            val b = buf[idx + 1].toInt()
            out[w++] = (a + (b - a) * frac).toInt().coerceIn(-32768, 32767).toShort()
            pos += step
        }
        return w
    }
}
