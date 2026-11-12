package my.maxcom.app.upload

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class RecordingGuardTest {
    private val me = "my.maxcom.app"

    @Test
    fun onlyTheAppsOwnRecordingNamesPass() {
        assertTrue(RecordingGuard.isRecordingName("MAXCOM-2026-11-06-1015-k1-01.mp4"))
        assertTrue(RecordingGuard.isRecordingName("MAXCOM-2026-11-06-1015-siaran-3.mp4"))
        assertTrue(RecordingGuard.isRecordingName("MAXCOM-2026-11-06-1015-kuliah_maghrib-02.mp4"))
        for (bad in listOf(
            "", "photo.jpg", "MAXCOM-2026-11-06-1015-k1-01.mkv", "MAXCOM-2026-11-06-1015-k1-01.mp4.bak",
            "maxcom-2026-11-06-k1-01.mp4", "../MAXCOM-2026-11-06-1015-k1-01.mp4", "a/MAXCOM-2026-11-06-1015-k1-01.mp4",
            "MAXCOM-2026-11-06-1015--01.mp4", "MAXCOM-2026-11-06-1015-k1-.mp4", "MAXCOM-26-11-06-k1-01.mp4",
            "MAXCOM-2026-11-06-1015-k1-01.mp4\n", "MAXCOM-2026-11-06-1015-k 1-01.mp4",
        )) assertFalse(bad, RecordingGuard.isRecordingName(bad))
    }

    @Test
    fun aMediaStoreRowMustBeInMoviesMaxcomOwnedByTheAppAndNamedLikeARecording() {
        val name = "MAXCOM-2026-11-06-1015-k1-01.mp4"
        assertTrue(RecordingGuard.acceptMediaRow(name, "Movies/MAXCOM/", me, me))
        assertTrue(RecordingGuard.acceptMediaRow(name, "Movies/MAXCOM", me, me))
        // not the app's own: another app, or an unknown owner (null), is never touched
        assertFalse(RecordingGuard.acceptMediaRow(name, "Movies/MAXCOM/", "com.other.app", me))
        assertFalse(RecordingGuard.acceptMediaRow(name, "Movies/MAXCOM/", null, me))
        assertFalse(RecordingGuard.acceptMediaRow(name, "Movies/MAXCOM/", "", me))
        // another folder, a sub folder, a look-alike folder
        assertFalse(RecordingGuard.acceptMediaRow(name, "Movies/", me, me))
        assertFalse(RecordingGuard.acceptMediaRow(name, "DCIM/Camera/", me, me))
        assertFalse(RecordingGuard.acceptMediaRow(name, "Movies/MAXCOM/old/", me, me))
        assertFalse(RecordingGuard.acceptMediaRow(name, "Movies/MAXCOMX/", me, me))
        assertFalse(RecordingGuard.acceptMediaRow(name, null, me, me))
        // a file in the right place with another name
        assertFalse(RecordingGuard.acceptMediaRow("holiday.mp4", "Movies/MAXCOM/", me, me))
    }

    @Test
    fun anAppFolderFileMustSitDirectlyInTheMaxcomFolderWithARecordingName() {
        val dir = "/storage/emulated/0/Android/data/my.maxcom.app/files/Movies/MAXCOM"
        assertTrue(RecordingGuard.acceptAppFile(dir, "MAXCOM-2026-11-06-1015-k1-01.mp4", "$dir/MAXCOM-2026-11-06-1015-k1-01.mp4"))
        assertFalse(RecordingGuard.acceptAppFile(dir, "MAXCOM-2026-11-06-1015-k1-01.mp4", "$dir/../MAXCOM-2026-11-06-1015-k1-01.mp4"))
        assertFalse(RecordingGuard.acceptAppFile(dir, "MAXCOM-2026-11-06-1015-k1-01.mp4", "$dir/sub/MAXCOM-2026-11-06-1015-k1-01.mp4"))
        assertFalse(RecordingGuard.acceptAppFile(dir, "MAXCOM-2026-11-06-1015-k1-01.mp4", "/storage/emulated/0/Movies/MAXCOM-2026-11-06-1015-k1-01.mp4"))
        assertFalse(RecordingGuard.acceptAppFile(dir, "notes.txt", "$dir/notes.txt"))
    }

    @Test
    fun onlyAskedNamesThatPassAreKept() {
        val asked = listOf("MAXCOM-2026-11-06-1015-k1-01.mp4", "../etc/passwd", "photo.jpg", "MAXCOM-2026-11-06-1015-k1-01.mp4", "MAXCOM-2026-11-06-1015-k1-02.mp4")
        assertEquals(
            listOf("MAXCOM-2026-11-06-1015-k1-01.mp4", "MAXCOM-2026-11-06-1015-k1-02.mp4"),
            RecordingGuard.askedNames(asked),
        )
        assertEquals(emptyList<String>(), RecordingGuard.askedNames(emptyList()))
        // never more than 200 names in one call
        val many = (1..300).map { "MAXCOM-2026-11-06-1015-k1-$it.mp4" }
        assertEquals(200, RecordingGuard.askedNames(many).size)
    }

    @Test
    fun theOlderSchemeAndRenamedCopiesNeverPass() {
        // older scheme (no HHmm): untouched for ever
        assertFalse(RecordingGuard.isRecordingName("MAXCOM-2026-11-06-siaran-01.mp4"))
        assertFalse(RecordingGuard.isRecordingName("MAXCOM-2026-11-06-k1-01.mp4"))
        // MediaStore's own rename of a clash
        assertFalse(RecordingGuard.isRecordingName("MAXCOM-2026-11-06-1015-siaran-01 (1).mp4"))
        assertFalse(RecordingGuard.isRecordingName("MAXCOM-2026-11-06-siaran-01 (1).mp4"))
        // a time that is no time
        assertFalse(RecordingGuard.isRecordingName("MAXCOM-2026-11-06-2460-siaran-01.mp4"))
        assertFalse(RecordingGuard.isRecordingName("MAXCOM-2026-11-06-1075-siaran-01.mp4"))
        assertTrue(RecordingGuard.isRecordingName("MAXCOM-2026-11-06-0000-siaran-01.mp4"))
        assertTrue(RecordingGuard.isRecordingName("MAXCOM-2026-11-06-2359-siaran-01.mp4"))
        // a row with a renamed copy is not accepted either
        assertFalse(RecordingGuard.acceptMediaRow("MAXCOM-2026-11-06-1015-siaran-01 (1).mp4", "Movies/MAXCOM/", me, me))
        assertEquals(emptyList<String>(), RecordingGuard.askedNames(listOf("MAXCOM-2026-11-06-siaran-01.mp4", "MAXCOM-2026-11-06-1015-siaran-01 (1).mp4")))
    }
}
