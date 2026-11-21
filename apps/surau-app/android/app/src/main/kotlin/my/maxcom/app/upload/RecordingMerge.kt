package my.maxcom.app.upload

import android.content.ContentValues
import android.content.Context
import android.media.MediaMetadataRetriever
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.os.StatFs
import android.provider.MediaStore
import java.io.File

/* After a live ends, the recording pieces of that live become ONE video file (contract C, Android).

   The phone records MP4 pieces to Movies/MAXCOM (naming scheme 2, `MAXCOM-<date>-<HHmm>-<prefix>-<nn>.mp4`). They are
   joined with MediaMuxer without re-encoding (SegmentJoiner / JoinCore) into `MAXCOM-<date>-<HHmm>-<prefix>-all.mp4`,
   the joined length is checked against the sum of the pieces, the joined file is published to Movies/MAXCOM, and only
   then are the pieces removed. Any failure leaves the pieces exactly as they were and the half-made file removed.
   The logic runs on [MergeEnv] so it is unit tested with fakes; [AndroidMergeEnv] is the real one. */

class MergePiece(val name: String, val uri: Uri?, val bytes: Long)

sealed class MergeResult {
    /** One piece or none: nothing to join; [name] is the file as it is (null when there was none). */
    class Nothing(val name: String?) : MergeResult()

    /**
     * [leftover] = pieces that could not be removed (they stay; the joined file exists); [leftoverNames] are those
     * pieces by name so the app can keep them in its record (they are not lost track of).
     */
    class Merged(
        val name: String,
        val bytes: Long,
        val durationMs: Long,
        val pieces: Int,
        val leftover: Int,
        val leftoverNames: List<String> = emptyList(),
    ) : MergeResult()

    /** Pieces untouched. [code] is a reason: not_found, no_space, name_taken, join_failed, length_mismatch, publish_failed. */
    class Failed(val code: String) : MergeResult()
}

interface MergeEnv {
    /** The pieces found now, in the order asked (only those that exist). */
    fun find(names: List<String>): List<MergePiece>
    fun durationUs(p: MergePiece): Long
    fun freeBytes(): Long
    fun nameTaken(name: String): Boolean

    /** Joins [pieces] into a temporary file; returns it. Throws on any failure (nothing is left behind). */
    fun join(pieces: List<MergePiece>, name: String): File
    fun durationUsOfFile(f: File): Long

    /** Puts [tmp] in Movies/MAXCOM under [name] and checks the size; returns the bytes, or null when it did not work. */
    fun publish(tmp: File, name: String): Long?

    /** Removes the published [name] again (after a failed check). */
    fun removePublished(name: String)

    /** Deletes the pieces; returns how many could not be deleted. */
    fun deletePieces(names: List<String>): Int
}

object MergeLogic {
    private val PIECE = Regex("^(MAXCOM-[0-9]{4}-[0-9]{2}-[0-9]{2}-(?:[01][0-9]|2[0-3])[0-5][0-9]-[A-Za-z0-9_-]{1,40})-[0-9]{1,4}[.]mp4$")

    /** `MAXCOM-<date>-<HHmm>-<prefix>-all.mp4` from the name of one piece; null when that is not a piece name. */
    fun joinedName(pieceName: String): String? = PIECE.matchEntire(pieceName)?.let { it.groupValues[1] + "-all.mp4" }

    /** The pieces of one live share date, time and prefix: one joined name for all, else null. */
    fun joinedNameOf(names: List<String>): String? {
        val all = names.map { joinedName(it) ?: return null }.toSet()
        return all.singleOrNull()
    }

    /** The joined length equals the sum of the pieces to within a container rounding: one second plus 0.2 percent. */
    fun lengthsMatch(sumUs: Long, joinedUs: Long): Boolean {
        if (sumUs <= 0 || joinedUs <= 0) return false
        val tol = 1_000_000L + sumUs / 500
        return kotlin.math.abs(sumUs - joinedUs) <= tol
    }

    /** Room for the temporary joined file and its copy in the gallery, with a margin. */
    fun roomFor(sumBytes: Long, freeBytes: Long): Boolean = freeBytes >= sumBytes * 2 + (16L shl 20)
}

/** One join at a time: two at once would write the same temporary file (`merge-<name>`). */
class SingleFlight {
    private val busy = java.util.concurrent.atomic.AtomicBoolean(false)

    /** True when this caller may run; it must call [leave] when done. */
    fun tryEnter(): Boolean = busy.compareAndSet(false, true)

    fun leave() {
        busy.set(false)
    }

    /** Runs [block] when no other run is in progress; null (and [block] not run) when one is. */
    fun <T> runOrNull(block: () -> T): T? {
        if (!tryEnter()) return null
        try {
            return block()
        } finally {
            leave()
        }
    }
}

object RecordingMerger {
    fun merge(
        env: MergeEnv,
        asked: List<String>,
        waitMs: Long = 10_000,
        stepMs: Long = 500,
        sleep: (Long) -> Unit = { Thread.sleep(it) },
    ): MergeResult {
        val names = RecordingGuard.askedNames(asked)
        if (names.size < 2) return MergeResult.Nothing(names.firstOrNull())
        val joined = MergeLogic.joinedNameOf(names) ?: return MergeResult.Failed("not_found")
        // The gallery copy of the last piece may still be running when the live has just ended.
        var pieces = env.find(names)
        var waited = 0L
        while (pieces.size < names.size && waited < waitMs) {
            sleep(stepMs)
            waited += stepMs
            pieces = env.find(names)
        }
        if (pieces.size != names.size) return MergeResult.Failed("not_found")
        if (env.nameTaken(joined)) return MergeResult.Failed("name_taken")
        if (!MergeLogic.roomFor(pieces.sumOf { it.bytes }, env.freeBytes())) return MergeResult.Failed("no_space")
        val sumUs = try {
            pieces.sumOf { env.durationUs(it) }
        } catch (_: Exception) {
            return MergeResult.Failed("join_failed")
        }
        val tmp = try {
            env.join(pieces, joined)
        } catch (_: Exception) {
            return MergeResult.Failed("join_failed")
        }
        try {
            val joinedUs = try { env.durationUsOfFile(tmp) } catch (_: Exception) { 0L }
            if (!MergeLogic.lengthsMatch(sumUs, joinedUs)) return MergeResult.Failed("length_mismatch")
            val bytes = env.publish(tmp, joined) ?: return MergeResult.Failed("publish_failed")
            // The joined file is there and has the right length: only now do the pieces go.
            if (env.find(listOf(joined)).size != 1) {
                env.removePublished(joined)
                return MergeResult.Failed("publish_failed")
            }
            val leftover = env.deletePieces(names)
            val leftoverNames = if (leftover > 0) {
                val asked = names.toSet()
                try { env.find(names).map { it.name }.filter { it in asked } } catch (_: Exception) { emptyList() }
            } else {
                emptyList()
            }
            return MergeResult.Merged(joined, bytes, joinedUs / 1000, names.size, leftover, leftoverNames)
        } finally {
            tmp.delete()
        }
    }
}

/** The real thing: MediaStore rows in `Movies/MAXCOM` or files in the app's own folder, MediaMuxer, MediaStore insert. */
class AndroidMergeEnv(
    private val context: Context,
    private val findFn: (List<String>) -> List<Map<String, Any?>>,
    private val deleteFn: (List<String>) -> Map<String, Any?>,
) : MergeEnv {
    override fun find(names: List<String>): List<MergePiece> =
        findFn(names).mapNotNull { m ->
            val n = m["name"] as? String ?: return@mapNotNull null
            val u = (m["uri"] as? String)?.let { Uri.parse(it) } ?: return@mapNotNull null
            MergePiece(n, u, (m["bytes"] as? Number)?.toLong() ?: 0L)
        }

    private fun durationOf(setter: (MediaMetadataRetriever) -> Unit): Long {
        val r = MediaMetadataRetriever()
        try {
            setter(r)
            return (r.extractMetadata(MediaMetadataRetriever.METADATA_KEY_DURATION)?.toLongOrNull() ?: 0L) * 1000
        } finally {
            try { r.release() } catch (_: Exception) {}
        }
    }

    override fun durationUs(p: MergePiece): Long = durationOf { it.setDataSource(context, p.uri!!) }
    override fun durationUsOfFile(f: File): Long = durationOf { it.setDataSource(f.path) }

    override fun freeBytes(): Long = try { StatFs(context.cacheDir.path).availableBytes } catch (_: Exception) { 0L }

    override fun nameTaken(name: String): Boolean {
        if (findFn(listOf(name)).isNotEmpty()) return true
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) return false
        return try {
            context.contentResolver.query(
                MediaStore.Video.Media.EXTERNAL_CONTENT_URI,
                arrayOf(MediaStore.Video.Media._ID),
                "${MediaStore.Video.Media.DISPLAY_NAME} = ?",
                arrayOf(name),
                null,
            )?.use { it.count > 0 } ?: false
        } catch (_: Exception) {
            false
        }
    }

    override fun join(pieces: List<MergePiece>, name: String): File {
        val tmp = File(context.cacheDir, "merge-$name")
        SegmentJoiner.join(context, pieces.map { it.uri!! }, tmp)
        return tmp
    }

    override fun publish(tmp: File, name: String): Long? {
        val size = tmp.length()
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            val resolver = context.contentResolver
            val values = ContentValues().apply {
                put(MediaStore.Video.Media.DISPLAY_NAME, name)
                put(MediaStore.Video.Media.MIME_TYPE, "video/mp4")
                put(MediaStore.Video.Media.RELATIVE_PATH, "Movies/MAXCOM")
                put(MediaStore.Video.Media.IS_PENDING, 1)
            }
            var uri: Uri? = null
            try {
                uri = resolver.insert(MediaStore.Video.Media.EXTERNAL_CONTENT_URI, values) ?: return null
                val copied = resolver.openOutputStream(uri)?.use { out -> tmp.inputStream().use { it.copyTo(out) } } ?: -1L
                if (copied != size) throw java.io.IOException("short copy")
                values.clear()
                values.put(MediaStore.Video.Media.IS_PENDING, 0)
                resolver.update(uri, values, null, null)
                return size
            } catch (_: Exception) {
                uri?.let { try { resolver.delete(it, null, null) } catch (_: Exception) {} }
                // falls through to the app's own folder
            }
        }
        val dir = context.getExternalFilesDir(Environment.DIRECTORY_MOVIES)?.let { File(it, "MAXCOM") } ?: return null
        dir.mkdirs()
        val out = File(dir, name)
        return try {
            tmp.copyTo(out, overwrite = false)
            if (out.length() == size) size else { out.delete(); null }
        } catch (_: Exception) {
            out.delete()
            null
        }
    }

    override fun removePublished(name: String) {
        deleteFn(listOf(name))
    }

    override fun deletePieces(names: List<String>): Int = (deleteFn(names)["skipped"] as? Number)?.toInt() ?: names.size
}
