// C1 of the 2026.11.15 Siaran langsung revamp (G1, B2, B10): settings are
// read fresh over the local copy, through the REAL offline-first gateway with
// a local store and the sync engine, and every default comes from the one
// helper over the generated registry.

import 'dart:async';

import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:surau_app/app/providers.dart';
import 'package:surau_app/features/enrol/enrol_flow.dart' show EnrolledBox;
import 'package:surau_app/features/settings_defaults.dart';
import 'package:surau_app/features/shell/box_gateway.dart';
import 'package:surau_app/features/shell/permissions.dart';
import 'package:surau_app/features/shell/read_cache.dart';
import 'package:surau_app/store/local_store.dart';
import 'package:surau_app/sync/sync_engine.dart';
import 'package:surau_app/sync/sync_providers.dart';
import 'package:surau_app/upload/recording_cleanup.dart';
import 'package:surau_app/upload/upload_providers.dart';

import '../sync/sync_fakes.dart';
import 'fakes.dart';

class _Reach implements ReachSink {
  BoxReach _r = BoxReach.unknown;
  @override
  BoxReach get reach => _r;
  @override
  void markUp(DateTime at) => _r = _r.up(at);
  @override
  void markDown(DateTime at) => _r = _r.failed(at);
}

class _NoBox extends EnrolledBoxNotifier {
  @override
  EnrolledBox? build() => null;
}

void main() {
  late MemoryLocalStore store;
  late SyncEngine engine;
  late FakeBox box;
  late bool boxAway;
  late int version;
  late Map<String, Object?> boxSettings;
  late BoxGateway gw;
  final clock = DateTime.utc(2026, 11, 23, 10);
  DateTime now() => clock;

  BoxGateway gateway({String token = 'tok-1'}) => BoxGateway(
    client: box.client(Uri.parse('https://127.0.0.1:8443')),
    token: token,
    cache: ReadCache(),
    reach: _Reach(),
    now: now,
    onSessionExpired: () {},
    store: store,
    engine: engine,
  );

  setUp(() async {
    store = MemoryLocalStore();
    await store.open('0123456789abcdef');
    engine = SyncEngine(
      store: store,
      key: FakeDeviceKey(present: true),
      box: syncBox(),
      transport: FakeTransport(FakeSyncServer()),
      now: now,
      autoSync: false,
      schedule: (d, f) => Timer(const Duration(days: 1), () {}),
    );
    boxAway = false;
    version = 7;
    boxSettings = {
      'liveCamera': {'enabled': true, 'name': 'Kamera Mimbar'},
      'clock': {'enabled': true, 'showSeconds': false},
    };
    box = FakeBox((r) async {
      if (boxAway) throw http.ClientException('away');
      if (r.url.path == '/api/health') return jsonResponse(200, {'ok': true, 'version': version});
      if (r.url.path == '/api/settings') return jsonResponse(200, boxSettings);
      return jsonResponse(404, {'error': 'not_found'});
    });
    gw = gateway();
    // the local copy as the last sync pull left it: the camera still ON
    await store.putDoc('settings', 'liveCamera', {'_feature': 'liveCamera', 'enabled': true, 'name': 'Kamera Mimbar', 'rev': 'r1'});
    await store.putDoc('settings', 'clock', {'_feature': 'clock', 'enabled': true, 'showSeconds': false, 'rev': 'r2'});
    await store.setMeta('seq', '4');
    await store.setMeta('seq@box', '4');
  });

  tearDown(() => engine.dispose());

  group('[G1] fresh over local', () {
    test('the box answers: its fresh settings win over the local copy, not marked stale', () async {
      boxSettings = {
        'liveCamera': {'enabled': false, 'name': 'Kamera Mimbar'},
        'clock': {'enabled': true, 'showSeconds': false},
      };
      final r = await gw.get('/api/settings');
      expect((r.value['liveCamera'] as Map)['enabled'], isFalse, reason: 'another device switched it off; the local copy still says on');
      expect(r.stale, isFalse);
      expect(box.byPath('/api/settings'), isNotNull);
    });

    test('this device\'s own waiting edit is laid over the fresh answer', () async {
      await gw.put('/api/settings/clock', {'showSeconds': true});
      expect(gw.lastPutQueued, isTrue);
      final r = await gw.get('/api/settings');
      expect(r.value['clock'], {'enabled': true, 'showSeconds': true}, reason: 'the box has not heard the edit yet');
      expect((r.value['liveCamera'] as Map)['name'], 'Kamera Mimbar');
    });

    test('the box away: the local copy shows, marked stale (the hint)', () async {
      boxAway = true;
      final r = await gw.get('/api/settings');
      expect((r.value['liveCamera'] as Map)['enabled'], isTrue);
      expect(r.value['liveCamera'], isNot(contains('rev')));
      expect(r.stale, isTrue);
    });

    test('the offline session (no token) never asks the box', () async {
      final off = gateway(token: '');
      final r = await off.get('/api/settings');
      expect((r.value['clock'] as Map)['enabled'], isTrue);
      expect(box.seen, isEmpty);
    });

    test('a refusal from the box falls back to the copy, marked stale', () async {
      box = FakeBox((r) async => jsonResponse(500, {'error': 'server_error'}));
      gw = gateway();
      final r = await gw.get('/api/settings');
      expect((r.value['liveCamera'] as Map)['enabled'], isTrue);
      expect(r.stale, isTrue);
    });

    test('another device\'s change shows after ONE health tick (success path)', () async {
      final c = ProviderContainer(
        overrides: [
          gatewayProvider.overrideWithValue(gw),
          syncEngineProvider.overrideWithValue(engine),
          enrolledBoxProvider.overrideWith(_NoBox.new),
        ],
      );
      addTearDown(c.dispose);
      c.listen(settingsProvider, (_, _) {});
      c.listen(healthProvider, (_, _) {});
      await c.read(healthProvider.future);
      final before = await c.read(settingsProvider.future);
      expect((before!.value['liveCamera'] as Map)['enabled'], isTrue);

      // the other admin switches the camera off: the box's version moves
      boxSettings = {
        'liveCamera': {'enabled': false, 'name': 'Kamera Mimbar'},
        'clock': {'enabled': true, 'showSeconds': false},
      };
      version = 8;
      await c.read(healthProvider.notifier).refresh();
      final after = await c.read(settingsProvider.future);
      expect((after!.value['liveCamera'] as Map)['enabled'], isFalse, reason: 'one health tick, no restart, no manual sync');
      expect(after.stale, isFalse);
    });

    test('with the box away the providers show the local copy with the hint', () async {
      boxAway = true;
      final c = ProviderContainer(
        overrides: [gatewayProvider.overrideWithValue(gw), syncEngineProvider.overrideWithValue(engine), enrolledBoxProvider.overrideWith(_NoBox.new)],
      );
      addTearDown(c.dispose);
      final s = await c.read(settingsProvider.future);
      expect((s!.value['liveCamera'] as Map)['name'], 'Kamera Mimbar');
      expect(s.stale, isTrue);
    });
  });

  group('[B2] one defaults helper over the registry', () {
    test('isOn(youtubeCatchUp) is true with no stored row', () {
      expect(FeatureFlags.defaults.isOn('youtubeCatchUp'), isTrue);
      expect(FeatureFlags.fromSettings(const {'clock': {'enabled': true}}).isOn('youtubeCatchUp'), isTrue);
      expect(FeatureFlags.fromSettings(const {'youtubeCatchUp': {'enabled': false}}).isOn('youtubeCatchUp'), isFalse);
    });

    test('the menu features keep their registry defaults', () {
      expect(FeatureFlags.defaults.isOn('finance'), isFalse);
      expect(FeatureFlags.defaults.isOn('liveOnKiosk'), isTrue);
      expect(FeatureFlags.defaults.isOn('liveYoutube'), isTrue);
      expect(FeatureFlags.defaults.isOn('jemaahPage'), isFalse, reason: 'hidden feature');
      expect(FeatureFlags.defaults.isOn('noSuchFeature'), isFalse);
    });

    test('CatchUpSettings: no row, and a row without the switch, are ON (the registry default)', () {
      expect(CatchUpSettings.fromDoc(null).enabled, isTrue);
      expect(const CatchUpSettings().enabled, isTrue);
      // B4's shape: only the segment was ever saved
      final onlySegment = CatchUpSettings.fromDoc(const {'replaceGappyLive': 'always'});
      expect(onlySegment.enabled, isTrue);
      expect(onlySegment.replaceGappyLive, 'always');
      expect(onlySegment.wifiOnly, isTrue);
      expect(CatchUpSettings.fromDoc(const {'enabled': false}).enabled, isFalse);
    });

    test('CleanupSettings: a row without the switch reads the registry default', () {
      expect(CleanupSettings.fromDocs(null, null).enabled, isTrue);
      expect(CleanupSettings.fromDocs(const {'keepDays': 3}, null).enabled, isTrue);
      expect(CleanupSettings.fromDocs(const {'keepDays': 3}, null).keepDays, 3);
      expect(CleanupSettings.fromDocs(const {'enabled': false}, null).enabled, isFalse);
      expect(CleanupSettings.fromDocs(const {'enabled': false}, null).keepDays, 1);
    });

    test('effectiveFeature lays the stored row over the defaults, nested cells kept', () {
      final e = effectiveFeature('liveCamera', const {'name': 'Kamera Mimbar', 'avOffsetMs': {'deviceMic': 150}});
      expect(e['enabled'], isFalse, reason: 'the registry default of the camera switch');
      expect(e['name'], 'Kamera Mimbar');
      expect(e['transport'], 'auto');
      expect(e['avOffsetMs'], {'deviceMic': 150, 'boxInput': 0});
      expect(effectiveFeature('youtubeCatchUp', null), {'enabled': true, 'wifiOnly': true, 'joinSegments': true, 'replaceGappyLive': 'ask'});
    });
  });
}
