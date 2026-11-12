package my.maxcom.box.core

import java.io.File
import java.nio.file.Files
import java.nio.file.StandardCopyOption

/**
 * Copy of the database made before a release switch (migrations only go forward): `data/backups/pre-<version>-<stamp>/`
 * with `surau.db` and its `-wal` and `-shm` files when present. Only the newest [KEEP] copies are kept.
 */
object DbBackup {
    const val KEEP = 2
    private val STAMP = Regex("[0-9]{8}-[0-9]{6}")

    /** Returns the new folder, or null when there is no database yet. [stamp] looks like `20261111-093000`. */
    fun make(db: File, backups: File, fromVersion: String, stamp: String): File? {
        require(VersionOrder.isValid(fromVersion)) { "bad version" }
        require(STAMP.matches(stamp)) { "bad stamp" }
        if (!db.isFile) return null
        val dir = File(backups, "pre-$fromVersion-$stamp")
        if (!dir.isDirectory && !dir.mkdirs()) throw java.io.IOException("cannot create backup folder")
        for (suffix in listOf("", "-wal", "-shm")) {
            val src = File(db.parentFile, db.name + suffix)
            if (src.isFile) Files.copy(src.toPath(), File(dir, src.name).toPath(), StandardCopyOption.REPLACE_EXISTING)
        }
        prune(backups)
        return dir
    }

    /** Keeps the [KEEP] newest `pre-*` folders (by name: the stamp sorts by time within one version). */
    fun prune(backups: File) {
        val kids = backups.listFiles { f -> f.isDirectory && f.name.startsWith("pre-") } ?: return
        val sorted = kids.sortedByDescending { it.lastModified() }
        for (old in sorted.drop(KEEP)) old.deleteRecursively()
    }
}
