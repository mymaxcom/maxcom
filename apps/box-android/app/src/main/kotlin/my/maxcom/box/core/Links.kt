package my.maxcom.box.core

import java.io.File
import java.nio.file.AtomicMoveNotSupportedException
import java.nio.file.Files
import java.nio.file.NotLinkException
import java.nio.file.Paths
import java.nio.file.StandardCopyOption

/** Symbolic link operations, behind an interface so tests on Windows can use [FakeLinks]. */
interface Links {
    /** Makes [link] a symbolic link whose stored text is [target] (relative targets stay relative). */
    fun symlink(target: String, link: File)

    /** The stored target text of [link], or null when [link] is not a symbolic link. Never follows it. */
    fun readLink(link: File): String?

    /** Atomically renames [from] over [to], replacing a link or file already at [to]. */
    fun renameOver(from: File, to: File)
}

/** Real links through java.nio.file (present on Android 8 and later). */
class NioLinks : Links {
    override fun symlink(target: String, link: File) {
        Files.createSymbolicLink(link.toPath(), Paths.get(target))
    }

    override fun readLink(link: File): String? {
        val p = link.toPath()
        if (!Files.isSymbolicLink(p)) return null
        return try {
            Files.readSymbolicLink(p).toString().replace('\\', '/')
        } catch (_: NotLinkException) {
            null
        }
    }

    override fun renameOver(from: File, to: File) {
        try {
            Files.move(from.toPath(), to.toPath(), StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING)
        } catch (e: AtomicMoveNotSupportedException) {
            // Never fall back to a non-atomic move: the switch must be all or nothing.
            throw java.io.IOException("atomic rename not supported", e)
        }
    }
}

/**
 * In-memory links for tests: nothing is created on disk. Keeps a map so [readLink] and
 * [renameOver] behave consistently, and records every call.
 */
class FakeLinks : Links {
    private val table = LinkedHashMap<String, String>()

    /** Every symlink call in order: (target text, link file). */
    val created = ArrayList<Pair<String, File>>()

    /** Every renameOver call in order: (from, to). */
    val renamed = ArrayList<Pair<File, File>>()

    private fun key(f: File): String = f.absoluteFile.normalize().path.replace('\\', '/')

    override fun symlink(target: String, link: File) {
        // Nothing exists on disk for a fake link, so a stale entry from a removed folder is just replaced.
        table[key(link)] = target
        created.add(target to link)
    }

    override fun readLink(link: File): String? = table[key(link)]

    override fun renameOver(from: File, to: File) {
        val target = table.remove(key(from)) ?: throw java.io.FileNotFoundException(from.path)
        table[key(to)] = target
        renamed.add(from to to)
    }

    /** Test helper: make a link known without recording a call. */
    fun put(link: File, target: String) {
        table[key(link)] = target
    }

    fun isLink(link: File): Boolean = table.containsKey(key(link))
}
