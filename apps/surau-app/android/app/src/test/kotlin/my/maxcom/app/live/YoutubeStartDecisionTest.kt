package my.maxcom.app.live

import my.maxcom.app.live.LiveLogic.YoutubeStart
import org.junit.Assert.assertEquals
import org.junit.Test

class YoutubeStartDecisionTest {
    private val url = "rtmps://a.example/live2/key"

    private fun d(
        live: Boolean = true, stopping: Boolean = false, hasStream: Boolean = true,
        want: Boolean = false, u: String? = url,
    ) = LiveLogic.youtubeStartDecision(live, stopping, hasStream, want, u)

    @Test fun opensWhenLiveAndLegNotWanted() = assertEquals(YoutubeStart.OPEN, d())

    @Test fun secondCallIsNoOp() = assertEquals(YoutubeStart.ALREADY_UP, d(want = true))

    @Test fun refusedWhenNotLive() {
        assertEquals(YoutubeStart.NOT_LIVE, d(live = false))
        assertEquals(YoutubeStart.NOT_LIVE, d(hasStream = false))
    }

    @Test fun refusedWhileStopping() = assertEquals(YoutubeStart.STOPPING, d(stopping = true))

    @Test fun refusedWithoutUrl() {
        assertEquals(YoutubeStart.NO_URL, d(u = null))
        assertEquals(YoutubeStart.NO_URL, d(u = "  "))
    }
}
