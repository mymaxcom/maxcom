package my.maxcom.box.core

import java.io.ByteArrayInputStream
import java.io.File
import java.io.IOException
import java.io.InputStream
import java.nio.file.Files
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Before
import org.junit.Test

class ReleaseStoreTest {
    private lateinit var base: File
    private lateinit var root: File
    private lateinit var fake: FakeLinks

    @Before
    fun setUp() {
        base = tempDir("relstore")
        root = File(base, "box")
        root.mkdirs()
        fake = FakeLinks()
    }

    @After
    fun tearDown() {
        base.deleteRecursively()
    }

    private fun store(links: Links = fake) = ReleaseStore(root, links)
    private fun releases() = File(root, "releases")
    private fun children(): List<String> = releases().list()?.sorted() ?: emptyList()

    private fun unpack(s: ReleaseStore, gz: ByteArray, version: String, sha: String = sha256Hex(gz), progress: (Int) -> Unit = {}) =
        s.unpack(ByteArrayInputStream(gz), sha, version, progress)

    @Test
    fun goodArchiveUnpacksWithBytesAndLinks() {
        val gz = releaseArchive("2026.11.1").gz()
        val counts = ArrayList<Int>()
        unpack(store(), gz, "2026.11.1") { counts.add(it) }
        val dir = File(releases(), "2026.11.1")
        assertEquals("export const a = 1;\n", File(dir, "packages/core/index.js").readText())
        assertTrue(File(dir, ".ok").isFile)
        assertEquals(listOf("2026.11.1"), children())
        assertEquals(listOf(1, 2, 3, 4), counts)
        if (!System.getProperty("os.name").lowercase().contains("windows")) {
            assertTrue(File(dir, "bin/run.sh").canExecute())
            assertFalse(File(dir, "package.json").canExecute())
        }
        assertEquals(1, fake.created.size)
        assertEquals("../../packages/core", fake.created[0].first)
        assertTrue(fake.created[0].second.path.replace('\\', '/').endsWith("2026.11.1.part/node_modules/@surau/core"))
    }

    @Test
    fun hostileEntriesAreRefusedAndLeaveNothing() {
        val cases = mapOf(
            "dotdot" to TarBuilder().file("../x", "1"),
            "absolute" to TarBuilder().file("/x", "1"),
            "nested dotdot" to TarBuilder().file("a/../../x", "1"),
            "drive" to TarBuilder().file("C:/x", "1"),
            "backslash" to TarBuilder().file("a\\b", "1"),
            "symlink" to TarBuilder().symlink("l", "/etc"),
            "hardlink" to TarBuilder().hardlink("h", "f"),
            "device" to TarBuilder().device("d"),
        )
        for ((label, b) in cases) {
            val gz = b.gz()
            val s = store()
            assertThrows(label, BadEntry::class.java) { unpack(s, gz, "2026.11.1") }
            assertEquals(label, emptyList<String>(), children())
            assertNull(label, s.installed())
        }
    }

    @Test
    fun truncatedGzipLeavesNothing() {
        val gz = releaseArchive("2026.11.1").gz()
        val cut = gz.copyOf(gz.size - 20)
        assertThrows(IOException::class.java) { unpack(store(), cut, "2026.11.1", sha256Hex(cut)) }
        assertEquals(emptyList<String>(), children())
    }

    @Test
    fun wrongHashIsRefusedAfterReadingAndLeavesNothing() {
        val gz = releaseArchive("2026.11.1").gz()
        val e = assertThrows(IOException::class.java) { unpack(store(), gz, "2026.11.1", "0".repeat(64)) }
        assertTrue(e.message!!.contains("sha256"))
        assertEquals(emptyList<String>(), children())
    }

    @Test
    fun hashCoversBytesAfterTheGzipEnd() {
        // Trailing bytes after the gzip member are ignored by the reader but are part of the hashed stream.
        val gz = releaseArchive("2026.11.1").gz()
        val padded = gz + ByteArray(100) { 7 }
        assertThrows(IOException::class.java) { unpack(store(), padded, "2026.11.1", sha256Hex(gz)) }
        assertEquals(emptyList<String>(), children())
        unpack(store(), padded, "2026.11.1", sha256Hex(padded))
        assertTrue(File(releases(), "2026.11.1/.ok").isFile)
    }

    @Test
    fun paxLongNameUnpacks() {
        val long = "packages/core/" + "d".repeat(120) + "/f.txt"
        val gz = TarBuilder().file("release.json", """{"version":"2026.11.1"}""").paxFile(long, "long".toByteArray()).gz()
        unpack(store(), gz, "2026.11.1")
        assertEquals("long", File(File(releases(), "2026.11.1"), long).readText())
    }

    @Test
    fun unpackTwiceIsANoOp() {
        val gz = releaseArchive("2026.11.1").gz()
        val s = store()
        unpack(s, gz, "2026.11.1")
        val linkCalls = fake.created.size
        val boom = object : InputStream() {
            override fun read(): Int = throw AssertionError("second unpack must not read")
        }
        s.unpack(boom, sha256Hex(gz), "2026.11.1") { }
        assertEquals(linkCalls, fake.created.size)
        assertEquals(listOf("2026.11.1"), children())
    }

    @Test
    fun leftoverPartIsCleanedAndRedone() {
        val part = File(releases(), "2026.11.1.part")
        File(part, "stale").mkdirs()
        File(part, "stale/junk.txt").writeText("junk")
        val gz = releaseArchive("2026.11.1").gz()
        unpack(store(), gz, "2026.11.1")
        assertEquals(listOf("2026.11.1"), children())
        assertFalse(File(releases(), "2026.11.1/stale").exists())
    }

    @Test
    fun folderWithoutOkIsRedone() {
        val dir = File(releases(), "2026.11.1")
        dir.mkdirs()
        File(dir, "half.txt").writeText("x")
        unpack(store(), releaseArchive("2026.11.1").gz(), "2026.11.1")
        assertFalse(File(dir, "half.txt").exists())
        assertTrue(File(dir, ".ok").isFile)
    }

    @Test
    fun cleanPartsRemovesPartFolders() {
        File(releases(), "2026.11.3.part/x").mkdirs()
        File(releases(), "2026.11.2").mkdirs()
        store().cleanParts()
        assertEquals(listOf("2026.11.2"), children())
    }

    @Test
    fun workspaceLinkChecks() {
        fun run(links: String) {
            unpack(store(), releaseArchive("2026.11.1", links).gz(), "2026.11.1")
        }
        assertThrows(BadEntry::class.java) { run("""[{"name":"@surau/core","target":"../../etc"}]""") }
        assertThrows(BadEntry::class.java) { run("""[{"name":"x","target":"packages/core"}]""") }
        assertThrows(BadEntry::class.java) { run("""[{"name":"@surau/../x","target":"packages/core"}]""") }
        assertThrows(BadEntry::class.java) { run("""[{"name":"@surau/Core","target":"packages/core"}]""") }
        assertThrows(BadEntry::class.java) { run("""[{"name":"@surau/core","target":"/etc"}]""") }
        assertThrows(BadEntry::class.java) { run("""[{"name":"@surau/core","target":"packages/missing"}]""") }
        assertThrows(BadEntry::class.java) { run("""[{"name":"@surau/core","target":"packages/core/index.js"}]""") }
        assertThrows(BadEntry::class.java) { run("""[{"name":"@surau/core"}]""") }
        assertThrows(BadEntry::class.java) { run("""{"name":"@surau/core"}""") }
        assertEquals(emptyList<String>(), children())
        assertEquals(0, fake.created.size)
    }

    @Test
    fun releaseJsonMustMatchTheVersion() {
        val gz = releaseArchive("2026.11.1").gz()
        assertThrows(BadEntry::class.java) { unpack(store(), gz, "2026.11.5") }
        val noJson = TarBuilder().file("package.json", "{}").gz()
        assertThrows(BadEntry::class.java) { unpack(store(), noJson, "2026.11.1") }
        assertEquals(emptyList<String>(), children())
    }

    @Test
    fun fileOverDirectoryAndParentFileAreRefused() {
        assertThrows(IOException::class.java) {
            unpack(store(), TarBuilder().file("a", "x").file("a/b", "y").gz(), "2026.11.1")
        }
        assertThrows(IOException::class.java) {
            unpack(store(), TarBuilder().dir("d").file("d", "y").gz(), "2026.11.1")
        }
        assertEquals(emptyList<String>(), children())
    }

    @Test
    fun badVersionOrHashArgumentsAreRefused() {
        val gz = releaseArchive("2026.11.1").gz()
        assertThrows(IllegalArgumentException::class.java) { unpack(store(), gz, "../x") }
        assertThrows(IllegalArgumentException::class.java) { unpack(store(), gz, "2026.11.1", "abc") }
        assertEquals(emptyList<String>(), children())
    }

    @Test
    fun switchWritesPreviousAndMovesTheLink() {
        val s = store()
        unpack(s, releaseArchive("2026.11.1").gz(), "2026.11.1")
        unpack(s, releaseArchive("2026.11.2").gz(), "2026.11.2")
        assertNull(s.installed())
        s.switchTo("2026.11.1")
        assertEquals("2026.11.1", s.installed())
        assertFalse(File(root, "previous.txt").exists())
        s.switchTo("2026.11.2")
        assertEquals("2026.11.2", s.installed())
        assertEquals("2026.11.1", File(root, "previous.txt").readText().trim())
        assertEquals("releases/2026.11.2", fake.readLink(File(root, "current")))
        // the switch went through a rename, never a direct write to `current`
        assertTrue(fake.renamed.any { it.second.name == "current" && it.first.name == "current.tmp" })
    }

    @Test
    fun switchToAnIncompleteReleaseIsRefused() {
        val s = store()
        File(releases(), "2026.11.9").mkdirs() // no .ok
        assertThrows(IOException::class.java) { s.switchTo("2026.11.9") }
        assertThrows(IOException::class.java) { s.switchTo("2026.11.8") }
        assertThrows(IllegalArgumentException::class.java) { s.switchTo("../x") }
        assertNull(s.installed())
    }

    @Test
    fun needsUnpackNewerOnDiskWins() {
        val s = store()
        assertTrue(s.needsUnpack("2026.11.2"))
        unpack(s, releaseArchive("2026.11.10").gz(), "2026.11.10")
        s.switchTo("2026.11.10")
        assertFalse(s.needsUnpack("2026.11.2"))
        assertFalse(s.needsUnpack("2026.11.10"))
        assertTrue(s.needsUnpack("2026.12.1"))
    }

    @Test
    fun bundledValidatesTheVersion() {
        val s = store()
        val ok = BundledRelease("2026.11.1", "0".repeat(64)) { ByteArrayInputStream(ByteArray(0)) }
        assertEquals("2026.11.1", s.bundled(ok))
        assertThrows(IllegalArgumentException::class.java) {
            s.bundled(BundledRelease("evil", "0".repeat(64)) { ByteArrayInputStream(ByteArray(0)) })
        }
    }

    @Test
    fun installedIgnoresAForeignLinkTarget() {
        fake.put(File(root, "current"), "../../etc")
        assertNull(store().installed())
        fake.put(File(root, "current"), "releases/..")
        assertNull(store().installed())
    }

    @Test
    fun pruneKeepsListedAndInstalled() {
        val s = store()
        for (v in listOf("2026.11.1", "2026.11.2", "2026.11.3")) unpack(s, releaseArchive(v).gz(), v)
        File(releases(), "2026.11.4.part").mkdirs()
        s.switchTo("2026.11.2")
        s.prune(setOf("2026.11.3"))
        assertEquals(listOf("2026.11.2", "2026.11.3"), children())
    }

    // Real links: skipped where the OS refuses to make them (Windows without the privilege).

    private fun nioOrSkip(): NioLinks {
        val probe = File(base, "probe-link")
        val ok = try {
            Files.createSymbolicLink(probe.toPath(), File(base, "elsewhere").toPath())
            Files.deleteIfExists(probe.toPath())
            true
        } catch (_: Exception) {
            false
        }
        assumeTrue("symlinks work here", ok)
        return NioLinks()
    }

    @Test
    fun pruneNeverFollowsALinkOutside() {
        val nio = nioOrSkip()
        val outside = File(base, "outside")
        File(outside, "inner").mkdirs()
        File(outside, "inner/precious.txt").writeText("keep me")
        File(outside, "top.txt").writeText("keep me too")
        val s = store(nio)
        unpack(s, releaseArchive("2026.11.1").gz(), "2026.11.1")
        unpack(s, releaseArchive("2026.11.2").gz(), "2026.11.2")
        s.switchTo("2026.11.2")
        val old = File(releases(), "2026.11.1")
        Files.createSymbolicLink(File(old, "evil-dir").toPath(), outside.toPath())
        Files.createSymbolicLink(File(old, "evil-file").toPath(), File(outside, "top.txt").toPath())
        s.prune(emptySet())
        assertEquals(listOf("2026.11.2"), children())
        assertEquals("keep me", File(outside, "inner/precious.txt").readText())
        assertEquals("keep me too", File(outside, "top.txt").readText())
    }

    @Test
    fun realSwitchIsReadBack() {
        val nio = nioOrSkip()
        val s = store(nio)
        unpack(s, releaseArchive("2026.11.1").gz(), "2026.11.1")
        unpack(s, releaseArchive("2026.11.2").gz(), "2026.11.2")
        s.switchTo("2026.11.1")
        s.switchTo("2026.11.2")
        assertEquals("2026.11.2", s.installed())
        assertEquals("2026.11.1", File(root, "previous.txt").readText().trim())
        assertTrue(File(root, "current/.ok").isFile)
        val ws = File(releases(), "2026.11.2/node_modules/@surau/core")
        assertEquals("../../packages/core", nio.readLink(ws))
        assertTrue(File(ws, "index.js").isFile)
        assertFalse(File(root, "current.tmp").exists())
    }

    @Test
    fun staleCurrentTmpIsReplaced() {
        val nio = nioOrSkip()
        val s = store(nio)
        unpack(s, releaseArchive("2026.11.1").gz(), "2026.11.1")
        Files.createSymbolicLink(File(root, "current.tmp").toPath(), File(base, "nowhere").toPath())
        s.switchTo("2026.11.1")
        assertEquals("2026.11.1", s.installed())
        assertFalse(File(root, "current.tmp").exists())
    }
}
