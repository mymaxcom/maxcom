package my.maxcom.box.core

import java.io.ByteArrayInputStream
import java.io.IOException
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class TarReaderTest {
    private class Seen(val entry: TarEntry, val bytes: ByteArray)

    private fun readAll(gz: ByteArray, limits: TarLimits = TarLimits()): List<Seen> {
        val seen = ArrayList<Seen>()
        TarReader.read(ByteArrayInputStream(gz), limits) { e, s -> seen.add(Seen(e, s.readBytes())) }
        return seen
    }

    @Test
    fun readsFilesDirsAndModes() {
        val gz = TarBuilder().dir("a").file("a/x.txt", "hello", 420).file("a/run", "#!", 493).gz()
        val seen = readAll(gz)
        assertEquals(listOf("a", "a/x.txt", "a/run"), seen.map { it.entry.path })
        assertEquals(TarType.DIR, seen[0].entry.type)
        assertEquals("hello", String(seen[1].bytes))
        assertEquals(420, seen[1].entry.mode)
        assertEquals(493, seen[2].entry.mode)
    }

    @Test
    fun callbackMayIgnoreTheData() {
        val gz = TarBuilder().file("a", "aaaa").file("b", "bbbb").gz()
        val names = ArrayList<String>()
        TarReader.read(ByteArrayInputStream(gz)) { e, _ -> names.add(e.path) }
        assertEquals(listOf("a", "b"), names)
    }

    @Test
    fun dotSlashPrefixIsNormalised() {
        val seen = readAll(TarBuilder().dir("./").file("./a/b.txt", "x").gz())
        assertEquals(listOf("", "a/b.txt"), seen.map { it.entry.path })
    }

    @Test
    fun paxLongNameWorks() {
        val long = "d/" + "n".repeat(150) + "/file.txt"
        val seen = readAll(TarBuilder().paxFile(long, "pax".toByteArray()).gz())
        assertEquals(long, seen[0].entry.path)
        assertEquals("pax", String(seen[0].bytes))
    }

    @Test
    fun gnuLongNameWorks() {
        val long = "d/" + "g".repeat(200) + "/file.txt"
        val seen = readAll(TarBuilder().gnuLongFile(long, "gnu".toByteArray()).gz())
        assertEquals(long, seen[0].entry.path)
    }

    @Test
    fun ustarPrefixIsJoined() {
        val seen = readAll(TarBuilder().prefixedFile("deep/dir", "f.txt", "p".toByteArray()).gz())
        assertEquals("deep/dir/f.txt", seen[0].entry.path)
    }

    @Test
    fun badPathsAreRefused() {
        for (p in listOf("../x", "/x", "a/../../x", "a/../b", "C:/x", "c:x", "a\b", "a//b", "", "a/\u0000b", "a/\nb")) {
            assertThrows("path <$p>", BadEntry::class.java) { TarReader.checkPath(p) }
        }
        assertEquals("a/b", TarReader.checkPath("a/b"))
        assertEquals("a/b", TarReader.checkPath("./a/./b/"))
        assertEquals("", TarReader.checkPath("./"))
        // a colon is only suspicious in the first segment
        assertEquals("a/b:c", TarReader.checkPath("a/b:c"))
    }

    @Test
    fun entryTypesOtherThanFileAndDirAreRefused() {
        assertThrows(BadEntry::class.java) { readAll(TarBuilder().symlink("l", "/etc/passwd").gz()) }
        assertThrows(BadEntry::class.java) { readAll(TarBuilder().hardlink("h", "f").gz()) }
        assertThrows(BadEntry::class.java) { readAll(TarBuilder().device("dev").gz()) }
        assertThrows(BadEntry::class.java) { TarReader.checkEntry("a", TarType.SYMLINK) }
    }

    @Test
    fun hostileEntryInTheMiddleStopsTheRead() {
        val seen = ArrayList<String>()
        val gz = TarBuilder().file("ok", "1").file("../evil", "2").file("never", "3").gz()
        assertThrows(BadEntry::class.java) {
            TarReader.read(ByteArrayInputStream(gz)) { e, _ -> seen.add(e.path) }
        }
        assertEquals(listOf("ok"), seen)
    }

    @Test
    fun truncatedGzipFails() {
        val gz = TarBuilder().file("a", "x".repeat(5000)).gz()
        val cut = gz.copyOf(gz.size / 2)
        assertThrows(IOException::class.java) { readAll(cut) }
    }

    @Test
    fun truncatedEntryDataFails() {
        val tar = TarBuilder().lyingSize("a", 4000, ByteArray(10)).tar().copyOf(600 + 10)
        assertThrows(IOException::class.java) {
            TarReader.readTar(ByteArrayInputStream(tar)) { _, s -> s.readBytes() }
        }
    }

    @Test
    fun damagedHeaderChecksumIsRefused() {
        assertThrows(BadEntry::class.java) { readAll(TarBuilder().file("a", "x").corruptChecksum().gz()) }
    }

    @Test
    fun sizeLimitsApply() {
        val big = TarBuilder().file("a", ByteArray(2000)).gz()
        assertThrows(BadEntry::class.java) { readAll(big, TarLimits(maxEntryBytes = 1000)) }
        val two = TarBuilder().file("a", ByteArray(800)).file("b", ByteArray(800)).gz()
        assertThrows(BadEntry::class.java) { readAll(two, TarLimits(maxTotalBytes = 1000)) }
        val many = TarBuilder().file("a", "1").file("b", "2").file("c", "3").gz()
        assertThrows(BadEntry::class.java) { readAll(many, TarLimits(maxEntries = 2)) }
        assertTrue(readAll(many).size == 3)
    }

    @Test
    fun overLongPathIsRefused() {
        assertThrows(BadEntry::class.java) { TarReader.checkPath("a/" + "b".repeat(300)) }
        assertThrows(BadEntry::class.java) { TarReader.checkPath(("seg/".repeat(300)) + "x") }
    }
}
