import 'dart:async';
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:surau_app/box/box_client.dart';
import 'package:surau_app/features/shell/box_gateway.dart';
import 'package:surau_app/features/shell/read_cache.dart';
import 'package:surau_app/store/local_store.dart';
import 'package:surau_app/sync/canonical.dart';
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
      if (r.url.path == '/assets/${'a' * 64}') {
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
    final id = 'a' * 64;

    test('a fetched picture is kept and served offline', () async {
      final first = await gw.getBytes('/assets/$id');
      expect(first, [1, 2, 3]);
      boxAway = true;
      expect(await gw.getBytes('/assets/$id'), [1, 2, 3]);
      expect(await store.getBlob('asset-$id'), isNotNull);
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
  });
}

class _CloudTransport implements SyncTransport {
  _CloudTransport(this.cloud);

  final FakeBox cloud;
  bool down = false;

  @override
  Future<SyncLink> connect() async {
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
