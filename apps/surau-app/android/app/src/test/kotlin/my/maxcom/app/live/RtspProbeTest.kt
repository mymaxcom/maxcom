package my.maxcom.app.live

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Test

class RtspProbeTest {
    @Test
    fun maskHelpers() {
        assertEquals("rtsp://admin:***@10.168.1.50:554/live", RtspMask.maskUrl("rtsp://admin:secret@10.168.1.50:554/live"))
        assertEquals("rtsp://10.168.1.50/live", RtspMask.maskUrl("rtsp://10.168.1.50/live"))
        assertEquals("rtsp://admin@10.168.1.50/live", RtspMask.maskUrl("rtsp://admin@10.168.1.50/live"))
        assertEquals("rtsp://10.168.1.50/a@b:c", RtspMask.maskUrl("rtsp://10.168.1.50/a@b:c"))
        val red = RtspMask.redact("Authorization: Digest response=\"x\"\nfailed rtsp://u:pw1@h/x and pw1", "pw1")
        assertFalse(red.contains("pw1"))
        assertFalse(red.contains("response=\"x\""))
    }

    @Test
    fun urlParsingDecodesLoginAndKeepsQuery() {
        val p = RtspProbe.parseUrl("rtsp://us%40er:p%3Aw@10.168.1.50:8554/a/b?ch=1&s=0")
        assertEquals("us@er", p.user)
        assertEquals("p:w", p.password)
        assertEquals(8554, p.port)
        assertEquals("rtsp://10.168.1.50:8554/a/b?ch=1&s=0", p.requestUri)
        assertEquals(554, RtspProbe.parseUrl("rtsp://10.168.1.50/x").port)
        val parts = RtspUrl.split("rtsp://a:b@10.168.1.50/x", "other", "pw")
        assertEquals("other", parts.user)
        assertEquals("pw", parts.password)
        assertEquals("rtsp://10.168.1.50/x", parts.uri)
    }
}
