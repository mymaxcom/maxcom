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
  });

  final bool boxReachable;

  /// Changes whenever someone edits the live notice text (the box's `noticeRev`); null while it does not say. The
  /// notice is read again when it changes.
  final int? noticeRev;

  /// False when the answer came from the cloud (2026.11.13): the YouTube grant is held by the MAXCOM at the surau,
  /// so sign-in, sign-out and a channel change are offered at the surau only; away, the screen shows the flag.
  final bool youtubeSignInHere;

  /// The box can reach the internet (the YouTube leg is possible).
  final bool internet;
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

  LiveBoxStatus copyWith({
    bool? boxReachable,
    bool? internet,
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
  }) => LiveBoxStatus(
    boxReachable: boxReachable ?? this.boxReachable,
    internet: internet ?? this.internet,
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
  );
}

/// A live started by another device (see [LiveBoxStatus.otherLive]).
class OtherLive {
  const OtherLive({required this.sessionId, required this.starter, this.video});

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

/// Only the codes the live screen has a banner for. The no-video and
/// cloud-unreachable ones belong to a live that is open (or being started).
Set<String> _mediaWarnings(Iterable<String> codes, {required bool live}) => {
  for (final c in codes)
    if (c == mediaPortsBlocked ||
        (live && (c == noVideoFromDevice || c == cloudUnreachableWarning)))
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
  final maxBitrateKbps = setting('liveYoutube', 'maxBitrateKbps', 2500);
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
  }) async {
    await ref
        .read(livePublisherProvider)
        .start(
          PublisherTargets(
            kuliahId: kuliahId,
            outputs: LiveOutputs(kiosk: true, youtube: youtube),
          ),
        );
  }

  Future<void> stopLive({String? notice}) async {
    await ref.read(livePublisherProvider).stop();
    if (notice != null) state = state.copyWith(notice: notice);
  }

  /// The Pentadbir stops a live another device started ("Henti kecemasan").
  Future<void> emergencyStop() async => state = state.copyWith(otherLive: null);

  /// Tries again to end this device's own live after a stop that did not
  /// reach the box.
  Future<void> retryStop() async {}

  /// True once per live when the person has left the Live page while it is
  /// still running (the screen then says so).
  bool takeLeaveReminder() => false;

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

  /// The status poll is also the heartbeat of the box session (an external
  /// camera live ends 10 minutes after the last one): it runs while the page
  /// is open AND while this device holds a live, whether or not the page is.
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
    _stopIngestPoll();
    _stopRetry();
    final publisher = ref.read(livePublisherProvider);
    _put(state.copyWith(stopping: true));
    try {
      await publisher.stop();
    } catch (e) {
      debugPrint('publisher stop after box end failed: ${e.runtimeType}');
    } finally {
      _targets = null;
    }
    _apply(d);
    _put(
      state.copyWith(
        sessionId: null,
        youtubeLeg: null,
        youtubeViaBox: false,
        ingestReady: null,
        stopping: false,
        // A stop we were retrying needs no "ended by the box" line: it is simply over.
        notice: state.stopFailed ? null : _s.ra4EndedByBox,
        stopFailed: false,
        warnings: _mediaWarnings(state.warnings, live: false),
      ),
    );
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
    if (live && s.youtubeViaBox) {
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
    _put(
      s.copyWith(
        boxReachable: true,
        internet: d.youtubeError != 'network',
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
        warnings: _mediaWarnings(d.warnings, live: live),
        audio: d.audio,
        otherLive: !live && d.sessionId != null
            ? OtherLive(sessionId: d.sessionId!, starter: d.startedBy ?? _s.liveOtherDevice, video: d.video)
            : null,
      ),
    );
  }

  // ---- start and stop ----

  @override
  Future<void> startLive({
    required String? kuliahId,
    required bool youtube,
    VideoSourceKind video = VideoSourceKind.phone,
    LiveAudioMix? mix,
  }) async {
    final publisher = ref.read(livePublisherProvider);
    final gateway = _gateway;
    if (gateway == null) {
      _put(state.copyWith(boxReachable: false, notice: null));
      return;
    }
    final android = _source == 'android';
    final via = android && !youtubeViaBoxBuild ? 'device' : 'box';
    _put(state.copyWith(notice: null, busyDevice: null, youtubeSeconds: 0, stopFailed: false));
    _stopRetry();
    _leftWhileLive = false;
    _leaveAsked = false;

    LiveStartResult result;
    try {
      result = LiveStartResult.fromJson(
        await gateway.post('/api/live/start', {
          'kuliahId': kuliahId,
          'source': _source,
          'outputs': {'kiosk': true, 'youtube': youtube},
          'youtubeVia': via,
          // The external camera and Mic-in: an older box reads neither and starts today's phone live.
          if (video == VideoSourceKind.external || (mix?.boxInput.enabled ?? false)) ...{
            'video': video == VideoSourceKind.external ? 'external' : 'phone',
            'audio': ?mix?.toJson(),
          },
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

    // What the box agreed to for YouTube (it can drop the leg: not signed
    // in, no internet): the publisher is told only what will really run.
    final yt = result.youtube;
    final ytRunning = youtube && yt != null;
    final ytViaDevice = ytRunning && yt.via == 'device' && yt.key != null;
    // Device mode, broadcast still being made: kiosk leg now, the key later.
    final ytLater =
        ytRunning && yt.via == 'device' && yt.key == null && yt.starting;
    _stopIngestPoll();
    final String? ingestUrl = android ? result.srt?.url : result.whip;
    String? youtubeUrl;
    if (ytViaDevice) {
      final base = (yt.ingest ?? '').replaceAll(RegExp(r'/+$'), '');
      youtubeUrl = base.isEmpty ? yt.key : '$base/${yt.key}';
    }
    final targets = PublisherTargets(
      kuliahId: kuliahId,
      outputs: LiveOutputs(kiosk: true, youtube: ytRunning && !ytLater),
      ingestUrl: ingestUrl,
      youtubeUrl: youtubeUrl,
    );
    _targets = targets;
    _put(
      state.copyWith(
        sessionId: result.sessionId,
        boxReachable: true,
        youtubeViaBox: ytRunning && yt.via == 'box',
        youtubeLeg: ytRunning && yt.via == 'box'
            ? OutputState.connecting
            : null,
        ingestReady: false,
        watchUrl: null,
        notice: youtube && !ytRunning ? _youtubeDropped(result.warnings, _s) : null,
        warnings: _mediaWarnings(result.warnings, live: true),
      ),
    );
    try {
      await publisher.start(targets);
    } catch (_) {
      // No picture will come: free the box side again and say so.
      _targets = null;
      _put(
        state.copyWith(sessionId: null, ingestReady: null, notice: _s.liveStartFailed),
      );
      await _postStop(gateway, result.sessionId);
      rethrow;
    }
    if (ytLater) _startIngestPoll(result.sessionId);
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
  Future<void> stopLive({String? notice}) async {
    final publisher = ref.read(livePublisherProvider);
    final gateway = _gateway;
    final id = state.sessionId;
    _stopIngestPoll();
    // From here to the end the screen says "Menghentikan siaran" and no
    // status poll can flag the box as away (the box is busy with our stop).
    _put(state.copyWith(stopping: true));
    try {
      // The recording is finalised before anything else.
      try {
        await publisher.stop();
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
    _put(
      state.copyWith(
        sessionId: null,
        youtubeLeg: null,
        youtubeViaBox: false,
        ingestReady: null,
        stopFailed: false,
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
    try {
      if (await _postStop(gateway, id)) {
        _clearSession();
        _put(state.copyWith(notice: null));
        unawaited(refreshPending());
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
    if (!await _postStop(gateway, id)) {
      // Not stopped: the live stays on the screen with its Stop.
      _put(state.copyWith(notice: _s.ra4StopNotYet));
      return;
    }
    _put(state.copyWith(otherLive: null, audio: const [], notice: null));
    unawaited(pollOnce());
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
