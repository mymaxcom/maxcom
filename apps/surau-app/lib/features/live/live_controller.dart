// The Live tab's controller (Plan 5 Task 8): starts and stops the session
// with the box, hands the publisher its targets, polls the box's status
// every 2 s while the screen is open, drives the YouTube device-code
// sign-in and keeps the web recordings bookkeeping.
//
// Secrets: the box's start answer carries the SRT passphrase and, for a
// phone that pushes to YouTube itself, the stream key. They are passed to
// the publisher and dropped; nothing here prints, logs or stores them, and
// [stopLive] clears the one reference kept while live.

import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter/widgets.dart'
    show AppLifecycleState, WidgetsBinding, WidgetsBindingObserver;
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../app/app_lang.dart';
import '../../app/deps.dart';
import '../../app/providers.dart';
import '../../box/box_client.dart';
import '../../l10n/generated/s.dart';
import '../../l10n/s_lookup.dart';
import '../common/error_text.dart' show errorText;
import '../shell/box_gateway.dart';
import '../shell/live_camera_gateway.dart';
import '../../sync/sync_providers.dart' show syncEngineProvider;
import 'live_destinations.dart';
import 'publisher.dart';
import 'recordings_store.dart';
import 'web_publisher.dart';

// ---- the box's side ----

/// [unknown]: the box could not reach the place that holds the sign-in just now. It is NOT signed out: the choice
/// and the sign-in card stay as they were, and the last good channel is named.
enum YoutubeAccountPhase { signedOut, signingIn, signedIn, unknown }

/// Why the account is signed out when it is not the plain start state: the person cancelled at Google, the
/// code ran out, or Google withdrew the access that was given ("ditarik balik").
enum YoutubeSignOutReason { denied, expired, revoked }

class YoutubeAccount {
  const YoutubeAccount.signedOut({this.reason})
    : byAdmin = false,
      phase = YoutubeAccountPhase.signedOut,
      userCode = null,
      verificationUrl = null,
      expiresAt = null,
      channel = null;

  const YoutubeAccount.signingIn({
    this.userCode,
    this.verificationUrl,
    this.expiresAt,
    this.byAdmin = false,
  }) : phase = YoutubeAccountPhase.signingIn,
       reason = null,
       channel = null;

  /// The sign-in could not be checked now; [channel] is the last one the box saw signed in (may be null).
  const YoutubeAccount.unknown({this.channel})
    : byAdmin = false,
      phase = YoutubeAccountPhase.unknown,
      userCode = null,
      verificationUrl = null,
      expiresAt = null,
      reason = null;

  const YoutubeAccount.signedIn(this.channel)
    : byAdmin = false,
      phase = YoutubeAccountPhase.signedIn,
      userCode = null,
      verificationUrl = null,
      expiresAt = null,
      reason = null;

  final YoutubeAccountPhase phase;

  /// Signed out after something happened (null for the plain start state).
  final YoutubeSignOutReason? reason;

  /// When the code being shown stops working (null when the box does not say).
  final DateTime? expiresAt;

  /// The device code to type at google.com/device.
  final String? userCode;
  final String? verificationUrl;

  /// A sign-in is under way but the box sent no code (the caller may only control the live): an administrator signs in.
  final bool byAdmin;

  /// The connected channel's name.
  final String? channel;

  bool get signedIn => phase == YoutubeAccountPhase.signedIn;
}

class _Keep {
  const _Keep();
}

const _keep = _Keep();

/// What the box says about the live (`GET /api/live/status`) plus what the
/// controller knows from its own calls.
class LiveBoxStatus {
  const LiveBoxStatus({
    this.boxReachable = true,
    this.internet = true,
    this.youtubeError,
    this.youtube = const YoutubeAccount.signedOut(),
    this.busyDevice,
    this.recordingsPending = 0,
    this.youtubeSeconds = 0,
    this.watchUrl,
    this.notice,
    this.sessionId,
    this.youtubeViaBox = false,
    this.youtubeLeg,
    this.ingestReady,
    this.stopping = false,
    this.warnings = const {},
    this.audio = const [],
    this.otherLive,
    this.stopFailed = false,
    this.youtubeSignInHere = true,
    this.noticeRev,
    this.viewers = const [],
    this.resume = LiveResume.none,
    this.controlOnly = false,
    this.startedAt,
    this.videoPath,
    this.cameraUse = const [],
    this.gapSeconds = 0,
    this.broadcastIds = const [],
    this.endedGapSeconds = 0,
    this.endedBroadcastIds = const [],
    this.youtubeStarting = false,
    this.sessionYoutube,
    this.controllerQuietSeconds,
    this.cameraKbps,
    this.canToggleKiosk = false,
    this.sessionKiosk,
    this.sessionRecording,
    this.sessionBoxPulled,
    this.sessionStartedBoxPulled,
    this.cpuPercent,
    this.lastLiveCpuPercent,
    this.relayBehindSeconds,
    this.relayQuality,
    this.relayRestarts = 0,
  });

  /// Seconds the YouTube leg is behind real time (build 6); null while the box does not say.
  final int? relayBehindSeconds;

  /// `full` or `low` (the picture lowered to 480p, build 6); null while the box does not say.
  final String? relayQuality;

  /// How many times the box restarted its YouTube leg in this live.
  final int relayRestarts;

  /// Whole-machine CPU of the live server, 0 to 100, 30 s average (build 5); null on an older box or when none is known.
  final int? cpuPercent;

  /// CPU average of the last ended live (build 5); null when unknown.
  final int? lastLiveCpuPercent;

  /// Seconds since a device last controlled the running live, as the box says (build 4); null on an older box.
  final int? controllerQuietSeconds;

  /// The camera's own 30 s average in kbps (`cameraKbps`, top level in the status); null on an older box.
  final double? cameraKbps;

  /// The box can switch the TV screen during a live (`canToggleKiosk`); an older box cannot.
  final bool canToggleKiosk;

  /// What the running session sends to the TVs and records, as the box says; null while it does not say.
  final bool? sessionKiosk;
  final bool? sessionRecording;

  /// What the box says about who pulls the camera right now (`session.boxPulled`); null while it does not say.
  final bool? sessionBoxPulled;

  /// `session.startedBoxPulled`: the live started with the box pulling the camera (the Stop right of a non-starter and the
  /// quiet notice follow it); null while the box does not say.
  final bool? sessionStartedBoxPulled;

  /// The box pulls the camera of the running live: this device shows no picture of it. The box's own word
  /// (`session.boxPulled`, false after a switch to the iPad's own camera) decides; a box that does not send it is
  /// read from `videoPath` as before.
  bool get boxPulled => sessionId != null && (sessionBoxPulled ?? videoPath == 'box');

  /// This device's own session was found on the box after the app was
  /// reopened (`session.mine`, B9): [LiveResume.sending] when the engine is
  /// still sending the picture (the screen re-attaches by itself),
  /// [LiveResume.needed] when it is not (the card "Siaran anda masih berjalan"
  /// with Sambung semula and Berhenti).
  final LiveResume resume;

  /// The box pulls the camera and this phone only controls the live (`videoPath: box` on Android): nothing is
  /// published or recorded here, and the screen shows the live from the box's status.
  final bool controlOnly;

  /// When the open session started, as the box says (a control-only or adopted live has no engine clock).
  final DateTime? startedAt;

  /// Who pulls the camera of the running live (`device` or `box`); null while the box does not say.
  final String? videoPath;

  /// The "camera in use" flags of the box: which camera a live holds, for which device, since when.
  final List<LiveCameraUseDto> cameraUse;

  /// Gap seconds and YouTube broadcasts of the running live, as the box records them (D1, D2).
  final int gapSeconds;
  final List<String> broadcastIds;

  /// The same two of this device's live that just ended, kept for its summary until the next start.
  final int endedGapSeconds;
  final List<String> endedBroadcastIds;

  /// Seconds the open session has run by the box's clock; 0 without one.
  int runSeconds(DateTime now) {
    final at = startedAt;
    if (at == null) return 0;
    final d = now.difference(at).inSeconds;
    return d < 0 ? 0 : d;
  }

  final bool boxReachable;

  /// Changes whenever someone edits the live notice text (the box's `noticeRev`); null while it does not say. The
  /// notice is read again when it changes.
  final int? noticeRev;

  /// False when the answer came from the cloud (2026.11.13): the YouTube grant is held by the MAXCOM at the surau,
  /// so sign-in, sign-out and a channel change are offered at the surau only; away, the screen shows the flag.
  final bool youtubeSignInHere;

  /// The box can reach the internet (the YouTube leg is possible).
  final bool internet;

  /// Why the box cannot use YouTube now, in its own code (`youtube.lastError`): `live_not_enabled`,
  /// `clock_wrong`, `client_refused`, `busy_other_box`; null when nothing stands in the way.
  final String? youtubeError;
  final YoutubeAccount youtube;

  /// Another device holds the live session.
  final String? busyDevice;

  /// Segments of an earlier web recording still waiting to be saved.
  final int recordingsPending;

  /// Seconds YouTube received in this session (for the summary).
  final int youtubeSeconds;

  /// The broadcast's watch page, once YouTube has one.
  final String? watchUrl;

  /// A refusal or failure in the box's own words (Malay), shown as a notice.
  final String? notice;

  /// The box session this device opened, while live.
  final String? sessionId;

  /// The YouTube leg of this session is relayed by the box (iPad, or an
  /// Android build with `youtubeViaBox`): its light comes from the box.
  final bool youtubeViaBox;

  /// O34: "Siarkan ke YouTube" was pressed and the box has not answered yet.
  final bool youtubeStarting;

  /// Whether the box says the running session sends to YouTube (`session.outputs.youtube`); null while it does not say.
  final bool? sessionYoutube;

  /// The box's view of that relayed leg; null when not relayed.
  final OutputState? youtubeLeg;

  /// The box confirms a publisher is delivering (`ingest.ready`) for the
  /// open session; null when there is no session or no box view yet. The
  /// kiosk light is "on" only when this is true ([kioskLeg]).
  final bool? ingestReady;

  /// This device is ending its session (recording closed, last look at the
  /// box, `POST /api/live/stop`). The screen says "Menghentikan siaran" and
  /// no poll that overlaps it can mark the box unreachable.
  final bool stopping;

  /// The media warnings the box reports ([mediaPortsBlocked], [noVideoFromDevice]);
  /// codes this app does not know are dropped.
  final Set<String> warnings;

  /// The TVs of the surau while a live runs, as the box reports them; empty while it says nothing.
  final List<LiveViewerDto> viewers;

  /// Per-source health of the audio mix as the box reports it (alignment,
  /// level, lost sources); empty while the box says nothing.
  final List<LiveAudioSourceDto> audio;

  /// A live another device started (this one holds no session): who started
  /// it and its box session id. Read-only here; the Pentadbir may stop it.
  final OtherLive? otherLive;

  /// This device's stop did not reach the box: [sessionId] is kept (the box
  /// still has the live, and so may YouTube and the TV) and the controller
  /// tries again every few seconds while the page lives.
  final bool stopFailed;

  LiveAudioSourceDto? audioOf(String id) {
    for (final a in audio) {
      if (a.id == id) return a;
    }
    return null;
  }

  /// The camera's sound is on air and arriving (its row reads `ok`: enabled, above 0 and not lost).
  bool get cameraSoundCarrying => audioOf('camera')?.state == 'ok';

  /// The box microphone is the source the box lost AND the camera sound carries the live meanwhile: the benched notice
  /// ("bunyi kamera digunakan"). A box that raises `audio_source_lost` without saying which source is read as this.
  bool get boxMicBenched {
    if (!warnings.contains(audioSourceLost)) return false;
    if (audio.isEmpty) return true;
    return audioOf('boxInput')?.state == 'lost' && cameraSoundCarrying;
  }

  /// The box microphone is gone and nothing else carries the sound: the broadcast may be silent.
  bool get boxMicLostSilent => audioOf('boxInput')?.state == 'lost' && !cameraSoundCarrying;

  /// The box microphone is in the mix and has been silent for a minute (`box_mic_silent`, build 5) and the camera
  /// sound does NOT carry the live: the broadcast may have no voice.
  bool get boxMicSilent => warnings.contains(boxMicSilentWarning) && !cameraSoundCarrying;

  /// The same warning while the camera sound carries the live: "Bunyi kamera digunakan".
  bool get boxMicSilentCovered => warnings.contains(boxMicSilentWarning) && cameraSoundCarrying;

  /// Seconds the box microphone has had no signal (`noSignalSeconds` of its audio row); null when it has none.
  int? get boxMicNoSignalSeconds => audioOf('boxInput')?.noSignalSeconds;

  /// The live server is too busy to serve the live well (`server_busy`, build 5).
  bool get serverBusy => warnings.contains(serverBusyWarning);

  /// The box microphone drops frames (`box_mic_drops`, build 6).
  bool get boxMicDrops => warnings.contains(boxMicDropsWarning);

  /// The YouTube leg is 4 s or more behind (`upload_behind`, build 6).
  bool get uploadBehind => warnings.contains(uploadBehindWarning);

  /// The picture of the YouTube leg was lowered to 480p (`quality_lowered`, build 6).
  bool get qualityLowered => warnings.contains(qualityLoweredWarning);

  /// The microphone of the sending device (the iPad's) is the source the box lost.
  bool get deviceMicLost => audioOf('deviceMic')?.state == 'lost';

  LiveBoxStatus copyWith({
    bool? boxReachable,
    bool? internet,
    Object? youtubeError = _keep,
    YoutubeAccount? youtube,
    Object? busyDevice = _keep,
    int? recordingsPending,
    int? youtubeSeconds,
    Object? watchUrl = _keep,
    Object? notice = _keep,
    Object? sessionId = _keep,
    bool? youtubeViaBox,
    Object? youtubeLeg = _keep,
    Object? ingestReady = _keep,
    bool? stopping,
    Set<String>? warnings,
    List<LiveAudioSourceDto>? audio,
    Object? otherLive = _keep,
    bool? stopFailed,
    bool? youtubeSignInHere,
    Object? noticeRev = _keep,
    List<LiveViewerDto>? viewers,
    LiveResume? resume,
    bool? controlOnly,
    Object? startedAt = _keep,
    Object? videoPath = _keep,
    List<LiveCameraUseDto>? cameraUse,
    int? gapSeconds,
    List<String>? broadcastIds,
    int? endedGapSeconds,
    List<String>? endedBroadcastIds,
    bool? youtubeStarting,
    Object? sessionYoutube = _keep,
    Object? controllerQuietSeconds = _keep,
    Object? cameraKbps = _keep,
    bool? canToggleKiosk,
    Object? sessionKiosk = _keep,
    Object? sessionRecording = _keep,
    Object? sessionBoxPulled = _keep,
    Object? sessionStartedBoxPulled = _keep,
    Object? cpuPercent = _keep,
    Object? lastLiveCpuPercent = _keep,
    Object? relayBehindSeconds = _keep,
    Object? relayQuality = _keep,
    int? relayRestarts,
  }) => LiveBoxStatus(
    relayBehindSeconds: identical(relayBehindSeconds, _keep) ? this.relayBehindSeconds : relayBehindSeconds as int?,
    relayQuality: identical(relayQuality, _keep) ? this.relayQuality : relayQuality as String?,
    relayRestarts: relayRestarts ?? this.relayRestarts,
    cpuPercent: identical(cpuPercent, _keep) ? this.cpuPercent : cpuPercent as int?,
    lastLiveCpuPercent: identical(lastLiveCpuPercent, _keep) ? this.lastLiveCpuPercent : lastLiveCpuPercent as int?,
    sessionBoxPulled: identical(sessionBoxPulled, _keep) ? this.sessionBoxPulled : sessionBoxPulled as bool?,
    sessionStartedBoxPulled: identical(sessionStartedBoxPulled, _keep)
        ? this.sessionStartedBoxPulled
        : sessionStartedBoxPulled as bool?,
    controllerQuietSeconds: identical(controllerQuietSeconds, _keep) ? this.controllerQuietSeconds : controllerQuietSeconds as int?,
    cameraKbps: identical(cameraKbps, _keep) ? this.cameraKbps : cameraKbps as double?,
    canToggleKiosk: canToggleKiosk ?? this.canToggleKiosk,
    sessionKiosk: identical(sessionKiosk, _keep) ? this.sessionKiosk : sessionKiosk as bool?,
    sessionRecording: identical(sessionRecording, _keep) ? this.sessionRecording : sessionRecording as bool?,
    resume: resume ?? this.resume,
    controlOnly: controlOnly ?? this.controlOnly,
    startedAt: identical(startedAt, _keep) ? this.startedAt : startedAt as DateTime?,
    videoPath: identical(videoPath, _keep) ? this.videoPath : videoPath as String?,
    youtubeStarting: youtubeStarting ?? this.youtubeStarting,
    sessionYoutube: identical(sessionYoutube, _keep) ? this.sessionYoutube : sessionYoutube as bool?,
    cameraUse: cameraUse ?? this.cameraUse,
    gapSeconds: gapSeconds ?? this.gapSeconds,
    broadcastIds: broadcastIds ?? this.broadcastIds,
    endedGapSeconds: endedGapSeconds ?? this.endedGapSeconds,
    endedBroadcastIds: endedBroadcastIds ?? this.endedBroadcastIds,
    boxReachable: boxReachable ?? this.boxReachable,
    internet: internet ?? this.internet,
    youtubeError: identical(youtubeError, _keep) ? this.youtubeError : youtubeError as String?,
    youtube: youtube ?? this.youtube,
    busyDevice: identical(busyDevice, _keep)
        ? this.busyDevice
        : busyDevice as String?,
    recordingsPending: recordingsPending ?? this.recordingsPending,
    youtubeSeconds: youtubeSeconds ?? this.youtubeSeconds,
    watchUrl: identical(watchUrl, _keep) ? this.watchUrl : watchUrl as String?,
    notice: identical(notice, _keep) ? this.notice : notice as String?,
    sessionId: identical(sessionId, _keep)
        ? this.sessionId
        : sessionId as String?,
    youtubeViaBox: youtubeViaBox ?? this.youtubeViaBox,
    youtubeLeg: identical(youtubeLeg, _keep)
        ? this.youtubeLeg
        : youtubeLeg as OutputState?,
    ingestReady: identical(ingestReady, _keep)
        ? this.ingestReady
        : ingestReady as bool?,
    stopping: stopping ?? this.stopping,
    warnings: warnings ?? this.warnings,
    audio: audio ?? this.audio,
    otherLive: identical(otherLive, _keep) ? this.otherLive : otherLive as OtherLive?,
    stopFailed: stopFailed ?? this.stopFailed,
    youtubeSignInHere: youtubeSignInHere ?? this.youtubeSignInHere,
    noticeRev: identical(noticeRev, _keep) ? this.noticeRev : noticeRev as int?,
    viewers: viewers ?? this.viewers,
  );
}

/// Where this device's own session stands after the app was reopened.
enum LiveResume {
  /// Nothing to resume (no session, or a live this run of the app started).
  none,

  /// The engine still sends the picture: the screen has re-attached.
  sending,

  /// The engine holds nothing: "Sambung semula" starts the publisher again.
  needed,
}

/// One stop of a live as the controller saw it (B12): which path stopped it
/// and whether a person tapped for it. Kept in [LiveBoxNotifier.stopLog] and
/// printed, so a stop "with no confirm" can be traced to its path.
class LiveStopEvent {
  const LiveStopEvent(this.path, this.at, {this.sessionId});

  /// `user` (the confirmed Berhenti), `camera_lost` (the engine gave the
  /// camera up), `ended_by_box` (the box no longer has the session),
  /// `start_failed` (the publisher could not start), `retry` (a stop that had
  /// not reached the box is sent again), `emergency` (the Pentadbir stops
  /// another device's live).
  final String path;
  final DateTime at;
  final String? sessionId;

  /// The paths that follow a tap on Berhenti and its confirm dialog.
  static const Set<String> confirmed = {'user', 'emergency'};

  @override
  String toString() => 'LiveStopEvent($path)';
}

/// A live started by another device (see [LiveBoxStatus.otherLive]).
class OtherLive {
  const OtherLive({
    required this.sessionId,
    required this.starter,
    this.video,
    this.videoPath,
    this.startedAt,
    this.boxPulled,
    this.startedBoxPulled,
  });

  /// `box` when the box pulls the camera (any holder of live control may stop that live); null while it is not said.
  final String? videoPath;

  /// `session.boxPulled` as the box says it; false after a switch to the iPad's own camera. Null on a box that does
  /// not say: [pulledByBox] then reads [videoPath].
  final bool? boxPulled;

  /// `session.startedBoxPulled`: the live started box-pulled (never ends by itself; any live:control holder may stop it).
  /// Null on a box that does not say: [startedPulled] then falls back to [pulledByBox].
  final bool? startedBoxPulled;

  /// The live started box-pulled, as far as the box says.
  bool get startedPulled => startedBoxPulled ?? pulledByBox;

  /// The box pulls the camera of this live now (the live has no picture on this device and carries on without a controller).
  bool get pulledByBox => boxPulled ?? videoPath == 'box';

  /// When the live started, by the box's clock.
  final DateTime? startedAt;

  /// The starter's name without its device: the box words it "Name (Device)".
  String get starterName {
    final m = RegExp(r'^(.*?)\s*\(([^)]+)\)\s*$').firstMatch(starter);
    final n = m?.group(1)?.trim();
    return n == null || n.isEmpty ? starter : n;
  }

  /// The device the starter used, null when the box did not name one.
  String? get starterDevice => RegExp(r'\(([^)]+)\)\s*$').firstMatch(starter)?.group(1);

  final String sessionId;

  /// The starting device as the box names it.
  final String starter;

  /// `phone` or `external`; null while the box does not say.
  final String? video;
}

/// The box's firewall rules for the media ports are missing or wrong.
const mediaPortsBlocked = 'media_ports_blocked';

/// The box has had no picture from the device for 12 s.
const noVideoFromDevice = 'no_video_from_device';

/// The box could not reach the cloud (which holds the YouTube sign-in) for
/// this live: the YouTube leg is skipped, the kiosk leg runs. Shown by the
/// live screen's banner, so it is not repeated as a notice.
const cloudUnreachableWarning = 'cloud_unreachable';

/// The camera the box pulls sends well above the configured maximum while
/// its picture is relayed to YouTube as it is (C3). Advice; the live goes on.
const cameraBitrateHigh = 'camera_bitrate_high';

/// The camera the box pulls sends H.265 only (C11).
const cameraH265 = 'camera_h265';

/// No device has controlled the running live for 10 minutes (build 4). The live goes on; any holder of live control
/// may stop it.
const controllerQuiet = 'controller_quiet';

/// The camera sends far less than its own running level: something else holds it (build 4).
const cameraSlow = 'camera_slow';

/// The box microphone was benched after stalls and the camera sound is used meanwhile (build 4).
const audioSourceLost = 'audio_source_lost';

/// The box microphone is in the mix with a volume above 0 and has had no signal for a minute (build 5).
const boxMicSilentWarning = 'box_mic_silent';

/// The live server is above 85% CPU for 30 s while its own TV and another TV play the live (build 5).
const serverBusyWarning = 'server_busy';

/// The box microphone drops frames (build 6).
const boxMicDropsWarning = 'box_mic_drops';

/// The YouTube leg is 4 s or more behind real time (build 6).
const uploadBehindWarning = 'upload_behind';

/// The YouTube picture was lowered to 480p (build 6).
const qualityLoweredWarning = 'quality_lowered';

/// YouTube did not deliver and the box switched the TV screen back on by itself so the live keeps a destination.
const kioskRestored = 'kiosk_restored';

/// The camera path of a live the box pulls has no picture (the box raises it; the camera row then reads `lost` too).
const noVideoFromCamera = 'no_video_from_camera';

/// Only the codes the live screen has a banner for. The no-video, camera and
/// cloud-unreachable ones belong to a live that is open (or being started).
Set<String> _mediaWarnings(Iterable<String> codes, {required bool live}) => {
  for (final c in codes)
    if (c == mediaPortsBlocked ||
        (live &&
            (c == noVideoFromDevice ||
                c == cloudUnreachableWarning ||
                c == cameraBitrateHigh ||
                c == cameraH265 ||
                c == controllerQuiet ||
                c == cameraSlow ||
                c == noVideoFromCamera ||
                c == kioskRestored ||
                c == boxMicSilentWarning ||
                c == serverBusyWarning ||
                c == boxMicDropsWarning ||
                c == uploadBehindWarning ||
                c == qualityLoweredWarning ||
                c == audioSourceLost)))
      c,
};

/// The kiosk leg as shown: the publisher's own word, but never "up" until
/// the box confirms it receives the stream (a refused SRT attempt must not
/// read as on air). [boxReady] null means no box view (tests, no session).
OutputState? kioskLeg(OutputState? publisher, bool? boxReady) {
  if (publisher == null) return null;
  if (publisher.phase == OutputPhase.up && boxReady == false) {
    return OutputState.connecting;
  }
  return publisher;
}

/// Sets the Android build to let the box relay to YouTube (spike S4 FAIL
/// branch): `--dart-define=youtubeViaBox=true`. The phone then sends SRT only.
const bool youtubeViaBoxBuild = bool.fromEnvironment('youtubeViaBox');

/// Seconds between the tries to end a live whose stop did not reach the box.
const Duration liveStopRetryInterval = Duration(seconds: 5);

/// Seconds between status polls while the Live tab is open.
const Duration livePollInterval = Duration(seconds: 2);

/// Overridable in tests; the real value is [livePollInterval].
final livePollIntervalProvider = Provider<Duration>((_) => livePollInterval);

/// How often, and for how long, the phone asks the box for the YouTube
/// stream key when the start answered before the broadcast existed.
final youtubeIngestPollIntervalProvider = Provider<Duration>(
  (_) => const Duration(seconds: 2),
);
final youtubeIngestTimeoutProvider = Provider<Duration>(
  (_) => const Duration(seconds: 60),
);

/// The web recordings store; null on Android (the phone saves to Movies).
final recordingsStoreProvider = Provider<RecordingsStore?>((ref) {
  final platform = ref.watch(appDepsProvider).platform;
  if (platform == 'android') return null;
  return openRecordingsStore();
});

/// The device's publisher: the browser one on the web, the RootEncoder
/// plugin on Android (`publisherFor`). Tests override it with a fake.
final livePublisherProvider = Provider<LivePublisher>((ref) {
  final deps = ref.read(appDepsProvider);
  final settings = ref.read(settingsProvider).value?.value;
  int setting(String feature, String key, int fallback) {
    final f = settings?[feature];
    final v = f is Map ? f[key] : null;
    return v is int ? v : fallback;
  }

  final segmentMinutes = setting('recording', 'segmentMinutes', 15);
  final maxBitrateKbps = setting('liveYoutube', 'maxBitrateKbps', 3500);
  final LivePublisher p;
  if (kIsWeb || deps.platform == 'web' || deps.platform == 'ios-web') {
    // The browser publisher also changes the box's audio mix (a box-combined live) and saves the fallback offset.
    p = WebPublisher(
      tokenProvider: () async => ref.read(sessionProvider)?.token,
      box: ref.read(enrolledBoxProvider)?.box,
      segmentMinutes: segmentMinutes,
      maxBitrateKbps: maxBitrateKbps,
      audioSender: (mix, {video, avOffsetMs}) async =>
          await ref.read(gatewayProvider)?.changeLiveAudio(mix, video: video, avOffsetMs: avOffsetMs),
      offsetSaver: (id, ms) => saveCameraOffset(ref.read(gatewayProvider), ref.read(settingsProvider).value?.value, id, ms),
      lang: () => sFor(ref.read(appLangProvider)),
    );
  } else {
    p = publisherFor(
      deps.platform,
      box: ref.read(enrolledBoxProvider)?.box,
      tokenProvider: () async => ref.read(sessionProvider)?.token,
      segmentMinutes: segmentMinutes,
      maxBitrateKbps: maxBitrateKbps,
    );
  }
  ref.onDispose(() => disposePublisher(p));
  return p;
});

/// "Imbangan masa audio" saved into the camera settings (`liveCamera.avOffsetMs`): one source's value changed.
Future<void> saveCameraOffset(
  BoxGateway? gateway,
  Map<String, dynamic>? settings,
  String id,
  int ms,
) async {
  if (gateway == null) return;
  final f = settings?['liveCamera'];
  final cur = f is Map && f['avOffsetMs'] is Map ? (f['avOffsetMs'] as Map) : const <dynamic, dynamic>{};
  int of(String k) => cur[k] is int ? cur[k] as int : 0;
  await gateway.put('/api/settings/liveCamera', {
    'avOffsetMs': {'deviceMic': of('deviceMic'), 'boxInput': of('boxInput'), id: ms},
  });
}

/// The state holder behind the Live tab. This base class works on a bare
/// publisher with no box (the screen tests and goldens); [LiveController]
/// is the real one against `/api/live/*`.
class LiveBoxNotifier extends Notifier<LiveBoxStatus> {
  LiveBoxNotifier([this.initial = const LiveBoxStatus()]);

  final LiveBoxStatus initial;

  @override
  LiveBoxStatus build() => initial;

  void set(LiveBoxStatus s) => state = s;

  /// The screen is open: start polling the box.
  void attach() {}

  /// The screen is gone: stop polling.
  void detach() {}

  Future<void> startLive({
    required String? kuliahId,
    required bool youtube,
    VideoSourceKind video = VideoSourceKind.phone,
    LiveAudioMix? mix,
    String? videoPath,
    bool kiosk = true,
    bool recording = false,
  }) async {
    await ref
        .read(livePublisherProvider)
        .start(
          PublisherTargets(
            kuliahId: kuliahId,
            outputs: LiveOutputs(kiosk: kiosk, youtube: youtube),
          ),
        );
  }

  /// [path] names why the live is stopped ([LiveStopEvent.path]).
  Future<void> stopLive({String? notice, String path = 'user'}) async {
    logStop(path);
    await ref.read(livePublisherProvider).stop();
    // the session, if this bare holder was given one, ends with the live
    state = state.copyWith(sessionId: null, resume: LiveResume.none, controlOnly: false, notice: notice ?? state.notice);
  }

  /// "Sambung semula": this device's own session, found on the box after the
  /// app was reopened, gets its publisher back (B9).
  Future<void> resumeLive() async {}

  /// O34 "Siarkan ke YouTube": adds YouTube to the running live that started without it. The bare holder does nothing.
  ///
  /// [title] and [privacy] are what the person confirmed in the sheet; left out, the box uses the live's own.
  Future<void> startYoutubeLater({String? title, String? privacy}) async {}

  /// Every stop of this run, newest last (at most 20): the path that stopped
  /// the live, for the question "who stopped it" (B12).
  final List<LiveStopEvent> stopLog = [];

  @protected
  void logStop(String path, {String? sessionId}) {
    DateTime at;
    try {
      at = ref.read(appDepsProvider).now();
    } on Object {
      at = DateTime.now();
    }
    stopLog.add(LiveStopEvent(path, at, sessionId: sessionId));
    if (stopLog.length > 20) stopLog.removeAt(0);
    // the path only: never a session secret
    debugPrint('live stop path: $path');
  }

  /// The Pentadbir stops a live another device started ("Henti kecemasan"); any holder of live control stops a live
  /// the box pulls (build 4).
  Future<void> emergencyStop() async => state = state.copyWith(otherLive: null);

  /// During a live: the TV screen and the local recording switched on or off (`POST /api/live/outputs`). True when
  /// the box took it. This bare holder takes everything.
  Future<bool> setOutputs({bool? kiosk, bool? recording}) async {
    state = state.copyWith(
      sessionKiosk: kiosk ?? state.sessionKiosk,
      sessionRecording: recording ?? state.sessionRecording,
    );
    return true;
  }

  /// Tries again to end this device's own live after a stop that did not
  /// reach the box.
  Future<void> retryStop() async {}

  /// True once per live when the person has left the Live page while it is
  /// still running (the screen then says so).
  bool takeLeaveReminder() => false;

  /// The live that went on without this page is one the box pulls (build 4): the reminder then says MAXCOM carries
  /// it on.
  bool get leaveReminderBoxPulled => state.boxPulled;

  Future<void> signIn() async =>
      state = state.copyWith(youtube: const YoutubeAccount.signingIn());

  Future<void> signOut() async =>
      state = state.copyWith(youtube: const YoutubeAccount.signedOut());

  /// Hands one pending web segment to the browser.
  Future<void> savePending() async =>
      state = state.copyWith(recordingsPending: 0);
}

final liveBoxProvider = NotifierProvider<LiveBoxNotifier, LiveBoxStatus>(
  LiveController.new,
);

/// The real controller: the box session, status polling, YouTube sign-in
/// and the web recordings bookkeeping.
class LiveController extends LiveBoxNotifier {
  LiveController() : super();

  /// The catalogue of the app language now; a notice keeps the language it was made in.
  S get _s => sFor(ref.read(appLangProvider));

  /// BM texts (the notice itself is made in the app language).
  static String get signInFailed => sBm.liveSignInFailed;
  static String get startFailed => sBm.liveStartFailed;

  Timer? _poll;
  Timer? _retryTimer;
  bool _leftWhileLive = false;
  bool _leaveAsked = false;
  bool _retrying = false;
  Timer? _signInTimer;
  Timer? _ingestTimer;
  _ResumeWatcher? _resumeWatcher;

  List<String> _boxWarnings = const [];
  bool _polling = false;
  bool _attached = false;
  bool _disposed = false;

  /// Credentials of the open session; cleared by [stopLive].
  PublisherTargets? _targets;

  @visibleForTesting
  bool get holdsTargets => _targets != null;

  @override
  LiveBoxStatus build() {
    ref.onDispose(() {
      _disposed = true;
      _unwatchResume();
      _poll?.cancel();
      _retryTimer?.cancel();
      _signInTimer?.cancel();
      _ingestTimer?.cancel();
      _targets = null;
      // the screen flag of a control-only live is not left behind
      if (_screenKept) unawaited(_keeper?.keepScreenOn(false) ?? Future<void>.value());
    });
    return const LiveBoxStatus();
  }

  BoxGateway? get _gateway => ref.read(gatewayProvider);

  String get _source =>
      ref.read(appDepsProvider).platform == 'android' ? 'android' : 'web';

  void _put(LiveBoxStatus s) {
    if (_disposed) return;
    state = s;
    _syncPoll();
    _syncScreenKeep();
  }

  bool _screenKept = false;
  LiveScreenKeep? _keeper;

  /// F1: a live this phone only controls keeps the screen on (the engine runs nothing then); cleared at its end.
  void _syncScreenKeep() {
    final want = state.controlOnly && state.sessionId != null;
    if (want == _screenKept) return;
    _screenKept = want;
    try {
      final p = ref.read(livePublisherProvider);
      _keeper = p is LiveScreenKeep ? p as LiveScreenKeep : null;
      if (_keeper != null) unawaited(_keeper!.keepScreenOn(want));
    } on Object catch (e) {
      debugPrint('keep screen not set: ${e.runtimeType}');
    }
  }

  // ---- polling ----

  @override
  void attach() {
    if (_attached) return;
    _attached = true;
    unawaited(refreshPending());
    unawaited(_refreshAll());
    _watchResume();
    _syncPoll();
  }

  /// One look at the box's status, then at the YouTube sign-in itself (2026.11.13: held by the box; away from the
  /// surau the cloud answers with the box's flag).
  Future<void> _refreshAll() async {
    await pollOnce();
    await refreshYoutube();
  }

  /// The app came back to the front (the person was at Google's page): look at once, a timer that slept is not waited for.
  void _watchResume() {
    if (_resumeWatcher != null) return;
    final w = _ResumeWatcher(() {
      if (_disposed || !_attached) return;
      unawaited(onResumed());
    });
    _resumeWatcher = w;
    WidgetsBinding.instance.addObserver(w);
  }

  void _unwatchResume() {
    final w = _resumeWatcher;
    if (w == null) return;
    WidgetsBinding.instance.removeObserver(w);
    _resumeWatcher = null;
  }

  int _unknownPolls = 0;

  /// The Live screen is open and the app has just resumed.
  @visibleForTesting
  Future<void> onResumed() async {
    // the surau's YouTube choice may have been changed on another phone meanwhile
    ref.invalidate(settingsProvider);
    await _refreshAll();
    if (_disposed) return;
    // a sign-in the person was finishing: the server holds it, ask it now instead of waiting for the next timer
    if (state.youtube.phase == YoutubeAccountPhase.signingIn) {
      _signInTimer?.cancel();
      await _pollSignIn();
    }
  }

  @override
  void detach() {
    if (_disposed || !_attached) return;
    _attached = false;
    _unwatchResume();
    if (state.sessionId != null) _leftWhileLive = true;
    _syncPoll();
  }

  /// The status poll tells the box a device is controlling the live (a live the box pulls goes on without it and
  /// only says "no controller" after 10 minutes; a live this device sends ends when the heartbeat stops): it runs
  /// while the page is open AND while this device holds a live, whether or not the page is.
  void _syncPoll() {
    final want = !_disposed && (_attached || state.sessionId != null);
    if (want && _poll == null) {
      _poll = Timer.periodic(ref.read(livePollIntervalProvider), (_) {
        unawaited(pollOnce());
        // an unknown sign-in is looked at again now and then (about every 10 polls)
        if (state.youtube.phase == YoutubeAccountPhase.unknown && ++_unknownPolls % 10 == 0) {
          unawaited(refreshYoutube());
        }
      });
    } else if (!want && _poll != null) {
      _poll?.cancel();
      _poll = null;
    }
  }

  @override
  bool takeLeaveReminder() {
    if (_disposed || !_leftWhileLive || _leaveAsked || state.sessionId == null) return false;
    _leaveAsked = true;
    return true;
  }

  @visibleForTesting
  bool get polling => _poll != null;

  /// One `GET /api/live/status`. A failure marks the box unreachable and
  /// leaves everything else (the publisher keeps running). While this
  /// device is stopping its own session the periodic poll is skipped, and a
  /// failure of a poll that overlaps the stop is not an outage: the stop
  /// itself reports a real one. [duringStop] is the stop's own last look.
  Future<LiveStatusDto?> pollOnce({bool duringStop = false}) async {
    final gateway = _gateway;
    if (gateway == null || _polling) return null;
    if (state.stopping && !duringStop) return null;
    _polling = true;
    final sentWith = state.sessionId;
    try {
      final raw = await gateway.getFresh('/api/live/status', quiet: () => state.stopping);
      final dto = LiveStatusDto.fromJson(raw);
      final pub = ref.read(livePublisherProvider);
      // The browser publisher words the audio rows and messages from the box's own status.
      if (pub is WebPublisher && state.sessionId != null) pub.applyBoxStatus(raw);
      // An answer that predates a start or a stop made meanwhile is stale.
      if (state.sessionId != sentWith) return dto;
      if (!state.stopping && sentWith != null && dto.sessionId != sentWith) {
        await _endedByBox(dto);
        return dto;
      }
      _apply(dto);
      return dto;
    } on SessionExpired {
      return null;
    } on BoxUnreachable {
      if (!state.stopping) _put(state.copyWith(boxReachable: false));
      return null;
    } on LiveOnly {
      // The offline-first gateway words an unreachable live route this way
      // (S5): it was an unhandled exception on every poll, and the screen
      // never learned that the box was away.
      if (!state.stopping) _put(state.copyWith(boxReachable: false));
      return null;
    } on BoxError {
      if (!state.stopping) _put(state.copyWith(boxReachable: false));
      return null;
    } finally {
      _polling = false;
    }
  }

  /// The box no longer has our session (or has another one): the live is
  /// over. Stop the publisher, clear the state, tell the person. No stop
  /// is POSTed: there is nothing left to stop on the box.
  Future<void> _endedByBox(LiveStatusDto d) async {
    final ended = state.sessionId;
    final wasRetrying = state.stopFailed;
    final control = state.controlOnly;
    logStop('ended_by_box', sessionId: ended);
    _stopIngestPoll();
    _stopRetry();
    final publisher = ref.read(livePublisherProvider);
    _put(state.copyWith(stopping: true));
    try {
      // a control-only live published nothing from this phone
      if (!control) await publisher.stop();
    } catch (e) {
      debugPrint('publisher stop after box end failed: ${e.runtimeType}');
    } finally {
      _targets = null;
    }
    final gaps = state.gapSeconds;
    final broadcasts = state.broadcastIds;
    _mine = null;
    _apply(d);
    _put(
      state.copyWith(
        sessionId: null,
        youtubeLeg: null,
        youtubeViaBox: false,
        ingestReady: null,
        stopping: false,
        resume: LiveResume.none,
        controlOnly: false,
        startedAt: null,
        endedGapSeconds: gaps,
        endedBroadcastIds: broadcasts,
        // A stop we were retrying needs no "ended by the box" line: it is simply over.
        notice: wasRetrying ? null : _s.liveStoppedByBox,
        stopFailed: false,
        warnings: _mediaWarnings(state.warnings, live: false),
      ),
    );
    unawaited(_syncAfterStop());
    // Every stop without a tap says why (B12): the box's own record of the
    // session names the reason; until it answers the notice says "by MAXCOM".
    if (!wasRetrying && ended != null) unawaited(_explainEnd(ended));
  }

  /// Reads why the box ended [sessionId] (`GET /api/live/sessions/recent`) and
  /// sharpens the notice: the camera was lost, a person stopped it (the
  /// Pentadbir's emergency stop), or the box itself did. Never throws.
  Future<void> _explainEnd(String sessionId) async {
    final gateway = _gateway;
    if (gateway == null) return;
    try {
      final rows = LiveSessionSummaryDto.listFrom(await gateway.getFresh('/api/live/sessions/recent', quiet: () => true));
      if (_disposed || state.sessionId != null) return;
      for (final r in rows) {
        if (r.id != sessionId) continue;
        final text = switch (r.reason) {
          'camera_lost' => _s.liveStoppedCameraLost,
          // a person's stop that was not this device's own: the Pentadbir ended it
          'stopped' => _s.liveStoppedByAdmin,
          _ => _s.liveStoppedByBox,
        };
        // only while the first notice is still the one on the screen
        if (state.notice == _s.liveStoppedByBox) {
          _put(state.copyWith(notice: text, endedGapSeconds: r.gapSeconds, endedBroadcastIds: r.broadcastIds));
        }
        return;
      }
    } on Object {
      // an older box has no such route: "by MAXCOM" stays
    }
  }

  /// One sync after a live ended (B13): the box was busy with the stop while
  /// the engine's last run may have failed, and that failure must not stay on
  /// the screen as a red icon.
  Future<void> _syncAfterStop() async {
    try {
      await ref.read(syncEngineProvider)?.sync();
    } on Object {
      // the next foreground sync tries again
    }
  }

  /// The account as the server describes it. The sign-in phase comes from the server's `signIn` (so an app opened
  /// later, or on another phone, shows the same code), not only from this app's memory.
  YoutubeAccount _accountOf({
    required bool signedIn,
    required String? channel,
    required YoutubeSignInInfo? signIn,
    required String? lastError,
    String? accountState,
    String? lastGoodChannel,
  }) {
    final local = state.youtube;
    // A box that says "unknown" could not look: never a sign-out (an older box sends no state, and the flag decides).
    if (accountState == 'unknown' && local.phase != YoutubeAccountPhase.signingIn) {
      return YoutubeAccount.unknown(channel: lastGoodChannel ?? channel);
    }
    if (signedIn) return YoutubeAccount.signedIn(channel);
    if (signIn != null) {
      if (signIn.state == 'pending') {
        return YoutubeAccount.signingIn(
          userCode: signIn.userCode,
          verificationUrl: signIn.verificationUrl,
          expiresAt: signIn.expiresAt,
          byAdmin: signIn.userCode == null || signIn.userCode!.isEmpty,
        );
      }
      return YoutubeAccount.signedOut(
        reason: signIn.state == 'denied'
            ? YoutubeSignOutReason.denied
            : YoutubeSignOutReason.expired,
      );
    }
    if (local.phase == YoutubeAccountPhase.signingIn) {
      // this app's own sign-in goes on until it ends (a status read between two polls may not show it yet)
      final until = local.expiresAt;
      if (until == null || ref.read(appDepsProvider).now().isBefore(until)) {
        return local;
      }
      return const YoutubeAccount.signedOut(
        reason: YoutubeSignOutReason.expired,
      );
    }
    // Google withdrew the access the surau gave: said plainly instead of the bare start state
    if (lastError == 'reauthorise') {
      return const YoutubeAccount.signedOut(reason: YoutubeSignOutReason.revoked);
    }
    // what ended this app's own attempt stays on the screen until the person starts again
    if (local.phase == YoutubeAccountPhase.signedOut &&
        (local.reason == YoutubeSignOutReason.denied ||
            local.reason == YoutubeSignOutReason.expired)) {
      return local;
    }
    return const YoutubeAccount.signedOut();
  }

  /// `GET /api/live/youtube/status`: the sign-in itself, read where it is kept (the box at the surau; away, the
  /// cloud answers with the box's flag and `signInHere: false`).
  /// Never throws; a failure leaves what the status poll said.
  Future<void> refreshYoutube() async {
    final gateway = _gateway;
    if (gateway == null || _disposed) return;
    try {
      final dto = YoutubeStatusDto.fromJson(
        await gateway.getFresh('/api/live/youtube/status', quiet: () => true),
      );
      if (_disposed) return;
      final account = _accountOf(
        signedIn: dto.signedIn,
        channel: dto.channelTitle,
        signIn: dto.signIn,
        lastError: dto.lastError,
        accountState: dto.state,
        lastGoodChannel: dto.lastGoodChannel,
      );
      _put(state.copyWith(youtube: account, youtubeSignInHere: dto.signInHere));
    } on Object {
      // the status poll's view stays; this look is only a sharper one
    }
  }

  void _apply(LiveStatusDto d) {
    final s = state;
    final live = s.sessionId != null;
    var account = _accountOf(
      signedIn: d.youtubeSignedIn,
      channel: d.channelTitle,
      signIn: d.signIn,
      lastError: d.youtubeError,
    );
    // The status poll cannot tell "unknown" from "signed out" (it carries the live leg): an unknown account stays
    // unknown until the sign-in itself is read again, or the poll sees it signed in.
    if (state.youtube.phase == YoutubeAccountPhase.unknown &&
        account.phase == YoutubeAccountPhase.signedOut &&
        account.reason == null) {
      account = state.youtube;
    }
    OutputState? leg;
    // the leg of this device's own live relayed by the box, or the leg of another device's live as the box's status
    // shows it (a non-starter has no engine to ask)
    final otherYoutube = !live && d.sessionId != null && d.sessionYoutube == true;
    if ((live && s.youtubeViaBox) || otherYoutube) {
      if (d.relayState == 'retrying') {
        leg = const OutputState(OutputPhase.retrying);
      } else if (d.relayState == 'failed' || d.youtubeState == 'error') {
        leg = OutputState.down;
      } else if (d.youtubeReceiving) {
        leg = OutputState.up;
      } else {
        leg = OutputState.connecting;
      }
    }
    _boxWarnings = d.warnings;
    // the box's own choice for its next live (B5): the destinations follow it
    if (d.nextLiveOn != null) ref.read(liveDestinationsProvider.notifier).fromStatus(d.nextLiveOn);
    // This device's own session, found after the app was reopened (B9): it is
    // adopted (the normal Berhenti, the heartbeat), never shown as another
    // device's live.
    final adopt = !live && !s.stopping && !_startingNow && d.sessionId != null && d.mine;
    if (adopt) {
      _mine = d;
      final controller = d.videoPath == 'box' && _source == 'android';
      _put(
        s.copyWith(
          sessionId: d.sessionId,
          controlOnly: controller,
          youtubeViaBox: d.youtubeVia == 'box' && (d.sessionYoutube ?? false),
          // until the engine has been asked, the card offers Sambung semula
          resume: controller ? LiveResume.none : LiveResume.needed,
          stopFailed: false,
          otherLive: null,
          notice: null,
        ),
      );
      if (!controller) unawaited(_askEngine(d.sessionId!));
      _apply(d);
      return;
    }
    _put(
      s.copyWith(
        boxReachable: true,
        startedAt: d.sessionId != null ? d.startedAt : null,
        videoPath: d.sessionId != null ? d.videoPath : null,
        cameraUse: d.cameraUse,
        sessionYoutube: d.sessionId != null ? d.sessionYoutube : null,
        sessionBoxPulled: d.sessionId != null ? d.sessionBoxPulled : null,
        sessionStartedBoxPulled: d.sessionId != null ? d.sessionStartedBoxPulled : null,
        gapSeconds: live ? d.gapSeconds : 0,
        broadcastIds: live ? d.broadcastIds : const [],
        internet: d.youtubeError != 'network',
        youtubeError: d.youtubeError,
        youtube: account,
        youtubeSignInHere: d.youtubeSignInHere,
        noticeRev: d.noticeRev,
        busyDevice: d.sessionId == null ? null : s.busyDevice,
        youtubeSeconds: live && d.youtubeReceiving
            ? s.youtubeSeconds + ref.read(livePollIntervalProvider).inSeconds
            : s.youtubeSeconds,
        // The box's watch link for any running session (own or another device's);
        // an own live just ended keeps it for the summary until the next start.
        watchUrl: d.sessionId != null
            ? (d.watchUrl ?? (live ? s.watchUrl : null))
            : (s.otherLive != null ? null : s.watchUrl),
        youtubeLeg: leg,
        ingestReady: live ? d.ingestReady : null,
        // another device's live also carries the build 4 notices (no controller, slow camera, benched microphone)
        warnings: {
          ..._mediaWarnings(d.warnings, live: live),
          if (d.sessionId != null)
            for (final c in d.warnings)
              if (c == controllerQuiet || c == cameraSlow || c == noVideoFromCamera || c == audioSourceLost || c == kioskRestored || c == boxMicSilentWarning || c == serverBusyWarning || c == boxMicDropsWarning || c == uploadBehindWarning || c == qualityLoweredWarning) c,
        },
        relayBehindSeconds: d.sessionId != null ? d.relayBehindSeconds : null,
        relayQuality: d.sessionId != null ? d.relayQuality : null,
        relayRestarts: d.sessionId != null ? d.relayRestarts : 0,
        controllerQuietSeconds: live || d.sessionId != null ? d.controllerQuietSeconds : null,
        cameraKbps: d.sessionId != null ? d.cameraKbps : null,
        cpuPercent: d.sessionId != null ? d.cpuPercent : null,
        lastLiveCpuPercent: d.sessionId == null ? d.lastLiveCpuPercent : null,
        canToggleKiosk: d.canToggleKiosk,
        sessionKiosk: d.sessionId != null ? d.sessionKiosk : null,
        sessionRecording: d.sessionId != null ? d.sessionRecording : null,
        audio: d.audio,
        viewers: d.sessionId != null ? d.viewers : const [],
        otherLive: !live && d.sessionId != null
            ? OtherLive(
                sessionId: d.sessionId!,
                starter: d.startedBy ?? _s.liveOtherDevice,
                video: d.video,
                videoPath: d.videoPath,
                startedAt: d.startedAt,
                boxPulled: d.sessionBoxPulled,
                startedBoxPulled: d.sessionStartedBoxPulled,
              )
            : null,
      ),
    );
  }

  // ---- this device's own session after a restart (B9) ----

  /// The status that showed this device's own session (what it was started with), until it ends.
  LiveStatusDto? _mine;

  /// Asks the engine whether it still holds [sessionId] and still sends the
  /// picture: then the screen only re-attaches; otherwise "Sambung semula" is
  /// offered. A publisher that keeps nothing beyond the screen holds nothing.
  Future<void> _askEngine(String sessionId) async {
    final pub = ref.read(livePublisherProvider);
    var sending = pub.current.isLive;
    if (!sending && pub is LiveSessionHolder) {
      try {
        final held = await (pub as LiveSessionHolder).status();
        sending = held != null && held.sessionId == sessionId && held.streaming;
      } on Object {
        sending = false;
      }
    }
    if (_disposed || state.sessionId != sessionId) return;
    _put(state.copyWith(resume: sending ? LiveResume.sending : LiveResume.needed));
  }

  /// "Sambung semula": the box gives this device its session back with fresh
  /// targets (`resume: true`, the same kuliah, source and outputs), and the
  /// publisher starts again on them. A refusal (`resume_mismatch`, the session
  /// is over) is said in the box's words and the session stays as it was.
  @override
  Future<void> resumeLive() async {
    final gateway = _gateway;
    final mine = _mine;
    final id = state.sessionId;
    if (gateway == null || mine == null || id == null || mine.sessionId != id || _resuming) return;
    _resuming = true;
    try {
      final android = _source == 'android';
      final youtube = mine.sessionYoutube ?? false;
      final LiveStartResult result;
      try {
        result = LiveStartResult.fromJson(
          await gateway.post('/api/live/start', {
            'kuliahId': mine.kuliahId,
            'source': mine.source ?? _source,
            // the CURRENT Skrin and Merakam: a live that records only (Skrin off) must resume the same way
            'outputs': {
              'kiosk': state.sessionKiosk ?? mine.sessionKiosk ?? true,
              'youtube': youtube,
              if ((state.sessionRecording ?? mine.sessionRecording) == true) 'recording': true,
            },
            'youtubeVia': mine.youtubeVia ?? (android && !youtubeViaBoxBuild ? 'device' : 'box'),
            if (mine.video == 'external') 'video': 'external',
            'videoPath': ?mine.videoPath,
            'resume': true,
          }),
        );
      } on SessionExpired {
        rethrow;
      } on BoxError catch (e) {
        _put(state.copyWith(notice: errorText(_s, e)));
        return;
      } on Object {
        _put(state.copyWith(boxReachable: false));
        return;
      }
      if (_disposed || state.sessionId != id) return;
      final targets = _targetsOf(result, kuliahId: mine.kuliahId, youtube: youtube, android: android);
      _targets = targets.targets;
      _put(
        state.copyWith(
          boxReachable: true,
          notice: null,
          youtubeViaBox: targets.viaBox,
          youtubeLeg: targets.viaBox ? OutputState.connecting : null,
          ingestReady: false,
        ),
      );
      try {
        await ref.read(livePublisherProvider).start(targets.targets);
      } catch (_) {
        // the session is still on the box: the card stays, with the reason
        _targets = null;
        _put(state.copyWith(notice: _s.liveStartFailed));
        return;
      }
      if (_disposed || state.sessionId != id) return;
      _put(state.copyWith(resume: LiveResume.sending));
      if (targets.later) _startIngestPoll(id);
    } finally {
      _resuming = false;
    }
  }

  bool _resuming = false;

  /// The publisher's targets from the box's start answer: what the box agreed
  /// to for YouTube (it can drop the leg: not signed in, no internet), so the
  /// publisher is told only what will really run.
  ({PublisherTargets targets, bool viaBox, bool running, bool later}) _targetsOf(
    LiveStartResult result, {
    required String? kuliahId,
    required bool youtube,
    required bool android,
  }) {
    final yt = result.youtube;
    final ytRunning = youtube && yt != null;
    final ytViaDevice = ytRunning && yt.via == 'device' && yt.key != null;
    // Device mode, broadcast still being made: kiosk leg now, the key later.
    final ytLater = ytRunning && yt.via == 'device' && yt.key == null && yt.starting;
    final String? ingestUrl = android ? result.srt?.url : result.whip;
    String? youtubeUrl;
    if (ytViaDevice) {
      final base = (yt.ingest ?? '').replaceAll(RegExp(r'/+$'), '');
      youtubeUrl = base.isEmpty ? yt.key : '$base/${yt.key}';
    }
    return (
      targets: PublisherTargets(
        kuliahId: kuliahId,
        outputs: LiveOutputs(kiosk: true, youtube: ytRunning && !ytLater),
        ingestUrl: ingestUrl,
        youtubeUrl: youtubeUrl,
        sessionId: result.sessionId,
      ),
      viaBox: ytRunning && yt.via == 'box',
      running: ytRunning,
      later: ytLater,
    );
  }

  // ---- start and stop ----

  /// A start of this device is under way (from the request to the end of its
  /// clean-up): a status read in between must not "adopt" the session it is
  /// just opening or closing.
  bool _startingNow = false;

  @override
  Future<void> startLive({
    required String? kuliahId,
    required bool youtube,
    VideoSourceKind video = VideoSourceKind.phone,
    LiveAudioMix? mix,
    String? videoPath,
    bool kiosk = true,
    bool recording = false,
  }) async {
    _startingNow = true;
    try {
      await _startLive(
        kuliahId: kuliahId,
        youtube: youtube,
        video: video,
        mix: mix,
        videoPath: videoPath,
        kiosk: kiosk,
        recording: recording,
      );
    } finally {
      _startingNow = false;
    }
  }

  Future<void> _startLive({
    required String? kuliahId,
    required bool youtube,
    required VideoSourceKind video,
    required LiveAudioMix? mix,
    required String? videoPath,
    required bool kiosk,
    required bool recording,
  }) async {
    final publisher = ref.read(livePublisherProvider);
    final gateway = _gateway;
    if (gateway == null) {
      _put(state.copyWith(boxReachable: false, notice: null));
      return;
    }
    final android = _source == 'android';
    // The box pulls the camera and this phone only controls (an admin's choice, never the default): nothing is
    // published from here, so YouTube can only leave from the box.
    final controller = android && video == VideoSourceKind.external && videoPath == 'box';
    final via = android && !youtubeViaBoxBuild && !controller ? 'device' : 'box';
    _put(
      state.copyWith(
        notice: null,
        busyDevice: null,
        youtubeSeconds: 0,
        stopFailed: false,
        endedGapSeconds: 0,
        endedBroadcastIds: const [],
      ),
    );
    _stopRetry();
    _leftWhileLive = false;
    _leaveAsked = false;

    LiveStartResult result;
    try {
      result = LiveStartResult.fromJson(
        await gateway.post('/api/live/start', {
          'kuliahId': kuliahId,
          'source': _source,
          // `recording` is informational and only said when true: a box that knows no such field sees today's body
          'outputs': {'kiosk': kiosk, 'youtube': youtube, if (recording) 'recording': true},
          'youtubeVia': via,
          // The external camera and Mic-in: an older box reads neither and starts today's phone live.
          if (video == VideoSourceKind.external || (mix?.boxInput.enabled ?? false)) ...{
            'video': video == VideoSourceKind.external ? 'external' : 'phone',
            'audio': ?mix?.toJson(),
          },
          // Who pulls the external camera; left out for `device` (the default), so an older box sees today's body.
          if (controller) 'videoPath': 'box',
        }),
      );
    } on OfflineWriteRefused {
      _put(state.copyWith(boxReachable: false));
      return;
    } on BoxUnreachable {
      _put(state.copyWith(boxReachable: false));
      return;
    } on SessionExpired {
      rethrow;
    } on BoxError catch (e) {
      if (e.code == 'live_busy') {
        _put(state.copyWith(busyDevice: _deviceIn(e.message, _s)));
      } else if (e.code == 'live_rate') {
        _put(state.copyWith(notice: _s.liveRateText));
      } else {
        _put(state.copyWith(notice: errorText(_s, e)));
      }
      return;
    }

    _stopIngestPoll();
    final t = _targetsOf(result, kuliahId: kuliahId, youtube: youtube, android: android);
    final ytRunning = t.running;
    final targets = t.targets;
    _targets = controller ? null : targets;
    _mine = null;
    _put(
      state.copyWith(
        sessionId: result.sessionId,
        boxReachable: true,
        youtubeViaBox: t.viaBox,
        youtubeLeg: t.viaBox ? OutputState.connecting : null,
        ingestReady: false,
        watchUrl: null,
        resume: LiveResume.none,
        controlOnly: controller,
        sessionKiosk: kiosk,
        sessionRecording: recording,
        startedAt: ref.read(appDepsProvider).now(),
        videoPath: video == VideoSourceKind.external ? (controller ? 'box' : 'device') : null,
        notice: youtube && !ytRunning ? _youtubeDropped(result.warnings, _s) : null,
        warnings: _mediaWarnings(result.warnings, live: true),
      ),
    );
    // The box pulls the camera: this phone sends nothing (and records nothing).
    if (controller) return;
    await _applyBrightness(publisher);
    try {
      await publisher.start(targets);
    } catch (_) {
      // No picture will come: free the box side again and say so.
      logStop('start_failed', sessionId: result.sessionId);
      _targets = null;
      _put(
        state.copyWith(sessionId: null, ingestReady: null, startedAt: null, videoPath: null, notice: _s.liveStartFailed),
      );
      await _postStop(gateway, result.sessionId);
      rethrow;
    }
    if (t.later) _startIngestPoll(result.sessionId);
  }

  /// B7: the saved "Kecerahan gambar" (`liveCamera.brightness`) goes to the phone's engine before the picture starts.
  /// A publisher without the control (the browser one) has nothing to set; a failure never stops a live.
  Future<void> _applyBrightness(LivePublisher publisher) async {
    if (publisher is! LiveBrightnessControl) return;
    // The live screen keeps the settings loaded; if they are not, the default (auto) applies, never a wait.
    final settings = ref.exists(settingsProvider) ? ref.read(settingsProvider).value?.value : null;
    final f = settings?['liveCamera'];
    final v = f is Map ? f['brightness'] : null;
    final level = v is String && const {'auto', 'normal', 'bright', 'brighter'}.contains(v) ? v : 'auto';
    try {
      await (publisher as LiveBrightnessControl).setBrightness(level);
    } on Object catch (e) {
      debugPrint('brightness not set: ${e.runtimeType}');
    }
  }

  // ---- YouTube added to a running live (O34) ----

  /// "Siarkan ke YouTube": the live started without YouTube. The box makes the broadcast and, when it relays, starts its
  /// leg; when the phone sends YouTube itself (`youtubeVia: device`) the phone waits for the ingest key as at a live
  /// started with YouTube and opens its own leg. A refusal is a CODE; its words are chosen here.
  @override
  Future<void> startYoutubeLater({String? title, String? privacy}) async {
    final gateway = _gateway;
    final sid = state.sessionId;
    if (gateway == null || sid == null || state.stopping || state.youtubeStarting) return;
    _put(state.copyWith(youtubeStarting: true, notice: null));
    try {
      final t = title?.trim();
      final raw = await gateway.post('/api/live/youtube/start', {
        'sessionId': sid,
        if (t != null && t.isNotEmpty) 'title': t,
        'privacy': ?privacy,
      });
      if (state.sessionId != sid || state.stopping) return;
      // The answer is the live status plus the leg block, but an older or other answer may be the bare start shape
      // ({session, youtube: {via, ...}}): the via and the watch link are read from either, and a bare answer is
      // never applied as a status (it lacks the account, audio rows and counts): the next status read fills them.
      final yt = raw['youtube'];
      final sess = raw['session'];
      final statusShaped = yt is Map && yt.containsKey('signedIn');
      final dto = statusShaped ? LiveStatusDto.fromJson(raw) : null;
      final rawVia = sess is Map && sess['youtubeVia'] is String
          ? sess['youtubeVia'] as String
          : (yt is Map && yt['via'] is String ? yt['via'] as String : null);
      final via = dto?.youtubeVia ?? rawVia ?? (_source == 'android' && !youtubeViaBoxBuild && !state.controlOnly ? 'device' : 'box');
      final watch = dto?.watchUrl ?? (yt is Map && yt['watchUrl'] is String ? yt['watchUrl'] as String : null);
      _put(
        state.copyWith(
          youtubeViaBox: via == 'box',
          youtubeLeg: via == 'box' ? OutputState.connecting : null,
          sessionYoutube: true,
          watchUrl: watch ?? state.watchUrl,
        ),
      );
      if (dto != null) {
        _apply(dto);
      } else {
        unawaited(pollOnce());
      }
      if (via == 'device' && !state.controlOnly) {
        // the answer carries the key for the owner: the leg opens at once; else the ingest poll waits for it
        final key = yt is Map && yt['key'] is String ? yt['key'] as String : '';
        final ingest = yt is Map && yt['ingest'] is String ? yt['ingest'] as String : '';
        if (key.isNotEmpty && ingest.isNotEmpty) {
          final base = ingest.replaceAll(RegExp(r'/+$'), '');
          try {
            await ref.read(livePublisherProvider).startYoutube('$base/$key');
          } catch (e) {
            debugPrint('youtube leg start failed: ${e.runtimeType}');
            if (!_disposed && state.sessionId == sid) _ingestGaveUp();
          }
        } else {
          _startIngestPoll(sid);
        }
      }
    } on SessionExpired {
      rethrow;
    } on BoxUnreachable {
      _put(state.copyWith(boxReachable: false));
    } on BoxError catch (e) {
      if (e.code == 'already_on') {
        // another device (or an earlier press) already did it: the next status read shows the leg
        await pollOnce();
      } else {
        _put(state.copyWith(notice: _youtubeLaterRefusal(e)));
      }
    } finally {
      if (!_disposed && state.sessionId == sid) _put(state.copyWith(youtubeStarting: false));
    }
  }

  String _youtubeLaterRefusal(BoxError e) {
    // I6: an older MAXCOM has no such route; its answer is a bare 403, 404 or 405 with no code
    if (e.code == null && (e.status == 403 || e.status == 404 || e.status == 405)) return _s.liveYoutubeLaterUpdateBox;
    return switch (e.code) {
      'not_signed_in' => _s.liveYoutubeLaterNotSignedIn,
      'not_owner' => _s.liveYoutubeLaterNotOwner,
      'busy' => _s.liveYoutubeLaterBusy,
      'no_session' => _s.liveYoutubeLaterNoSession,
      'bad_request' => _s.liveYoutubeLaterBadRequest,
      'youtube_off' => _s.liveYoutubeLaterYoutubeOff,
      'tools_missing' => _s.liveYoutubeLaterToolsMissing,
      'no_internet' => _s.liveYoutubeLaterNoInternet,
      'privacy_not_allowed' => _s.liveYoutubeLaterPrivacyNotAllowed,
      'live_rate' => _s.liveRateText,
      _ => errorText(_s, e),
    };
  }

  // ---- YouTube key for the phone's own leg ----

  void _stopIngestPoll() {
    _ingestTimer?.cancel();
    _ingestTimer = null;
  }

  /// Asks `GET /api/live/youtube/ingest` every 2 s for up to 60 s, then
  /// opens the RTMPS leg when it is ready. Failed or timed out: a notice;
  /// the kiosk leg keeps running. The key and URL are never logged.
  void _startIngestPoll(String sessionId) {
    final every = ref.read(youtubeIngestPollIntervalProvider);
    final maxTicks =
        (ref.read(youtubeIngestTimeoutProvider).inMilliseconds /
                every.inMilliseconds)
            .ceil();
    var ticks = 0;
    var busy = false;
    bool current() => !_disposed && state.sessionId == sessionId;
    _ingestTimer = Timer.periodic(every, (timer) async {
      if (busy) return;
      if (!current() || state.stopping) {
        timer.cancel();
        return;
      }
      ticks++;
      busy = true;
      var done = false;
      try {
        final gateway = _gateway;
        if (gateway == null) return;
        final dto = LiveYoutubeIngest.fromJson(
          await gateway.getFresh(
            '/api/live/youtube/ingest',
            quiet: () => state.stopping,
          ),
        );
        if (!current() || state.stopping || !timer.isActive) {
          done = true;
          return;
        }
        if (dto.state == 'ready' && dto.key != null) {
          done = true;
          timer.cancel();
          final base = (dto.ingest ?? '').replaceAll(RegExp(r'/+$'), '');
          final url = base.isEmpty ? dto.key! : '$base/${dto.key}';
          try {
            await ref.read(livePublisherProvider).startYoutube(url);
            final t = _targets;
            if (t != null && current()) {
              _targets = PublisherTargets(
                kuliahId: t.kuliahId,
                outputs: const LiveOutputs(kiosk: true, youtube: true),
                ingestUrl: t.ingestUrl,
                youtubeUrl: url,
              );
            }
          } catch (e) {
            debugPrint('youtube leg start failed: ${e.runtimeType}');
            if (current()) _ingestGaveUp();
          }
        } else if (dto.state == 'failed' || dto.state == 'none') {
          done = true;
          timer.cancel();
          _ingestGaveUp();
        }
      } on Object catch (e) {
        // a missed answer is tried again on the next tick
        if (e is SessionExpired) {
          done = true;
          timer.cancel();
        }
      } finally {
        busy = false;
        if (!done && ticks >= maxTicks && timer.isActive) {
          timer.cancel();
          if (current()) _ingestGaveUp();
        }
      }
    });
  }

  void _ingestGaveUp() {
    _stopIngestPoll();
    _put(
      state.copyWith(
        notice: _youtubeDropped(_boxWarnings, _s) ??
            // The cloud holds the YouTube sign-in: it did not answer, YouTube did not refuse.
            (_boxWarnings.contains(cloudUnreachableWarning)
                ? warningText(cloudUnreachableWarning, _s)
                : warningText('youtube_forbidden', _s)),
      ),
    );
  }

  @visibleForTesting
  void giveUpYoutubeForTest() => _ingestGaveUp();

  @override
  Future<void> stopLive({String? notice, String path = 'user'}) async {
    final publisher = ref.read(livePublisherProvider);
    final gateway = _gateway;
    final id = state.sessionId;
    final control = state.controlOnly;
    logStop(path, sessionId: id);
    _stopIngestPoll();
    // From here to the end the screen says "Menghentikan siaran" and no
    // status poll can flag the box as away (the box is busy with our stop).
    _put(state.copyWith(stopping: true));
    try {
      // The recording is finalised before anything else.
      try {
        // a control-only live published nothing from this phone
        if (!control) await publisher.stop();
      } catch (e) {
        // The box must still be told; log the type only (no secrets).
        debugPrint('publisher stop failed: ${e.runtimeType}');
      } finally {
        _targets = null;
      }
      if (gateway == null || id == null) {
        _put(
          state.copyWith(sessionId: null, youtubeLeg: null, ingestReady: null),
        );
        return;
      }
      // One last look for the summary (YouTube minutes, watch page).
      await pollOnce(duringStop: true);
      if (!await _postStop(gateway, id)) {
        // The stop did not reach the box: it still has the live (and so may
        // YouTube and the TV). Keep the session and try again until it answers.
        _put(state.copyWith(stopFailed: true, notice: _s.ra4StopNotYet));
        _startRetry();
        return;
      }
      _clearSession();
      unawaited(refreshPending());
      unawaited(_syncAfterStop());
    } finally {
      _put(
        state.copyWith(
          stopping: false,
          notice: state.stopFailed ? state.notice : (notice ?? state.notice),
        ),
      );
    }
  }

  void _clearSession() {
    _stopRetry();
    _mine = null;
    _put(
      state.copyWith(
        sessionId: null,
        youtubeLeg: null,
        youtubeViaBox: false,
        ingestReady: null,
        stopFailed: false,
        resume: LiveResume.none,
        controlOnly: false,
        startedAt: null,
        endedGapSeconds: state.gapSeconds,
        endedBroadcastIds: state.broadcastIds,
        gapSeconds: 0,
        broadcastIds: const [],
        warnings: _mediaWarnings(state.warnings, live: false),
      ),
    );
  }

  void _startRetry() {
    _retryTimer ??= Timer.periodic(liveStopRetryInterval, (_) {
      unawaited(retryStop());
    });
  }

  void _stopRetry() {
    _retryTimer?.cancel();
    _retryTimer = null;
  }

  @override
  Future<void> retryStop() async {
    final gateway = _gateway;
    final id = state.sessionId;
    if (_retrying || _disposed || gateway == null || id == null || !state.stopFailed) {
      return;
    }
    _retrying = true;
    logStop('retry', sessionId: id);
    try {
      if (await _postStop(gateway, id)) {
        _clearSession();
        _put(state.copyWith(notice: null));
        unawaited(refreshPending());
        unawaited(_syncAfterStop());
      }
    } finally {
      _retrying = false;
    }
  }

  /// "Henti kecemasan": the Pentadbir (`settings:write`) stops the live of
  /// another device. The box writes the emergency-stop audit entry.
  @override
  Future<void> emergencyStop() async {
    final gateway = _gateway;
    final id = state.otherLive?.sessionId;
    if (gateway == null || id == null) return;
    logStop('emergency', sessionId: id);
    if (!await _postStop(gateway, id)) {
      // Not stopped: the live stays on the screen with its Stop.
      _put(state.copyWith(notice: _s.ra4StopNotYet));
      return;
    }
    _put(state.copyWith(otherLive: null, audio: const [], notice: null));
    unawaited(pollOnce());
  }

  /// `POST /api/live/outputs`: the TV screen and the recording switched during the live. False when the box refused
  /// (`last_output`: the last destination cannot go) or did not answer; the screen then keeps what it showed.
  @override
  Future<bool> setOutputs({bool? kiosk, bool? recording}) async {
    final gateway = _gateway;
    final id = state.sessionId;
    if (gateway == null || id == null) return false;
    try {
      await gateway.post('/api/live/outputs', {
        'sessionId': id,
        // the box requires `kiosk` on every call: a Rakam-only change sends the CURRENT Skrin
        'kiosk': kiosk ?? state.sessionKiosk ?? true,
        'recording': ?recording,
      });
      _put(
        state.copyWith(
          boxReachable: true,
          sessionKiosk: kiosk ?? state.sessionKiosk,
          sessionRecording: recording ?? state.sessionRecording,
        ),
      );
      return true;
    } on BoxError catch (e) {
      _put(state.copyWith(boxReachable: true, notice: e.code == 'last_output' ? _s.liveDestLastOne : errorText(_s, e)));
    } on Object {
      _put(state.copyWith(boxReachable: false));
    }
    return false;
  }

  /// `POST /api/live/stop`. True when the box no longer has that live (it
  /// stopped it, or it was already over: 404 or 409 no_session); false when
  /// the stop did not get an answer from it (away, 401/403/429/5xx): the live
  /// may still be running.
  Future<bool> _postStop(BoxGateway gateway, String id) async {
    try {
      await gateway.post('/api/live/stop', {'sessionId': id});
      _put(state.copyWith(boxReachable: true));
      return true;
    } on OfflineWriteRefused {
      _put(state.copyWith(boxReachable: false));
    } on BoxUnreachable {
      _put(state.copyWith(boxReachable: false));
    } on LiveOnly {
      _put(state.copyWith(boxReachable: false));
    } on Uncertain {
      _put(state.copyWith(boxReachable: false));
    } on SessionExpired {
      // the guard sends the person to unlock; the live is still there
    } on BoxError catch (e) {
      // Only "no such live" means ended: a 404, or a 409 with the box's
      // no_session code. 401/403/429/5xx are not an answer (403 not_owner:
      // another device owns the live, so the session stays).
      if (e.status == 404) return true;
      if (e.status == 409 && (e.code == 'no_session' || e.code == 'not_found')) return true;
      _put(state.copyWith(boxReachable: true));
    }
    return false;
  }

  static String _deviceIn(String message, S s) {
    final m = RegExp(r'\(([^)]+)\)\s*$').firstMatch(message);
    return m?.group(1) ?? s.liveOtherDevice;
  }

  /// The text of one box warning code in the language of [lang] (BM when
  /// none is given), null when unknown.
  @visibleForTesting
  static String? warningText(String code, [S? lang]) {
    final s = lang ?? sBm;
    return switch (code) {
      'youtube_not_signed_in' => s.liveWarnYoutubeNotSignedIn,
      'no_internet' => s.liveWarnNoInternet,
      'youtube_off' => s.liveWarnYoutubeOff,
      'youtube_quota' => s.liveWarnYoutubeQuota,
      'youtube_reauthorise' => s.liveWarnYoutubeReauth,
      'youtube_forbidden' => s.liveWarnYoutubeForbidden,
      // Y9, Y11: the box's own cause, said as it is
      'youtube_live_not_enabled' => s.errcYoutubeLiveNotEnabled,
      'box_clock_wrong' => s.errcBoxClockWrong,
      'youtube_client_refused' => s.errcYoutubeClientRefused,
      'youtube_busy_other_box' => s.errcYoutubeBusyOtherBox,
      'live_rate' => s.liveRateText,
      cloudUnreachableWarning => s.liveWarnCloudUnreachable,
      _ => null,
    };
  }

  static String? _youtubeDropped(List<String> warnings, S s) {
    for (final w in warnings) {
      // the live screen's banner already says this one
      if (w == cloudUnreachableWarning) continue;
      final t = warningText(w, s);
      if (t != null) return t;
    }
    return null;
  }

  // ---- YouTube sign-in ----

  @override
  Future<void> signIn() async {
    final gateway = _gateway;
    if (gateway == null) return;
    _signInTimer?.cancel();
    // away from the surau nothing is sent: the cloud signs nothing in (2026.11.13)
    if (!state.youtubeSignInHere) {
      _put(state.copyWith(notice: _s.liveYoutubeAtSurauOnly));
      return;
    }
    try {
      final dto = YoutubeSignInDto.fromJson(
        await gateway.post('/api/live/youtube/signin', const {}),
      );
      _put(
        state.copyWith(
          notice: null,
          youtube: YoutubeAccount.signingIn(
            userCode: dto.userCode,
            verificationUrl: dto.verificationUrl,
            expiresAt: dto.expiresAt,
          ),
        ),
      );
      _schedulePoll(dto.interval);
    } on LiveOnly {
      // the MAXCOM at the surau did not answer: the sign-in is made there only
      _put(state.copyWith(notice: _s.liveYoutubeAtSurauOnly));
    } on OfflineWriteRefused {
      _put(state.copyWith(boxReachable: false));
    } on BoxError catch (e) {
      _put(state.copyWith(notice: errorText(_s, e)));
    } on BoxUnreachable {
      _put(state.copyWith(boxReachable: false));
    }
  }

  void _schedulePoll(int seconds) {
    _signInTimer?.cancel();
    final wait = Duration(seconds: seconds < 1 ? 1 : seconds);
    _signInTimer = Timer(wait, () => unawaited(_pollSignIn()));
  }

  Future<void> _pollSignIn() async {
    final gateway = _gateway;
    if (gateway == null || _disposed) return;
    try {
      final p = YoutubeSignInPoll.fromJson(
        await gateway.post('/api/live/youtube/signin/poll', const {}),
      );
      if (p.signedIn || p.state == 'signed_in') {
        final a = YoutubeAccount.signedIn(p.channelTitle);
        _put(state.copyWith(youtube: a, notice: null));
      } else if (p.state == 'pending' || p.state == 'error') {
        // the server polls Google itself; a failed look of its own is not the end of the sign-in
        _schedulePoll(p.interval ?? 5);
      } else if (p.state == 'denied' || p.state == 'expired') {
        _put(
          state.copyWith(
            youtube: YoutubeAccount.signedOut(
              reason: p.state == 'denied'
                  ? YoutubeSignOutReason.denied
                  : YoutubeSignOutReason.expired,
            ),
            notice: null,
          ),
        );
      } else {
        _put(
          state.copyWith(
            youtube: const YoutubeAccount.signedOut(),
            notice: _s.liveSignInFailed,
          ),
        );
      }
    } on BoxError catch (e) {
      _put(
        state.copyWith(
          youtube: const YoutubeAccount.signedOut(),
          notice: errorText(_s, e),
        ),
      );
    } on LiveOnly {
      _schedulePoll(5);
    } on OfflineWriteRefused {
      _schedulePoll(5);
    } on BoxUnreachable {
      _schedulePoll(5);
    }
  }

  @override
  Future<void> signOut() async {
    final gateway = _gateway;
    _signInTimer?.cancel();
    if (gateway == null) return;
    // a sign-out or a channel change is made at the surau only (2026.11.13)
    if (!state.youtubeSignInHere) {
      _put(state.copyWith(notice: _s.liveYoutubeAtSurauOnly));
      return;
    }
    try {
      await gateway.post('/api/live/youtube/signout', const {});
      _put(state.copyWith(youtube: const YoutubeAccount.signedOut()));
    } on LiveOnly {
      _put(state.copyWith(notice: _s.liveYoutubeAtSurauOnly));
    } on OfflineWriteRefused {
      _put(state.copyWith(boxReachable: false));
    } on BoxError catch (e) {
      _put(state.copyWith(notice: errorText(_s, e)));
    } on BoxUnreachable {
      _put(state.copyWith(boxReachable: false));
    }
  }

  // ---- recordings bookkeeping (web) ----

  Future<void> refreshPending() async {
    final store = ref.read(recordingsStoreProvider);
    if (store == null) return;
    try {
      final list = await store.pending();
      _put(state.copyWith(recordingsPending: list.length));
    } catch (_) {
      // an unreadable store shows no banner
    }
  }

  /// Offers the oldest unsaved file to the browser (one tap each).
  @override
  Future<void> savePending() async {
    final store = ref.read(recordingsStoreProvider);
    if (store == null) return;
    try {
      final list = await store.pending();
      if (list.isNotEmpty) {
        await store.save(list.first.id);
        await store.markSaved(list.first.id);
      }
    } catch (_) {
      // a blocked download leaves the file pending
    }
    await refreshPending();
  }
}

/// Calls back when the app returns to the front (the Live screen is open).
class _ResumeWatcher with WidgetsBindingObserver {
  _ResumeWatcher(this._onResumed);

  final void Function() _onResumed;

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.resumed) _onResumed();
  }
}

// ---- "Paparkan siaran langsung" (build 5): the per-TV switch of the live ----

/// What the switch card knows: the TVs whose save is in flight, and whether the box has the route at all.
class LiveTvShowState {
  const LiveTvShowState({this.busy = const {}, this.unavailable = false, this.pending = const {}});

  final Set<String> busy;

  /// The box answered 404 to `PUT /api/live/tv-show` (a build 4 box): the card is hidden for the session.
  final bool unavailable;

  /// The value the person just chose per TV, shown until the refreshed settings carry it (or the save failed).
  final Map<String, bool> pending;

  LiveTvShowState copyWith({Set<String>? busy, bool? unavailable, Map<String, bool>? pending}) => LiveTvShowState(
    busy: busy ?? this.busy,
    unavailable: unavailable ?? this.unavailable,
    pending: pending ?? this.pending,
  );
}

class LiveTvShowNotifier extends Notifier<LiveTvShowState> {
  @override
  LiveTvShowState build() => const LiveTvShowState();

  /// Marks the route as missing (also set by a failed write).
  void markUnavailable() => state = state.copyWith(unavailable: true);

  /// Writes the switch of [tvId] (`self` or a device id). True when the box saved it. A 404 without the `unknown_tv`
  /// code is a box without the route. The chosen value shows at once ([LiveTvShowState.pending]) and stays until the
  /// settings have been read again; a failed save puts the old value back.
  Future<bool> set(String tvId, bool show) async {
    final gateway = ref.read(gatewayProvider);
    if (gateway == null || state.busy.contains(tvId)) return false;
    state = state.copyWith(busy: {...state.busy, tvId}, pending: {...state.pending, tvId: show});
    try {
      await gateway.put('/api/live/tv-show', {'tvId': tvId, 'show': show});
      if (!ref.mounted) return true;
      ref.invalidate(settingsProvider);
      try {
        await ref.read(settingsProvider.future);
      } on Object {
        // the next read of the settings carries the value
      }
      return true;
    } on BoxError catch (e) {
      if (e.status == 404 && e.code != 'unknown_tv' && ref.mounted) markUnavailable();
      return false;
    } on Object {
      return false;
    } finally {
      if (ref.mounted) {
        state = state.copyWith(busy: {...state.busy}..remove(tvId), pending: {...state.pending}..remove(tvId));
      }
    }
  }
}

final liveTvShowProvider = NotifierProvider<LiveTvShowNotifier, LiveTvShowState>(LiveTvShowNotifier.new);
