// The Live controller against a fake box and a fake publisher (Plan 5
// Task 8): the start body and targets per platform, the order of stop,
// refusals, the box going away during a live, polling, YouTube sign-in
// and the web recordings bookkeeping.

import 'dart:async';
import 'dart:convert';

import 'package:flutter/widgets.dart' show AppLifecycleState;
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:surau_app/l10n/s_lookup.dart';
import 'package:surau_app/app/app_lang.dart';
import 'package:surau_app/app/deps.dart';
import 'package:surau_app/app/providers.dart';
import 'package:surau_app/features/common/surau_info.dart';
import 'package:surau_app/features/enrol/enrol_flow.dart';
import 'package:surau_app/features/live/fake_publisher.dart';
import 'package:surau_app/box/wire.dart';
import 'package:surau_app/features/live/live_controller.dart';
import 'package:surau_app/l10n/generated/s_ar.dart';
import 'package:surau_app/l10n/generated/s_en.dart';
import 'package:surau_app/l10n/generated/s_ms.dart';
import 'package:surau_app/features/live/live_destinations.dart';
import 'package:surau_app/features/live/publisher.dart';
import 'package:surau_app/features/live/recordings_store.dart';
import 'package:surau_app/features/shell/read_cache.dart';
import 'package:surau_app/features/shell/box_gateway.dart';

import '../fakes.dart';

const _key = 'abcd-efgh-ijkl-mnop-qrst';
const _pass = 'PassPhraseOf24CharsLong1';

Map<String, Object?> _startAnswer({
  String? ytVia,
  bool srt = true,
  List<String> warnings = const [],
}) => {
  'session': {'id': 's1'},
  'ingest': {
    'whip': '/api/live/whip',
    'srt': srt
        ? {
            'host': '10.168.1.20',
            'port': 8890,
            'streamId': 'publish:surau:pub-s1:SecretCred',
            'passphrase': _pass,
          }
        : null,
  },
  'youtube': ytVia == null
      ? null
      : ytVia == 'device'
      ? {
          'via': 'device',
          'ingest': 'rtmps://a.rtmps.youtube.com:443/live2',
          'key': _key,
        }
      : {'via': 'box', 'ingest': null, 'key': null},
  if (warnings.isNotEmpty) 'warnings': warnings,
};

Map<String, Object?> _status({
  String? session,
  String ytState = 'none',
  String? health,
  String relay = 'off',
  String? watch,
  bool signedIn = true,
  Map<String, Object?>? signIn,
  String? lastError,
  List<String> warnings = const [],
}) => {
  'warnings': warnings,
  'session': session == null ? null : {'id': session, 'startedBy': 'Ustaz Ali'},
  'ingest': {'ready': session != null},
  'relay': {'state': relay},
  'youtube': {
    'signedIn': signedIn,
    'channelTitle': signedIn ? 'Surau Contoh' : null,
    'state': ytState,
    'health': health,
    'watchUrl': watch,
    'lastError': lastError,
    if (signIn != null) 'signIn': signIn,
  },
};

final List<_Env> _envs = [];

/// A widget test whose live session (and so its 2 s heartbeat) is closed with the container
/// before the framework looks for timers still pending.
void _liveTest(String name, Future<void> Function(WidgetTester tester) body) {
  testWidgets(name, (tester) async {
    try {
      await body(tester);
    } finally {
      for (final e in _envs) {
        e.container.dispose();
      }
      _envs.clear();
    }
  });
}

class _Env {
  _Env(this.platform, {bool throwingStop = false, FakePublisher Function(List<String> log)? publisher, bool liveOnly = false, Map<String, dynamic>? settings, Duration? ingestEvery}) {
    pub = publisher != null ? publisher(log) : (throwingStop ? _ThrowingStopPublisher(log) : _LoggingPublisher(log));
    box = FakeBox(_handle);
    final enrolled = fixtureBox(roles: ['media']);
    deps = AppDeps(
      boxStore: MemoryEnrolledBoxStore()..save(enrolled),
      surauInfoStore: MemorySurauInfoStore(SurauInfo.fromJson(fixtureInfoJson)),
      key: FakeDeviceKey(present: true),
      trust: FakeTrust(),
      biometric: FakeBiometricPin(),
      clientFor: (u) => box.client(u),
      enrolledClient: (b) async => box.client(b.box),
      platform: platform,
      cameraAvailable: false,
      healthPollInterval: null,
      now: fixedNow,
      initialBox: enrolled,
    );
    container = ProviderContainer(
      overrides: [
        appDepsProvider.overrideWithValue(deps),
        livePublisherProvider.overrideWithValue(pub),
        recordingsStoreProvider.overrideWithValue(store),
        if (settings != null) settingsProvider.overrideWith(() => _FixedSettings(settings)),
        if (ingestEvery != null) youtubeIngestPollIntervalProvider.overrideWithValue(ingestEvery),
        gatewayProvider.overrideWith(
          (ref) => liveOnly
              ? _LiveOnlyGateway(client: box.client(Uri.parse('https://box.test:8443')), reach: ref.watch(connectivityProvider.notifier))
              : BoxGateway(
            client: box.client(Uri.parse('https://box.test:8443')),
            token: 'tok-1',
            cache: ReadCache(store: null, boxId: 'b'),
            reach: ref.watch(connectivityProvider.notifier),
            now: fixedNow,
            onSessionExpired: () {},
          ),
        ),
      ],
    );
    _envs.add(this);
  }

  final String platform;
  late final FakeBox box;
  late final AppDeps deps;
  late final ProviderContainer container;
  late final FakePublisher pub;
  final MemoryRecordingsStore store = MemoryRecordingsStore();

  /// Every request as `METHOD path`, in order (across publisher calls too).
  final List<String> log = [];
  Map<String, Object?> startAnswer = _startAnswer();
  Map<String, Object?> status = _status();
  int startStatus = 200;
  Map<String, Object?> startError = const {};
  bool away = false;
  bool statusDown = false;
  Completer<void>? stopGate;
  int stopStatus = 200;
  String? stopCode;
  int signinStatus = 200;
  Map<String, Object?> signinError = const {};
  Map<String, Object?> signin = {
    'verificationUrl': 'https://www.google.com/device',
    'userCode': 'ABCD-EFGH',
    'expiresAt': 'x',
    'interval': 5,
  };
  final List<Map<String, Object?>> polls = [];

  /// O34 `POST /api/live/youtube/start` and the ingest key the phone then asks for; O4 `POST /api/live/camera/release`.
  int ytStartStatus = 200;
  Map<String, Object?> ytStartAnswer = const {};
  Map<String, Object?> ingestAnswer = const {'state': 'none'};
  int releaseStatus = 204;

  /// `GET /api/live/youtube/status`; null answers 404 (a box that has no such route).
  Map<String, Object?>? ytStatus;

  /// `GET /api/live/sessions/recent`; null answers 404 (an older box).
  List<Map<String, Object?>>? recent;

  Future<http.Response> _handle(http.Request r) async {
    if (away) throw http.ClientException('box away');
    log.add('${r.method} ${r.url.path}');
    switch ('${r.method} ${r.url.path}') {
      case 'POST /api/live/start':
        return startStatus == 200
            ? jsonResponse(200, startAnswer)
            : jsonResponse(startStatus, startError);
      case 'POST /api/live/outputs':
        return jsonResponse(200, status);
      case 'POST /api/live/stop':
        await stopGate?.future;
        return stopStatus == 200
            ? jsonResponse(200, {'stopped': true})
            : jsonResponse(stopStatus, {'errors': ['x'], if (stopCode != null) 'code': stopCode});
      case 'GET /api/live/status':
        if (statusDown) throw http.ClientException('status down');
        return jsonResponse(200, status);
      case 'GET /api/live/sessions/recent':
        return recent == null ? jsonResponse(404, {'errors': ['tiada']}) : jsonResponse(200, {'sessions': recent});
      case 'GET /api/live/youtube/status':
        return ytStatus == null ? jsonResponse(404, {'errors': ['tiada']}) : jsonResponse(200, ytStatus!);
      case 'POST /api/live/youtube/signin':
        return signinStatus == 200
            ? jsonResponse(200, signin)
            : jsonResponse(signinStatus, signinError);
      case 'POST /api/live/youtube/signin/poll':
        return jsonResponse(
          200,
          polls.isEmpty
              ? {'state': 'pending', 'signedIn': false}
              : polls.removeAt(0),
        );
      case 'POST /api/live/youtube/start':
        return jsonResponse(ytStartStatus, ytStartAnswer);
      case 'GET /api/live/youtube/ingest':
        return jsonResponse(200, ingestAnswer);
      case 'POST /api/live/camera/release':
        return http.Response('', releaseStatus);
      case 'POST /api/live/youtube/signout':
        return jsonResponse(200, {'signedIn': false});
    }
    return jsonResponse(404, {
      'errors': ['tiada'],
    });
  }

  LiveController get ctrl =>
      container.read(liveBoxProvider.notifier) as LiveController;
  LiveBoxStatus get state => container.read(liveBoxProvider);

  Map<String, dynamic> startBody() => jsonDecode(
    box.seen.firstWhere((r) => r.url.path == '/api/live/start').body,
  ) as Map<String, dynamic>;
}

Future<void> _drain(WidgetTester tester) async {
  for (var i = 0; i < 5; i++) {
    await tester.pump(const Duration(milliseconds: 10));
  }
}

void main() {
  revampTests();
  _liveTest('web start posts source web, youtubeVia box; the box relays '
      'so the publisher gets the WHIP path and no YouTube key', (tester) async {
    final e = _Env('web')..startAnswer = _startAnswer(ytVia: 'box', srt: false);
    await e.ctrl.startLive(kuliahId: 'c3', youtube: true);
    expect(e.startBody(), {
      'kuliahId': 'c3',
      'source': 'web',
      'outputs': {'kiosk': true, 'youtube': true},
      'youtubeVia': 'box',
    });
    final t = e.pub.started.single;
    expect(t.ingestUrl, '/api/live/whip');
    expect(t.youtubeUrl, isNull);
    expect(t.outputs.youtube, isTrue);
    expect(e.state.sessionId, 's1');
    expect(e.state.youtubeViaBox, isTrue);
  });

  _liveTest('android start posts youtubeVia device and hands the SRT '
      'target and the YouTube key to the publisher', (tester) async {
    final e = _Env('android')..startAnswer = _startAnswer(ytVia: 'device');
    await e.ctrl.startLive(kuliahId: null, youtube: true);
    final body = e.startBody();
    expect(body['source'], 'android');
    expect(body['youtubeVia'], 'device');
    expect(body['kuliahId'], isNull);
    final t = e.pub.started.single;
    final srt = Uri.parse(t.ingestUrl!);
    expect(srt.scheme, 'srt');
    expect(srt.host, '10.168.1.20');
    expect(srt.port, 8890);
    expect(srt.queryParameters['streamid'], 'publish:surau:pub-s1:SecretCred');
    expect(srt.queryParameters['passphrase'], _pass);
    expect(t.youtubeUrl, 'rtmps://a.rtmps.youtube.com:443/live2/$_key');
    expect(e.state.youtubeViaBox, isFalse);
    // the secrets are in no printable form
    expect(t.toString(), isNot(contains(_key)));
    expect(t.toString(), isNot(contains(_pass)));
    expect(e.state.toString(), isNot(contains(_key)));
  });

  _liveTest('YouTube off sends youtube false and no key is held', (
    tester,
  ) async {
    final e = _Env('android');
    await e.ctrl.startLive(kuliahId: 'c3', youtube: false);
    expect(e.startBody()['outputs'], {'kiosk': true, 'youtube': false});
    final t = e.pub.started.single;
    expect(t.outputs.youtube, isFalse);
    expect(t.youtubeUrl, isNull);
  });

  _liveTest('a YouTube leg the box dropped is not started on the phone', (
    tester,
  ) async {
    final e = _Env('android')
      ..startAnswer = _startAnswer(warnings: ['youtube_not_signed_in']);
    await e.ctrl.startLive(kuliahId: 'c3', youtube: true);
    final t = e.pub.started.single;
    expect(t.outputs.youtube, isFalse);
    expect(t.youtubeUrl, isNull);
    expect(e.state.notice, contains('YouTube'));
  });

  _liveTest('stop ends the publisher before POST /api/live/stop; the '
      'credentials are gone afterwards', (tester) async {
    final e = _Env('android')..startAnswer = _startAnswer(ytVia: 'device');
    await e.ctrl.startLive(kuliahId: 'c3', youtube: true);
    expect(e.ctrl.holdsTargets, isTrue);
    await e.ctrl.stopLive();
    final iPub = e.log.indexOf('publisher.stop');
    final iBox = e.log.indexOf('POST /api/live/stop');
    expect(iPub, greaterThan(-1));
    expect(iBox, greaterThan(iPub), reason: 'recording is finalised first');
    expect(e.pub.current.phase, PublisherPhase.stopped);
    expect(e.ctrl.holdsTargets, isFalse);
    expect(e.state.sessionId, isNull);
    final stopBody = jsonDecode(
      e.box.seen.lastWhere((r) => r.url.path == '/api/live/stop').body,
    );
    expect(stopBody, {'sessionId': 's1'});
  });

  _liveTest('409 live_busy shows who is live and never starts the '
      'publisher', (tester) async {
    final e = _Env('web')
      ..startStatus = 409
      ..startError = {
        'errors': ['Siaran sedang berjalan dari peranti lain (iPad Surau)'],
        'code': 'live_busy',
      };
    await e.ctrl.startLive(kuliahId: 'c3', youtube: false);
    expect(e.state.busyDevice, 'iPad Surau');
    expect(e.pub.started, isEmpty);
    expect(e.state.sessionId, isNull);
  });

  _liveTest('another refusal shows the box\'s own words', (tester) async {
    final e = _Env('web')
      ..startStatus = 409
      ..startError = {
        'errors': ['Siaran langsung di skrin dimatikan'],
        'code': 'live_off',
      };
    await e.ctrl.startLive(kuliahId: null, youtube: false);
    expect(e.state.notice, 'Siaran langsung di skrin dimatikan');
    expect(e.pub.started, isEmpty);
  });

  _liveTest('a box that cannot be reached at start never starts the '
      'publisher', (tester) async {
    final e = _Env('android')..away = true;
    await e.ctrl.startLive(kuliahId: 'c3', youtube: false);
    expect(e.pub.started, isEmpty);
    expect(e.state.boxReachable, isFalse);
    expect(e.state.sessionId, isNull);
  });

  _liveTest('a publisher that fails to start frees the box session', (
    tester,
  ) async {
    final e = _Env('android');
    final failing = _FailingPublisher();
    final c = ProviderContainer(
      overrides: [
        appDepsProvider.overrideWithValue(e.deps),
        livePublisherProvider.overrideWithValue(failing),
        gatewayProvider.overrideWith(
          (ref) => BoxGateway(
            client: e.box.client(Uri.parse('https://box.test:8443')),
            token: 'tok-1',
            cache: ReadCache(store: null, boxId: 'b'),
            reach: ref.watch(connectivityProvider.notifier),
            now: fixedNow,
            onSessionExpired: () {},
          ),
        ),
      ],
    );
    addTearDown(c.dispose);
    final ctrl = c.read(liveBoxProvider.notifier) as LiveController;
    await expectLater(
      ctrl.startLive(kuliahId: null, youtube: false),
      throwsA(isA<StateError>()),
    );
    expect(e.log, contains('POST /api/live/stop'));
    expect(c.read(liveBoxProvider).sessionId, isNull);
  });

  _liveTest('a status failure during a live keeps the publisher and marks '
      'the box unreachable; it comes back on the next good poll', (
    tester,
  ) async {
    final e = _Env('web')..startAnswer = _startAnswer(srt: false);
    await e.ctrl.startLive(kuliahId: 'c3', youtube: false);
    final stopsBefore = e.pub.stops;
    e.away = true;
    await e.ctrl.pollOnce();
    expect(e.state.boxReachable, isFalse);
    expect(e.pub.stops, stopsBefore);
    expect(e.pub.current.phase, PublisherPhase.live);
    expect(e.state.sessionId, 's1');
    e.away = false;
    await e.ctrl.pollOnce();
    expect(e.state.boxReachable, isTrue);
  });

  _liveTest('media warnings of the box reach the state: from the start '
      'answer and from every poll, and no_video clears when the picture '
      'arrives', (tester) async {
    final e = _Env('android')
      ..startAnswer = _startAnswer(warnings: ['media_ports_blocked']);
    expect(e.state.warnings, isEmpty);
    await e.ctrl.startLive(kuliahId: 'c3', youtube: false);
    expect(e.state.warnings, {'media_ports_blocked'});

    e.status = _status(
      session: 's1',
      warnings: ['media_ports_blocked', 'no_video_from_device'],
    );
    await e.ctrl.pollOnce();
    expect(e.state.warnings, {'media_ports_blocked', 'no_video_from_device'});

    e.status = _status(session: 's1');
    await e.ctrl.pollOnce();
    expect(e.state.warnings, isEmpty);

    // a code this app does not know is ignored, not shown
    e.status = _status(session: 's1', warnings: ['something_new']);
    await e.ctrl.pollOnce();
    expect(e.state.warnings, isEmpty);
  });

  _liveTest('polls every 2 s while attached and stops when detached', (
    tester,
  ) async {
    final e = _Env('android');
    e.ctrl.attach();
    await _drain(tester);
    int polls() => e.log.where((l) => l == 'GET /api/live/status').length;
    final first = polls();
    expect(first, greaterThanOrEqualTo(1));
    await tester.pump(const Duration(seconds: 2));
    await _drain(tester);
    expect(polls(), first + 1);
    await tester.pump(const Duration(seconds: 2));
    await _drain(tester);
    expect(polls(), first + 2);
    e.ctrl.detach();
    expect(e.ctrl.polling, isFalse);
    await tester.pump(const Duration(seconds: 10));
    await _drain(tester);
    expect(polls(), first + 2);
  });

  _liveTest('another device live: its watch link is kept, cleared when no session runs', (tester) async {
    final e = _Env('android');
    e.status = _status(session: 's9', ytState: 'live', watch: 'https://youtu.be/xyz');
    await e.ctrl.pollOnce();
    expect(e.state.otherLive, isNotNull);
    expect(e.state.watchUrl, 'https://youtu.be/xyz');
    e.status = _status();
    await e.ctrl.pollOnce();
    expect(e.state.otherLive, isNull);
    expect(e.state.watchUrl, isNull);
  });

  _liveTest('YouTube seconds add up while YouTube receives, for the '
      'summary, and the watch page is kept', (tester) async {
    final e = _Env('android')..startAnswer = _startAnswer(ytVia: 'device');
    await e.ctrl.startLive(kuliahId: 'c3', youtube: true);
    e.status = _status(
      session: 's1',
      ytState: 'live',
      health: 'good',
      watch: 'https://youtu.be/xyz',
    );
    await e.ctrl.pollOnce();
    await e.ctrl.pollOnce();
    await e.ctrl.pollOnce();
    expect(e.state.youtubeSeconds, 6);
    expect(e.state.watchUrl, 'https://youtu.be/xyz');
    // not receiving: no more seconds
    e.status = _status(session: 's1', ytState: 'live', health: null);
    await e.ctrl.pollOnce();
    expect(e.state.youtubeSeconds, 6);
  });

  _liveTest('the kiosk leg is not on air until the box confirms the '
      'stream; ready turns it on', (tester) async {
    final e = _Env('android');
    await e.ctrl.startLive(kuliahId: null, youtube: false);
    // the phone believes it is up, but the box has no publisher
    expect(e.state.ingestReady, isFalse);
    expect(
      kioskLeg(OutputState.up, e.state.ingestReady)!.phase,
      OutputPhase.connecting,
    );
    e.status = {
      ..._status(session: 's1'),
      'ingest': {'ready': false},
    };
    await e.ctrl.pollOnce();
    expect(e.state.ingestReady, isFalse);
    expect(
      kioskLeg(OutputState.up, e.state.ingestReady)!.phase,
      OutputPhase.connecting,
    );
    // a retry or failure the phone reports is shown as it is
    expect(
      kioskLeg(const OutputState(OutputPhase.retrying), false)!.phase,
      OutputPhase.retrying,
    );
    e.status = _status(session: 's1');
    await e.ctrl.pollOnce();
    expect(e.state.ingestReady, isTrue);
    expect(
      kioskLeg(OutputState.up, e.state.ingestReady)!.phase,
      OutputPhase.up,
    );
    // no box view (tests without a box): the phone's word stands
    expect(kioskLeg(OutputState.up, null)!.phase, OutputPhase.up);
    await e.ctrl.stopLive();
    expect(e.state.ingestReady, isNull);
  });

  _liveTest('a box-relayed leg takes its light from the box', (tester) async {
    final e = _Env('web')..startAnswer = _startAnswer(ytVia: 'box', srt: false);
    await e.ctrl.startLive(kuliahId: 'c3', youtube: true);
    e.status = _status(session: 's1', relay: 'retrying');
    await e.ctrl.pollOnce();
    expect(e.state.youtubeLeg!.phase, OutputPhase.retrying);
    e.status = _status(
      session: 's1',
      ytState: 'live',
      health: 'ok',
      relay: 'running',
    );
    await e.ctrl.pollOnce();
    expect(e.state.youtubeLeg!.phase, OutputPhase.up);
  });

  _liveTest('sign-in shows the code, polls at the box\'s interval and '
      'ends signed in', (tester) async {
    final e = _Env('android');
    e.polls.addAll([
      {'state': 'pending', 'signedIn': false, 'interval': 5},
      {
        'state': 'signed_in',
        'signedIn': true,
        'channelTitle': 'Surau Contoh',
      },
    ]);
    await e.ctrl.signIn();
    expect(e.state.youtube.phase, YoutubeAccountPhase.signingIn);
    expect(e.state.youtube.userCode, 'ABCD-EFGH');
    expect(e.state.youtube.verificationUrl, 'https://www.google.com/device');
    int polls() =>
        e.log.where((l) => l == 'POST /api/live/youtube/signin/poll').length;
    await tester.pump(const Duration(seconds: 4));
    await _drain(tester);
    expect(polls(), 0, reason: 'not before the interval');
    await tester.pump(const Duration(seconds: 1));
    await _drain(tester);
    expect(polls(), 1);
    expect(e.state.youtube.phase, YoutubeAccountPhase.signingIn);
    await tester.pump(const Duration(seconds: 5));
    await _drain(tester);
    expect(polls(), 2);
    expect(e.state.youtube.signedIn, isTrue);
    expect(e.state.youtube.channel, 'Surau Contoh');
  });

  _liveTest('an expired or denied sign-in goes back to signed out with its '
      'own line, not a notice', (tester) async {
    final e = _Env('android');
    e.polls.add({'state': 'expired', 'signedIn': false});
    await e.ctrl.signIn();
    await tester.pump(const Duration(seconds: 5));
    await _drain(tester);
    expect(e.state.youtube.phase, YoutubeAccountPhase.signedOut);
    expect(e.state.youtube.reason, YoutubeSignOutReason.expired);
    expect(e.state.notice, isNull);
    // a status poll with nothing pending does not wipe what ended the attempt
    e.status = _status(signedIn: false);
    await e.ctrl.pollOnce();
    expect(e.state.youtube.reason, YoutubeSignOutReason.expired);
  });

  _liveTest('a sign-in the server holds shows after a cold start (code, '
      'address, expiry) without this app having started it', (tester) async {
    final e = _Env('android');
    final expires = fixedNow().add(const Duration(minutes: 8));
    e.status = _status(
      signedIn: false,
      signIn: {
        'state': 'pending',
        'userCode': 'WXYZ-1234',
        'verificationUrl': 'https://www.google.com/device',
        'expiresAt': expires.toUtc().toIso8601String(),
      },
    );
    await e.ctrl.pollOnce();
    expect(e.state.youtube.phase, YoutubeAccountPhase.signingIn);
    expect(e.state.youtube.userCode, 'WXYZ-1234');
    expect(e.state.youtube.verificationUrl, 'https://www.google.com/device');
    expect(e.state.youtube.expiresAt, isNotNull);
    expect(e.log.where((l) => l.contains('signin')), isEmpty);
    // the server finished it while the app was away
    e.status = _status();
    await e.ctrl.pollOnce();
    expect(e.state.youtube.signedIn, isTrue);
    expect(e.state.youtube.channel, 'Surau Contoh');
  });

  _liveTest('the server reports denied and expired; and Google withdrawing '
      'the access reads as revoked', (tester) async {
    final e = _Env('android');
    e.status = _status(signedIn: false, signIn: {'state': 'denied'});
    await e.ctrl.pollOnce();
    expect(e.state.youtube.reason, YoutubeSignOutReason.denied);
    e.status = _status(signedIn: false, signIn: {'state': 'expired'});
    await e.ctrl.pollOnce();
    expect(e.state.youtube.reason, YoutubeSignOutReason.expired);
    final f = _Env('android');
    f.status = _status(signedIn: false, lastError: 'reauthorise');
    await f.ctrl.pollOnce();
    expect(f.state.youtube.phase, YoutubeAccountPhase.signedOut);
    expect(f.state.youtube.reason, YoutubeSignOutReason.revoked);
  });

  _liveTest('2026.11.13: the box holds the grant, so its status is taken as it is '
      '(no hold against a lagging box any more)', (tester) async {
    final e = _Env('android');
    e.status = _status(signedIn: false);
    e.ytStatus = {'configured': true, 'signedIn': true, 'channelTitle': 'Surau Satu', 'lastError': null};
    await e.ctrl.refreshYoutube();
    expect(e.state.youtube.signedIn, isTrue);
    expect(e.state.youtubeSignInHere, isTrue);
    await e.ctrl.pollOnce();
    expect(e.state.youtube.signedIn, isFalse);
  });

  _liveTest('W5: state unknown (a newer box) is NOT signed out: last channel kept, the poll does not turn it into '
      'a sign-out, and the next read of the sign-in resolves it', (tester) async {
    final e = _Env('android');
    e.status = _status(signedIn: false);
    e.ytStatus = {
      'configured': true,
      'signedIn': false,
      'state': 'unknown',
      'lastGood': {'signedIn': true, 'channelTitle': 'Surau Satu', 'at': '2026-11-19T10:00:00Z'},
    };
    await e.ctrl.refreshYoutube();
    expect(e.state.youtube.phase, YoutubeAccountPhase.unknown);
    expect(e.state.youtube.channel, 'Surau Satu');
    expect(e.state.youtube.signedIn, isFalse);
    await e.ctrl.pollOnce();
    expect(e.state.youtube.phase, YoutubeAccountPhase.unknown, reason: 'the live status cannot tell unknown from out');
    e.ytStatus = {'configured': true, 'signedIn': true, 'state': 'signedIn', 'channelTitle': 'Surau Satu'};
    await e.ctrl.refreshYoutube();
    expect(e.state.youtube.signedIn, isTrue);
    e.ytStatus = {'configured': true, 'signedIn': false, 'state': 'signedOut', 'lastError': 'reauthorise'};
    await e.ctrl.refreshYoutube();
    expect(e.state.youtube.phase, YoutubeAccountPhase.signedOut);
    expect(e.state.youtube.reason, YoutubeSignOutReason.revoked);
  });

  _liveTest('build 5: the status parses cpuPercent, lastLiveCpuPercent, the two new codes and noSignalSeconds', (tester) async {
    final e = _Env('android');
    e.status = {
      ..._status(session: 's1', warnings: ['box_mic_silent', 'server_busy', 'unknown_code']),
      'cpuPercent': 91,
      'audio': {
        'sources': [
          {'id': 'boxInput', 'enabled': true, 'volume': 100, 'state': 'ok', 'level': -90, 'noSignalSeconds': 75},
          {'id': 'camera', 'enabled': true, 'volume': 0, 'state': 'silent'},
        ],
      },
    };
    await e.ctrl.pollOnce();
    expect(e.state.cpuPercent, 91);
    expect(e.state.lastLiveCpuPercent, isNull);
    expect(e.state.warnings, containsAll(<String>[boxMicSilentWarning, serverBusyWarning]));
    expect(e.state.warnings, isNot(contains('unknown_code')));
    expect(e.state.serverBusy, isTrue);
    expect(e.state.audioOf('boxInput')!.noSignalSeconds, 75);
    expect(e.state.audioOf('camera')!.noSignalSeconds, isNull);
    expect(e.state.boxMicSilent, isTrue, reason: 'the camera sound does not carry');
    expect(e.state.boxMicSilentCovered, isFalse);
    // the camera sound carries: the same warning is the covered variant
    e.status = {
      ..._status(session: 's1', warnings: ['box_mic_silent']),
      'audio': {
        'sources': [
          {'id': 'boxInput', 'enabled': true, 'volume': 100, 'state': 'ok', 'noSignalSeconds': 80},
          {'id': 'camera', 'enabled': true, 'volume': 100, 'state': 'ok'},
        ],
      },
    };
    await e.ctrl.pollOnce();
    expect(e.state.boxMicSilent, isFalse);
    expect(e.state.boxMicSilentCovered, isTrue);
    expect(e.state.serverBusy, isFalse);
    expect(e.state.cpuPercent, isNull);
  });

  _liveTest('build 5: a build 4 status (none of the new fields) still parses', (tester) async {
    final e = _Env('android');
    e.status = _status(session: 's1');
    await e.ctrl.pollOnce();
    expect(e.state.sessionId, isNull, reason: 'another device holds that live, seen from here');
    expect(e.state.cpuPercent, isNull);
    expect(e.state.lastLiveCpuPercent, isNull);
    expect(e.state.boxMicSilent, isFalse);
    expect(e.state.serverBusy, isFalse);
    expect(e.state.otherLive, isNotNull);
  });

  _liveTest('build 5: lastLiveCpuPercent is kept only when no live runs', (tester) async {
    final e = _Env('android');
    e.status = {..._status(), 'lastLiveCpuPercent': 64};
    await e.ctrl.pollOnce();
    expect(e.state.lastLiveCpuPercent, 64);
    expect(e.state.cpuPercent, isNull);
  });

  _liveTest('C9: stopping is false again after a stop the box refused', (tester) async {
    final e = _Env('android');
    await e.ctrl.startLive(kuliahId: null, youtube: false);
    e.status = _status(session: 's1');
    e.stopStatus = 500;
    await e.ctrl.stopLive();
    expect(e.state.stopping, isFalse);
    expect(e.state.stopFailed, isTrue);
  });

  _liveTest('C9: a status with youtube.signedIn true moves an unknown account to signed in', (tester) async {
    final e = _Env('android');
    e.status = _status(signedIn: false);
    e.ytStatus = {'configured': true, 'signedIn': false, 'state': 'unknown'};
    await e.ctrl.refreshYoutube();
    expect(e.state.youtube.phase, YoutubeAccountPhase.unknown);
    e.status = _status(signedIn: true);
    await e.ctrl.pollOnce();
    expect(e.state.youtube.phase, YoutubeAccountPhase.signedIn);
    expect(e.state.youtube.channel, 'Surau Contoh');
  });

  _liveTest('W5: an older box (no state, no lastGood) and a garbled state read as today', (tester) async {
    final e = _Env('android');
    e.ytStatus = {'configured': true, 'signedIn': false, 'state': 7, 'lastGood': 'x'};
    await e.ctrl.refreshYoutube();
    expect(e.state.youtube.phase, YoutubeAccountPhase.signedOut);
    e.ytStatus = {'configured': true, 'signedIn': true, 'channelTitle': 'Surau Satu'};
    await e.ctrl.refreshYoutube();
    expect(e.state.youtube.signedIn, isTrue);
  });

  _liveTest('2026.11.13: away (the cloud answers signInHere false) the flag shows '
      'and sign-in / sign-out send nothing', (tester) async {
    final e = _Env('android');
    e.ytStatus = {'configured': true, 'signedIn': true, 'channelTitle': 'Surau Satu', 'lastError': null, 'heldBy': 'box', 'signInHere': false};
    await e.ctrl.refreshYoutube();
    expect(e.state.youtube.channel, 'Surau Satu');
    expect(e.state.youtubeSignInHere, isFalse);
    final before = e.log.length;
    await e.ctrl.signIn();
    expect(e.state.notice, sBm.liveYoutubeAtSurauOnly);
    await e.ctrl.signOut();
    expect(e.log.length, before);
  });

  _liveTest('coming back to the app (resumed) looks at the status at once, '
      'and at the sign-in it was finishing', (tester) async {
    final e = _Env('android');
    e.status = _status(
      signedIn: false,
      signIn: {
        'state': 'pending',
        'userCode': 'WXYZ-1234',
        'verificationUrl': 'https://www.google.com/device',
        'expiresAt': fixedNow().add(const Duration(minutes: 8)).toUtc().toIso8601String(),
      },
    );
    e.ctrl.attach();
    await tester.pump(const Duration(milliseconds: 50));
    await _drain(tester);
    int statuses() => e.log.where((l) => l == 'GET /api/live/status').length;
    int polls() => e.log.where((l) => l == 'POST /api/live/youtube/signin/poll').length;
    final before = statuses();
    expect(polls(), 0);
    e.polls.add({'state': 'signed_in', 'signedIn': true, 'channelTitle': 'Surau Satu'});
    tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.resumed);
    await tester.pump(const Duration(milliseconds: 50));
    await _drain(tester);
    expect(statuses(), greaterThan(before));
    expect(polls(), 1);
    expect(e.state.youtube.signedIn, isTrue);
    e.ctrl.detach();
  });

  _liveTest('sign-out posts and signs out', (tester) async {
    final e = _Env('android');
    e.ctrl.set(const LiveBoxStatus(youtube: YoutubeAccount.signedIn('Surau')));
    await e.ctrl.signOut();
    expect(e.log, contains('POST /api/live/youtube/signout'));
    expect(e.state.youtube.phase, YoutubeAccountPhase.signedOut);
  });

  _liveTest('web: pending recordings are counted at open and saved one '
      'tap each', (tester) async {
    final e = _Env('web');
    for (final i in [0, 1]) {
      await e.store.appendPart(
        sessionId: 'old',
        index: i,
        mime: 'video/mp4',
        label: 'Isyak',
        chunk: Object(),
        size: 100,
      );
      await e.store.finishSegment('old', i);
    }
    await e.ctrl.refreshPending();
    expect(e.state.recordingsPending, 2);
    await e.ctrl.savePending();
    expect(e.state.recordingsPending, 1);
    await e.ctrl.savePending();
    expect(e.state.recordingsPending, 0);
  });

  _liveTest('stopping: flagged until the box answers, periodic polls are '
      'skipped meanwhile', (tester) async {
    final e = _Env('android')..startAnswer = _startAnswer();
    await e.ctrl.startLive(kuliahId: 'c3', youtube: false);
    e.stopGate = Completer<void>();
    final stop = e.ctrl.stopLive();
    await _drain(tester);
    expect(e.state.stopping, isTrue);
    final before = e.log.length;
    expect(await e.ctrl.pollOnce(), isNull);
    expect(e.log.length, before, reason: 'no poll while stopping');
    e.stopGate!.complete();
    await stop;
    await _drain(tester);
    expect(e.state.stopping, isFalse);
    expect(e.state.sessionId, isNull);
    expect(e.state.boxReachable, isTrue);
  });

  _liveTest('a status poll that fails during our own stop is not an '
      'outage', (tester) async {
    final e = _Env('android')..startAnswer = _startAnswer();
    await e.ctrl.startLive(kuliahId: 'c3', youtube: false);
    e.statusDown = true;
    await e.ctrl.stopLive();
    await _drain(tester);
    expect(e.state.boxReachable, isTrue);
    expect(e.state.stopping, isFalse);
    expect(e.container.read(connectivityProvider).down, isFalse);
    expect(e.log, contains('POST /api/live/stop'));
  });

  _liveTest('outside a stop a failing poll still marks the box '
      'unreachable', (tester) async {
    final e = _Env('android')..startAnswer = _startAnswer();
    await e.ctrl.startLive(kuliahId: 'c3', youtube: false);
    e.statusDown = true;
    await e.ctrl.pollOnce();
    expect(e.state.boxReachable, isFalse);
  });

  _liveTest('a live the box ended is reconciled: publisher stopped, state '
      'cleared, notice shown, no stop POST', (tester) async {
    final e = _Env('android');
    await e.ctrl.startLive(kuliahId: null, youtube: false);
    expect(e.state.sessionId, 's1');
    e.status = _status();
    await e.ctrl.pollOnce();
    expect(e.state.sessionId, isNull);
    expect(e.pub.stops, 1);
    expect(e.state.notice, 'Siaran dihentikan oleh MAXCOM');
    expect(e.ctrl.holdsTargets, isFalse);
    expect(e.log, isNot(contains('POST /api/live/stop')));
  });

  _liveTest('a different session id on the box also ends our live', (
    tester,
  ) async {
    final e = _Env('android');
    await e.ctrl.startLive(kuliahId: null, youtube: false);
    e.status = _status(session: 'other');
    await e.ctrl.pollOnce();
    expect(e.state.sessionId, isNull);
    expect(e.state.notice, 'Siaran dihentikan oleh MAXCOM');
    expect(e.log, isNot(contains('POST /api/live/stop')));
  });

  _liveTest('a publisher whose stop throws still gets the box stop', (
    tester,
  ) async {
    final e = _Env('android', throwingStop: true);
    await e.ctrl.startLive(kuliahId: null, youtube: false);
    await e.ctrl.stopLive();
    expect(e.log, contains('POST /api/live/stop'));
    expect(e.state.sessionId, isNull);
    expect(e.state.stopping, isFalse);
  });

  _liveTest('[L2] a stop that cannot reach the box keeps the session, says so '
      'and the retry stops it when the box is back', (tester) async {
    final e = _Env('android');
    await e.ctrl.startLive(kuliahId: null, youtube: false);
    e.status = _status(session: 's1');
    expect(e.state.sessionId, 's1');
    e.away = true;
    await e.ctrl.stopLive();
    expect(e.state.sessionId, 's1', reason: 'the box still has the live');
    expect(e.state.stopFailed, isTrue);
    expect(e.state.stopping, isFalse);
    expect(e.state.notice, 'Siaran belum berhenti. Cuba lagi.');
    expect(e.pub.stops, 1, reason: 'the phone side is over');
    // The box answers again: the next try (every 5 s) ends it.
    e.away = false;
    await tester.pump(const Duration(seconds: 5));
    await _drain(tester);
    expect(e.log, contains('POST /api/live/stop'));
    expect(e.state.sessionId, isNull);
    expect(e.state.stopFailed, isFalse);
    expect(e.state.notice, isNull);
  });

  _liveTest('[L2] the retry keeps trying every 5 s while the box is away and '
      'the manual retry works at once', (tester) async {
    final e = _Env('android');
    await e.ctrl.startLive(kuliahId: null, youtube: false);
    e.status = _status(session: 's1');
    e.away = true;
    await e.ctrl.stopLive();
    for (var i = 0; i < 3; i++) {
      await tester.pump(const Duration(seconds: 5));
      await _drain(tester);
      expect(e.state.sessionId, 's1');
      expect(e.state.stopFailed, isTrue);
    }
    e.away = false;
    await e.ctrl.pollOnce(); // the heartbeat that finds the box again
    await e.ctrl.retryStop();
    expect(e.state.sessionId, isNull);
    expect(e.state.stopFailed, isFalse);
    final stops = e.log.where((l) => l == 'POST /api/live/stop').length;
    await tester.pump(const Duration(seconds: 30));
    await _drain(tester);
    expect(
      e.log.where((l) => l == 'POST /api/live/stop').length,
      stops,
      reason: 'no more tries once stopped',
    );
  });

  _liveTest('[L2] a stop the box refuses with a coded 5xx also stays; a 404 '
      'for an unknown session ends it', (tester) async {
    final e = _Env('android');
    await e.ctrl.startLive(kuliahId: null, youtube: false);
    e.stopStatus = 503;
    await e.ctrl.stopLive();
    expect(e.state.sessionId, 's1');
    expect(e.state.stopFailed, isTrue);
    e.stopStatus = 404;
    await e.ctrl.retryStop();
    expect(e.state.sessionId, isNull, reason: 'the box has no such live');
    expect(e.state.stopFailed, isFalse);
  });

  _liveTest('[Q5] 401, 403, 429 and 5xx keep the session retrying; 409 '
      'no_session and 404 end it', (tester) async {
    final e = _Env('android');
    await e.ctrl.startLive(kuliahId: null, youtube: false);
    for (final st in [401, 403, 429, 500]) {
      e.stopStatus = st;
      e.stopCode = st == 403 ? 'not_owner' : null;
      await e.ctrl.stopLive();
      expect(e.state.sessionId, 's1', reason: 'status $st');
      expect(e.state.stopFailed, isTrue, reason: 'status $st');
    }
    e.stopStatus = 409;
    e.stopCode = 'live_busy';
    await e.ctrl.retryStop();
    expect(e.state.sessionId, 's1', reason: 'an unrelated 409 is not ended');
    e.stopCode = 'no_session';
    await e.ctrl.retryStop();
    expect(e.state.sessionId, isNull);
    expect(e.state.stopFailed, isFalse);
  });

  _liveTest('[L2] a status poll that shows no session ends a stop that was '
      'waiting to be retried', (tester) async {
    final e = _Env('android');
    await e.ctrl.startLive(kuliahId: null, youtube: false);
    e.away = true;
    await e.ctrl.stopLive();
    e.away = false;
    e.status = _status();
    await e.ctrl.pollOnce();
    expect(e.state.sessionId, isNull);
    expect(e.state.stopFailed, isFalse);
  });

  _liveTest('[L3] the heartbeat keeps coming after the page is left while a '
      'session is open, and stops once the live ends', (tester) async {
    final e = _Env('android');
    e.ctrl.attach();
    await e.ctrl.startLive(kuliahId: null, youtube: false);
    e.status = _status(session: 's1');
    e.ctrl.detach();
    int polls() => e.log.where((l) => l == 'GET /api/live/status').length;
    final before = polls();
    await tester.pump(const Duration(seconds: 2));
    await _drain(tester);
    await tester.pump(const Duration(seconds: 2));
    await _drain(tester);
    expect(polls(), before + 2, reason: 'the page is gone, the live is not');
    expect(e.ctrl.polling, isTrue);
    e.status = _status();
    await tester.pump(const Duration(seconds: 2));
    await _drain(tester);
    expect(e.state.sessionId, isNull);
    final after = polls();
    await tester.pump(const Duration(seconds: 10));
    await _drain(tester);
    expect(polls(), after, reason: 'no live, no page, no heartbeat');
    expect(e.ctrl.polling, isFalse);
  });

  _liveTest('[L3] leaving the page during a live is asked once per live', (
    tester,
  ) async {
    final e = _Env('android');
    e.ctrl.attach();
    await e.ctrl.startLive(kuliahId: null, youtube: false);
    expect(e.ctrl.takeLeaveReminder(), isFalse, reason: 'still on the page');
    e.ctrl.detach();
    expect(e.ctrl.takeLeaveReminder(), isTrue);
    expect(e.ctrl.takeLeaveReminder(), isFalse, reason: 'once');
  });

  _liveTest('[L6] a YouTube leg lost because the cloud is unreachable says '
      'so, not that YouTube refused', (tester) async {
    final e = _Env('android')..startAnswer = _startAnswer(ytVia: 'device');
    e.status = _status(
      session: 's1',
      warnings: ['cloud_unreachable'],
    );
    await e.ctrl.startLive(kuliahId: 'c3', youtube: true);
    await e.ctrl.pollOnce();
    e.ctrl.giveUpYoutubeForTest();
    expect(e.state.notice, 'YouTube: awan tidak dapat dihubungi');
    expect(e.state.notice, isNot('YouTube menolak permintaan.'));
  });

  _liveTest('[L7] the ended-by-box and stop notices follow the app language', (
    tester,
  ) async {
    final e = _Env('android');
    await e.container.read(appLangProvider.notifier).set(AppLang.en);
    await e.ctrl.startLive(kuliahId: null, youtube: false);
    e.status = _status();
    await e.ctrl.pollOnce();
    expect(e.state.notice, sFor(AppLang.en).liveStoppedByBox);
    await e.ctrl.startLive(kuliahId: null, youtube: false);
    e.away = true;
    await e.ctrl.stopLive();
    expect(e.state.notice, 'The broadcast has not stopped yet. Try again.');
  });

  _liveTest('[L7] a YouTube sign-in refused by a code reads in English', (
    tester,
  ) async {
    final e = _Env('android');
    await e.container.read(appLangProvider.notifier).set(AppLang.en);
    e.signinStatus = 409;
    e.signinError = {
      'errors': ['Siaran langsung sedang berjalan'],
      'code': 'live_busy',
    };
    await e.ctrl.signIn();
    expect(e.state.notice, 'A live broadcast is running. Try again when it ends.');
  });

  test('each box warning code maps to its BM text', () {
    expect(
      LiveController.warningText('youtube_quota'),
      'Kuota YouTube hari ini telah habis.',
    );
    expect(
      LiveController.warningText('youtube_reauthorise'),
      'Log masuk YouTube perlu diperbaharui.',
    );
    expect(
      LiveController.warningText('youtube_forbidden'),
      'YouTube menolak permintaan.',
    );
    expect(
      LiveController.warningText('no_internet'),
      'Tiada internet: YouTube dimatikan',
    );
    expect(
      LiveController.warningText('live_rate'),
      'Terlalu banyak cubaan mula siaran. Cuba lagi sebentar lagi.',
    );
    expect(LiveController.warningText('zzz'), isNull);
  });

  test('Y9, Y11: every YouTube warning the box can put in status.warnings has its own text, in each language', () {
    // the codes `youtubeWarning` of the box (live/sessions.ts) can give, beside `cloud_unreachable`
    const codes = {
      'youtube_quota',
      'youtube_reauthorise',
      'youtube_forbidden',
      'youtube_live_not_enabled',
      'box_clock_wrong',
      'youtube_client_refused',
      'youtube_busy_other_box',
      'no_internet',
      'cloud_unreachable',
    };
    for (final lang in [SMs(), SEn(), SAr()]) {
      final texts = {for (final c in codes) LiveController.warningText(c, lang)};
      expect(texts.contains(null), isFalse);
      expect(texts.length, codes.length, reason: 'no two causes share a sentence');
    }
    expect(LiveController.warningText('youtube_live_not_enabled'), 'Siaran langsung belum diaktifkan pada saluran YouTube ini.');
    expect(LiveController.warningText('box_clock_wrong'), 'Jam MAXCOM tidak tepat. Betulkan jam dan cuba lagi.');
    expect(LiveController.warningText('youtube_client_refused'), 'Fail klien YouTube ditolak oleh Google. Hubungi Pentadbir MAXCOM.');
    expect(LiveController.warningText('youtube_busy_other_box'), 'YouTube sedang digunakan oleh MAXCOM Kiosk Box lain.');
  });

  test('C3, C11: the camera warnings of a running live reach the screen, and go with the live', () async {
    final e = _Env('android')..startAnswer = _startAnswer();
    e.status = _status(warnings: ['camera_bitrate_high', 'camera_h265']);
    await e.ctrl.pollOnce();
    expect(e.state.warnings, isEmpty, reason: 'no live is open');
    await e.ctrl.startLive(kuliahId: 'c3', youtube: false);
    e.status = _status(session: 's1', warnings: ['camera_bitrate_high', 'camera_h265']);
    await e.ctrl.pollOnce();
    expect(e.state.warnings, {'camera_bitrate_high', 'camera_h265'});
    e.status = _status(session: 's1');
    await e.ctrl.pollOnce();
    expect(e.state.warnings, isEmpty);
  });

  _liveTest('a quota warning at start shows the quota text', (tester) async {
    final e = _Env('web')
      ..startAnswer = {
        ..._startAnswer(),
        'youtube': null,
        'warnings': ['youtube_quota'],
      };
    await e.ctrl.startLive(kuliahId: null, youtube: true);
    expect(e.state.notice, 'Kuota YouTube hari ini telah habis.');
  });

  _liveTest('429 live_rate shows the rate text', (tester) async {
    final e = _Env('web')
      ..startStatus = 429
      ..startError = {'errors': <String>[], 'code': 'live_rate'};
    await e.ctrl.startLive(kuliahId: null, youtube: false);
    expect(
      e.state.notice,
      'Terlalu banyak cubaan mula siaran. Cuba lagi sebentar lagi.',
    );
  });
}

/// A status as a 2026.11.15 box sends it: the session with `mine` and what it was started with.
Map<String, Object?> _statusMine({
  String id = 's1',
  bool mine = true,
  String? videoPath,
  String? video,
  bool youtube = false,
  String via = 'device',
  bool? nextLiveOn,
  List<Map<String, Object?>> cameraUse = const [],
  bool? kiosk,
  bool? recording,
  bool? boxPulled,
}) => {
  ..._status(session: id),
  'session': {
    'id': id,
    'startedBy': 'Ustaz Ali',
    'kuliahId': 'c3',
    'source': 'android',
    'outputs': {'kiosk': kiosk ?? true, 'youtube': youtube, 'recording': ?recording},
    'boxPulled': ?boxPulled,
    'youtubeVia': via,
    'startedAt': '2026-11-23T12:00:00.000Z',
    'mine': mine,
    'videoPath': ?videoPath,
  },
  'video': ?video,
  'nextLiveOn': ?nextLiveOn,
  'cameraUse': cameraUse,
};

/// An engine that outlived the screen and still holds the live (the Android service).
class _HoldingPublisher extends _LoggingPublisher implements LiveSessionHolder {
  _HoldingPublisher(super.log, this.held);

  PublisherSession? held;

  @override
  Future<PublisherSession?> status() async => held;
}

class _LiveOnlyGateway extends BoxGateway {
  _LiveOnlyGateway({required super.client, required super.reach})
    : super(token: 't', cache: ReadCache(store: null, boxId: 'b'), now: fixedNow, onSessionExpired: _nothing);

  static void _nothing() {}

  @override
  Future<Map<String, dynamic>> getFresh(String path, {bool Function()? quiet}) async => throw LiveOnly(path);
}

void revampTests() {
  group('[B9] this device\'s own session after the app was reopened', () {
    _liveTest('a status with mine:true is adopted: the session is ours (Berhenti), not another device\'s (Henti kecemasan)', (tester) async {
      final e = _Env('android');
      e.status = _statusMine();
      await e.ctrl.pollOnce();
      await _drain(tester);
      expect(e.state.sessionId, 's1');
      expect(e.state.otherLive, isNull);
      expect(e.state.resume, LiveResume.needed, reason: 'a fresh process: the engine holds nothing');
      expect(e.ctrl.polling, isTrue, reason: 'the heartbeat of our session runs again');
      // the normal stop of our own session
      await e.ctrl.stopLive();
      expect(e.log, contains('POST /api/live/stop'));
      expect(e.state.sessionId, isNull);
      expect(e.state.resume, LiveResume.none);
    });

    _liveTest('mine:false stays another device\'s live', (tester) async {
      final e = _Env('android');
      e.status = _statusMine(mine: false);
      await e.ctrl.pollOnce();
      expect(e.state.sessionId, isNull);
      expect(e.state.otherLive?.sessionId, 's1');
      expect(e.state.resume, LiveResume.none);
    });

    _liveTest('Sambung semula: start with resume:true and the same request, the publisher starts on the returned targets (success)', (tester) async {
      final e = _Env('android')..startAnswer = _startAnswer(ytVia: 'device');
      e.status = _statusMine(youtube: true);
      await e.ctrl.pollOnce();
      await _drain(tester);
      await e.ctrl.resumeLive();
      final body = e.startBody();
      expect(body['resume'], isTrue);
      expect(body['kuliahId'], 'c3');
      expect(body['source'], 'android');
      expect(body['outputs'], {'kiosk': true, 'youtube': true});
      expect(body['youtubeVia'], 'device');
      final t = e.pub.started.single;
      expect(Uri.parse(t.ingestUrl!).host, '10.168.1.20');
      expect(t.youtubeUrl, 'rtmps://a.rtmps.youtube.com:443/live2/$_key');
      expect(t.sessionId, 's1', reason: 'the engine is told which session it serves');
      expect(e.state.resume, LiveResume.sending);
      expect(e.state.sessionId, 's1');
    });

    _liveTest('a refused resume (resume_mismatch) keeps the session and says why', (tester) async {
      final e = _Env('android');
      e.status = _statusMine();
      await e.ctrl.pollOnce();
      await _drain(tester);
      e.startStatus = 409;
      e.startError = {'errors': ['x'], 'code': 'resume_mismatch'};
      await e.ctrl.resumeLive();
      expect(e.pub.started, isEmpty);
      expect(e.state.sessionId, 's1');
      expect(e.state.resume, LiveResume.needed);
      expect(e.state.notice, sBm.errcResumeMismatch);
    });

    _liveTest('the engine still sends the picture: the screen only re-attaches, nothing is started again', (tester) async {
      final e = _Env('android', publisher: (log) => _HoldingPublisher(
        log,
        PublisherSession(sessionId: 's1', startedAt: DateTime.utc(2026, 11, 23, 12), streaming: true),
      ));
      e.status = _statusMine();
      await e.ctrl.pollOnce();
      await _drain(tester);
      expect(e.state.sessionId, 's1');
      expect(e.state.resume, LiveResume.sending);
      expect(e.pub.started, isEmpty);
      expect(e.log, isNot(contains('POST /api/live/start')));
    });

    _liveTest('an engine holding ANOTHER session does not count as ours', (tester) async {
      final e = _Env('android', publisher: (log) => _HoldingPublisher(
        log,
        PublisherSession(sessionId: 'old', startedAt: DateTime.utc(2026, 11, 23, 11), streaming: true),
      ));
      e.status = _statusMine();
      await e.ctrl.pollOnce();
      await _drain(tester);
      expect(e.state.resume, LiveResume.needed);
    });
  });

  group('[audit] the controller says the current Skrin and Rakam', () {
    _liveTest('Sambung semula sends recording true for a record-only live and the CURRENT Skrin', (tester) async {
      final e = _Env('android')..startAnswer = _startAnswer(ytVia: 'device');
      e.status = _statusMine(kiosk: false, recording: true, videoPath: 'box', boxPulled: true);
      await e.ctrl.pollOnce();
      await _drain(tester);
      expect(e.state.sessionKiosk, isFalse);
      expect(e.state.sessionRecording, isTrue);
      await e.ctrl.resumeLive();
      Map<String, dynamic> lastStart() => jsonDecode(e.box.seen.lastWhere((r) => r.url.path == '/api/live/start').body) as Map<String, dynamic>;
      expect(lastStart()['resume'], isTrue);
      expect(lastStart()['outputs'], {'kiosk': false, 'youtube': false, 'recording': true});
      // Skrin was switched on meanwhile (from another device): the next resume says so, not the first snapshot
      e.status = _statusMine(kiosk: true, recording: true, videoPath: 'box', boxPulled: true);
      await e.ctrl.pollOnce();
      await _drain(tester);
      await e.ctrl.resumeLive();
      expect(lastStart()['outputs'], {'kiosk': true, 'youtube': false, 'recording': true});
    });

    _liveTest('a Rakam only change posts the current Skrin with it; the old nested cameraKbps still reads', (tester) async {
      final e = _Env('android');
      e.status = {
        ..._statusMine(kiosk: false, youtube: true, videoPath: 'box', boxPulled: true),
        'canToggleKiosk': true,
        'ingest': {'ready': true, 'cameraKbps': 2400},
      };
      await e.ctrl.pollOnce();
      await _drain(tester);
      expect(e.state.cameraKbps, 2400);
      expect(await e.ctrl.setOutputs(recording: true), isTrue);
      final body = jsonDecode(e.box.seen.lastWhere((r) => r.url.path == '/api/live/outputs').body) as Map<String, dynamic>;
      expect(body, {'sessionId': 's1', 'kiosk': false, 'recording': true});
      expect(e.state.sessionRecording, isTrue);
    });

    _liveTest('a box that stopped pulling (iPad own camera) is read from session.boxPulled, not videoPath', (tester) async {
      final e = _Env('android');
      e.status = _statusMine(mine: false, videoPath: 'box', boxPulled: false);
      await e.ctrl.pollOnce();
      await _drain(tester);
      expect(e.state.otherLive?.pulledByBox, isFalse);
      e.status = _statusMine(mine: false, videoPath: 'box', boxPulled: true);
      await e.ctrl.pollOnce();
      await _drain(tester);
      expect(e.state.otherLive?.pulledByBox, isTrue);
    });
  });

  group('[S5] the box off the LAN route', () {
    _liveTest('LiveOnly from the gateway marks the box unreachable instead of escaping the poll', (tester) async {
      final e = _Env('android', liveOnly: true);
      await expectLater(e.ctrl.pollOnce(), completion(isNull));
      expect(e.state.boxReachable, isFalse);
    });
  });

  group('[B12] every stop path names itself, and a stop without a tap says why', () {
    _liveTest('the confirmed Berhenti is path user', (tester) async {
      final e = _Env('android');
      await e.ctrl.startLive(kuliahId: null, youtube: false);
      await e.ctrl.stopLive();
      expect(e.ctrl.stopLog.map((x) => x.path), ['user']);
      expect(LiveStopEvent.confirmed.contains('user'), isTrue);
      expect(e.state.notice, isNull, reason: 'the person stopped it: no notice needed');
    });

    _liveTest('ended by the box: path ended_by_box, notice "oleh MAXCOM" (an older box: no reason to read)', (tester) async {
      final e = _Env('android');
      await e.ctrl.startLive(kuliahId: null, youtube: false);
      e.status = _status();
      await e.ctrl.pollOnce();
      await _drain(tester);
      expect(e.ctrl.stopLog.single.path, 'ended_by_box');
      expect(LiveStopEvent.confirmed.contains('ended_by_box'), isFalse);
      expect(e.state.notice, 'Siaran dihentikan oleh MAXCOM');
    });

    _liveTest('ended by the box with the reason camera_lost in its record: the camera notice', (tester) async {
      final e = _Env('android')..recent = [{'id': 's1', 'reason': 'camera_lost', 'gapSeconds': 120, 'broadcastIds': ['b1']}];
      await e.ctrl.startLive(kuliahId: null, youtube: false);
      e.status = _status();
      await e.ctrl.pollOnce();
      await _drain(tester);
      expect(e.state.notice, 'Siaran dihentikan kerana kamera luaran terputus');
      expect(e.state.endedGapSeconds, 120);
      expect(e.state.endedBroadcastIds, ['b1']);
    });

    _liveTest('ended by a person who is not this device (the emergency stop): "oleh pentadbir"', (tester) async {
      final e = _Env('android')..recent = [{'id': 's1', 'reason': 'stopped'}];
      await e.ctrl.startLive(kuliahId: null, youtube: false);
      e.status = _status();
      await e.ctrl.pollOnce();
      await _drain(tester);
      expect(e.state.notice, 'Siaran dihentikan oleh pentadbir');
    });

    _liveTest('the engine gave the lost camera up: path camera_lost with its notice', (tester) async {
      final e = _Env('android');
      await e.ctrl.startLive(kuliahId: null, youtube: false);
      await e.ctrl.stopLive(notice: sBm.liveStoppedCameraLost, path: 'camera_lost');
      expect(e.ctrl.stopLog.single.path, 'camera_lost');
      expect(e.state.notice, 'Siaran dihentikan kerana kamera luaran terputus');
    });

    _liveTest('a failed start cleans up as path start_failed with its notice', (tester) async {
      final e = _Env('android', publisher: (log) => _FailingPublisher());
      await expectLater(e.ctrl.startLive(kuliahId: null, youtube: false), throwsStateError);
      expect(e.ctrl.stopLog.single.path, 'start_failed');
      expect(e.state.notice, LiveController.startFailed);
      expect(e.state.sessionId, isNull);
    });

    _liveTest('a stop that did not reach the box is retried as path retry; the emergency stop is path emergency', (tester) async {
      final e = _Env('android');
      await e.ctrl.startLive(kuliahId: null, youtube: false);
      e.away = true;
      await e.ctrl.stopLive();
      expect(e.state.stopFailed, isTrue);
      e.away = false;
      e.status = _statusMine();
      await e.ctrl.pollOnce(); // the heartbeat that finds the box again
      await e.ctrl.retryStop();
      e.status = _status();
      expect(e.ctrl.stopLog.map((x) => x.path), ['user', 'retry']);
      expect(e.state.sessionId, isNull);

      e.status = _statusMine(id: 's9', mine: false);
      await e.ctrl.pollOnce();
      await e.ctrl.emergencyStop();
      expect(e.ctrl.stopLog.last.path, 'emergency');
      expect(LiveStopEvent.confirmed.contains('emergency'), isTrue);
      await _drain(tester);
    });
  });

  group('the box pulls the camera (videoPath box), the phone only controls', () {
    _liveTest('start: videoPath box and youtubeVia box in the body, the publisher is NOT started (success)', (tester) async {
      final e = _Env('android')..startAnswer = _startAnswer(ytVia: 'box');
      await e.ctrl.startLive(kuliahId: 'c3', youtube: true, video: VideoSourceKind.external, videoPath: 'box');
      final body = e.startBody();
      expect(body['videoPath'], 'box');
      expect(body['youtubeVia'], 'box');
      expect(body['video'], 'external');
      expect(e.pub.started, isEmpty, reason: 'the phone publishes nothing');
      expect(e.state.sessionId, 's1');
      expect(e.state.controlOnly, isTrue);
      expect(e.state.youtubeViaBox, isTrue);
      expect(e.ctrl.holdsTargets, isFalse);
      await e.ctrl.stopLive();
      expect(e.log, contains('POST /api/live/stop'));
      expect(e.log, isNot(contains('publisher.stop')), reason: 'nothing was published from this phone');
      expect(e.state.controlOnly, isFalse);
    });

    _liveTest('F1: a control-only live keeps this phone screen on from its start to its stop; a phone that pulls sends no such call', (tester) async {
      final e = _Env('android')..startAnswer = _startAnswer(ytVia: 'box');
      await e.ctrl.startLive(kuliahId: 'c3', youtube: false, video: VideoSourceKind.external, videoPath: 'box');
      expect(e.pub.screenKeeps, [true]);
      e.status = _status(session: 's1');
      await e.ctrl.stopLive();
      expect(e.pub.screenKeeps, [true, false]);
    });

    _liveTest('F1: a phone that pulls the camera itself leaves the screen flag to the engine', (tester) async {
      final e = _Env('android')..startAnswer = _startAnswer();
      await e.ctrl.startLive(kuliahId: null, youtube: false);
      expect(e.pub.screenKeeps, isEmpty);
    });

    _liveTest('the default start (the phone pulls) sends no videoPath, as today', (tester) async {
      final e = _Env('android');
      await e.ctrl.startLive(kuliahId: null, youtube: false, video: VideoSourceKind.external);
      expect(e.startBody().containsKey('videoPath'), isFalse);
      expect(e.pub.started, hasLength(1));
      expect(e.state.controlOnly, isFalse);
    });

    _liveTest('a control-only session found after a restart is adopted as controller, with no resume card', (tester) async {
      final e = _Env('android');
      e.status = _statusMine(videoPath: 'box', video: 'external', youtube: true, via: 'box');
      await e.ctrl.pollOnce();
      await _drain(tester);
      expect(e.state.sessionId, 's1');
      expect(e.state.controlOnly, isTrue);
      expect(e.state.resume, LiveResume.none);
    });
  });

  group('the camera in use flag', () {
    _liveTest('the status carries which camera, by whom and since when; another device\'s pull blocks ours', (tester) async {
      final e = _Env('android');
      e.status = _statusMine(mine: false, video: 'external', cameraUse: [
        {'cameraId': 'external', 'sessionId': 's1', 'via': 'device', 'by': {'name': 'Tablet Surau', 'mine': false}, 'since': '2026-11-23T12:00:00.000Z'},
      ]);
      await e.ctrl.pollOnce();
      final u = e.state.cameraUse.single;
      expect(u.byName, 'Tablet Surau');
      expect(u.via, 'device');
      expect(u.since, DateTime.utc(2026, 11, 23, 12));
      expect(cameraUseBlocksPull(e.state.cameraUse), isTrue);
    });

    test('cameraUseBlocksPull is core\'s rule', () {
      LiveCameraUseDto use(String via, bool mine) =>
          LiveCameraUseDto(cameraId: 'external', sessionId: 's', via: via, byName: 'x', byMine: mine);
      expect(cameraUseBlocksPull(const []), isFalse, reason: 'free');
      expect(cameraUseBlocksPull([use('device', true)]), isFalse, reason: 'this device holds it with its own pull');
      expect(cameraUseBlocksPull([use('device', false)]), isTrue);
      expect(cameraUseBlocksPull([use('box', true)]), isTrue, reason: 'the box pulls: join through the box');
      expect(cameraUseBlocksPull([use('box', false)]), isTrue);
    });
  });

  group('[B5] the box\'s own choice travels in the status', () {
    _liveTest('nextLiveOn of the status is what the destinations show', (tester) async {
      final e = _Env('android');
      expect(e.container.read(liveDestinationsProvider).wanted, isTrue, reason: 'the registry default');
      e.status = {..._status(), 'nextLiveOn': false};
      await e.ctrl.pollOnce();
      expect(e.container.read(liveDestinationsProvider).fromBox, isFalse);
      expect(e.container.read(liveDestinationsProvider).wanted, isFalse);
      expect(e.container.read(liveDestinationsProvider).unconfirmed, isFalse);
    });
  });

  // ---- lane P2 (2026.11.15): B7 brightness, O4 camera release, O34 YouTube added to a running live ----

  _liveTest('B7: the saved brightness reaches the phone engine before the start; the default is auto', (tester) async {
    final a = _Env('android');
    await a.ctrl.startLive(kuliahId: null, youtube: false);
    expect(a.pub.brightnessLevels, ['auto']);
    final b = _Env('android', settings: {
      'liveCamera': {'enabled': false, 'brightness': 'brighter'},
    });
    await b.container.read(settingsProvider.future);
    await b.ctrl.startLive(kuliahId: null, youtube: false);
    expect(b.pub.brightnessLevels, ['brighter']);
    final c = _Env('android', settings: {
      'liveCamera': {'brightness': 'dim'},
    });
    await c.container.read(settingsProvider.future);
    await c.ctrl.startLive(kuliahId: null, youtube: false);
    expect(c.pub.brightnessLevels, ['auto']);
  });

  _liveTest('O34: Siarkan ke YouTube, relayed by the box: the answer is the status, the watch link and the leg follow', (tester) async {
    final e = _Env('android')..startAnswer = _startAnswer();
    await e.ctrl.startLive(kuliahId: null, youtube: false);
    expect(e.state.sessionYoutube, isNull);
    e.ytStartAnswer = {
      ..._status(session: 's1', ytState: 'live', relay: 'running', watch: 'https://youtu.be/AbCdEfGh123'),
      'session': {'id': 's1', 'youtubeVia': 'box', 'outputs': {'kiosk': true, 'youtube': true}},
    };
    await e.ctrl.startYoutubeLater();
    expect(e.log, contains('POST /api/live/youtube/start'));
    final body = jsonDecode(e.box.seen.firstWhere((r) => r.url.path == '/api/live/youtube/start').body) as Map<String, dynamic>;
    expect(body['sessionId'], 's1');
    expect(e.state.youtubeViaBox, isTrue);
    expect(e.state.sessionYoutube, isTrue);
    expect(e.state.watchUrl, 'https://youtu.be/AbCdEfGh123');
    expect(e.state.youtubeStarting, isFalse);
    expect(e.state.notice, isNull);
    // the phone opens no leg of its own
    expect(e.pub.startedYoutube, isEmpty);
  });

  _liveTest('O34: when YouTube goes via the phone, it waits for the key and starts its own leg', (tester) async {
    final e = _Env('android', ingestEvery: const Duration(milliseconds: 100))..startAnswer = _startAnswer();
    await e.ctrl.startLive(kuliahId: null, youtube: false);
    e.ytStartAnswer = {
      ..._status(session: 's1', watch: 'https://youtu.be/AbCdEfGh123'),
      'session': {'id': 's1', 'youtubeVia': 'device', 'outputs': {'kiosk': true, 'youtube': true}},
    };
    e.ingestAnswer = {'state': 'ready', 'ingest': 'rtmps://a.rtmps.youtube.com:443/live2', 'key': _key};
    await e.ctrl.startYoutubeLater();
    expect(e.state.youtubeViaBox, isFalse);
    await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 400)));
    for (var i = 0; i < 20; i++) {
      await tester.pump(const Duration(milliseconds: 300));
    }
    expect(e.log, contains('GET /api/live/youtube/ingest'));
    expect(e.pub.startedYoutube, ['rtmps://a.rtmps.youtube.com:443/live2/$_key']);
  });

  _liveTest('O34: a refusal is a code and reads in words; already_on is not an error', (tester) async {
    final e = _Env('android')..startAnswer = _startAnswer();
    await e.ctrl.startLive(kuliahId: null, youtube: false);
    final en = SMs(); // the app language of these tests is BM
    final cases = {
      'not_signed_in': en.liveYoutubeLaterNotSignedIn,
      'not_owner': en.liveYoutubeLaterNotOwner,
      'busy': en.liveYoutubeLaterBusy,
    };
    for (final c in cases.entries) {
      e.ytStartStatus = 409;
      e.ytStartAnswer = {'errors': ['x'], 'code': c.key};
      await e.ctrl.startYoutubeLater();
      expect(e.state.notice, c.value, reason: c.key);
      expect(e.state.youtubeStarting, isFalse);
    }
    e.ytStartAnswer = {'errors': ['x'], 'code': 'already_on'};
    e.status = _status(session: 's1');
    await e.ctrl.startYoutubeLater();
    expect(e.state.notice, isNull, reason: 'already_on shows no refusal');
  });

  _liveTest('FX1 answer: via device with a key in the answer opens the phone leg at once, no ingest poll', (tester) async {
    final e = _Env('android')..startAnswer = _startAnswer();
    await e.ctrl.startLive(kuliahId: null, youtube: false);
    e.ytStartAnswer = {
      ..._status(session: 's1', watch: 'https://youtu.be/AbCdEfGh123'),
      'session': {'id': 's1', 'youtubeVia': 'device', 'outputs': {'kiosk': true, 'youtube': true}},
    };
    (e.ytStartAnswer['youtube'] as Map<String, Object?>).addAll({'via': 'device', 'ingest': 'rtmps://a.rtmps.youtube.com:443/live2', 'key': _key, 'legState': 'ready'});
    await e.ctrl.startYoutubeLater();
    expect(e.pub.startedYoutube, ['rtmps://a.rtmps.youtube.com:443/live2/$_key']);
    expect(e.log, isNot(contains('GET /api/live/youtube/ingest')));
  });

  _liveTest('F4: the confirmed title and privacy go to the box; left out, only the session id is sent', (tester) async {
    final e = _Env('android')..startAnswer = _startAnswer();
    await e.ctrl.startLive(kuliahId: null, youtube: false);
    e.ytStartAnswer = {
      ..._status(session: 's1', ytState: 'live', relay: 'running', watch: 'https://youtu.be/AbCdEfGh123'),
      'session': {'id': 's1', 'youtubeVia': 'box', 'outputs': {'kiosk': true, 'youtube': true}},
    };
    await e.ctrl.startYoutubeLater(title: '  Kuliah Subuh  ', privacy: 'unlisted');
    final body = jsonDecode(e.box.seen.firstWhere((r) => r.url.path == '/api/live/youtube/start').body) as Map<String, dynamic>;
    expect(body, {'sessionId': 's1', 'title': 'Kuliah Subuh', 'privacy': 'unlisted'});
    expect(e.state.sessionYoutube, isTrue);
  });

  _liveTest('I2/F3: an answer in the bare start shape is not applied as a status; the via and a status read follow', (tester) async {
    final e = _Env('android')..startAnswer = _startAnswer();
    await e.ctrl.startLive(kuliahId: null, youtube: false);
    e.status = {
      ..._status(session: 's1', ytState: 'live', relay: 'running', watch: 'https://youtu.be/AbCdEfGh123'),
      'session': {'id': 's1', 'startedBy': 'Ustaz Ali', 'mine': true, 'outputs': {'kiosk': true, 'youtube': true}},
    };
    e.ytStartAnswer = {
      'session': {'id': 's1', 'youtubeVia': 'box'},
      'youtube': {'via': 'box', 'ingest': null, 'key': null, 'state': 'connecting'},
    };
    final before = e.log.where((l) => l == 'GET /api/live/status').length;
    await e.ctrl.startYoutubeLater();
    await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 50)));
    expect(e.state.youtubeViaBox, isTrue);
    expect(e.state.sessionYoutube, isTrue);
    expect(e.state.youtube.signedIn, isTrue, reason: 'the account is not blanked by a bare answer');
    expect(e.log.where((l) => l == 'GET /api/live/status').length, greaterThan(before), reason: 'the status is read again');
    expect(e.state.watchUrl, 'https://youtu.be/AbCdEfGh123');
  });

  _liveTest('I6: an older MAXCOM (a bare 403 or 404) is told to update; F27: the other codes have their own words', (tester) async {
    final e = _Env('android')..startAnswer = _startAnswer();
    await e.ctrl.startLive(kuliahId: null, youtube: false);
    final s = SMs();
    for (final st in [403, 404]) {
      e.ytStartStatus = st;
      e.ytStartAnswer = {'errors': ['x']};
      await e.ctrl.startYoutubeLater();
      expect(e.state.notice, s.liveYoutubeLaterUpdateBox, reason: 'status $st');
    }
    final cases = {
      'no_session': s.liveYoutubeLaterNoSession,
      'bad_request': s.liveYoutubeLaterBadRequest,
      'youtube_off': s.liveYoutubeLaterYoutubeOff,
      'tools_missing': s.liveYoutubeLaterToolsMissing,
      'no_internet': s.liveYoutubeLaterNoInternet,
      'privacy_not_allowed': s.liveYoutubeLaterPrivacyNotAllowed,
    };
    for (final c in cases.entries) {
      e.ytStartStatus = 409;
      e.ytStartAnswer = {'errors': ['x'], 'code': c.key};
      await e.ctrl.startYoutubeLater();
      expect(e.state.notice, c.value, reason: c.key);
    }
    // all three languages carry every new text, none with dashes or arrows
    for (final l in [SMs(), SEn(), SAr()]) {
      for (final t in [
        l.liveYoutubeLaterUpdateBox, l.liveYoutubeLaterNoSession, l.liveYoutubeLaterBadRequest, l.liveYoutubeLaterYoutubeOff,
        l.liveYoutubeLaterToolsMissing, l.liveYoutubeLaterNoInternet, l.liveYoutubeLaterSheetTitle, l.liveYoutubeLaterTitleLabel,
        l.liveYoutubeLaterPrivacyLabel, l.liveYoutubePrivacyPrivate, l.liveYoutubePrivacyUnlisted, l.liveYoutubePrivacyPublic,
        l.liveYoutubeLaterConfirm, l.liveYoutubeLaterConfirmNote, l.liveRecNoSpaceNote, l.uploadErrorClaimLost,
      ]) {
        expect(t.trim(), isNotEmpty);
        expect(t, isNot(matches(RegExp('[–—→≈]'))));
      }
    }
  });

  _liveTest('O34: nothing is sent without a running session', (tester) async {
    final e = _Env('android');
    await e.ctrl.startYoutubeLater();
    expect(e.log, isNot(contains('POST /api/live/youtube/start')));
  });

  test('O34: the new words exist in all three languages without dashes or arrows', () {
    for (final s in [SMs(), SEn(), SAr()]) {
      for (final t in [
        s.liveYoutubeLaterButton,
        s.liveYoutubeLaterHint,
        s.liveYoutubeLaterStarting,
        s.liveYoutubeLaterNotSignedIn,
        s.liveYoutubeLaterNotOwner,
        s.liveYoutubeLaterBusy,
      ]) {
        expect(t.trim(), isNotEmpty);
        expect(RegExp('[–—→≈]').hasMatch(t), isFalse);
      }
    }
    expect(SMs().liveYoutubeLaterButton, 'Siarkan ke YouTube');
  });
}

class _FixedSettings extends SettingsNotifier {
  _FixedSettings(this.values);

  final Map<String, dynamic> values;

  @override
  Future<Read<Map<String, dynamic>>?> build() async => Read(values, at: DateTime.utc(2026, 11, 24), stale: false);
}

class _FailingPublisher extends FakePublisher {
  @override
  Future<void> start(PublisherTargets t) async => throw StateError('no camera');
}

class _LoggingPublisher extends FakePublisher {
  _LoggingPublisher(this.log);

  final List<String> log;

  @override
  Future<void> stop() async {
    log.add('publisher.stop');
    await super.stop();
  }
}

class _ThrowingStopPublisher extends _LoggingPublisher {
  _ThrowingStopPublisher(super.log);

  @override
  Future<void> stop() async {
    await super.stop();
    throw StateError('encoder gone');
  }
}
