// The publisher seam of the Live tab (Plan 5): one capture, one preview,
// the kiosk leg and the optional YouTube leg, and a recorder that runs
// beside them. Two implementations follow in later tasks (web: WHIP from
// Safari or Chrome; Android: the in-repo RootEncoder plugin); the screen
// only ever sees this interface and the immutable [PublisherState] it
// streams. The stream key and passphrase in [PublisherTargets] live in
// memory only and are never logged.

import 'package:flutter/widgets.dart';

import '../shell/live_camera_gateway.dart' show LiveAudioMix;

/// Where the publisher is in one session.
enum PublisherPhase {
  idle,
  preparing,
  ready,
  starting,
  live,
  stopping,
  stopped,
  error,
}

/// One output leg's health.
enum OutputPhase { connecting, up, retrying, down }

class OutputState {
  const OutputState(this.phase, {this.retryInSec, this.message});

  static const OutputState connecting = OutputState(OutputPhase.connecting);
  static const OutputState up = OutputState(OutputPhase.up);
  static const OutputState down = OutputState(OutputPhase.down);

  final OutputPhase phase;

  /// Seconds to the next attempt while [OutputPhase.retrying].
  final int? retryInSec;

  /// A reason code from the engine (never a key or URL).
  final String? message;
}

class PublisherOutputs {
  const PublisherOutputs({this.kiosk, this.youtube});

  static const PublisherOutputs none = PublisherOutputs();

  /// The kiosk leg (to the box); null before the first connect.
  final OutputState? kiosk;

  /// The YouTube leg; null when it is not used in this session.
  final OutputState? youtube;
}

class RecordingState {
  const RecordingState({
    this.on = false,
    this.segments = 0,
    this.bytes = 0,
    this.lastError,
  });

  static const RecordingState off = RecordingState();

  final bool on;
  final int segments;
  final int bytes;
  final String? lastError;
}

class StreamStats {
  const StreamStats({
    this.bitrateKbps = 0,
    this.fps = 0,
    this.rttMs,
    this.dropped = 0,
  });

  static const StreamStats zero = StreamStats();

  final int bitrateKbps;
  final int fps;
  final int? rttMs;
  final int dropped;
}

/// What the device itself warns about while live.
enum Warning { lowBattery, hot, screenLockRisk, lowStorage, noInternet }

// ---- The external camera and the audio mix on the phone (plan rev 4, task K2).
// All of it is additive: a publisher that knows nothing of it keeps the
// defaults (phone camera, no camera link, no audio rows).

/// The picture source of a live.
enum VideoSourceKind { phone, external }

/// The phone's RTSP connection to the external camera (the native
/// `CameraLinkState`, lower case on the wire).
enum CameraLink { idle, connecting, playing, lost, stopped }

/// The external camera as the phone sees it while it pulls it.
class CameraStatus {
  const CameraStatus({
    this.link = CameraLink.idle,
    this.hasAudio,
    this.lostSec = 0,
    this.transport,
    this.width = 0,
    this.height = 0,
  });

  final CameraLink link;

  /// Null until the camera's format is known; false = a camera with no audio
  /// track (the fallback "Imbangan masa audio" applies).
  final bool? hasAudio;

  /// Whole seconds the picture has been lost (0 while it is not).
  final int lostSec;

  /// `tcp` or `udp`, the one in use; null before the first picture.
  final String? transport;
  final int width;
  final int height;

  bool get isLost => link == CameraLink.lost;
}

/// One row of the "Audio" card as the phone's own engine reports it. Same
/// shape as the box's `LiveAudioSourceStatus`, plus the meter [level].
class AudioRow {
  const AudioRow({
    required this.id,
    required this.enabled,
    required this.volume,
    required this.level,
    required this.state,
    this.alignState,
    this.delayMs,
    this.residualMs,
  });

  /// `camera` or `deviceMic` (the box reports `boxInput` itself).
  final String id;
  final bool enabled;

  /// 0 to 100.
  final int volume;

  /// The meter, 0.0 to 1.0.
  final double level;

  /// `ok`, `silent` or `lost`.
  final String state;

  /// `searching`, `locked`, `holding`, `failed` or `manual`; null on the
  /// reference (the camera).
  final String? alignState;
  final int? delayMs;
  final double? residualMs;

  bool get lost => state == 'lost';
}

/// Alignment state, per-source meters and the mixed level while the phone mixes.
class PublisherAudio {
  const PublisherAudio({
    this.rows = const [],
    this.mixed = 0,
    this.micFailed = false,
  });

  final List<AudioRow> rows;

  /// The mixed level over the preview, 0.0 to 1.0.
  final double mixed;

  /// The phone microphone could not be opened.
  final bool micFailed;

  AudioRow? row(String id) {
    for (final r in rows) {
      if (r.id == id) return r;
    }
    return null;
  }
}

/// The "Uji tepukan" clip (a camera with no audio track only).
enum ClapPhase { idle, capturing, ready, replaying, failed }

/// Why the engine ended a live by itself: the lost camera ran out its 10
/// minutes ("Siaran dihentikan kerana kamera terputus lebih 10 minit.").
const String endedCameraLost = 'camera_lost';

/// The external camera to pull. [url] is the full RTSP address from
/// `GET /api/live/camera/source` and may hold the login: keep it in memory
/// only; [toString] shows it masked.
class ExternalCameraSource {
  const ExternalCameraSource({required this.url, this.transport = 'auto'});

  final String url;

  /// `auto`, `tcp` or `udp` (the `liveCamera.transport` setting).
  final String transport;

  /// `rtsp://user:***@host/path`; an address without a password is unchanged.
  static String mask(String url) => url.replaceFirstMapped(
    RegExp(r'^(\w+://[^:/@\s]*):[^@/\s]*@'),
    (m) => '${m[1]}:***@',
  );

  @override
  String toString() => 'ExternalCameraSource(${mask(url)}, $transport)';
}

class PublisherState {
  const PublisherState({
    this.phase = PublisherPhase.idle,
    this.outputs = PublisherOutputs.none,
    this.recording = RecordingState.off,
    this.stats = StreamStats.zero,
    this.warnings = const {},
    this.durationSec = 0,
    this.muted = false,
    this.frontCamera = false,
    this.portrait = false,
    this.video = VideoSourceKind.phone,
    this.camera,
    this.audio,
    this.endReason,
    this.clap = ClapPhase.idle,
  });

  static const PublisherState initial = PublisherState();

  final PublisherPhase phase;
  final PublisherOutputs outputs;
  final RecordingState recording;
  final StreamStats stats;
  final Set<Warning> warnings;
  final int durationSec;
  final bool muted;
  final bool frontCamera;

  /// The device is held upright (portrait). The output is always 16:9
  /// 1280x720; in portrait the picture is a centred 16:9 band of the camera.
  final bool portrait;

  /// The picture source in use (Android: the phone pulls the external camera).
  final VideoSourceKind video;

  /// The external camera's link; null with the phone camera.
  final CameraStatus? camera;

  /// Meters and alignment of the phone's own mix; null with the phone camera.
  final PublisherAudio? audio;

  /// Set when the engine ended the live itself (see [endedCameraLost]).
  final String? endReason;

  /// The "Uji tepukan" clip.
  final ClapPhase clap;

  bool get isLive => phase == PublisherPhase.live;

  /// [clearExternal] drops [camera] and [audio] (back to the phone camera);
  /// [clearEndReason] drops [endReason] (a new session).
  PublisherState copyWith({
    PublisherPhase? phase,
    PublisherOutputs? outputs,
    RecordingState? recording,
    StreamStats? stats,
    Set<Warning>? warnings,
    int? durationSec,
    bool? muted,
    bool? frontCamera,
    bool? portrait,
    VideoSourceKind? video,
    CameraStatus? camera,
    PublisherAudio? audio,
    String? endReason,
    ClapPhase? clap,
    bool clearExternal = false,
    bool clearEndReason = false,
  }) => PublisherState(
    phase: phase ?? this.phase,
    outputs: outputs ?? this.outputs,
    recording: recording ?? this.recording,
    stats: stats ?? this.stats,
    warnings: warnings ?? this.warnings,
    durationSec: durationSec ?? this.durationSec,
    muted: muted ?? this.muted,
    frontCamera: frontCamera ?? this.frontCamera,
    portrait: portrait ?? this.portrait,
    video: video ?? this.video,
    camera: clearExternal ? null : (camera ?? this.camera),
    audio: clearExternal ? null : (audio ?? this.audio),
    endReason: clearEndReason ? null : (endReason ?? this.endReason),
    clap: clap ?? this.clap,
  );
}

/// What [LivePublisher.prepare] sets up before anything is sent.
class PublisherConfig {
  const PublisherConfig({
    this.recording = true,
    this.frontCamera = false,
    this.portrait,
    this.video = VideoSourceKind.phone,
    this.camera,
    this.mix,
    this.avOffsetMs = 0,
  });

  /// The picture source. With [VideoSourceKind.external] [camera] is required
  /// (Android: the phone pulls it); a publisher that cannot do it ends in
  /// [PublisherPhase.error].
  final VideoSourceKind video;
  final ExternalCameraSource? camera;

  /// The audio mix to start with; null = the default of [video].
  final LiveAudioMix? mix;

  /// The fixed "Imbangan masa audio", used only for a camera with no audio.
  final int avOffsetMs;

  /// False when the `recording` feature is off: nothing is recorded.
  final bool recording;
  final bool frontCamera;

  /// How the device is held at prepare; null lets the publisher read it.
  /// The output is 1280x720 (16:9) either way.
  final bool? portrait;
}

/// The two legs asked for.
class LiveOutputs {
  const LiveOutputs({this.kiosk = true, this.youtube = false});

  final bool kiosk;
  final bool youtube;
}

/// Where to send, from the box's `POST /api/live/start` answer (Task 8).
/// Secrets are held here in memory only, for one session.
class PublisherTargets {
  const PublisherTargets({
    required this.outputs,
    this.kuliahId,
    this.ingestUrl,
    this.youtubeUrl,
  });

  final LiveOutputs outputs;

  /// The kuliah broadcast, or null for `Tanpa kuliah`.
  final String? kuliahId;

  /// WHIP path (web) or SRT target (Android) on the box.
  final String? ingestUrl;

  /// RTMPS target with the stream key (Android only); never logged.
  final String? youtubeUrl;

  @override
  String toString() =>
      'PublisherTargets(kiosk: ${outputs.kiosk}, youtube: ${outputs.youtube})';
}

abstract class LivePublisher {
  Stream<PublisherState> get states;

  /// The last state streamed (what a screen shows before the next event).
  PublisherState get current;

  /// Permissions, camera, microphone and preview.
  Future<void> prepare(PublisherConfig c);

  Future<void> start(PublisherTargets t);

  /// Opens the YouTube RTMPS leg of a live that is already running (the
  /// broadcast was not ready at start). [url] holds the stream key and is
  /// never logged.
  Future<void> startYoutube(String url);

  /// Ends the outputs and finalises the recording.
  Future<void> stop();

  /// Android: the exact file names the last live wrote (scheme 2, date then
  /// HHmm then prefix then index, `.mp4`), in order. These names, and only these, bind the
  /// recording to its live for the clean-up and the catch-up upload. Empty on
  /// the web (the browser files its segments by session id) and when nothing
  /// was recorded.
  Future<List<String>> sessionRecordings();

  /// The browser publisher's own id of the live it recorded (the web files its
  /// segments under it); null on Android and before any live. Read it BEFORE
  /// stopping: the catch-up upload names this id and never guesses from the
  /// newest unsaved file.
  String? get recordingSessionId;

  Future<void> switchCamera();

  void setMuted(bool muted);

  /// A platform view on Android, an `HtmlElementView` on the web.
  Widget preview(BuildContext context);
}

/// What a publisher that mixes on the device can do beyond [LivePublisher]
/// (task K2; implemented by the Android publisher, which pulls the external
/// camera itself). The screen asks `publisher is LiveSourceControl`. A
/// separate interface so the browser publisher, which lets the box pull and
/// mix, is not forced to carry it. Every method throws `PublisherException`
/// (android_publisher.dart) with a reason code, never an address, when the
/// engine refuses.
abstract interface class LiveSourceControl {
  /// Switches the picture source, also during the live (no restart: the same
  /// encoder, SRT session, YouTube leg and recording carry on). To the phone
  /// camera the sound becomes the phone microphone alone with no delay; back
  /// to [VideoSourceKind.external] the camera sound returns and the [mix] is
  /// restored after the new alignment lock.
  Future<void> setVideoSource(
    VideoSourceKind kind, {
    ExternalCameraSource? camera,
    LiveAudioMix? mix,
    int avOffsetMs = 0,
  });

  /// Volumes, and adding or removing the phone microphone, during the live.
  Future<void> setAudioMix(LiveAudioMix mix);

  /// "Imbangan masa audio", used only while the camera has no audio track.
  Future<void> setAvOffset(int ms);

  /// "Uji tepukan" (a camera with no audio track, before the live): records
  /// about five seconds of picture and microphone; [PublisherState.clap]
  /// follows.
  Future<void> clapCapture();

  /// Replays the clip in a loop with the sound [offsetMs] after the picture.
  Future<void> clapReplay(int offsetMs);

  /// The stepper moved during a replay.
  Future<void> clapOffset(int offsetMs);

  /// Ends the replay and gives the live preview back.
  Future<void> clapStop();
}

/// What a publisher can do when the person plugs a microphone into the
/// device (the browser one; on Android the system picks the new microphone
/// by itself). The screen asks `publisher is LiveMicControl`.
abstract interface class LiveMicControl {
  /// The sound comes from [deviceId] from now on (null = the device's own
  /// default). A running live and its recording carry on. False when the
  /// microphone could not be opened; nothing changes then.
  Future<bool> setMicrophone(String? deviceId);
}
