package my.maxcom.box.core

import java.io.File

/** One [LogFile] per log path for the whole process, so every writer shares the same registered secrets. */
object BoxLogs {
    private val files = HashMap<String, LogFile>()

    @Synchronized
    fun forFile(file: File): LogFile = files.getOrPut(file.absoluteFile.path) { LogFile(file) }
}
