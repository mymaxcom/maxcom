package my.maxcom.box.core.mdns

import java.io.File
import java.nio.file.Files
import java.time.Instant
import my.maxcom.box.core.BoxName
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class BoxNameStoreTest {
    private fun dir(): File = Files.createTempDirectory("boxname").toFile().also { it.deleteOnExit() }
    private val at = Instant.parse("2026-11-14T10:00:00Z")

    @Test
    fun writesAndReadsBack() {
        val f = File(dir(), "data/box-name.json")
        val s = BoxNameStore(f)
        assertNull(s.read())
        s.write(7, at)
        assertEquals(StoredName(7, at), s.read())
        assertEquals("{\"n\":7,\"claimedAt\":\"2026-11-14T10:00:00Z\"}\n", f.readText())
    }

    @Test
    fun aSecondWriteReplacesTheFirstAndLeavesNoTemporaryFile() {
        val d = dir()
        val s = BoxNameStore(File(d, "box-name.json"))
        s.write(1, at)
        s.write(2, at.plusSeconds(60))
        assertEquals(2, s.read()!!.n)
        assertEquals(listOf("box-name.json"), d.list()!!.toList())
    }

    @Test
    fun readsTheWindowsWriterFormatWithAnyKeyOrderAndSpacing() {
        val f = File(dir(), "box-name.json")
        f.writeText("{ \"claimedAt\": \"2026-11-14T10:00:00.123Z\",\n  \"n\": 12 }")
        assertEquals(12, BoxNameStore(f).read()!!.n)
    }

    @Test
    fun damagedOrOddFilesAreNoName() {
        val f = File(dir(), "box-name.json")
        val s = BoxNameStore(f)
        for (bad in listOf(
            "", "{", "not json", "[]", "{\"n\":0,\"claimedAt\":\"2026-11-14T10:00:00Z\"}",
            "{\"n\":100,\"claimedAt\":\"2026-11-14T10:00:00Z\"}", "{\"n\":-1,\"claimedAt\":\"2026-11-14T10:00:00Z\"}",
            "{\"n\":\"1\",\"claimedAt\":\"2026-11-14T10:00:00Z\"}", "{\"n\":1}", "{\"n\":1,\"claimedAt\":\"yesterday\"}",
            "{\"n\":1,\"claimedAt\":\"2026-11-14T10:00:00Z\"} trailing", "\u0000\u0000\u0000",
        )) {
            f.writeText(bad)
            assertNull("bad: $bad", s.read())
        }
        f.writeBytes(ByteArray(2000) { 'a'.code.toByte() })
        assertNull(s.read())
    }

    @Test
    fun aMissingFileOrADirectoryIsNoName() {
        val d = dir()
        assertNull(BoxNameStore(File(d, "none.json")).read())
        assertNull(BoxNameStore(d).read())
    }

    @Test
    fun outOfRangeNumbersAreRefusedOnWrite() {
        val d = dir()
        val s = BoxNameStore(File(d, "box-name.json"))
        assertThrows(IllegalArgumentException::class.java) { s.write(0, at) }
        assertThrows(IllegalArgumentException::class.java) { s.write(100, at) }
        assertFalse(File(d, "box-name.json").exists())
    }

    @Test
    fun atMostThreeRenumbersPerDayAreRecordedAndTheCapReleasesAfter24Hours() {
        val s = BoxNameStore(File(dir(), "box-name.json"))
        assertTrue("no stored name: nothing to cap", s.tryRecordRenumber(at))
        s.write(1, at)
        assertTrue(s.tryRecordRenumber(at.plusSeconds(10)))
        assertTrue(s.tryRecordRenumber(at.plusSeconds(20)))
        assertTrue(s.tryRecordRenumber(at.plusSeconds(30)))
        assertFalse(s.tryRecordRenumber(at.plusSeconds(40)))
        assertEquals(3, s.renumbersInLastDay(at.plusSeconds(50)))
        // the claim moves on; the record stays
        s.persistClaim(4, at.plusSeconds(60))
        assertEquals(4, s.read()!!.n)
        assertEquals(3, s.read()!!.renumbers.size)
        assertFalse(s.tryRecordRenumber(at.plusSeconds(70)))
        // a plain write keeps the record too
        s.write(5, at.plusSeconds(80))
        assertEquals(3, s.read()!!.renumbers.size)
        // 24 hours after the first record one slot is free again
        assertTrue(s.tryRecordRenumber(at.plusSeconds(10 + 24 * 3600 + 1)))
    }

    @Test
    fun theRenumberRecordSurvivesAReadAndAClockInThePastStillCounts() {
        val f = File(dir(), "box-name.json")
        val s = BoxNameStore(f)
        s.write(2, at)
        s.tryRecordRenumber(at)
        assertEquals("{\"n\":2,\"claimedAt\":\"2026-11-14T10:00:00Z\",\"renumbers\":[${at.epochSecond}]}\n", f.readText())
        assertEquals(listOf(at), s.read()!!.renumbers)
        // a box clock far in the past (no battery, no network time yet) must not free the cap
        s.tryRecordRenumber(at)
        s.tryRecordRenumber(at)
        assertFalse(s.tryRecordRenumber(Instant.parse("1970-01-02T00:00:00Z")))
    }

    @Test
    fun theBoxNameHelperAcceptsOnlyTheNinetyNineNames() {
        assertEquals(99, BoxName.all().size)
        assertEquals(1, BoxName.parse("box1-surau.local"))
        assertEquals(99, BoxName.parse("box99-surau.local"))
        for (bad in listOf("box0-surau.local", "box100-surau.local", "box01-surau.local", "box1.surau.local", "box.surau.local", "BOX1-surau.local", "box1-surau.local.", "xbox1-surau.local", "box1-surau.localx", "")) {
            assertNull(bad, BoxName.parse(bad))
        }
        assertTrue(BoxName.all().all { BoxName.parse(it) != null })
    }
}
