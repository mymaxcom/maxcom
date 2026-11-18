// The iPad / web side of a live with the external camera (plan 4.6, 4.7 and
// 5, task C4): what the browser publisher knows and says while the BOX pulls
// the camera, combines its sound with the iPad microphone and serves the
// combined stream back by WHEP. Pure Dart (no browser types), so the stub and
// the VM tests see it too.
//
// The box is the source of truth for the audio mix: volumes, source health
// and the alignment state come from `LiveStatus.audio` (core
// `live/types.ts`); this file only reads them and words them (Bahasa
// Malaysia, the strings of plan 4.7 and the accepted mockups 23, 24, 33, 35).

import '../../l10n/generated/s.dart';
import '../../l10n/s_lookup.dart';
import '../labels.dart' show appLangOfS;
import '../labels_cam.dart' show externalMixFailedMessage;
import '../shell/live_camera_gateway.dart' show LiveAudioMix;

/// Where the picture of an external-camera session comes from right now.
enum ExternalVideo {
  /// The box pulls the camera; the iPad sends at most its microphone.
  external,

  /// After "Tukar ke kamera iPad": the iPad sends its camera and microphone.
  ipadCamera,
}

/// The iPad microphone leg (the WHIP of an added source).
enum ExternalMic {
  /// Not in the mix: nothing is sent (controller only).
  off,
  starting,
  ok,

  /// Ended by the browser (Safari hidden, screen locked) or refused.
  lost,
}

/// The preview of the box's combined stream (WHEP).
enum ExternalPreview { idle, connecting, playing, retrying }

/// What happened to the recording of the received stream (plan 5, T0 item 7).
enum ExternalRecording {
  /// Not asked for (`recording` feature off) or not started yet.
  off,

  /// The browser recorder is running on the received stream.
  running,

  /// The browser cannot record a received stream (no recorder, or no data
  /// came): nothing is recorded and [externalRecordingFallback] is shown.
  unavailable,
}

/// One row of the "Audio" card as the box reports it (`LiveAudioSourceStatus`).
class ExternalAudioSource {
  const ExternalAudioSource({
    required this.id,
    required this.enabled,
    required this.volume,
    required this.state,
    this.alignState,
    this.delayMs,
    this.residualMs,
    this.levelDb,
  });

  /// `camera`, `deviceMic` or `boxInput`.
  final String id;
  final bool enabled;

  /// 0 to 100.
  final int volume;

  /// `ok`, `silent` or `lost`.
  final String state;

  /// `searching`, `locked`, `holding`, `failed` or `manual`; null on the
  /// reference (the camera).
  final String? alignState;
  final int? delayMs;
  final int? residualMs;

  /// The level the box measures on its combiner (dBFS, -90 to 0); null when
  /// the box reports none (no combiner running, or an older box).
  final double? levelDb;

  /// The level as a 0 to 1 bar fill (-60 dBFS and below is empty, 0 is full);
  /// null when there is no level.
  double? get levelFill {
    final l = levelDb;
    if (l == null) return null;
    return ((l + 60) / 60).clamp(0.0, 1.0);
  }

  bool get isAdded => id != 'camera';
  bool get lost => state == 'lost';
}

/// The wording, state by state, in the language of the [S] passed in (BM
/// when none is given).

/// The note under the preview for every iPad live with the external camera
/// (mockup note M5): the box always combines it.
String boxPullNote(String cameraName, [S? lang]) =>
    (lang ?? sBm).liveExtBoxPullNote(cameraName);

/// Camera audio alone: the iPad sends nothing (mockup 35).
String externalControllerOnlyNote([S? lang]) => (lang ?? sBm).liveExtControllerOnly;

/// With the iPad microphone in the mix (plan 4.4).
String externalScreenLockNote([S? lang]) => (lang ?? sBm).liveExtScreenLock;

/// Plan section 10, open point 1: the default when Safari cannot record a
/// received stream.
String externalRecordingFallback([S? lang]) => (lang ?? sBm).liveExtRecordingFallback;

String externalSourceName([S? lang]) => (lang ?? sBm).liveExtSourceName;

/// Mockup 33 and plan 4.7: the iPad microphone ended while the live goes on.
String externalMicLostMessage({required bool cameraAudible, S? lang}) {
  final s = lang ?? sBm;
  return cameraAudible
      ? s.liveExtMicLostCamera(s.liveExtSourceName)
      : s.liveExtMicLostSilent(s.liveExtSourceName);
}

String externalMicLostHint([S? lang]) => (lang ?? sBm).liveExtMicLostHint;

/// The microphone could not be opened at the start (permission refused).
String externalMicRefusedMessage([S? lang]) => (lang ?? sBm).liveExtMicRefused;

/// Chip on an added row. [started] is false before the live (mockup M4);
/// [micLost] shows the wording of mockup 33.
String externalAlignChip({
  required String? alignState,
  required bool started,
  bool micLost = false,
  S? lang,
}) {
  final s = lang ?? sBm;
  if (micLost) return s.liveExtChipRealign;
  if (!started) return s.liveExtChipOnStart;
  switch (alignState) {
    case 'locked':
    case 'holding':
      return s.liveExtChipAligned;
    case 'failed':
      return s.liveExtChipNotAligned;
    case 'manual':
      return s.liveExtChipManual;
    default:
      return s.liveExtChipAligning;
  }
}

/// "Penyelarasan automatik belum berjaya" (plan 4.7), the two forms.
String externalAlignFailedMessage({required bool cameraAudible, S? lang}) {
  final s = lang ?? sBm;
  return cameraAudible
      ? s.liveExtAlignFailedCamera(s.liveExtSourceName)
      : s.liveExtAlignFailedSilent;
}

String externalUseMicOnlyAction([S? lang]) {
  final s = lang ?? sBm;
  return s.liveExtUseMicOnly(s.liveExtSourceName);
}

String externalCameraNoAudioWithMic([S? lang]) {
  final s = lang ?? sBm;
  return s.liveExtCameraNoAudioMic(s.liveExtSourceName);
}

String externalCameraNoAudioAlone([S? lang]) => (lang ?? sBm).liveExtCameraNoAudioAlone;

String externalAllMutedMessage([S? lang]) => (lang ?? sBm).liveExtAllMuted;

String externalPreviewRetryMessage([S? lang]) => (lang ?? sBm).liveExtPreviewRetry;

/// The fallback offset ("Imbangan masa audio", camera with no audio): 0 to
/// 2000 ms in steps of 50 (plan 4.3a).
const int externalOffsetMin = 0;
const int externalOffsetMax = 2000;
const int externalOffsetStep = 50;

int clampExternalOffset(int ms) {
  final c = ms.clamp(externalOffsetMin, externalOffsetMax);
  return (c / externalOffsetStep).round() * externalOffsetStep;
}

/// True when a sound the audience hears comes from the camera.
bool cameraAudible(LiveAudioMix m) => m.camera.enabled && m.camera.volume > 0;

/// True when every source is off or at volume 0.
bool allMuted(LiveAudioMix m) =>
    !(cameraAudible(m) ||
        (m.deviceMic.enabled && m.deviceMic.volume > 0) ||
        (m.boxInput.enabled && m.boxInput.volume > 0));

/// The sources array of a `GET /api/live/status` body (`audio.sources`);
/// anything malformed is dropped, never thrown.
List<ExternalAudioSource> parseExternalAudio(Object? statusJson) {
  if (statusJson is! Map) return const [];
  final audio = statusJson['audio'];
  if (audio is! Map) return const [];
  final raw = audio['sources'];
  if (raw is! List) return const [];
  final out = <ExternalAudioSource>[];
  for (final s in raw) {
    if (s is! Map) continue;
    final id = s['id'];
    if (id is! String) continue;
    final vol = s['volume'];
    final align = s['align'];
    int? intOf(Object? v) => v is num ? v.round() : null;
    out.add(
      ExternalAudioSource(
        id: id,
        enabled: s['enabled'] == true,
        volume: vol is num ? vol.round().clamp(0, 100) : 0,
        state: s['state'] is String ? s['state'] as String : 'ok',
        alignState: align is Map && align['state'] is String
            ? align['state'] as String
            : null,
        delayMs: align is Map ? intOf(align['delayMs']) : null,
        residualMs: align is Map ? intOf(align['residualMs']) : null,
        levelDb: s['level'] is num
            ? (s['level'] as num).toDouble().clamp(-90.0, 0.0)
            : null,
      ),
    );
  }
  return out;
}

/// The warning codes of `LiveStatus.warnings`, strings only.
List<String> parseExternalWarnings(Object? statusJson) {
  if (statusJson is! Map) return const [];
  final w = statusJson['warnings'];
  if (w is! List) return const [];
  return [
    for (final e in w)
      if (e is String) e,
  ];
}

/// Everything the screen needs about an external-camera session on the
/// iPad, beside the generic [PublisherState].
class ExternalLiveState {
  const ExternalLiveState({
    this.active = false,
    this.video = ExternalVideo.external,
    this.mic = ExternalMic.off,
    this.preview = ExternalPreview.idle,
    this.previewSound = true,
    this.recording = ExternalRecording.off,
    this.sources = const [],
    this.warnings = const [],
    this.notice,
    this.noticeHint,
    this.canUseMicOnly = false,
    this.cameraHasAudio = true,
    this.fallbackOffsetMs = 0,
  });

  static const ExternalLiveState idle = ExternalLiveState();

  /// An external-camera session is prepared or running.
  final bool active;
  final ExternalVideo video;
  final ExternalMic mic;
  final ExternalPreview preview;

  /// The preview plays with its sound (the box's combined stream).
  final bool previewSound;
  final ExternalRecording recording;

  /// The rows the box reports (volumes, health, alignment).
  final List<ExternalAudioSource> sources;
  final List<String> warnings;

  /// The one message to show now (highest priority first), and its hint line.
  final String? notice;
  final String? noticeHint;

  /// The "Guna Mikrofon iPad sahaja" action applies (alignment failed with
  /// the camera audible).
  final bool canUseMicOnly;
  final bool cameraHasAudio;

  /// The fallback "Imbangan masa audio" for the iPad microphone.
  final int fallbackOffsetMs;

  ExternalAudioSource? source(String id) {
    for (final s in sources) {
      if (s.id == id) return s;
    }
    return null;
  }

  ExternalLiveState copyWith({
    bool? active,
    ExternalVideo? video,
    ExternalMic? mic,
    ExternalPreview? preview,
    bool? previewSound,
    ExternalRecording? recording,
    List<ExternalAudioSource>? sources,
    List<String>? warnings,
    String? notice,
    String? noticeHint,
    bool clearNotice = false,
    bool? canUseMicOnly,
    bool? cameraHasAudio,
    int? fallbackOffsetMs,
  }) => ExternalLiveState(
    active: active ?? this.active,
    video: video ?? this.video,
    mic: mic ?? this.mic,
    preview: preview ?? this.preview,
    previewSound: previewSound ?? this.previewSound,
    recording: recording ?? this.recording,
    sources: sources ?? this.sources,
    warnings: warnings ?? this.warnings,
    notice: clearNotice ? null : (notice ?? this.notice),
    noticeHint: clearNotice ? null : (noticeHint ?? this.noticeHint),
    canUseMicOnly: canUseMicOnly ?? this.canUseMicOnly,
    cameraHasAudio: cameraHasAudio ?? this.cameraHasAudio,
    fallbackOffsetMs: fallbackOffsetMs ?? this.fallbackOffsetMs,
  );
}

/// The message to show, by priority: the box combiner failed, the microphone lost, alignment not
/// found, the camera without sound, everything muted, the recording that
/// cannot be made. Null when there is nothing to say.
({String message, String? hint, bool micOnlyAction})? externalNoticeFor({
  required LiveAudioMix mix,
  required ExternalMic mic,
  required List<ExternalAudioSource> sources,
  required List<String> warnings,
  required bool cameraHasAudio,
  required bool micInMix,
  required ExternalRecording recording,
  required bool recordingAsked,
  S? lang,
}) {
  final s = lang ?? sBm;
  if (warnings.contains('audio_mix_failed')) {
    return (message: externalMixFailedMessage(appLangOfS(s)), hint: null, micOnlyAction: false);
  }
  final audible = cameraAudible(mix);
  final boxMicLost = sources.any((s) => s.id == 'deviceMic' && s.lost);
  if (micInMix && (mic == ExternalMic.lost || boxMicLost)) {
    return (
      message: externalMicLostMessage(cameraAudible: audible, lang: s),
      hint: externalMicLostHint(s),
      micOnlyAction: false,
    );
  }
  final align = sources.any(
    (s) => s.id == 'deviceMic' && s.alignState == 'failed',
  );
  if (micInMix && (align || warnings.contains('audio_align_failed'))) {
    return (
      message: externalAlignFailedMessage(cameraAudible: audible, lang: s),
      hint: null,
      micOnlyAction: audible,
    );
  }
  if (!cameraHasAudio || warnings.contains('camera_no_audio')) {
    return (
      message: micInMix
          ? externalCameraNoAudioWithMic(s)
          : externalCameraNoAudioAlone(s),
      hint: null,
      micOnlyAction: false,
    );
  }
  if (allMuted(mix) || warnings.contains('audio_all_muted')) {
    return (message: externalAllMutedMessage(s), hint: null, micOnlyAction: false);
  }
  if (recordingAsked && recording == ExternalRecording.unavailable) {
    return (
      message: externalRecordingFallback(s),
      hint: null,
      micOnlyAction: false,
    );
  }
  return null;
}
