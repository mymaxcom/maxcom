// Device-mode YouTube leg when the box answers the start before the
// broadcast exists (`youtube.state: starting`): the kiosk leg starts at
// once, the phone polls GET /api/live/youtube/ingest every 2 s for up to
// 60 s, then opens the RTMPS leg. The key and ingest URL are never shown.

import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:surau_app/app/deps.dart';
import 'package:surau_app/app/providers.dart';
import 'package:surau_app/features/common/surau_info.dart';
import 'package:surau_app/features/enrol/enrol_flow.dart';
import 'package:surau_app/features/live/fake_publisher.dart';
import 'package:surau_app/features/live/live_controller.dart';
import 'package:surau_app/features/live/recordings_store.dart';
import 'package:surau_app/features/shell/box_gateway.dart';
import 'package:surau_app/features/shell/read_cache.dart';

import '../fakes.dart';

const _key = 'abcd-efgh-ijkl-mnop-qrst';
const _ingest = 'rtmps://a.rtmps.youtube.com:443/live2';

Map<String, Object?> _answer(Map<String, Object?>? youtube) => {
  'session': {'id': 's1'},
  'ingest': {
    'whip': '/api/live/whip',
    'srt': {
      'host': '10.168.1.20',
      'port': 8890,
      'streamId': 'publish:surau:pub-s1:SecretCred',
      'passphrase': 'PassPhraseOf24CharsLong1',
    },
  },
  'youtube': youtube,
};

const _starting = {
  'via': 'device',
  'ingest': null,
  'key': null,
  'state': 'starting',
};

class _Env {
  _Env() {
    box = FakeBox(_handle);
    final enrolled = fixtureBox(roles: ['media']);
    final deps = AppDeps(
      boxStore: MemoryEnrolledBoxStore()..save(enrolled),
      surauInfoStore: MemorySurauInfoStore(SurauInfo.fromJson(fixtureInfoJson)),
      key: FakeDeviceKey(present: true),
      trust: FakeTrust(),
      biometric: FakeBiometricPin(),
      clientFor: (u) => box.client(u),
      enrolledClient: (b) async => box.client(b.box),
      platform: 'android',
      cameraAvailable: false,
      healthPollInterval: null,
      now: fixedNow,
      initialBox: enrolled,
    );
    container = ProviderContainer(
      overrides: [
        appDepsProvider.overrideWithValue(deps),
        livePublisherProvider.overrideWithValue(pub),
        recordingsStoreProvider.overrideWithValue(MemoryRecordingsStore()),
        gatewayProvider.overrideWith(
          (ref) => BoxGateway(
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
    addTearDown(container.dispose);
  }

  late final FakeBox box;
  late final ProviderContainer container;
  final FakePublisher pub = FakePublisher();
  Map<String, Object?> startAnswer = _answer(_starting);

  /// Ingest answers in order; the last one repeats.
  List<Map<String, Object?>> ingest = [
    {'state': 'starting', 'ingest': null, 'key': null},
  ];
  int ingestCalls = 0;

  Future<http.Response> _handle(http.Request r) async {
    switch ('${r.method} ${r.url.path}') {
      case 'POST /api/live/start':
        return jsonResponse(200, startAnswer);
      case 'POST /api/live/stop':
        return jsonResponse(200, {'stopped': true});
      case 'GET /api/live/youtube/ingest':
        final i = ingestCalls < ingest.length ? ingestCalls : ingest.length - 1;
        ingestCalls++;
        return jsonResponse(200, ingest[i]);
    }
    return jsonResponse(404, {
      'errors': ['tiada'],
    });
  }

  LiveController get ctrl =>
      container.read(liveBoxProvider.notifier) as LiveController;
  LiveBoxStatus get state => container.read(liveBoxProvider);
}

Future<void> _wait(WidgetTester t, int seconds) async {
  for (var i = 0; i < seconds * 2; i++) {
    await t.pump(const Duration(milliseconds: 500));
  }
}

void main() {
  testWidgets('starting then ready: kiosk leg at once, YouTube leg opens '
      'with the key from the ingest route', (t) async {
    final e = _Env()
      ..ingest = [
        {'state': 'starting', 'ingest': null, 'key': null},
        {'state': 'ready', 'ingest': _ingest, 'key': _key},
      ];
    await e.ctrl.startLive(kuliahId: null, youtube: true);
    final first = e.pub.started.single;
    expect(first.outputs.kiosk, isTrue);
    expect(first.outputs.youtube, isFalse);
    expect(first.youtubeUrl, isNull);
    expect(e.pub.startedYoutube, isEmpty);
    await _wait(t, 5);
    expect(e.pub.startedYoutube, ['$_ingest/$_key']);
    expect(e.state.notice, isNull);
    // polling ended once the leg opened
    final calls = e.ingestCalls;
    await _wait(t, 10);
    expect(e.ingestCalls, calls);
    await e.ctrl.stopLive();
  });

  testWidgets('failed: the notice shows, kiosk leg untouched, no key shown', (
    t,
  ) async {
    final e = _Env()
      ..ingest = [
        {'state': 'failed', 'ingest': null, 'key': null},
      ];
    await e.ctrl.startLive(kuliahId: null, youtube: true);
    await _wait(t, 3);
    expect(e.pub.startedYoutube, isEmpty);
    expect(e.pub.stops, 0);
    expect(e.state.sessionId, 's1');
    expect(e.state.notice, isNotNull);
    expect(e.state.notice, isNot(contains(_key)));
    expect(e.state.notice, isNot(contains('rtmps')));
    await e.ctrl.stopLive();
  });

  testWidgets('never ready: after 60 s the notice shows and polling stops', (
    t,
  ) async {
    final e = _Env();
    await e.ctrl.startLive(kuliahId: null, youtube: true);
    await _wait(t, 70);
    expect(e.pub.startedYoutube, isEmpty);
    expect(e.state.notice, isNotNull);
    expect(e.state.sessionId, 's1');
    final calls = e.ingestCalls;
    expect(calls, inInclusiveRange(25, 31));
    await _wait(t, 10);
    expect(e.ingestCalls, calls);
    await e.ctrl.stopLive();
  });

  testWidgets('stop during polling stops it', (t) async {
    final e = _Env();
    await e.ctrl.startLive(kuliahId: null, youtube: true);
    await _wait(t, 4);
    expect(e.ingestCalls, greaterThan(0));
    await e.ctrl.stopLive();
    final calls = e.ingestCalls;
    e.ingest = [
      {'state': 'ready', 'ingest': _ingest, 'key': _key},
    ];
    await _wait(t, 10);
    expect(e.ingestCalls, calls);
    expect(e.pub.startedYoutube, isEmpty);
  });

  testWidgets('old box: key in the start answer opens both legs at once, '
      'no polling', (t) async {
    final e = _Env()
      ..startAnswer = _answer({'via': 'device', 'ingest': _ingest, 'key': _key});
    await e.ctrl.startLive(kuliahId: null, youtube: true);
    final s = e.pub.started.single;
    expect(s.outputs.youtube, isTrue);
    expect(s.youtubeUrl, '$_ingest/$_key');
    await _wait(t, 6);
    expect(e.ingestCalls, 0);
    expect(e.pub.startedYoutube, isEmpty);
    await e.ctrl.stopLive();
  });
}
