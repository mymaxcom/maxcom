// The publisher seam of the Live tab (Plan 5): one capture, one preview,
// the kiosk leg and the optional YouTube leg, and a recorder that runs
// beside them. Two implementations follow in later tasks (web: WHIP from
// Safari or Chrome; Android: the in-repo RootEncoder plugin); the screen
// only ever sees this interface and the immutable [PublisherState] it
// streams. The stream key and passphrase in [PublisherTargets] live in
// memory only and are never logged.

import 'package:flutter/widgets.dart';

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

  bool get isLive => phase == PublisherPhase.live;

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
  );
}

/// What [LivePublisher.prepare] sets up before anything is sent.
class PublisherConfig {
  const PublisherConfig({
    this.recording = true,
    this.frontCamera = false,
    this.portrait,
  });

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

  Future<void> switchCamera();

  void setMuted(bool muted);

  /// A platform view on Android, an `HtmlElementView` on the web.
  Widget preview(BuildContext context);
}
