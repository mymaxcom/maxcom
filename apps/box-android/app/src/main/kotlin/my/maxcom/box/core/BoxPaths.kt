package my.maxcom.box.core

import java.io.File

/**
 * Every path of the "Layout on the box" in one place. [filesDir] is the app-private folder,
 * [nativeLibDir] the read-only folder the system fills with the APK's libraries.
 */
class BoxPaths(val filesDir: File, val nativeLibDir: File) {
    // box/: install root, same shape as C:\Program Files\MAXCOM
    val boxRoot: File = File(filesDir, "box")
    val releases: File = File(boxRoot, "releases")
    val current: File = File(boxRoot, "current")
    val previousTxt: File = File(boxRoot, "previous.txt")
    val boxConfig: File = File(boxRoot, "box-config.json")

    // runtime/
    val runtime: File = File(filesDir, "runtime")
    val runtimeLib: File = File(runtime, "lib")
    val runtimeEtc: File = File(runtime, "etc")
    val certPem: File = File(runtimeEtc, "cert.pem")

    // tools/live/
    val tools: File = File(filesDir, "tools")
    val toolsLive: File = File(tools, "live")
    val mediamtxLink: File = File(File(toolsLive, "mediamtx"), "mediamtx")
    val ffmpegLink: File = File(File(toolsLive, "ffmpeg"), "ffmpeg")
    val versionsMd: File = File(toolsLive, "VERSIONS.md")

    val caDir: File = File(filesDir, "ca")
    val rootCaCopy: File = File(caDir, "root-ca.cer")
    val tmp: File = File(filesDir, "tmp")

    // data/ = SURAU_DATA_DIR
    val data: File = File(filesDir, "data")
    val db: File = File(data, "surau.db")
    val pki: File = File(data, "pki")
    val rootCa: File = File(pki, "root-ca.cer")
    val leafCert: File = File(pki, "box-leaf.cer")
    val boxCaJson: File = File(pki, "box-ca.json")
    val secret: File = File(data, "secret")
    val boxKey: File = File(secret, "box.key")
    val leafKeyPem: File = File(secret, "box-key.pem")
    val logs: File = File(data, "logs")
    val boxLog: File = File(logs, "box.log")
    val certRenewLog: File = File(logs, "cert-renew.log")
    val serviceLog: File = File(logs, "service.log")

    /** The Node executable: the one file the supervisor starts. It lives only in [nativeLibDir]. */
    val nodeBinary: File = File(nativeLibDir, "libnode.so")

    /** Working directory of the child. */
    val workDir: File get() = current

    /** The entry script the child runs. */
    val entryScript: File = File(File(File(File(current, "apps"), "box-server"), "src"), "main.ts")

    /** Native library [apk] name resolved inside [nativeLibDir] (no checking here). */
    fun nativeLib(apk: String): File = File(nativeLibDir, apk)
}
