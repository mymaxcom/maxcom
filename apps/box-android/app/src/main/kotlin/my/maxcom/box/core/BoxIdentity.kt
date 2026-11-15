package my.maxcom.box.core

import java.io.File
import java.io.IOException
import java.security.MessageDigest

/** The public box id the box server derives from its master key: first 16 hex of sha256 of the 32 key bytes. */
object BoxIdentity {
    private const val KEY_BYTES = 32

    /** The id, or null when the key file is missing or not exactly 32 bytes (the server makes it on its first start). */
    fun boxId(keyFile: File): String? {
        if (!keyFile.isFile || keyFile.length() != KEY_BYTES.toLong()) return null
        val key = try { keyFile.readBytes() } catch (e: IOException) { return null }
        if (key.size != KEY_BYTES) return null
        return BoxCa.bytesToHex(MessageDigest.getInstance("SHA-256").digest(key)).substring(0, 16)
    }

    /** First 16 hex of the root's sha256 (the QR `caSha256` prefix), or null for an empty input. */
    fun caShort(rootDer: ByteArray?): String? = rootDer?.takeIf { it.isNotEmpty() }?.let { BoxCa.sha256Hex(it).substring(0, 16) }
}
