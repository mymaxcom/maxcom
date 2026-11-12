// Gate follow-up item 1: the box's `cloud_unreachable` warning reaches the
// live state (start answer and polls while live), is dropped once the live
// is over, and its BM text exists.

import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:surau_app/app/deps.dart';
import 'package:surau_app/app/providers.dart';
import 'package:surau_app/box/box_client.dart';
import 'package:surau_app/features/common/surau_info.dart';
import 'package:surau_app/features/enrol/enrol_flow.dart';
import 'package:surau_app/features/live/fake_publisher.dart';
import 'package:surau_app/features/live/live_controller.dart';
import 'package:surau_app/features/live/recordings_store.dart';
import 'package:surau_app/features/shell/box_gateway.dart';
import 'package:surau_app/features/shell/read_cache.dart';
import 'package:surau_app/sync/live_only.dart';

import '../fakes.dart';

Map<String, Object?> _start(List<String> warnings) => {
  'session': {'id': 's1'},
  'ingest': {'whip': '/api/live/whip', 'srt': null},
  'youtube': null,
  'warnings': warnings,
};

Map<String, Object?> _status(String? session, List<String> warnings) => {
  'warnings': warnings,
  'session': session == null ? null : {'id': session, 'startedBy': 'Ustaz Ali'},
  'ingest': {'ready': session != null},
  'relay': {'state': 'off'},
  'youtube': {
    'signedIn': true,
    'channelTitle': 'Surau',
    'state': 'none',
    'health': null,
    'watchUrl': null,
    'lastError': null,
  },
};

class _Env {
  _Env() {
    box = FakeBox((r) async {
      switch ('${r.method} ${r.url.path}') {
        case 'POST /api/live/start':
          return jsonResponse(200, startAnswer);
        case 'POST /api/live/stop':
          return jsonResponse(200, {'stopped': true});
        case 'GET /api/live/status':
          return jsonResponse(200, status);
      }
      return jsonResponse(404, {
        'errors': ['tiada'],
      });
    });
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
        livePublisherProvider.overrideWithValue(FakePublisher()),
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
  Map<String, Object?> startAnswer = _start(const []);
  Map<String, Object?> status = _status(null, const []);

  LiveController get ctrl =>
      container.read(liveBoxProvider.notifier) as LiveController;
  LiveBoxStatus get state => container.read(liveBoxProvider);
}

class _CloudAwayGateway extends BoxGateway {
  _CloudAwayGateway(BoxClient client, ReachSink reach)
    : super(
        client: client,
        token: 'tok-1',
        cache: ReadCache(store: null, boxId: 'b'),
        reach: reach,
        now: fixedNow,
        onSessionExpired: () {},
      );

  @override
  Future<Map<String, dynamic>> post(String path, Object body) =>
      throw LiveOnly(path);
}

void main() {
  testWidgets('YouTube sign-in with the cloud away says so instead of '
      'throwing', (tester) async {
    final e = _Env();
    final c = ProviderContainer(
      overrides: [
        appDepsProvider.overrideWithValue(e.container.read(appDepsProvider)),
        livePublisherProvider.overrideWithValue(FakePublisher()),
        recordingsStoreProvider.overrideWithValue(MemoryRecordingsStore()),
        gatewayProvider.overrideWith(
          (ref) => _CloudAwayGateway(
            e.box.client(Uri.parse('https://box.test:8443')),
            ref.watch(connectivityProvider.notifier),
          ),
        ),
      ],
    );
    addTearDown(c.dispose);
    final ctrl = c.read(liveBoxProvider.notifier) as LiveController;
    await ctrl.signIn();
    expect(c.read(liveBoxProvider).notice, liveOnlyMessage);
    await ctrl.signOut();
    expect(c.read(liveBoxProvider).notice, liveOnlyMessage);
  });

  test('warningText has the BM line for cloud_unreachable', () {
    expect(
      LiveController.warningText('cloud_unreachable'),
      'YouTube: awan tidak dapat dihubungi',
    );
  });

  testWidgets('cloud_unreachable in the start answer is kept while live and '
      'is not repeated as a notice', (tester) async {
    final e = _Env()..startAnswer = _start(['cloud_unreachable']);
    await e.ctrl.startLive(kuliahId: 'c3', youtube: true);
    expect(e.state.warnings, {'cloud_unreachable'});
    // the banner is the one place that says it
    expect(e.state.notice, isNull);
  });

  testWidgets('cloud_unreachable comes and goes with the polls while live, '
      'and is dropped once the live is over', (tester) async {
    final e = _Env();
    await e.ctrl.startLive(kuliahId: 'c3', youtube: true);
    expect(e.state.warnings, isEmpty);

    e.status = _status('s1', ['cloud_unreachable']);
    await e.ctrl.pollOnce();
    expect(e.state.warnings, {'cloud_unreachable'});

    e.status = _status('s1', const []);
    await e.ctrl.pollOnce();
    expect(e.state.warnings, isEmpty);

    e.status = _status('s1', ['cloud_unreachable']);
    await e.ctrl.pollOnce();
    e.status = _status(null, ['cloud_unreachable']);
    await e.ctrl.stopLive();
    expect(e.state.sessionId, isNull);
    expect(e.state.warnings, isEmpty);
  });

  testWidgets('with no live open a poll does not show cloud_unreachable', (
    tester,
  ) async {
    final e = _Env()..status = _status(null, ['cloud_unreachable']);
    await e.ctrl.pollOnce();
    expect(e.state.warnings, isEmpty);
  });
}
