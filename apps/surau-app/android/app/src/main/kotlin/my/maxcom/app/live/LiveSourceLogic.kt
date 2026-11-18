package my.maxcom.app.live

import kotlin.math.abs
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt

/* Pure rules of the source wiring (plan rev 4, 4.5; task K2). No Android classes: LiveEngine, LiveChannel and the unit
   tests share them. Nothing here ever holds a camera address: only [ExternalCamera] does, and it prints masked. */

/** The picture source of a live: the phone's own camera, or the external camera the phone pulls over RTSP. */
enum class VideoKind(val wire: String) {
    PHONE("phone"),
    EXTERNAL("external");

    companion object {
        fun parse(s: String?): VideoKind = if (s == "external") EXTERNAL else PHONE
    }
}

/** One entry of the audio mix as the screen sends it: on or off, a volume 0 to 100 in steps of 5. */
class MixEntry(val enabled: Boolean, val volume: Int)

/** Twin of core `LiveAudioMix`: `{camera, deviceMic, boxInput}`, each `{enabled, volume}`. */
class AudioMixCfg(val camera: MixEntry, val deviceMic: MixEntry, val boxInput: MixEntry) {
    companion object {
        /** First use: the phone camera with its microphone; the external camera with its own audio. */
        fun default(video: VideoKind) = AudioMixCfg(
            MixEntry(video == VideoKind.EXTERNAL, 100),
            MixEntry(video == VideoKind.PHONE, 100),
            MixEntry(false, 100),
        )

        fun clampVolume(v: Int): Int = ((v.coerceIn(0, 100) + 2) / 5) * 5

        /** Never throws: a bad part falls back to the default. */
        fun fromMap(m: Map<*, *>?, video: VideoKind): AudioMixCfg {
            val d = default(video)
            fun entry(key: String, fallback: MixEntry): MixEntry {
                val e = m?.get(key) as? Map<*, *> ?: return fallback
                val on = e["enabled"] as? Boolean ?: fallback.enabled
                val vol = (e["volume"] as? Number)?.toInt()?.let { clampVolume(it) } ?: fallback.volume
                return MixEntry(on, vol)
            }
            return AudioMixCfg(entry("camera", d.camera), entry("deviceMic", d.deviceMic), entry("boxInput", d.boxInput))
        }
    }
}

/** The external camera's address (the full RTSP address; it may hold the login). Held in memory only; prints masked. */
class ExternalCamera(val url: String, val transport: TransportMode) {
    override fun toString(): String = "ExternalCamera(${RtspMask.maskUrl(url)}, ${transport.name.lowercase()})"
}

/** What `prepare` and `setSource` are told about the picture and the sound. */
class SourceSpec(
    val video: VideoKind,
    val camera: ExternalCamera?,
    val mix: AudioMixCfg,
    /** The fixed offset ("Imbangan masa audio"), used only when the camera has no audio track. */
    val avOffsetMs: Int = 0,
)

/** What the engine applies to the phone mixer. */
class MixSettings(
    val cameraVolume: Int,
    val micEnabled: Boolean,
    val micVolume: Int,
    /** "Mic-in only": the phone still sends its reference sound at full level so the box can align (4.5 item 8). */
    val referenceForced: Boolean,
)

object SourceLogic {
    /**
     * The spec from the channel arguments: `source` = `{kind, url, transport}`, `mix` = the audio mix map,
     * `avOffsetMs` = the fallback offset. Never throws. An external kind with no usable address comes back with a null
     * camera (the engine answers `camera_source_missing`). The address is only carried, never logged.
     */
    fun specFrom(source: Map<*, *>?, mix: Map<*, *>?, avOffsetMs: Number?): SourceSpec {
        val kind = VideoKind.parse(source?.get("kind") as? String)
        val url = (source?.get("url") as? String)?.trim()?.takeIf { it.isNotEmpty() }
        val cam = if (kind == VideoKind.EXTERNAL && url != null) {
            ExternalCamera(url, TransportMode.parse(source?.get("transport") as? String))
        } else {
            null
        }
        return SourceSpec(kind, cam, AudioMixCfg.fromMap(mix, kind), ClapPlan.clampOffset(avOffsetMs?.toInt() ?: 0))
    }

    /** A lost camera stops the live after this long (4.5 item 6). */
    const val LOST_STOP_MS = 10L * 60 * 1000

    /** Reason code of the `ended` event when the lost camera ended the live. */
    const val ENDED_CAMERA_LOST = "camera_lost"

    /** The words drawn into the stream while the camera is lost. */
    const val LOST_MESSAGE = "Siaran akan bersambung sebentar lagi"

    /**
     * The phone-side mixer settings for an external-camera live.
     *
     * With "Mic-in pada kotak" added and every phone-side sound at volume 0, the camera sound (the reference) is sent at
     * full level anyway: the box aligns Mic-in against it and mutes it after the alignment tap. A camera with no audio
     * track has no reference, so nothing is forced then.
     */
    fun mixSettings(cfg: AudioMixCfg, cameraHasAudio: Boolean = true): MixSettings {
        val camAudible = cfg.camera.enabled && cameraHasAudio && cfg.camera.volume > 0
        val micAudible = cfg.deviceMic.enabled && cfg.deviceMic.volume > 0
        val micInOnly = cfg.boxInput.enabled && !camAudible && !micAudible && cameraHasAudio
        return MixSettings(
            cameraVolume = if (micInOnly) 100 else cfg.camera.volume,
            micEnabled = cfg.deviceMic.enabled,
            micVolume = cfg.deviceMic.volume,
            referenceForced = micInOnly,
        )
    }

    /**
     * The phone-camera mute with "Mic-in only": the phone microphone is the reference then, so it is not muted while
     * Mic-in is added (the user's mute is remembered and applies again when Mic-in is removed).
     */
    fun effectiveMuted(userMuted: Boolean, cfg: AudioMixCfg): Boolean = userMuted && !cfg.boxInput.enabled

    /**
     * While the camera is lost and the added microphone has never been aligned, the hold-out rule would keep the
     * microphone silent against a camera sound that is not there. The camera volume is then 0 so the microphone plays;
     * the user's volume returns with the camera.
     */
    fun effectiveCameraVolume(userVolume: Int, linkLost: Boolean, micEnabled: Boolean, micAligned: Boolean): Int =
        if (linkLost && micEnabled && !micAligned) 0 else userVolume

    /** True when a camera lost since [lostSinceMs] (epoch ms, 0 = not lost) has been lost for [limitMs] or more. */
    fun lostExpired(lostSinceMs: Long, nowMs: Long, limitMs: Long = LOST_STOP_MS): Boolean =
        lostSinceMs > 0 && nowMs - lostSinceMs >= limitMs

    /**
     * Where the 10 minutes start: when the camera was lost, but never before the live began (a live started with an
     * unreachable camera counts from its own start). 0 while the camera is not lost.
     */
    fun lostBase(lostSinceMs: Long, liveStartedMs: Long): Long = if (lostSinceMs <= 0) 0 else max(lostSinceMs, liveStartedMs)

    /** Whole seconds a camera has been lost (0 when it is not). */
    fun lostSeconds(lostSinceMs: Long, nowMs: Long): Int =
        if (lostSinceMs <= 0 || nowMs < lostSinceMs) 0 else ((nowMs - lostSinceMs) / 1000).toInt()

    /**
     * The GL viewport [x, y, w, h] that shows a [srcW] x [srcH] picture undistorted inside a [dstW] x [dstH] surface
     * (bars at the sides or the top). The camera picture is kept in its own shape in the SurfaceTexture (see
     * [LiveEngine]), the GL pass fills the frame with it and this viewport shrinks that frame back, so the picture is
     * never stretched. Null when the shapes already match (within 1%) or a size is unknown.
     */
    fun letterbox(srcW: Int, srcH: Int, dstW: Int, dstH: Int): IntArray? {
        if (srcW <= 0 || srcH <= 0 || dstW <= 0 || dstH <= 0) return null
        val src = srcW.toDouble() / srcH
        val dst = dstW.toDouble() / dstH
        if (abs(src - dst) / dst < 0.01) return null
        return if (src < dst) {
            val w = (dstH * src).roundToInt().coerceIn(1, dstW)
            intArrayOf((dstW - w) / 2, 0, w, dstH)
        } else {
            val h = (dstW / src).roundToInt().coerceIn(1, dstH)
            intArrayOf(0, (dstH - h) / 2, dstW, h)
        }
    }

    /** Wire form of a link state for the Dart side. */
    fun linkWire(s: CameraLinkState): String = s.name.lowercase()

    /** The `camera` part of an audio event. [hasAudio] is null until the camera's format is known. */
    fun cameraStatus(
        link: CameraLinkState,
        hasAudio: Boolean?,
        lostSec: Int,
        transport: RtspTransport?,
        width: Int,
        height: Int,
    ): Map<String, Any?> = mapOf(
        "link" to linkWire(link),
        "hasAudio" to hasAudio,
        "lostSec" to lostSec,
        "transport" to transport?.name?.lowercase(),
        "width" to width,
        "height" to height,
    )

    private fun level2(v: Float): Double = (v.coerceIn(0f, 1f) * 100).roundToInt() / 100.0

    /** One row of the `sources` list. [align] is only given for an added source. */
    fun sourceRow(
        id: String,
        enabled: Boolean,
        volume: Int,
        level: Float,
        state: String,
        align: Map<String, Any?>? = null,
    ): Map<String, Any?> {
        val m = linkedMapOf<String, Any?>(
            "id" to id, "enabled" to enabled, "volume" to volume, "level" to level2(level), "state" to state,
        )
        if (align != null) m["align"] = align
        return m
    }

    fun alignInfo(state: AlignState, delayMs: Int, residualMs: Double?): Map<String, Any?> =
        mapOf("state" to state.wire, "delayMs" to delayMs, "residualMs" to residualMs?.let { (it * 10).roundToInt() / 10.0 })

    /** The periodic audio and camera event (4.7: per-source meters and alignment state). */
    fun audioEvent(
        sources: List<Map<String, Any?>>,
        mixed: Float,
        camera: Map<String, Any?>?,
        micFailed: Boolean,
    ): Map<String, Any?> = mapOf(
        "type" to "audio", "sources" to sources, "mixed" to level2(mixed), "camera" to camera, "micFailed" to micFailed,
    )

    /** A row's state: lost when its source is gone, silent when nothing was heard for a while, else ok. */
    fun sourceState(lost: Boolean, silent: Boolean): String = when {
        lost -> "lost"
        silent -> "silent"
        else -> "ok"
    }
}

/** True when no sound above [threshold] was heard during the last [silentAfterMs]. */
class SilenceTracker(private val threshold: Float = 0.003f, private val silentAfterMs: Long = 3000) {
    private var lastLoud = -1L
    private var first = -1L

    fun update(level: Float, nowMs: Long): Boolean {
        if (first < 0) first = nowMs
        if (level >= threshold) lastLoud = nowMs
        val since = if (lastLoud < 0) first else lastLoud
        return nowMs - since >= silentAfterMs
    }

    fun reset() {
        lastLoud = -1
        first = -1
    }
}

/** MSB-first bit reader for parameter sets (emulation prevention bytes are removed by [SpsSize]). */
class BitReader(private val d: ByteArray) {
    private var pos = 0

    fun bits(n: Int): Int {
        var v = 0
        repeat(n) { v = (v shl 1) or bit() }
        return v
    }

    fun bit(): Int {
        val byte = pos ushr 3
        if (byte >= d.size) throw IndexOutOfBoundsException("sps_end")
        val b = (d[byte].toInt() shr (7 - (pos and 7))) and 1
        pos++
        return b
    }

    fun skip(n: Int) {
        pos += n
    }

    /** Unsigned Exp-Golomb. */
    fun ue(): Int {
        var zeros = 0
        while (bit() == 0) {
            zeros++
            if (zeros > 31) throw IndexOutOfBoundsException("bad_ue")
        }
        return if (zeros == 0) 0 else ((1L shl zeros) - 1 + bits(zeros).toLong()).toInt()
    }

    /** Signed Exp-Golomb. */
    fun se(): Int {
        val k = ue()
        return if (k and 1 == 1) (k + 1) / 2 else -(k / 2)
    }
}

/** Reads the picture size from an H.264 or H.265 SPS, so a camera that is not 16:9 can be shown undistorted. */
object SpsSize {
    /** [sps] may start with a start code. Returns (width, height) after cropping, or null when it cannot be read. */
    fun parse(sps: ByteArray?, h265: Boolean): Pair<Int, Int>? {
        if (sps == null || sps.size < 6) return null
        return try {
            val r = BitReader(unescape(sps, headerEnd(sps), if (h265) 2 else 1))
            if (h265) parseH265(r) else parseH264(r)
        } catch (_: RuntimeException) {
            null
        }
    }

    private fun headerEnd(d: ByteArray): Int {
        if (d.size > 4 && d[0] == 0.toByte() && d[1] == 0.toByte() && d[2] == 0.toByte() && d[3] == 1.toByte()) return 4
        if (d.size > 3 && d[0] == 0.toByte() && d[1] == 0.toByte() && d[2] == 1.toByte()) return 3
        return 0
    }

    /** The payload after [skipHeader] bytes of the NAL header, with the 00 00 03 emulation prevention removed. */
    private fun unescape(d: ByteArray, from: Int, skipHeader: Int): ByteArray {
        val out = java.io.ByteArrayOutputStream(d.size)
        var zeros = 0
        var i = from + skipHeader
        while (i < d.size) {
            val b = d[i].toInt() and 0xFF
            if (zeros >= 2 && b == 3) {
                zeros = 0
                i++
                continue
            }
            out.write(b)
            zeros = if (b == 0) zeros + 1 else 0
            i++
        }
        return out.toByteArray()
    }

    private fun skipScalingList(r: BitReader, size: Int) {
        var last = 8
        var next = 8
        for (j in 0 until size) {
            if (next != 0) {
                val delta = r.se()
                next = (last + delta + 256) % 256
            }
            last = if (next == 0) last else next
        }
    }

    private fun parseH264(r: BitReader): Pair<Int, Int> {
        val profile = r.bits(8)
        r.skip(16) // constraint flags and level
        r.ue() // sps id
        var chroma = 1
        if (profile in HIGH_PROFILES) {
            chroma = r.ue()
            if (chroma == 3) r.skip(1)
            r.ue()
            r.ue()
            r.skip(1)
            if (r.bit() == 1) {
                for (i in 0 until (if (chroma != 3) 8 else 12)) {
                    if (r.bit() == 1) skipScalingList(r, if (i < 6) 16 else 64)
                }
            }
        }
        r.ue() // log2_max_frame_num_minus4
        when (r.ue()) { // pic_order_cnt_type
            0 -> r.ue()
            1 -> {
                r.skip(1)
                r.se()
                r.se()
                val n = r.ue()
                repeat(n) { r.se() }
            }
        }
        r.ue() // max_num_ref_frames
        r.skip(1)
        val wMbs = r.ue() + 1
        val hMapUnits = r.ue() + 1
        val frameMbsOnly = r.bit()
        if (frameMbsOnly == 0) r.skip(1)
        r.skip(1) // direct_8x8_inference
        var cl = 0
        var cr = 0
        var ct = 0
        var cb = 0
        if (r.bit() == 1) {
            cl = r.ue()
            cr = r.ue()
            ct = r.ue()
            cb = r.ue()
        }
        val cropX = if (chroma == 0 || chroma == 3) 1 else 2
        val cropY = (if (chroma == 1) 2 else 1) * (2 - frameMbsOnly)
        val w = wMbs * 16 - cropX * (cl + cr)
        val h = (2 - frameMbsOnly) * hMapUnits * 16 - cropY * (ct + cb)
        return if (w > 0 && h > 0) w to h else throw IndexOutOfBoundsException("size")
    }

    private fun parseH265(r: BitReader): Pair<Int, Int> {
        r.skip(4) // vps id
        val maxSub = r.bits(3)
        r.skip(1)
        r.skip(96) // general profile, tier, level
        val profilePresent = BooleanArray(8)
        val levelPresent = BooleanArray(8)
        for (i in 0 until maxSub) {
            profilePresent[i] = r.bit() == 1
            levelPresent[i] = r.bit() == 1
        }
        if (maxSub > 0) r.skip(2 * (8 - maxSub))
        for (i in 0 until maxSub) {
            if (profilePresent[i]) r.skip(88)
            if (levelPresent[i]) r.skip(8)
        }
        r.ue() // sps id
        val chroma = r.ue()
        if (chroma == 3) r.skip(1)
        var w = r.ue()
        var h = r.ue()
        if (r.bit() == 1) {
            val l = r.ue()
            val rt = r.ue()
            val t = r.ue()
            val b = r.ue()
            val subW = if (chroma == 1 || chroma == 2) 2 else 1
            val subH = if (chroma == 1) 2 else 1
            w -= subW * (l + rt)
            h -= subH * (t + b)
        }
        return if (w > 0 && h > 0) w to h else throw IndexOutOfBoundsException("size")
    }

    private val HIGH_PROFILES = setOf(100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135)
}

/** The fallback "Imbangan masa audio" and its clap test: pure parts. */
object ClapPlan {
    /** The captured clip is about this long (4.3a). */
    const val CAPTURE_MS = 5000L

    /** Same range as core `AV_OFFSET_MAX_MS` and its steps of 50. */
    const val OFFSET_MAX_MS = 2000
    const val OFFSET_STEP_MS = 50

    fun clampOffset(ms: Int): Int = (min(OFFSET_MAX_MS, max(0, ms)) + OFFSET_STEP_MS / 2) / OFFSET_STEP_MS * OFFSET_STEP_MS

    /**
     * The clip is captured with the microphone at offset 0 (picture late, sound early). Replaying it with the sound
     * started [offsetMs] after the picture shows what the live will look like with that offset.
     */
    fun soundStartDelayMs(offsetMs: Int): Long = clampOffset(offsetMs).toLong()
}
