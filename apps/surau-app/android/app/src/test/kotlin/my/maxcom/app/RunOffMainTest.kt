package my.maxcom.app

import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class RunOffMainTest {
    @Test
    fun workRunsOnTheExecutorAndTheAnswerIsPostedToMain() {
        val caller = Thread.currentThread()
        val pool = Executors.newSingleThreadExecutor { r -> Thread(r, "worker") }
        val posted = ArrayList<Runnable>()
        var workThread: Thread? = null
        var delivered: Result<ByteArray>? = null
        val done = CountDownLatch(1)

        runOffMain(
            pool,
            { r -> synchronized(posted) { posted.add(r) }; done.countDown() },
            { workThread = Thread.currentThread(); byteArrayOf(1, 2, 3) },
        ) { delivered = it }

        assertTrue(done.await(5, TimeUnit.SECONDS))
        assertNotEquals(caller, workThread)
        // Nothing is answered until the main-thread post runs.
        assertEquals(null, delivered)
        synchronized(posted) { posted.single().run() }
        assertEquals(listOf<Byte>(1, 2, 3), delivered!!.getOrThrow().toList())
        pool.shutdown()
    }

    @Test
    fun aThrownErrorStillAnswers() {
        val posted = ArrayList<Runnable>()
        var delivered: Result<Int>? = null
        runOffMain(
            Executor_direct,
            { r -> posted.add(r) },
            { throw OutOfMemoryError("big") },
        ) { delivered = it }
        posted.single().run()
        assertTrue(delivered!!.isFailure)
    }

    @Test
    fun anExceptionIsDeliveredAsAFailure() {
        val posted = ArrayList<Runnable>()
        var delivered: Result<Int>? = null
        runOffMain(
            Executor_direct,
            { r -> posted.add(r) },
            { throw IllegalStateException("x") },
        ) { delivered = it }
        posted.single().run()
        assertTrue(delivered!!.exceptionOrNull() is IllegalStateException)
    }

    private companion object {
        val Executor_direct = java.util.concurrent.Executor { it.run() }
    }
}
