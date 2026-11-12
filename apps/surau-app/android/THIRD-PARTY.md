# Third-party code in the Android build

## RootEncoder (live publisher)

| | |
|---|---|
| Library | RootEncoder, `com.github.pedroSG94.RootEncoder:library` |
| Version (pinned) | 2.8.1 (tag `2.8.1`, released 2026-09-01) |
| Licence | Apache License 2.0 (GitHub licence field `Apache-2.0`; each source file carries the Apache-2.0 header) |
| Source | https://github.com/pedroSG94/RootEncoder |
| Where it is published | JitPack (`https://jitpack.io`), not Maven Central. `android/build.gradle.kts` adds the repository with a content filter that allows only the group `com.github.pedroSG94.RootEncoder`, so no other dependency can resolve from JitPack. |
| Used by | `app/src/main/kotlin/my/maxcom/app/live/` (`LiveEngine`, `LiveService`, `LiveChannel`, `PreviewView`) |
| Pulled in transitively | its own modules `common`, `encoder`, `rtmp`, `rtsp`, `srt`, `udp`, `whip` (same licence, same repository) and `kotlinx-coroutines-android` (Apache-2.0) |

Apache-2.0 allows use, modification and redistribution in a closed application provided the licence text and notices travel with the distribution. The licence text is at https://www.apache.org/licenses/LICENSE-2.0 and inside the library's AAR.

### API facts the plugin relies on (checked against 2.8.1, 2026-11-04)

- **Two simultaneous outputs from one encoder:** `com.pedro.library.multiple.MultiStream` takes one list of `ConnectChecker` per protocol and feeds every connected client from the same video and audio encoder callbacks. The plugin builds it with one RTMP client (YouTube, RTMPS) and one SRT client (kiosk). `GenericStream` supports only one connection at a time, so it is not used. MultiStream is marked "Experiment class" by its author; it is the reason Plan 10 spike S4 (30 min, both outputs, one phone) matters.
- **Independent reconnect:** each client has its own `StreamBaseClient.setReTries` and `reTry(delay, reason)`; the plugin applies its own backoff (2, 4, 8, 16, 30 s, then 30 s) per leg and sets the retry count to the maximum.
- **Recording:** `StreamBase.startRecord(path, tracks, listener)` takes a file path, not a MediaStore URI or file descriptor. The plugin records each segment into the app's own `Movies/MAXCOM` folder, then copies it into the shared `Movies/MAXCOM` collection with `MediaStore` (Android 10 and later) and removes the private copy only after the copy has the same size. Below Android 10 the segments stay in the app's folder.
- **SRT:** the caller URL is `srt://host:port?streamid=...&passphrase=...`; RootEncoder requires a passphrase of 10 to 79 characters when one is set.
- **Cellular for the YouTube leg (builder's call 10): not possible in 2.8.1.** The public client API (`setSocketType`, `setSocketTimeout`, `setDelay`) does not expose the socket or a `SocketFactory`, so `Network.bindSocket` cannot be applied. The YouTube leg therefore uses the phone's current network (Wi-Fi at the surau). Deferred.

- **Orientation: always upright 16:9 1280x720 in all four device orientations (operator decision 2026-11-05; third rewrite after the 15:xx real-device test), read from the 2.8.1 binaries (no sources ship; checked with `javap`).**
  - **What the two failed attempts taught.** The build with RootEncoder's default handling (b60e08a) was upright whenever the phone was landscape and only portrait was wrong (the full portrait frame was stretched into the 16:9 buffer). The next build (a5b9d27) replaced RootEncoder's camera turn with our own maths (`setCameraOrientation(0)` plus `setStreamRotation/setPreviewRotation(sensor - display)`) and was wrong in every orientation, because the camera frame reaches RootEncoder already corrected by the camera's `SurfaceTexture` transform for the natural orientation; adding the sensor angle turned it a second time. RootEncoder's own camera pass is right; only the portrait shape needed our help. The own rotation maths is gone.
  - `prepareVideo(w, h, ..., rotation)`: always `LiveLogic.PREPARE_ROTATION` = 0, so the encoder stays 1280x720 (90 or 270 would swap it to 720x1280). It throws while streaming, recording or previewing, so the size cannot change mid-live.
  - Calls on `MultiStream.getGlInterface()` (a `GlStreamInterface`); all are plain field writes read on the next frame, so a turn mid-live changes neither the encoder nor the connections:
    - `forceOrientation(OrientationForced.NONE)`: sets the camera-pass orientation from the display rotation (`CameraHelper.getCameraOrientation`: 0 gives 270, otherwise value minus 90) and sets `shouldHandleOrientation`. Called again on every display change, which is what makes a turn mid-live work. `PORTRAIT` and `LANDSCAPE` would pin one angle and are not used.
    - `autoHandleOrientation = true`: starts RootEncoder's `SensorRotationManager` (an `OrientationEventListener`) with the start of the GL; it calls `setCameraOrientation` and `setIsPortrait` with the same values. In 2.8.1 the manager is built with `followUI = true`, so it only accepts a sensor angle that equals the UI orientation; it therefore never leads the display, and it cannot help when the screen is locked (nothing then changes the UI orientation). The engine's `DisplayListener` is the reliable trigger; the sensor handler is a harmless second source of identical values.
    - `setIsPortrait(b)`: true for display rotation 0 and 180 (`LiveLogic.isPortrait`). It selects the portrait branch of the preview aspect maths and of the default encoder viewport.
    - `setAspectRatioMode(AspectRatioMode.Fill)`: the preview draw (`ScreenRender.drawPreview`) uses it, with the stream size swapped when portrait, so the preview crops to fill the view and shows the same centred 16:9 band as the output. Only the preview uses the aspect mode: the encoder draw (`drawEncoder`) takes only `isPortrait`, and in portrait that pillarboxes (a narrow centred picture). There is no fill mode for the stream.
    - `setStreamViewPort(vp)`: therefore, for the stream (SRT, RTMPS and the MP4 recording), when portrait the viewport is the upright 9:16 picture scaled to the full width and centred (`LiveLogic.cropViewport`), so only the centred 16:9 band is inside the 1280x720 surface; null (RootEncoder's default full viewport) in landscape.
    - Not called any more: `setCameraOrientation(0)`, `setStreamRotation`, `setPreviewRotation`, `setPreviewViewPort`. Neither camera is mirrored (no flip is set; the flips default to false and the raw front frame is not mirrored).
  - Why this combination: the encoder stays fixed landscape 1280x720; RootEncoder rotates in its GL camera pass (full-resolution frame, no maths of ours); the crop is the one thing RootEncoder lacks for the stream, done with one viewport, and the preview gets the same result from its native Fill mode.
  - **Stop safety.** `OrientationGuard` is closed until a session is prepared, paused during `stop()` and closed on release; `applyFraming` returns at once when it is not open and never throws (it logs the exception type only). `stop()` unregisters the display listener first, finishes the recording (`stopRecord`, so the MP4 gets its moov) before the outputs stop, and re-arms the listener afterwards only when the session is still prepared; `release()` closes the guard first and the recorder is finished before the GL and the camera are released.
  - **Diagnostic line**, once at start and whenever it changes: `Log.i("MaxcomLive", "orientation display=<0|90|180|270> camera=<RootEncoder camera orientation> sensor=<SENSOR_ORIENTATION> facing=<back|front> aspect=Fill enc=1280x720")`. No URL, key, passphrase or stream id.
  - To prove on a real phone: upright in all four orientations, both cameras, turned mid-live, portrait showing the centred 16:9 band in the preview and the output. If a landscape is upside down, the fault would be in RootEncoder's `camera` value shown in the log line, not in engine maths.

### Secrets

The stream key and the SRT passphrase reach the plugin once, inside the `start` call, and live only inside the connect string of the running clients. The plugin does not log, persist or show them (the foreground notification says only `MAXCOM sedang bersiaran`). Engine events carry reason codes (`connect_failed`, `auth_failed`, `storage_low`), never URLs.

## WorkManager (catch-up upload worker)

| | |
|---|---|
| Library | AndroidX WorkManager, `androidx.work:work-runtime-ktx` |
| Version (pinned) | 2.9.1 |
| Licence | Apache License 2.0 |
| Source | https://developer.android.com/jetpack/androidx/releases/work |
| Where it is published | Google Maven (`google()`), already a repository of the build |
| Used by | `app/src/main/kotlin/my/maxcom/app/upload/` (`UploadWorker`, `UploadChannel`) |
| Test scope | `org.json:json:20240303` (`testImplementation` only; org.json is a stub in Android unit tests). Not in the APK. |

Why this one: it is the platform's own way to run a resumable upload in the background with `NetworkType.UNMETERED` (Wi-Fi) or `CONNECTED` (mobile data allowed) constraints and retry while the app is closed, and it persists the request across an app kill and a reboot. No other library is added: the worker speaks plain HTTPS (`HttpsURLConnection`) and joins segments with the platform's `MediaExtractor` and `MediaMuxer`.

### Secrets in the upload worker (builder's call 8, for the security reviewer)

- The session token, the cloud base URL and the cloud root CA reach the worker through WorkManager's input data (Android keeps it in its own app-private database) for the life of the job. The input data is limited to 10 KB; `UploadPlan.fitsInput` refuses a job that does not fit (`job_too_large`).
- The YouTube resumable session URI is a bearer secret. It is held in memory, in the Dart local store's `uploads` collection (Keystore-sealed on Android) and in the worker's private preferences `maxcom_upload_state` (so a WorkManager retry resumes instead of beginning a new session). It is removed from the Dart job when the part is done; the worker's saved state is cleared by `forget` when the app has seen the job finish or the person removes the job.
- Neither the token nor the URI is written to `Log`, to the notification (numbers only: `Bahagian 2 daripada 4: 35%`) or to an error sent to Dart (reason codes only). The generated `toString` of the job and event classes is overridden to leave the URI out.
- The recordings are only read. Nothing in the upload package deletes, moves or renames a file in `Movies/MAXCOM`; the only file it deletes is its own joined copy in `cacheDir/maxcom-upload/`, after a successful upload.
