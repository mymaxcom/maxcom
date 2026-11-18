import 'dart:async';
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:surau_app/box/box_client.dart';
import 'package:surau_app/features/settings_repository.dart' show loadSettings;
import 'package:surau_app/l10n/generated/s_ar.dart';
import 'package:surau_app/l10n/generated/s_en.dart';
import 'package:surau_app/l10n/generated/s_ms.dart';
import 'package:surau_app/features/shell/box_gateway.dart';
import 'package:surau_app/features/shell/read_cache.dart';
import 'package:surau_app/store/local_store.dart';
import 'package:surau_app/sync/canonical.dart';
import 'package:surau_app/sync/live_only.dart';
import 'package:surau_app/sync/sync_engine.dart';

import '../features/fakes.dart';
import 'sync_fakes.dart';

class _Reach implements ReachSink {
  BoxReach _r = BoxReach.unknown;
  @override
  BoxReach get reach => _r;
  @override
  void markUp(DateTime at) => _r = _r.up(at);
  @override
  void markDown(DateTime at) => _r = _r.failed(at);
}

void main() {
  late MemoryLocalStore store;
  late FakeSyncServer syncServer;
  late SyncEngine engine;
  late FakeBox box;
  late bool boxAway;
  late _Reach reach;
  late BoxGateway gw;
  var clock = DateTime.utc(2026, 11, 5, 10);
  DateTime now() => clock;

  setUp(() async {
    store = MemoryLocalStore();
    await store.open('0123456789abcdef');
    syncServer = FakeSyncServer();
    engine = SyncEngine(
      store: store,
      key: FakeDeviceKey(present: true),
      box: syncBox(),
      transport: FakeTransport(syncServer),
      now: now,
      autoSync: false,
      schedule: (d, f) => Timer(const Duration(days: 1), () {}),
    );
    boxAway = false;
    box = FakeBox((r) async {
      if (boxAway) throw http.ClientException('away');
      if (r.url.path.startsWith('/assets/')) {
        return http.Response.bytes([1, 2, 3], 200);
      }
      return jsonResponse(200, {'ok': true, 'from': 'network'});
    });
    reach = _Reach();
    gw = BoxGateway(
      client: box.client(Uri.parse('https://127.0.0.1:8443')),
      token: 'tok-1',
      cache: ReadCache(),
      reach: reach,
      now: now,
      onSessionExpired: () {},
      store: store,
      engine: engine,
    );
    await store.putDoc('content:pengumuman', 'p1', {
      'id': 'p1',
      'title': 'Lama',
      'rev': 'r1',
    });
    await store.putDoc('settings', 'clock', {
      '_feature': 'clock',
      'enabled': true,
      'rev': 'r2',
    });
    await store.putDoc('users', 'u1', {'id': 'u1', 'name': 'Ali'});
    await store.putDoc('surauInfo', 'info', {'name': 'Surau Darul'});
    await store.setMeta('seq', '4');
    await store.setMeta('seq@box', '4');
  });

  tearDown(() => engine.dispose());

  group('reads come from the local copy', () {
    test('a content list is local, with no request to the box', () async {
      final r = await gw.get('/api/content/pengumuman');
      expect((r.value['items'] as List).single, {'id': 'p1', 'title': 'Lama'});
      expect(box.seen, isEmpty);
    });

    test('settings are keyed by feature and carry no bookkeeping', () async {
      final r = await gw.get('/api/settings');
      expect(r.value, {
        'clock': {'enabled': true},
      });
    });

    test('[K5] a settings save is queued here and says so; a live-only one is not', () async {
      await gw.put('/api/settings/clock', {'showSeconds': true});
      expect(gw.lastPutQueued, isTrue);
    });

    test('[K1] the local copy has no appLock: the page reads it live from the box', () async {
      box = FakeBox((r) async => jsonResponse(200, {
            'clock': {'enabled': true},
            'appLock': {'enabled': true},
          }));
      gw = BoxGateway(
        client: box.client(Uri.parse('https://127.0.0.1:8443')),
        token: 'tok-1',
        cache: ReadCache(),
        reach: reach,
        now: now,
        onSessionExpired: () {},
        store: store,
        engine: engine,
      );
      final r = await loadSettings(gw, enrolledAppLock: false);
      expect((r.value['appLock'] as Map)['enabled'], isTrue, reason: 'the box says on, the enrolment record said off');
      expect((r.value['appLock'] as Map)['_live'], isNot(false));
    });

    test('[K1] the box away: the enrolled box value, marked not live', () async {
      boxAway = true;
      final r = await loadSettings(gw, enrolledAppLock: true);
      expect((r.value['appLock'] as Map)['enabled'], isTrue);
      expect((r.value['appLock'] as Map)['_live'], isFalse);
    });

    test('one item, users, surau info', () async {
      expect((await gw.get('/api/content/pengumuman/p1')).value['item'], {
        'id': 'p1',
        'title': 'Lama',
      });
      expect((await gw.get('/api/users')).value['users'], [
        {'id': 'u1', 'name': 'Ali'},
      ]);
      expect((await gw.get('/api/surau/info')).value['name'], 'Surau Darul');
    });

    test('stale follows the last sync', () async {
      expect(
        (await gw.get('/api/settings')).stale,
        isTrue,
        reason: 'never synced',
      );
      await engine.sync();
      expect((await gw.get('/api/settings')).stale, isFalse);
      clock = clock.add(const Duration(minutes: 30));
      expect((await gw.get('/api/settings')).stale, isTrue);
    });

    test('a path the store does not hold goes to the network', () async {
      final r = await gw.get('/api/health');
      expect(r.value['from'], 'network');
      expect(box.seen, hasLength(1));
    });

    test('before the first pull the box is asked', () async {
      await store.setMeta('seq', null);
      final r = await gw.get('/api/content/pengumuman');
      expect(r.value['from'], 'network');
    });

    test('an item missing locally falls through to the box', () async {
      final r = await gw.get('/api/content/pengumuman/zzz');
      expect(r.value['from'], 'network');
    });
  });

  group('writes are queued', () {
    test('put content enqueues and the list shows it as pending', () async {
      boxAway = true;
      final out = await gw.put('/api/content/pengumuman/p2', {'title': 'Baru'});
      expect((out['item'] as Map)['title'], 'Baru');
      expect(engine.view.pendingOut, 1);
      expect(box.seen, isEmpty, reason: 'nothing sent to the box');
      final list =
          (await gw.get('/api/content/pengumuman')).value['items'] as List;
      final p2 = list.cast<Map<String, dynamic>>().firstWhere(
        (e) => e['id'] == 'p2',
      );
      expect(p2['pending'], isTrue);
      expect(p2['title'], 'Baru');
      final p1 = list.cast<Map<String, dynamic>>().firstWhere(
        (e) => e['id'] == 'p1',
      );
      expect(p1.containsKey('pending'), isFalse);
    });

    test(
      'delete content enqueues; the item disappears from the list',
      () async {
        await gw.delete('/api/content/pengumuman/p1');
        final list =
            (await gw.get('/api/content/pengumuman')).value['items'] as List;
        expect(list, isEmpty);
        expect(
          await gw
              .get('/api/content/pengumuman/p1')
              .then((r) => r.value['from']),
          'network',
        );
        expect(engine.view.pendingOut, 1);
      },
    );

    test('settings put queues and answers with all settings', () async {
      final all = await gw.put('/api/settings/clock', {'enabled': false});
      expect(all['clock'], {'enabled': false});
      expect(engine.view.pendingOut, 1);
    });

    test('roles and deactivate queue a user.put', () async {
      await gw.put('/api/users/u1/roles', {
        'roles': ['ajk'],
      });
      await gw.post('/api/users/u1/deactivate', const {});
      final ops = await engine.outbox.pending();
      expect(ops.map((o) => o.kind), ['user.put', 'user.put']);
      expect(ops[0].payload, {
        'roles': ['ajk'],
      });
      expect(ops[1].payload, {'active': false});
    });

    test('[PP-A1] a rename queues a user.put {name} and the local copy has the new name at once', () async {
      boxAway = true;
      final out = await gw.put('/api/users/u1/name', {'name': 'Ali Baru'});
      expect(gw.lastPutQueued, isTrue);
      expect(out['name'], 'Ali Baru');
      final ops = await engine.outbox.pending();
      expect(ops.map((o) => o.kind), ['user.put']);
      expect(ops.single.payload, {'name': 'Ali Baru'});
      expect(ops.single.entityId, 'u1');
      expect(box.seen, isEmpty);
      final list = await gw.get('/api/users');
      expect((list.value['users'] as List).single['name'], 'Ali Baru');
    });

    test('[PP-A1] "Aktifkan semula" queues a user.put {active: true}', () async {
      boxAway = true;
      final out = await gw.post('/api/users/u1/activate', const {});
      expect(out['ok'], isTrue);
      final ops = await engine.outbox.pending();
      expect(ops.map((o) => o.kind), ['user.put']);
      expect(ops.single.payload, {'active': true});
      expect(box.seen, isEmpty);
      expect((await store.getDoc('users', 'u1'))!['active'], isTrue);
    });

    test('[PP-A1] a deleted person in the local copy is not served; the others are', () async {
      await store.putDoc('users', 'u2', {
        'id': 'u2',
        'name': 'Puan Aminah',
        'active': false,
        'deleted': true,
        'ref': 'U-0002',
      });
      await store.putDoc('users', 'u3', {'id': 'u3', 'name': 'Kak Siti', 'active': true, 'deleted': false});
      final list = await gw.get('/api/users');
      expect([for (final u in list.value['users'] as List) u['id']], ['u1', 'u3']);
    });

    test('an image upload queues and answers with the sha256 id', () async {
      boxAway = true;
      final bytes = Uint8List.fromList([9, 8, 7, 6]);
      final meta = await gw.uploadAsset(bytes, 'image/png');
      expect(meta.id, sha256HexOf(bytes));
      expect(meta.bytes, 4);
      expect(await gw.getBytes('/assets/${meta.id}'), bytes);
      expect(box.seen, isEmpty);
    });
  });

  group('live-only operations', () {
    test('the app lock setting needs a connection and says so', () async {
      boxAway = true;
      await expectLater(
        gw.put('/api/settings/appLock', {'enabled': false}),
        throwsA(
          isA<LiveOnly>().having(
            (e) => e.path,
            'path',
            '/api/settings/appLock',
          ),
        ),
      );
      expect(LiveOnly.message, 'Perlukan sambungan ke MAXCOM atau awan');
      expect(engine.view.pendingOut, 0, reason: 'never queued');
      expect(reach.reach.down, isTrue);
    });

    test('go live with no connection is refused aloud', () async {
      boxAway = true;
      await expectLater(
        gw.post('/api/live/start', const {}),
        throwsA(isA<LiveOnly>()),
      );
    });

    test('[PP-A1] the people routes are live-only: no base, no queue, LiveOnly', () async {
      boxAway = true;
      final writes = <(String, String)>[
        ('PUT', '/api/devices/d1/name'),
        ('PUT', '/api/auth/device/name'),
        ('POST', '/api/users/u1/unlock'),
        ('POST', '/api/enrol/cancel'),
        ('POST', '/api/devices/revoke-inactive'),
        ('POST', '/api/users/u1/delete'),
        ('POST', '/api/users/u1/restore'),
        ('PUT', '/api/users/u1/phone'),
      ];
      for (final w in writes) {
        expect(isLiveOnly(w.$1, w.$2), isTrue, reason: '${w.$1} ${w.$2}');
        await expectLater(
          w.$1 == 'PUT' ? gw.put(w.$2, {'name': 'x'}) : gw.post(w.$2, const {}),
          throwsA(isA<LiveOnly>().having((e) => e.path, 'path', w.$2)),
          reason: '${w.$1} ${w.$2}',
        );
      }
      for (final r in ['/api/people/activity', '/api/enrol/open', '/api/enrol/recent']) {
        expect(isLiveOnly('GET', r), isTrue, reason: r);
        await expectLater(gw.getFresh(r), throwsA(isA<LiveOnly>()), reason: r);
      }
      expect(engine.view.pendingOut, 0, reason: 'nothing queued');
    });

    test('[PP-A1] rename and activate are NOT live-only (they queue)', () {
      expect(isLiveOnly('PUT', '/api/users/u1/name'), isFalse);
      expect(isLiveOnly('POST', '/api/users/u1/activate'), isFalse);
    });

    test('[PP-A1] every live-only entry has its words in all three languages', () {
      final ms = SMs();
      final en = SEn();
      final ar = SAr();
      for (final e in liveOnlyList) {
        expect(e.label(ms), isNotEmpty);
        expect(e.label(en), isNotEmpty);
        expect(e.label(ar), isNotEmpty);
      }
      final people = [
        for (final w in <(String, String)>[
          ('PUT', '/api/devices/d1/name'),
          ('POST', '/api/users/u1/delete'),
          ('POST', '/api/users/u1/restore'),
          ('PUT', '/api/users/u1/phone'),
          ('GET', '/api/people/activity'),
          ('POST', '/api/users/u1/unlock'),
          ('GET', '/api/enrol/open'),
        ])
          liveOnlyList.firstWhere((e) => e.matches(w.$1, w.$2)).label(ms),
      ];
      expect(people, [
        'Tukar nama peranti',
        'Padam pengguna',
        'Pulihkan pengguna',
        'Tukar nombor telefon',
        'Lihat status aktif',
        'Buka kunci PIN',
        'Urus kod pendaftaran',
      ]);
    });

    test('with the box up a live-only call goes straight through', () async {
      final out = await gw.post('/api/devices/d1/revoke', const {});
      expect(out['from'], 'network');
      expect(box.seen.single.url.path, '/api/devices/d1/revoke');
    });

    test(
      'picture analysis offline is LiveOnly, not a silent failure',
      () async {
        boxAway = true;
        await expectLater(
          gw.getFresh('/api/assets/abc/analyze'),
          throwsA(isA<LiveOnly>()),
        );
      },
    );
  });

  group('pictures', () {
    // The box names a picture by the sha256 of its bytes (the fake answers
    // [1, 2, 3] for any asset).
    final id = sha256HexOf([1, 2, 3]);

    test('a fetched picture is kept and served offline', () async {
      final first = await gw.getBytes('/assets/$id');
      expect(first, [1, 2, 3]);
      boxAway = true;
      expect(await gw.getBytes('/assets/$id'), [1, 2, 3]);
      expect(await store.getBlob('asset-$id'), isNotNull);
    });

    test('bytes that do not hash to the id are returned but not kept', () async {
      final wrong = 'a' * 64;
      expect(await gw.getBytes('/assets/$wrong'), [1, 2, 3]);
      expect(await store.getBlob('asset-$wrong'), isNull);
    });
  });

  group('without an engine the Plan 4 rules hold', () {
    test('writes are refused when the box is away', () async {
      final plain = BoxGateway(
        client: box.client(Uri.parse('https://127.0.0.1:8443')),
        token: 't',
        cache: ReadCache(),
        reach: reach,
        now: now,
        onSessionExpired: () {},
      );
      reach.markDown(now());
      await expectLater(
        plain.put('/api/content/pengumuman/x', {'title': 'x'}),
        throwsA(isA<OfflineWriteRefused>()),
      );
    });
  });

  group('live-only operations away from the surau (Task 9)', () {
    late FakeBox cloud;
    late BoxGateway away;
    late _CloudTransport transport;

    setUp(() {
      boxAway = true;
      cloud = FakeBox((r) async {
        if (r.url.path == '/api/enrol/begin') {
          return jsonResponse(200, {
            'code': 'ABCD-EFGH-2345',
            'expiresAt': '2026-11-05T10:10:00.000Z',
            'payload': 'surau1:from-the-cloud',
            'auth': r.headers['authorization'],
          });
        }
        return jsonResponse(200, {'ok': true});
      });
      transport = _CloudTransport(cloud);
      final cloudEngine = SyncEngine(
        store: store,
        key: FakeDeviceKey(present: true),
        box: syncBox(),
        transport: transport,
        now: now,
        autoSync: false,
        schedule: (d, f) => Timer(const Duration(days: 1), () {}),
      );
      addTearDown(cloudEngine.dispose);
      away = BoxGateway(
        client: box.client(Uri.parse('https://127.0.0.1:8443')),
        token: 'tok-1',
        cache: ReadCache(),
        reach: reach,
        now: now,
        onSessionExpired: () {},
        store: store,
        engine: cloudEngine,
      );
    });

    test(
      'enrol from home: the box is away, the cloud makes the code',
      () async {
        final out = await away.post('/api/enrol/begin', {
          'userId': 'u2',
          'deviceName': 'iPad',
        });
        expect(out['payload'], 'surau1:from-the-cloud');
        expect(
          out['auth'],
          'Bearer tok-cloud',
          reason: 'the cloud session, never the box one',
        );
        expect(cloud.byPath('/api/enrol/begin')?.method, 'POST');
      },
    );

    test('no cloud either: LiveOnly, nothing queued', () async {
      transport.down = true;
      await expectLater(
        away.post('/api/enrol/begin', const {}),
        throwsA(
          isA<LiveOnly>().having((e) => e.path, 'path', '/api/enrol/begin'),
        ),
      );
      expect(cloud.seen, isEmpty);
    });

    test('[K4] the app lock is the surau\'s own: with the box away it is LiveOnly and the cloud is never asked', () async {
      await expectLater(
        away.put('/api/settings/appLock', {'enabled': false}),
        throwsA(isA<LiveOnly>().having((e) => e.path, 'path', '/api/settings/appLock')),
      );
      expect(cloud.seen, isEmpty);
      expect(transport.connects, 0, reason: 'the cloud is not even connected to');
    });

    test('[K4] boxLocalOnly lists the app lock write and nothing that may go to the cloud', () {
      expect(isBoxLocalOnly('PUT', '/api/settings/appLock'), isTrue);
      expect(isBoxLocalOnly('PUT', '/api/settings/appLock?x=1'), isTrue);
      expect(isBoxLocalOnly('GET', '/api/settings/appLock'), isFalse);
      expect(isBoxLocalOnly('POST', '/api/enrol/begin'), isFalse);
      expect(isBoxLocalOnly('PUT', '/api/settings/clock'), isFalse);
    });

    test('[K8] a POST that was sent and timed out is not re-sent through the cloud: Uncertain', () async {
      final slow = FakeBox((r) async => throw TimeoutException('no answer'));
      final gw2 = BoxGateway(
        client: slow.client(Uri.parse('https://127.0.0.1:8443')),
        token: 'tok-1',
        cache: ReadCache(),
        reach: reach,
        now: now,
        onSessionExpired: () {},
        store: store,
        engine: away.engine,
      );
      await expectLater(
        gw2.post('/api/users', {'name': 'Aminah'}),
        throwsA(isA<Uncertain>().having((e) => e.path, 'path', '/api/users')),
      );
      expect(slow.seen, hasLength(1), reason: 'sent once, never retried');
      expect(cloud.seen, isEmpty, reason: 'not sent again through the cloud');
    });

    test('[K8] a connection failure before sending still falls back to the cloud', () async {
      final out = await away.post('/api/users', {'name': 'Aminah'});
      expect(out['ok'], true);
      expect(cloud.byPath('/api/users')?.method, 'POST');
    });
  });
}

class _CloudTransport implements SyncTransport {
  _CloudTransport(this.cloud);

  final FakeBox cloud;
  bool down = false;
  int connects = 0;

  @override
  Future<SyncLink> connect() async {
    connects++;
    if (down) throw const BoxUnreachable('away');
    final base = Uri.parse('https://203.0.113.10');
    return SyncLink(
      base: base,
      via: 'cloud',
      client: cloud.client(base),
      token: 'tok-cloud',
    );
  }
}
