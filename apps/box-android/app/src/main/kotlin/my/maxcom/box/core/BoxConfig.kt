package my.maxcom.box.core

import java.io.File
import org.json.JSONException
import org.json.JSONObject

/** Result of reading `box-config.json`: either a usable config or a Bahasa Malaysia message for the start screen. */
sealed class BoxConfigRead {
    data class Ok(val config: BoxConfig) : BoxConfigRead()
    data class Invalid(val message: String) : BoxConfigRead()
}

/** The optional extra environment of the box server. Only [ALLOWED] keys can ever be in [env]. */
class BoxConfig private constructor(val env: Map<String, String>) {
    companion object {
        /** The only keys box-config.json may set (the Launcher contract). */
        val ALLOWED: Set<String> = linkedSetOf(
            "SURAU_ALLOWED_HOSTS",
            "SURAU_ASSETS_MAX_MB",
            "SURAU_FINANCE_PHOTOS_MAX_MB",
            "SURAU_CLOUD_URL",
            "SURAU_WORKER_URL",
        )

        /** Keys the app computes or that would change how the child runs; named in a clearer message. */
        private val FORBIDDEN: Set<String> = setOf(
            "SURAU_ROLE", "SURAU_KIOSK_TOKEN", "NODE_OPTIONS", "LD_LIBRARY_PATH",
        )

        const val MAX_FILE_BYTES = 64 * 1024
        const val MAX_VALUE_CHARS = 2048

        val EMPTY: BoxConfig = BoxConfig(emptyMap())

        /** A missing file is the empty config. */
        fun read(file: File): BoxConfigRead {
            if (!file.exists()) return BoxConfigRead.Ok(EMPTY)
            val text = try {
                if (!file.isFile || file.length() > MAX_FILE_BYTES) {
                    return invalid("fail terlalu besar atau bukan fail biasa")
                }
                file.readText(Charsets.UTF_8)
            } catch (_: java.io.IOException) {
                return invalid("fail tidak dapat dibaca")
            }
            return parse(text)
        }

        fun parse(text: String): BoxConfigRead {
            val root = try {
                JSONObject(text.removePrefix("﻿"))
            } catch (_: JSONException) {
                return invalid("format JSON tidak sah")
            }
            for (key in root.keys()) {
                if (key != "v" && key != "env") return invalid("kunci tidak dikenali: ${shown(key)}")
            }
            val v = root.opt("v")
            if (!(v is Int && v == 1) && !(v is Long && v == 1L)) return invalid("nilai v mesti 1")
            val envObj = when (val e = root.opt("env")) {
                null, JSONObject.NULL -> return BoxConfigRead.Ok(EMPTY)
                is JSONObject -> e
                else -> return invalid("env mesti objek")
            }
            val out = LinkedHashMap<String, String>()
            for (key in envObj.keys()) {
                if (key in FORBIDDEN) return invalid("kunci $key tidak dibenarkan")
                if (key !in ALLOWED) return invalid("kunci tidak dikenali: ${shown(key)}")
                val value = envObj.opt(key)
                if (value !is String) return invalid("nilai $key mesti teks")
                if (value.length > MAX_VALUE_CHARS) return invalid("nilai $key terlalu panjang")
                if (value.any { it == '\n' || it == '\r' || it == '\u0000' }) {
                    return invalid("nilai $key mengandungi baris baharu atau aksara kosong")
                }
                out[key] = value
            }
            return BoxConfigRead.Ok(BoxConfig(out))
        }

        private fun invalid(why: String) = BoxConfigRead.Invalid("GAGAL: box-config.json tidak sah, $why")

        /** A key from a file is shown in an error only when it is short and printable. */
        private fun shown(key: String): String =
            if (key.length <= 40 && key.all { it in ' '..'~' }) key else "(tidak boleh dipaparkan)"
    }
}
