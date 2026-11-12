package my.maxcom.app.upload

import android.content.Context
import android.media.MediaCodec
import android.media.MediaExtractor
import android.media.MediaFormat
import android.media.MediaMuxer
import android.net.Uri
import java.io.File
import java.nio.ByteBuffer

/** One sample read from a segment: [track] indexes the segment's own track list. */
class JoinSample(val track: Int, val ptsUs: Long, val flags: Int, val size: Int)

/** A recorded segment, read sample by sample. */
interface SegmentSource {
    /** Per track: the mime (`video/avc`, `audio/mp4a-latm`) and an opaque format object. */
    val tracks: List<Pair<String, Any?>>

    /** Reads the next sample into [buf] (cleared by the reader); null at the end. */
    fun next(buf: ByteBuffer): JoinSample?

    fun close()
}

/** The joined file being written. */
interface JoinSink {
    /** Adds an output track; returns its index. */
    fun addTrack(mime: String, format: Any?): Int
    fun start()
    fun write(track: Int, buf: ByteBuffer, size: Int, ptsUs: Long, flags: Int)
    fun stop()
}

class JoinMismatch : Exception("segment tracks differ")

/**
 * Joins segments end to end without re-encoding: every sample of segment N is copied with its
 * timestamp shifted by the running duration of segments 1..N-1 (Plan 6 Task 10). The logic works
 * on [SegmentSource] and [JoinSink], so unit tests drive it with synthetic samples; the Android
 * classes below plug `MediaExtractor` and `MediaMuxer` into it.
 */
object JoinCore {
    /** Returns the total duration in microseconds. */
    fun join(sources: List<SegmentSource>, sink: JoinSink, bufferBytes: Int = 1 shl 20): Long {
        require(sources.isNotEmpty())
        val first = sources[0].tracks
        val outTracks = first.map { (mime, fmt) -> sink.addTrack(mime, fmt) }
        sink.start()
        val buf = ByteBuffer.allocate(bufferBytes)
        var offset = 0L
        for (src in sources) {
            if (src.tracks.map { it.first } != first.map { it.first }) throw JoinMismatch()
            val maxPts = LongArray(first.size) { -1L }
            val lastPts = LongArray(first.size) { -1L }
            val minDelta = LongArray(first.size) { Long.MAX_VALUE }
            while (true) {
                buf.clear()
                val s = src.next(buf) ?: break
                val t = s.track
                val d = s.ptsUs - lastPts[t]
                if (lastPts[t] >= 0 && d > 0 && d < minDelta[t]) minDelta[t] = d
                lastPts[t] = s.ptsUs
                if (s.ptsUs > maxPts[t]) maxPts[t] = s.ptsUs
                buf.position(0)
                buf.limit(s.size)
                sink.write(outTracks[t], buf, s.size, s.ptsUs + offset, s.flags)
            }
            // The segment lasts until the last sample plus one sample's length.
            var segEnd = 0L
            for (t in first.indices) {
                if (maxPts[t] < 0) continue
                val delta = if (minDelta[t] == Long.MAX_VALUE) 0L else minDelta[t]
                segEnd = maxOf(segEnd, maxPts[t] + delta)
            }
            offset += segEnd
            src.close()
        }
        sink.stop()
        return offset
    }
}

/** Android: [MediaExtractor] over a content URI or a file. */
class ExtractorSource(context: Context, uri: Uri) : SegmentSource {
    private val ex = MediaExtractor()
    private val selected = ArrayList<Int>()

    init {
        ex.setDataSource(context, uri, null)
        for (i in 0 until ex.trackCount) {
            val f = ex.getTrackFormat(i)
            val mime = f.getString(MediaFormat.KEY_MIME) ?: continue
            if (mime.startsWith("video/") || mime.startsWith("audio/")) {
                ex.selectTrack(i)
                selected.add(i)
            }
        }
    }

    override val tracks: List<Pair<String, Any?>>
        get() = selected.map { i ->
            val f = ex.getTrackFormat(i)
            (f.getString(MediaFormat.KEY_MIME) ?: "") to f
        }

    override fun next(buf: ByteBuffer): JoinSample? {
        val size = ex.readSampleData(buf, 0)
        if (size < 0) return null
        val track = selected.indexOf(ex.sampleTrackIndex)
        val s = JoinSample(track, ex.sampleTime, ex.sampleFlags, size)
        ex.advance()
        return s
    }

    override fun close() = ex.release()
}

/** Android: [MediaMuxer] writing an MP4 file. */
class MuxerSink(outFile: File) : JoinSink {
    private val muxer = MediaMuxer(outFile.path, MediaMuxer.OutputFormat.MUXER_OUTPUT_MPEG_4)
    private val info = MediaCodec.BufferInfo()

    override fun addTrack(mime: String, format: Any?) = muxer.addTrack(format as MediaFormat)
    override fun start() = muxer.start()

    override fun write(track: Int, buf: ByteBuffer, size: Int, ptsUs: Long, flags: Int) {
        info.set(0, size, ptsUs, flags)
        muxer.writeSampleData(track, buf, info)
    }

    override fun stop() {
        muxer.stop()
        muxer.release()
    }
}

object SegmentJoiner {
    /**
     * Joins [uris] into [outFile]. Returns the joined duration in microseconds. Throws on any
     * failure (the worker then uploads the segments one by one and reports `join_failed`); a
     * half-written output is deleted.
     */
    fun join(context: Context, uris: List<Uri>, outFile: File): Long {
        outFile.parentFile?.mkdirs()
        if (outFile.exists()) outFile.delete()
        val sources = ArrayList<SegmentSource>()
        try {
            for (u in uris) sources.add(ExtractorSource(context, u))
            return JoinCore.join(sources, MuxerSink(outFile))
        } catch (e: Exception) {
            outFile.delete()
            throw e
        } finally {
            for (s in sources) try { s.close() } catch (_: RuntimeException) {}
        }
    }
}
