package my.maxcom.box.core

import java.io.ByteArrayInputStream
import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

class RuntimeLayoutTest {
    @get:Rule
    val tmp = TemporaryFolder()

    private lateinit var filesDir: File
    private lateinit var nativeA: File
    private lateinit var links: FakeLinks

    private val pem = "-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----\n"
    private val map = """[{"apk":"libz_so_1.so","name":"libz.so.1"},{"apk":"libc++_shared.so","name":"libc++_shared.so"}]"""

    @Before
    fun setUp() {
        filesDir = tmp.newFolder("files")
        nativeA = tmp.newFolder("nativeA")
        links = FakeLinks()
        for (n in listOf("libz_so_1.so", "libc++_shared.so", "libmediamtx.so", "libffmpeg.so", "libnode.so")) {
            File(nativeA, n).writeText("x")
        }
    }

    private fun layout(native: File = nativeA, l: Links = links) = RuntimeLayout(BoxPaths(filesDir, native), l)
    private fun cert(s: String = pem) = ByteArrayInputStream(s.toByteArray())
    private fun paths(native: File = nativeA) = BoxPaths(filesDir, native)

    private fun norm(p: String) = p.replace('\\', '/')

    @Test
    fun makesTheExpectedLinks() {
        layout().rebuild(map, "# versions\n", cert())
        val p = paths()
        assertEquals(norm(File(nativeA, "libz_so_1.so").path), links.readLink(File(p.runtimeLib, "libz.so.1"))?.let(::norm))
        assertEquals(norm(File(nativeA, "libc++_shared.so").path), links.readLink(File(p.runtimeLib, "libc++_shared.so"))?.let(::norm))
        assertEquals(norm(File(nativeA, "libmediamtx.so").path), links.readLink(p.mediamtxLink)?.let(::norm))
        assertEquals(norm(File(nativeA, "libffmpeg.so").path), links.readLink(p.ffmpegLink)?.let(::norm))
        assertEquals(4, links.created.size)
        assertEquals("# versions\n", p.versionsMd.readText())
        assertEquals(pem, p.certPem.readText())
        assertTrue(p.tmp.isDirectory)
    }

    @Test
    fun missingToolIsLeftOutNotAnError() {
        File(nativeA, "libffmpeg.so").delete()
        layout().rebuild(map, "v", cert())
        assertNull(links.readLink(paths().ffmpegLink))
        assertTrue(links.isLink(paths().mediamtxLink))
    }

    @Test
    fun refusesTraversalAndSeparatorsInEitherField() {
        val bad = listOf(
            """[{"apk":"../x","name":"a.so"}]""",
            """[{"apk":"libz_so_1.so","name":"../a.so"}]""",
            """[{"apk":"sub/libz_so_1.so","name":"a.so"}]""",
            """[{"apk":"libz_so_1.so","name":"a/b.so"}]""",
            """[{"apk":"libz_so_1.so","name":"a\\b.so"}]""",
            """[{"apk":"libz_so_1.so","name":".."}]""",
            """[{"apk":"libz_so_1.so","name":"."}]""",
            """[{"apk":"libz_so_1.so","name":""}]""",
            """[{"apk":"libz_so_1.so","name":"a\u0000b"}]""",
            """[{"apk":"libz_so_1.so","name":"a\nb"}]""",
            """[{"apk":"/data/x.so","name":"a.so"}]""",
            """[{"apk":"libz_so_1.so"}]""",
            """[{"apk":1,"name":"a.so"}]""",
            """["libz_so_1.so"]""",
            """[]""",
            """{"apk":"libz_so_1.so","name":"a.so"}""",
            "not json",
        )
        for (m in bad) {
            assertThrows(m, RuntimeLayoutException::class.java) { layout().rebuild(m, "v", cert()) }
        }
        assertTrue("no link may be made by a refused map", links.created.isEmpty())
    }

    @Test
    fun refusesMissingApkFileAndDuplicateNames() {
        assertThrows(RuntimeLayoutException::class.java) {
            layout().rebuild("""[{"apk":"libnope.so","name":"libnope.so"}]""", "v", cert())
        }
        assertThrows(RuntimeLayoutException::class.java) {
            layout().rebuild(
                """[{"apk":"libz_so_1.so","name":"a.so"},{"apk":"libc++_shared.so","name":"a.so"}]""",
                "v",
                cert(),
            )
        }
        // a folder is not a library file
        File(nativeA, "dir.so").mkdir()
        assertThrows(RuntimeLayoutException::class.java) {
            layout().rebuild("""[{"apk":"dir.so","name":"dir.so"}]""", "v", cert())
        }
        assertTrue(links.created.isEmpty())
    }

    @Test
    fun aRefusedRebuildLeavesTheOldLayoutAlone() {
        layout().rebuild(map, "old", cert())
        val before = links.created.size
        assertThrows(RuntimeLayoutException::class.java) {
            layout().rebuild("""[{"apk":"../x","name":"a.so"}]""", "new", cert("-----BEGIN CERTIFICATE-----\nBBBB\n"))
        }
        assertEquals(before, links.created.size)
        assertEquals("old", paths().versionsMd.readText())
        assertEquals(pem, paths().certPem.readText())
    }

    @Test
    fun secondRebuildAfterNativeDirChangedPointsEveryLinkAtTheNewFolder() {
        layout().rebuild(map, "v1", cert())
        val nativeB = tmp.newFolder("nativeB")
        for (n in nativeA.list()!!) File(nativeB, n).writeText("y")
        layout(nativeB).rebuild(map, "v2", cert())
        val p = paths(nativeB)
        for (name in listOf("libz.so.1", "libc++_shared.so")) {
            val t = norm(links.readLink(File(p.runtimeLib, name))!!)
            assertTrue(t, t.startsWith(norm(nativeB.path) + "/"))
        }
        assertTrue(norm(links.readLink(p.mediamtxLink)!!).startsWith(norm(nativeB.path) + "/"))
        assertTrue(norm(links.readLink(p.ffmpegLink)!!).startsWith(norm(nativeB.path) + "/"))
        assertEquals("v2", p.versionsMd.readText())
    }

    @Test
    fun removesStaleFilesInTheTwoFolders() {
        val p = paths()
        p.runtimeLib.mkdirs()
        File(p.runtimeLib, "stale.so").writeText("old")
        File(p.runtimeLib, "dir").mkdirs()
        File(File(p.runtimeLib, "dir"), "inner").writeText("old")
        File(p.toolsLive, "other").also { it.mkdirs() }
        File(File(p.toolsLive, "other"), "x").writeText("old")
        layout().rebuild(map, "v", cert())
        assertFalse(File(p.runtimeLib, "stale.so").exists())
        assertFalse(File(p.runtimeLib, "dir").exists())
        assertFalse(File(p.toolsLive, "other").exists())
    }

    @Test
    fun certIsRewrittenOnlyWhenItsHashDiffers() {
        layout().rebuild(map, "v", cert())
        val f = paths().certPem
        f.setLastModified(1_000_000L)
        layout().rebuild(map, "v", cert())
        assertEquals("unchanged cert must not be rewritten", 1_000_000L, f.lastModified())
        val newer = "-----BEGIN CERTIFICATE-----\nBBBB\n-----END CERTIFICATE-----\n"
        layout().rebuild(map, "v", cert(newer))
        assertEquals(newer, f.readText())
    }

    @Test
    fun refusesNonPemAndOversizedCert() {
        assertThrows(RuntimeLayoutException::class.java) { layout().rebuild(map, "v", cert("hello")) }
        assertThrows(RuntimeLayoutException::class.java) {
            layout().rebuild(map, "v", ByteArrayInputStream(ByteArray(RuntimeLayout.MAX_CERT_BYTES + 1) { 'A'.code.toByte() }))
        }
        assertFalse(paths().certPem.exists())
    }

    @Test
    fun noTempFilesLeftBehind() {
        layout().rebuild(map, "v", cert())
        val p = paths()
        assertEquals(listOf("cert.pem"), p.runtimeEtc.list()!!.toList())
        assertTrue(p.toolsLive.list()!!.none { it.endsWith(".tmp") })
    }
}
