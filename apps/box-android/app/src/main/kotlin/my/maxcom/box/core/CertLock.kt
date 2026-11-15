package my.maxcom.box.core

import java.io.IOException
import java.util.concurrent.TimeUnit
import java.util.concurrent.locks.ReentrantLock

/**
 * One lock for everything that changes the root, the leaf and their files: the service's certify step and the
 * maintenance re-key both hold it, so a re-key never interleaves with a leaf being issued (one process).
 * Waiting for it is bounded: a holder stuck in a hung key store call must not block every later caller for ever.
 */
/** The lock wait ran out. Not a certificate failure: callers keep the server and try again on the next trigger. */
class CertLockBusy : IOException("certificate lock busy")

object CertLock {
    val lock = ReentrantLock()

    const val DEFAULT_WAIT_MS = 60_000L

    inline fun <T> held(waitMs: Long = DEFAULT_WAIT_MS, block: () -> T): T {
        if (!lock.tryLock(waitMs, TimeUnit.MILLISECONDS)) throw CertLockBusy()
        try {
            return block()
        } finally {
            lock.unlock()
        }
    }
}
