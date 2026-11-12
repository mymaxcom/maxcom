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
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../app/deps.dart';
import '../../app/providers.dart';
import '../../box/box_client.dart';
import '../../sync/live_only.dart';
import '../shell/box_gateway.dart';
import 'publisher.dart';
import 'recordings_store.dart';

// ---- the box's side ----

enum YoutubeAccountPhase { signedOut, signingIn, signedIn }

class YoutubeAccount {
  const YoutubeAccount.signedOut()
    : phase = YoutubeAccountPhase.signedOut,
      userCode = null,
      verificationUrl = null,
      channel = null;

  const YoutubeAccount.signingIn({this.userCode, this.verificationUrl})
    : phase = YoutubeAccountPhase.signingIn,
      channel = null;

  const YoutubeAccount.signedIn(this.channel)
    : phase = YoutubeAccountPhase.signedIn,
      userCode = null,
      verificationUrl = null;

  final YoutubeAccountPhase phase;

  /// The device code to type at google.com/device.
  final String? userCode;
  final String? verificationUrl;

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
  });

  final bool boxReachable;

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
  );
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

  final p = publisherFor(
    deps.platform,
    box: ref.read(enrolledBoxProvider)?.box,
    tokenProvider: () async => ref.read(sessionProvider)?.token,
    segmentMinutes: setting('recording', 'segmentMinutes', 15),
    maxBitrateKbps: setting('liveYoutube', 'maxBitrateKbps', 2500),
  );
  ref.onDispose(() => disposePublisher(p));
  return p;
});

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

  Future<void> stopLive() => ref.read(livePublisherProvider).stop();

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

  static const String signInFailed =
      'Log masuk YouTube tidak berjaya. Cuba lagi.';
  static const String startFailed = 'Siaran tidak dapat dimulakan';

  Timer? _poll;
  Timer? _signInTimer;
  Timer? _ingestTimer;
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
      _poll?.cancel();
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
    if (!_disposed) state = s;
  }

  // ---- polling ----

  @override
  void attach() {
    if (_attached) return;
    _attached = true;
    unawaited(refreshPending());
    unawaited(pollOnce());
    _poll = Timer.periodic(ref.read(livePollIntervalProvider), (_) {
      unawaited(pollOnce());
    });
  }

  @override
  void detach() {
    _attached = false;
    _poll?.cancel();
    _poll = null;
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
      final dto = LiveStatusDto.fromJson(
        await gateway.getFresh('/api/live/status', quiet: () => state.stopping),
      );
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

  static const endedByBox = 'Siaran telah dihentikan oleh kotak.';

  /// The box no longer has our session (or has another one): the live is
  /// over. Stop the publisher, clear the state, tell the person. No stop
  /// is POSTed: there is nothing left to stop on the box.
  Future<void> _endedByBox(LiveStatusDto d) async {
    _stopIngestPoll();
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
        notice: endedByBox,
        warnings: _mediaWarnings(state.warnings, live: false),
      ),
    );
  }

  void _apply(LiveStatusDto d) {
    final s = state;
    final live = s.sessionId != null;
    final YoutubeAccount account;
    if (d.youtubeSignedIn) {
      account = YoutubeAccount.signedIn(d.channelTitle);
    } else if (s.youtube.phase == YoutubeAccountPhase.signingIn) {
      account = s.youtube;
    } else {
      account = const YoutubeAccount.signedOut();
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
        busyDevice: d.sessionId == null ? null : s.busyDevice,
        youtubeSeconds: live && d.youtubeReceiving
            ? s.youtubeSeconds + ref.read(livePollIntervalProvider).inSeconds
            : s.youtubeSeconds,
        watchUrl: live ? (d.watchUrl ?? s.watchUrl) : s.watchUrl,
        youtubeLeg: leg,
        ingestReady: live ? d.ingestReady : null,
        warnings: _mediaWarnings(d.warnings, live: live),
      ),
    );
  }

  // ---- start and stop ----

  @override
  Future<void> startLive({
    required String? kuliahId,
    required bool youtube,
  }) async {
    final publisher = ref.read(livePublisherProvider);
    final gateway = _gateway;
    if (gateway == null) {
      _put(state.copyWith(boxReachable: false, notice: null));
      return;
    }
    final android = _source == 'android';
    final via = android && !youtubeViaBoxBuild ? 'device' : 'box';
    _put(state.copyWith(notice: null, busyDevice: null, youtubeSeconds: 0));

    LiveStartResult result;
    try {
      result = LiveStartResult.fromJson(
        await gateway.post('/api/live/start', {
          'kuliahId': kuliahId,
          'source': _source,
          'outputs': {'kiosk': true, 'youtube': youtube},
          'youtubeVia': via,
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
        _put(state.copyWith(busyDevice: _deviceIn(e.message)));
      } else if (e.code == 'live_rate') {
        _put(state.copyWith(notice: liveRateText));
      } else {
        _put(state.copyWith(notice: e.message));
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
        notice: youtube && !ytRunning ? _youtubeDropped(result.warnings) : null,
        warnings: _mediaWarnings(result.warnings, live: true),
      ),
    );
    try {
      await publisher.start(targets);
    } catch (_) {
      // No picture will come: free the box side again and say so.
      _targets = null;
      _put(
        state.copyWith(sessionId: null, ingestReady: null, notice: startFailed),
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
        notice:
            _youtubeDropped(_boxWarnings) ?? warningText('youtube_forbidden'),
      ),
    );
  }

  @override
  Future<void> stopLive() async {
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
      await _postStop(gateway, id);
      _put(
        state.copyWith(
          sessionId: null,
          youtubeLeg: null,
          youtubeViaBox: false,
          ingestReady: null,
          warnings: _mediaWarnings(state.warnings, live: false),
        ),
      );
      unawaited(refreshPending());
    } finally {
      _put(state.copyWith(stopping: false));
    }
  }

  Future<void> _postStop(BoxGateway gateway, String id) async {
    try {
      await gateway.post('/api/live/stop', {'sessionId': id});
      _put(state.copyWith(boxReachable: true));
    } on OfflineWriteRefused {
      _put(state.copyWith(boxReachable: false));
    } on BoxUnreachable {
      _put(state.copyWith(boxReachable: false));
    } on SessionExpired {
      // the guard sends the person to unlock
    } on BoxError {
      // already ended on the box: nothing to do
    }
  }

  static String _deviceIn(String message) {
    final m = RegExp(r'\(([^)]+)\)\s*$').firstMatch(message);
    return m?.group(1) ?? 'peranti lain';
  }

  static const liveRateText =
      'Terlalu banyak cubaan mula siaran. Cuba lagi sebentar lagi.';

  /// BM text of one box warning code, null when unknown.
  @visibleForTesting
  static String? warningText(String code) => switch (code) {
    'youtube_not_signed_in' =>
      'YouTube belum dilog masuk di kotak. Siaran ke skrin surau berjalan.',
    'no_internet' => 'Tiada internet: YouTube dimatikan',
    'youtube_off' => 'YouTube dimatikan oleh pentadbir',
    'youtube_quota' => 'Kuota YouTube hari ini telah habis.',
    'youtube_reauthorise' => 'Log masuk YouTube perlu diperbaharui.',
    'youtube_forbidden' => 'YouTube menolak permintaan.',
    'live_rate' => liveRateText,
    cloudUnreachableWarning => 'YouTube: awan tidak dapat dihubungi',
    _ => null,
  };

  static String? _youtubeDropped(List<String> warnings) {
    for (final w in warnings) {
      // the live screen's banner already says this one
      if (w == cloudUnreachableWarning) continue;
      final t = warningText(w);
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
          ),
        ),
      );
      _schedulePoll(dto.interval);
    } on LiveOnly {
      // the cloud holds the YouTube sign-in and did not answer
      _put(state.copyWith(notice: liveOnlyMessage));
    } on OfflineWriteRefused {
      _put(state.copyWith(boxReachable: false));
    } on BoxError catch (e) {
      _put(state.copyWith(notice: e.message));
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
        _put(
          state.copyWith(
            youtube: YoutubeAccount.signedIn(p.channelTitle),
            notice: null,
          ),
        );
      } else if (p.state == 'pending') {
        _schedulePoll(p.interval ?? 5);
      } else {
        _put(
          state.copyWith(
            youtube: const YoutubeAccount.signedOut(),
            notice: signInFailed,
          ),
        );
      }
    } on BoxError catch (e) {
      _put(
        state.copyWith(
          youtube: const YoutubeAccount.signedOut(),
          notice: e.message,
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
    try {
      await gateway.post('/api/live/youtube/signout', const {});
      _put(state.copyWith(youtube: const YoutubeAccount.signedOut()));
    } on LiveOnly {
      _put(state.copyWith(notice: liveOnlyMessage));
    } on OfflineWriteRefused {
      _put(state.copyWith(boxReachable: false));
    } on BoxError catch (e) {
      _put(state.copyWith(notice: e.message));
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
