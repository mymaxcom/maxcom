package my.maxcom.box.core

import java.io.File
import java.nio.file.Files
import java.nio.file.StandardCopyOption
import java.nio.file.attribute.PosixFilePermissions

/** Which signer holds the root key, and where it is recorded (`box-ca.json` `store`). */
class RootSigner(val signer: CaSigner, val store: String, val secureHardware: Boolean? = null)

/** The root key cannot be reached now and must not be replaced; the caller reports it and retries later. */
class RootKeyUnavailable(message: String) : Exception(message)

/**
 * Decision 18, made safe: the Keystore holds the root key. A file key (`ca/root-key.pk8`, mode 0600) is
 * made ONLY when no root certificate exists anywhere (neither `ca/root-ca.cer` nor `pki/root-ca.cer`) and
 * the Keystore cannot make a key after [tries] attempts. When a root certificate exists the Keystore is
 * retried and, if it still fails, [RootKeyUnavailable] is thrown without writing any key file: a fresh file
 * key would never match the stored root, and a second key must never exist beside it.
 * Once a file key exists it stays the root's key.
 *
 * Pure Kotlin: the Keystore, the clock and the file key generator are passed in, so the decision is tested
 * with fakes.
 */
object RootSignerChooser {
    const val TRIES = 3
    private const val PKCS8 = "root-key.pk8"
    private const val SPKI = "root-key.pub"

    fun open(
        caDir: File,
        pkiDir: File,
        keystore: () -> RootSigner,
        sleep: (Long) -> Unit = { Thread.sleep(it) },
        generateFileKey: () -> SoftwareCaSigner = { SoftwareCaSigner.generate() },
        tries: Int = TRIES,
    ): RootSigner {
        val pk8 = File(caDir, PKCS8)
        val pub = File(caDir, SPKI)
        if (pk8.isFile && pub.isFile) {
            return RootSigner(SoftwareCaSigner.fromEncoded(pk8.readBytes(), pub.readBytes()), "File")
        }
        var attempt = 0
        while (true) {
            attempt++
            try {
                return keystore()
            } catch (e: InterruptedException) {
                throw e
            } catch (e: Exception) {
                if (attempt >= tries) break
                sleep(500L * (1L shl (attempt - 1))) // 0.5 s, 1 s
            }
        }
        if (File(caDir, "root-ca.cer").exists() || File(pkiDir, "root-ca.cer").exists()) {
            throw RootKeyUnavailable("root certificate exists but the Keystore cannot open its key")
        }
        val sw = generateFileKey()
        caDir.mkdirs()
        // Public half first: the private file is the marker that selects the file signer.
        write(pub, sw.publicKey.encoded)
        write(pk8, sw.privateKeyPkcs8())
        return RootSigner(sw, "File")
    }

    private fun write(f: File, bytes: ByteArray) {
        val tmp = File(f.parentFile, f.name + ".tmp")
        tmp.delete()
        try {
            Files.createFile(tmp.toPath(), PosixFilePermissions.asFileAttribute(PosixFilePermissions.fromString("rw-------")))
        } catch (e: UnsupportedOperationException) {
            Files.createFile(tmp.toPath()) // not POSIX (a Windows test machine); Android always is
        }
        tmp.writeBytes(bytes)
        Files.move(tmp.toPath(), f.toPath(), StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING)
    }
}
