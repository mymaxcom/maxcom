package my.maxcom.app.upload

import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** The pieces of one live become one file; nothing is removed unless the joined file exists and has the right length. */
class RecordingMergeTest {
    private val p1 = "MAXCOM-2026-11-21-1930-subuh-01.mp4"
    private val p2 = "MAXCOM-2026-11-21-1930-subuh-02.mp4"
    private val p3 = "MAXCOM-2026-11-21-1930-subuh-03.mp4"
    private val joined = "MAXCOM-2026-11-21-1930-subuh-all.mp4"

    private class FakeEnv(
        val existing: MutableMap<String, Long>,
        val pieceUs: Long = 60_000_000L,
        val joinedUs: (Int) -> Long = { it * 60_000_000L },
        var free: Long = 10L shl 30,
        var joinFails: Boolean = false,
        var publishFails: Boolean = false,
        var leftover: Int = 0,
        var findHidesFor: Int = 0,
    ) : MergeEnv {
        val calls = mutableListOf<String>()
        var tmp: File? = null
        var lastCount = 0

        override fun find(names: List<String>): List<MergePiece> {
            if (findHidesFor > 0 && names.size > 1) {
                findHidesFor--
                return names.drop(1).filter { it in existing }.map { MergePiece(it, null, existing[it]!!) }
            }
            return names.filter { it in existing }.map { MergePiece(it, null, existing[it]!!) }
        }

        override fun durationUs(p: MergePiece): Long = pieceUs
        override fun freeBytes(): Long = free
        override fun nameTaken(name: String): Boolean = name in existing

        override fun join(pieces: List<MergePiece>, name: String): File {
            calls.add("join:${pieces.size}")
            if (joinFails) throw RuntimeException("mux")
            lastCount = pieces.size
            return File.createTempFile("merge", ".mp4").also { tmp = it; it.writeBytes(ByteArray(1000)) }
        }

        override fun durationUsOfFile(f: File): Long = joinedUs(lastCount)

        override fun publish(tmp: File, name: String): Long? {
            calls.add("publish:$name")
            if (publishFails) return null
            existing[name] = tmp.length()
            return tmp.length()
        }

        override fun removePublished(name: String) {
            calls.add("removePublished")
            existing.remove(name)
        }

        override fun deletePieces(names: List<String>): Int {
            calls.add("delete:${names.size}")
            if (leftover == 0) names.forEach { existing.remove(it) }
            return leftover
        }
    }

    private fun env(vararg names: String, bytes: Long = 10L shl 20) = FakeEnv(names.associateWith { bytes }.toMutableMap())

    @Test
    fun theJoinedNameKeepsDateTimeAndPrefixAndEndsAll() {
        assertEquals(joined, MergeLogic.joinedName(p1))
        assertEquals(joined, MergeLogic.joinedNameOf(listOf(p1, p2, p3)))
        assertNull(MergeLogic.joinedName("photo.jpg"))
        assertNull(MergeLogic.joinedName("MAXCOM-2026-11-21-subuh-01.mp4")) // the older scheme is never touched
        // pieces of two different lives are never joined into one
        assertNull(MergeLogic.joinedNameOf(listOf(p1, "MAXCOM-2026-11-21-2000-subuh-01.mp4")))
        // the joined name is itself a name the app may find and delete
        assertTrue(RecordingGuard.isRecordingName(joined))
        assertFalse(RecordingGuard.isRecordingName("MAXCOM-2026-11-21-1930-subuh-.mp4"))
    }

    @Test
    fun theJoinedLengthMustEqualTheSumOfThePieces() {
        assertTrue(MergeLogic.lengthsMatch(180_000_000, 180_000_000))
        assertTrue(MergeLogic.lengthsMatch(180_000_000, 179_300_000)) // container rounding
        assertFalse(MergeLogic.lengthsMatch(180_000_000, 120_000_000)) // a piece missing
        assertFalse(MergeLogic.lengthsMatch(180_000_000, 0))
        assertFalse(MergeLogic.lengthsMatch(0, 0))
    }

    @Test
    fun roomIsNeededForTheTemporaryFileAndItsCopy() {
        assertTrue(MergeLogic.roomFor(100L shl 20, 300L shl 20))
        assertFalse(MergeLogic.roomFor(100L shl 20, 150L shl 20))
    }

    @Test
    fun threePiecesBecomeOneFileAndOnlyThenTheyAreRemoved() {
        val e = env(p1, p2, p3)
        val r = RecordingMerger.merge(e, listOf(p1, p2, p3))
        assertTrue(r is MergeResult.Merged)
        r as MergeResult.Merged
        assertEquals(joined, r.name)
        assertEquals(3, r.pieces)
        assertEquals(0, r.leftover)
        assertEquals(180_000L, r.durationMs)
        // the order: join, publish, then delete
        assertEquals(listOf("join:3", "publish:$joined", "delete:3"), e.calls)
        assertEquals(setOf(joined), e.existing.keys)
        assertFalse("the temporary file is gone", e.tmp!!.exists())
    }

    @Test
    fun aWrongLengthLeavesEveryPieceAndMakesNothing() {
        val e = env(p1, p2, p3)
        val e2 = FakeEnv(e.existing, joinedUs = { 100_000_000L })
        val r = RecordingMerger.merge(e2, listOf(p1, p2, p3))
        assertEquals("length_mismatch", (r as MergeResult.Failed).code)
        assertEquals(setOf(p1, p2, p3), e2.existing.keys)
        assertTrue(e2.calls.none { it.startsWith("publish") || it.startsWith("delete") })
        assertFalse(e2.tmp!!.exists())
    }

    @Test
    fun aFailedJoinLeavesThePieces() {
        val e = env(p1, p2)
        e.joinFails = true
        val r = RecordingMerger.merge(e, listOf(p1, p2))
        assertEquals("join_failed", (r as MergeResult.Failed).code)
        assertEquals(setOf(p1, p2), e.existing.keys)
    }

    @Test
    fun aFailedPublishLeavesThePieces() {
        val e = env(p1, p2)
        e.publishFails = true
        val r = RecordingMerger.merge(e, listOf(p1, p2))
        assertEquals("publish_failed", (r as MergeResult.Failed).code)
        assertEquals(setOf(p1, p2), e.existing.keys)
        assertTrue(e.calls.none { it.startsWith("delete") })
    }

    @Test
    fun noRoomRefusesBeforeAnythingIsWritten() {
        val e = env(p1, p2)
        e.free = 1L shl 20
        val r = RecordingMerger.merge(e, listOf(p1, p2))
        assertEquals("no_space", (r as MergeResult.Failed).code)
        assertTrue(e.calls.isEmpty())
    }

    @Test
    fun aJoinedNameAlreadyThereIsNeverOverwritten() {
        val e = env(p1, p2, joined)
        val r = RecordingMerger.merge(e, listOf(p1, p2))
        assertEquals("name_taken", (r as MergeResult.Failed).code)
        assertTrue(e.calls.isEmpty())
    }

    @Test
    fun aPieceThatIsMissingForGoodIsNotJoined() {
        val e = env(p1, p3)
        var slept = 0L
        val r = RecordingMerger.merge(e, listOf(p1, p2, p3), waitMs = 2_000, stepMs = 500, sleep = { slept += it })
        assertEquals("not_found", (r as MergeResult.Failed).code)
        assertEquals(2_000L, slept) // it waited for the last copy to the gallery, then gave up
        assertEquals(setOf(p1, p3), e.existing.keys)
    }

    @Test
    fun aPieceStillBeingCopiedToTheGalleryIsWaitedFor() {
        val e = env(p1, p2)
        e.findHidesFor = 2
        val r = RecordingMerger.merge(e, listOf(p1, p2), sleep = {})
        assertTrue(r is MergeResult.Merged)
    }

    @Test
    fun pieceThatCannotBeRemovedStaysAndIsCounted() {
        val e = env(p1, p2)
        e.leftover = 1
        val r = RecordingMerger.merge(e, listOf(p1, p2)) as MergeResult.Merged
        assertEquals(1, r.leftover)
        assertTrue(joined in e.existing)
        // the pieces that stayed are named so the app keeps them in its record (AQ7)
        assertEquals(listOf(p1, p2), r.leftoverNames)
    }

    @Test
    fun noLeftoverNamesWhenEveryPieceWasRemoved() {
        val e = env(p1, p2)
        val r = RecordingMerger.merge(e, listOf(p1, p2)) as MergeResult.Merged
        assertEquals(0, r.leftover)
        assertTrue(r.leftoverNames.isEmpty())
    }

    @Test
    fun onlyOneJoinRunsAtATime() {
        val f = SingleFlight()
        assertTrue(f.tryEnter())
        assertFalse(f.tryEnter())
        f.leave()
        assertTrue(f.tryEnter())
        f.leave()
        assertEquals("ran", f.runOrNull { "ran" })
        val inner = f.runOrNull { f.runOrNull { "second" } }
        assertNull(inner)
        // released even when the block throws
        try { f.runOrNull { error("x") } } catch (_: IllegalStateException) {}
        assertEquals("again", f.runOrNull { "again" })
    }

    @Test
    fun oneOrNoPieceIsLeftAsItIs() {
        val e = env(p1)
        val r = RecordingMerger.merge(e, listOf(p1))
        assertEquals(p1, (r as MergeResult.Nothing).name)
        assertTrue(e.calls.isEmpty())
        assertNull((RecordingMerger.merge(e, emptyList()) as MergeResult.Nothing).name)
        // names that are not the app's own recordings are dropped before anything else
        assertNull((RecordingMerger.merge(e, listOf("../x.mp4", "photo.jpg")) as MergeResult.Nothing).name)
    }
}
