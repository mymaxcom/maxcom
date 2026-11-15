package my.maxcom.box.core

import java.io.File
import java.time.Instant

/** Where the key of one root lives: a Keystore [alias] and the base name of the file-key pair under `ca/`. */
class RootKeyNames(val alias: String, val fileBase: String)

/**
 * The root key of a V2 root is named after the root's label (`maxcom-root-ca-<label>`, `root-key-<label>.pk8`),
 * so a re-key can make a new key without touching the old one, and the right key is found again from the
 * stored root alone (no pointer file that a crash could leave behind). A legacy root keeps the original names.
 */
object RootKeys {
    const val DEFAULT_ALIAS = "maxcom-root-ca"
    const val DEFAULT_FILE_BASE = "root-key"
    internal const val MAX_ROOT_BYTES = 16 * 1024

    val LEGACY = RootKeyNames(DEFAULT_ALIAS, DEFAULT_FILE_BASE)

    fun namesForLabel(label: String): RootKeyNames = RootKeyNames("$DEFAULT_ALIAS-$label", "$DEFAULT_FILE_BASE-$label")

    /** The first stored root certificate that parses (`ca/` copy first, as [BoxCa.ensureRoot] reads them), or null. */
    fun storedRoot(caDir: File, pkiDir: File): ByteArray? {
        for (f in listOf(File(caDir, "root-ca.cer"), File(pkiDir, "root-ca.cer"))) {
            val b = try { if (f.isFile && f.length() <= MAX_ROOT_BYTES) f.readBytes() else null } catch (e: java.io.IOException) { null }
            if (b != null && BoxCa.rootLabelOf(b) != null) return b
        }
        return null
    }

    /**
     * The key names for the box's root: those of the stored V2 root's label; the legacy names for a stored
     * legacy (or unreadable) root; and, when there is no root at all, the names of [freshLabel] (the label the
     * new root will get) or the legacy names when none is given.
     */
    fun resolve(caDir: File, pkiDir: File, freshLabel: String?): RootKeyNames {
        val der = storedRoot(caDir, pkiDir)
        if (der != null) {
            val label = BoxCa.rootLabelOf(der)
            return if (label != null && BoxCa.rootGeneration(der) == RootGeneration.V2) namesForLabel(label) else LEGACY
        }
        return freshLabel?.let { namesForLabel(it) } ?: LEGACY
    }
}

/** What [RootRekey.run] made. */
class RekeyResult(val rootDer: ByteArray, val signer: RootSigner, val label: String, val archivedAs: String)

/**
 * Replaces a legacy root with a V2 root made by a NEW key (the old key and the old files are kept, never
 * deleted). Order, so that no crash leaves the box without a usable root: (1) make the new key (a failure here
 * changes nothing), (2) archive the old root, leaf and record in `pki/old/<oldLabel>/`, (3) write the new root to
 * `ca/root-ca.cer` then `pki/root-ca.cer`. A crash between the two writes is repaired by [BoxCa.ensureRoot]
 * (it reads the `ca/` copy first). The caller issues a new leaf afterwards (the old leaf no longer chains).
 */
object RootRekey {
    fun run(
        caDir: File,
        pkiDir: File,
        now: Instant,
        newSigner: (label: String) -> RootSigner,
        label: String = BoxCa.newLabel(),
    ): RekeyResult {
        val old = storedRootOrThrow(caDir, pkiDir)
        if (BoxCa.rootGeneration(old) != RootGeneration.LEGACY) throw IllegalStateException("the root is not a legacy root")
        val oldLabel = BoxCa.rootLabelOf(old) ?: throw IllegalStateException("the root has no label")
        require(label != oldLabel) { "the new label must differ" }

        val rs = newSigner(label) // (1)
        val newRoot = BoxCa.makeRoot(rs.signer, label, now, generation = RootGeneration.V2)

        val archive = File(File(pkiDir, "old"), oldLabel) // (2)
        BoxCa.writeAtomic(File(archive, "root-ca.cer").toPath(), old, secret = false)
        for (name in listOf("box-leaf.cer", "box-ca.json")) {
            val f = File(pkiDir, name)
            if (f.isFile && f.length() <= RootKeys.MAX_ROOT_BYTES) BoxCa.writeAtomic(File(archive, name).toPath(), f.readBytes(), secret = false)
        }

        BoxCa.writeAtomic(File(caDir, "root-ca.cer").toPath(), newRoot, secret = false) // (3)
        BoxCa.writeAtomic(File(pkiDir, "root-ca.cer").toPath(), newRoot, secret = false)
        return RekeyResult(newRoot, rs, label, "old/$oldLabel")
    }

    private fun storedRootOrThrow(caDir: File, pkiDir: File): ByteArray =
        RootKeys.storedRoot(caDir, pkiDir) ?: throw IllegalStateException("no root certificate")
}
