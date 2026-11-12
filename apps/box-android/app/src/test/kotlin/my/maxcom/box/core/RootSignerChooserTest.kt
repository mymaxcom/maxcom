package my.maxcom.box.core

import java.io.File
import java.nio.file.Files
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertSame
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

/** The root key decision with a fake Keystore: a file key is never written while a root certificate exists. */
class RootSignerChooserTest {
    private fun tmp(): File = Files.createTempDirectory("maxcom chooser").toFile().also { it.deleteOnExit() }

    private val keystoreSigner = RootSigner(PkiTestKeys.rootA, "AndroidKeyStore", true)

    private class FakeKeystore(private val failures: Int, private val ok: RootSigner) : () -> RootSigner {
        var calls = 0
        override fun invoke(): RootSigner {
            calls++
            if (calls <= failures) throw java.security.GeneralSecurityException("keystore busy")
            return ok
        }
    }

    private fun dirs(withRoot: String? = null): Pair<File, File> {
        val base = tmp()
        val ca = File(base, "ca")
        val pki = File(base, "pki")
        if (withRoot != null) {
            val d = if (withRoot == "ca") ca else pki
            d.mkdirs()
            File(d, "root-ca.cer").writeBytes(byteArrayOf(1, 2, 3))
        }
        return ca to pki
    }

    private fun keyFiles(ca: File) = listOf("root-key.pk8", "root-key.pub", "root-key.pk8.tmp", "root-key.pub.tmp").filter { File(ca, it).exists() }

    @Test
    fun keystoreWorksFirstTimeAndNoFileIsWritten() {
        val (ca, pki) = dirs()
        val ks = FakeKeystore(0, keystoreSigner)
        val r = RootSignerChooser.open(ca, pki, ks, sleep = {})
        assertSame(keystoreSigner, r)
        assertEquals(1, ks.calls)
        assertEquals(emptyList<String>(), keyFiles(ca))
    }

    @Test
    fun aKeystoreThatRecoversWithinThreeTriesIsUsedAndNoFileIsWritten() {
        for (root in listOf(null, "ca", "pki")) {
            val (ca, pki) = dirs(root)
            val ks = FakeKeystore(2, keystoreSigner)
            val sleeps = mutableListOf<Long>()
            val r = RootSignerChooser.open(ca, pki, ks, sleep = { sleeps += it })
            assertSame(keystoreSigner, r)
            assertEquals(3, ks.calls)
            assertEquals(2, sleeps.size)
            assertTrue("backoff grows", sleeps[1] > sleeps[0])
            assertEquals(emptyList<String>(), keyFiles(ca))
        }
    }

    @Test
    fun withARootCertificateAFailingKeystoreNeverWritesAKeyFile() {
        for (root in listOf("ca", "pki")) {
            val (ca, pki) = dirs(root)
            val ks = FakeKeystore(Int.MAX_VALUE, keystoreSigner)
            var generated = 0
            assertThrows(RootKeyUnavailable::class.java) {
                RootSignerChooser.open(ca, pki, ks, sleep = {}, generateFileKey = { generated++; SoftwareCaSigner.generate() })
            }
            assertEquals("tried the Keystore three times", 3, ks.calls)
            assertEquals("no file key was even generated", 0, generated)
            assertEquals(emptyList<String>(), keyFiles(ca))
        }
    }

    @Test
    fun withoutAnyRootAnUnusableKeystoreFallsBackToAFileKeyOnce() {
        val (ca, pki) = dirs()
        val ks = FakeKeystore(Int.MAX_VALUE, keystoreSigner)
        val r = RootSignerChooser.open(ca, pki, ks, sleep = {})
        assertEquals("File", r.store)
        assertEquals(3, ks.calls)
        assertTrue(File(ca, "root-key.pk8").isFile && File(ca, "root-key.pub").isFile)
        assertFalse(File(ca, "root-key.pk8.tmp").exists())
        // once a file key exists it stays the root key, and the Keystore is not asked again
        val ks2 = FakeKeystore(0, keystoreSigner)
        val again = RootSignerChooser.open(ca, pki, ks2, sleep = {})
        assertEquals("File", again.store)
        assertEquals(0, ks2.calls)
        assertEquals(r.signer.publicKey, again.signer.publicKey)
    }

    @Test
    fun anInterruptStopsTheRetries() {
        val (ca, pki) = dirs()
        var calls = 0
        assertThrows(InterruptedException::class.java) {
            RootSignerChooser.open(ca, pki, { calls++; throw InterruptedException() }, sleep = {})
        }
        assertEquals(1, calls)
        assertEquals(emptyList<String>(), keyFiles(ca))
    }
}
