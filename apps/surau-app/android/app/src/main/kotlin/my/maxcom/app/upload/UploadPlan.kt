package my.maxcom.app.upload

import androidx.work.NetworkType

/**
 * The small decisions of the upload worker that need no Android framework, so unit tests reach
 * them: which network a job needs, what the notification says, whether a job fits WorkManager's
 * input data.
 */
object UploadPlan {
    /** `UNMETERED` (Wi-Fi) by default, any network once the person allows mobile data. */
    fun networkType(allowMobile: Boolean): NetworkType =
        if (allowMobile) NetworkType.CONNECTED else NetworkType.UNMETERED

    /** WorkManager refuses input data over 10 KB. */
    const val MAX_INPUT_BYTES = 10_240

    /** Headroom for the keys and the type tags WorkManager adds. */
    fun fitsInput(vararg values: String): Boolean =
        values.sumOf { it.toByteArray(Charsets.UTF_8).size } < MAX_INPUT_BYTES - 512

    /** What the worker does about the joined cache file of a job that was collapsed into it. */
    enum class JoinedFilePlan { USE_FILE, REJOIN, MISSING }

    /**
     * The joined file lives in the cache folder, which Android may purge. [partDone]: the video is
     * already up, the file is no longer needed. [canRejoin]: the original segment files are known
     * (all `android:` sources, none of them the joined file itself).
     */
    fun joinedFilePlan(fileExists: Boolean, partDone: Boolean, canRejoin: Boolean): JoinedFilePlan = when {
        fileExists || partDone -> JoinedFilePlan.USE_FILE
        canRejoin -> JoinedFilePlan.REJOIN
        else -> JoinedFilePlan.MISSING
    }

    fun canRejoin(segments: List<PartSpec>?): Boolean =
        !segments.isNullOrEmpty() && segments.all { it.source.startsWith("android:") && it.source != "android:joined" }

    const val TITLE = "MAXCOM memuat naik rakaman"
    const val CANCEL = "Batal"
    const val CHANNEL_ID = "maxcom_upload"
    const val CHANNEL_NAME = "Muat naik rakaman"

    /**
     * The notification body. It takes numbers only, so no upload URI, token, file name or kuliah
     * title can reach the notification.
     */
    fun notificationText(partIndex: Int, partCount: Int, sentBytes: Long, totalBytes: Long): String {
        val pct = percent(sentBytes, totalBytes)
        return if (partCount > 1) {
            "Bahagian $partIndex daripada $partCount: $pct%"
        } else {
            "$pct%"
        }
    }

    fun percent(sent: Long, total: Long): Int =
        if (total <= 0) 0 else (sent.coerceIn(0, total) * 100 / total).toInt()
}
