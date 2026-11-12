import 'dart:async';
import 'dart:convert';
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:surau_app/box/box_client.dart';
import 'package:surau_app/store/local_store.dart';
import 'package:surau_app/sync/canonical.dart';
import 'package:surau_app/sync/outbox.dart';
import 'package:surau_app/sync/sync_engine.dart';

import '../features/fakes.dart';
import 'sync_fakes.dart';

void main() {
  late MemoryLocalStore store;
  late FakeSyncServer server;
  late FakeTransport transport;
  late FakeDeviceKey key;
  late SyncEngine engine;
  late List<Duration> delays;
  late int changed;
  late int revoked;
  late int wakes;
  late int expired;
  var clock = DateTime.utc(2026, 11, 5, 10, 0, 0);

  Timer fakeTimer(Duration d, void Function() f) {
    delays.add(d);
    return Timer(const Duration(days: 1), () {});
  }

  SyncEngine make({bool auto = false}) => SyncEngine(
    store: store,
    key: key,
    box: syncBox(),
    transport: transport,
    now: () => clock = clock.add(const Duration(seconds: 1)),
    autoSync: auto,
    schedule: fakeTimer,
    onChanged: () => changed++,
    onRevoked: () => revoked++,
    onWakeNeeded: () => wakes++,
    onSessionExpired: () => expired++,
  );

  setUp(() async {
    store = MemoryLocalStore();
    await store.open('0123456789abcdef');
    server = FakeSyncServer();
    transport = FakeTransport(server);
    key = FakeDeviceKey(present: true);
    delays = [];
    changed = revoked = wakes = expired = 0;
    engine = make();
  });

  tearDown(() => engine.dispose());

  Future<void> seed({int seq = 5}) async {
    await store.putDoc('content:pengumuman', 'p1', {
      'id': 'p1',
      'title': 'Lama',
      'rev': '2026-11-04T09:00:00.000Z|dev-2',
    });
    await store.setMeta('seq@box', '$seq');
  }

  group('enqueue', () {
    test(
      'signs over opMessage, shows the edit as pending, queues it',
      () async {
        await seed();
        final op = await engine.enqueue(
          kind: 'content.put',
          entity: 'content:pengumuman',
          entityId: 'p1',
          payload: {'title': 'Baharu'},
        );
        // The fake key recorded exactly the bytes the Dart opMessage gives.
        final unsigned = Map<String, dynamic>.of(op.json)..remove('sig');
        expect(key.signed.single, opMessage(unsigned));
        expect(op.json['baseRev'], '2026-11-04T09:00:00.000Z|dev-2');
        expect(op.json['deviceId'], 'dev-1');
        expect(op.json['userId'], 'u1');
        expect(op.json['boxId'], '0123456789abcdef');
        expect(op.opId, matches(ulidPattern));
        expect((op.json['sig'] as String).length, greaterThan(40));

        final doc = await store.getDoc('content:pengumuman', 'p1');
        expect(doc!['pending'], isTrue);
        expect(doc['title'], 'Baharu');
        expect(doc['rev'], 'pending:${op.opId}');
        expect(engine.view.pendingOut, 1);
        expect(server.paths, isEmpty, reason: 'nothing sent yet');
      },
    );

    test(
      'a second edit of the same item keeps the last server rev as base',
      () async {
        await seed();
        await engine.enqueue(
          kind: 'content.put',
          entity: 'content:pengumuman',
          entityId: 'p1',
          payload: {'title': 'A'},
        );
        final second = await engine.enqueue(
          kind: 'content.put',
          entity: 'content:pengumuman',
          entityId: 'p1',
          payload: {'title': 'B'},
        );
        expect(second.json['baseRev'], '2026-11-04T09:00:00.000Z|dev-2');
        expect(engine.view.pendingOut, 2);
      },
    );

    test('a HadeethEnc hadis switched with {shown} alone keeps its text in the local copy; the op carries only shown', () async {
      await store.putDoc('content:hadis', 'hadeethenc-1', {
        'id': 'hadeethenc-1',
        'textMs': 'Teks dari HadeethEnc.',
        'source': 'Muttafaq alaih',
        'grade': 'sahih',
        'order': 1000,
        'ext': {'provider': 'hadeethenc', 'id': '1'},
        'rev': '2026-11-04T09:00:00.000Z|dev-2',
      });
      final op = await engine.enqueue(
        kind: 'content.put',
        entity: 'content:hadis',
        entityId: 'hadeethenc-1',
        payload: {'shown': false},
      );
      expect(op.payload, {'shown': false});
      final doc = await store.getDoc('content:hadis', 'hadeethenc-1');
      expect(doc!['shown'], isFalse);
      expect(doc['textMs'], 'Teks dari HadeethEnc.');
      expect(doc['ext'], {'provider': 'hadeethenc', 'id': '1'});
      expect(doc['order'], 1000);
      expect(doc['pending'], isTrue);
      expect(op.json['baseRev'], '2026-11-04T09:00:00.000Z|dev-2');
    });

    test('an own hadis (no ext) is still replaced by its payload, as every other item', () async {
      await store.putDoc('content:hadis', 'own-1', {
        'id': 'own-1',
        'textMs': 'Lama',
        'source': 'S',
        'rev': '2026-11-04T09:00:00.000Z|dev-2',
      });
      await engine.enqueue(
        kind: 'content.put',
        entity: 'content:hadis',
        entityId: 'own-1',
        payload: {'textMs': 'Baharu', 'source': 'S'},
      );
      final doc = await store.getDoc('content:hadis', 'own-1');
      expect(doc!['textMs'], 'Baharu');
    });

    test('the engine bookkeeping never rides in the payload', () async {
      final op = await engine.enqueue(
        kind: 'content.put',
        entity: 'content:pengumuman',
        entityId: 'p9',
        payload: {'title': 'X', 'rev': 'r', 'pending': true, '_deleted': true},
      );
      expect(op.payload, {'title': 'X'});
    });

    test('works with no base at all', () async {
      transport.connectError = const BoxUnreachable('down');
      await engine.enqueue(
        kind: 'content.put',
        entity: 'content:pengumuman',
        entityId: 'p2',
        payload: {'title': 'Luar talian'},
      );
      expect(engine.view.pendingOut, 1);
    });
  });

  group('sync', () {
    test(
      'applied: the doc takes the server rev and the outbox empties',
      () async {
        await seed();
        final op = await engine.enqueue(
          kind: 'content.put',
          entity: 'content:pengumuman',
          entityId: 'p1',
          payload: {'title': 'Baharu'},
        );
        final v = await engine.sync();
        expect(server.opBatches.single['ops'], hasLength(1));
        expect(
          (server.opBatches.single['ops'] as List).single['opId'],
          op.opId,
        );
        final doc = await store.getDoc('content:pengumuman', 'p1');
        expect(doc!.containsKey('pending'), isFalse);
        expect(doc['rev'], startsWith('2026-11-05T10:00:00.'));
        expect(doc['title'], 'Baharu');
        expect(await engine.outbox.count, 0);
        expect(v.pendingOut, 0);
        expect(v.lastError, isNull);
        expect(v.via, 'box');
        expect(v.state, SyncState.idle);
        expect((await store.meta())['lastSync'], isNotNull);
      },
    );

    test(
      'superseded: a conflict names the winner; the winner comes back',
      () async {
        await seed();
        server.verdict = (op) => {
          'opId': op['opId'],
          'status': 'superseded',
          'rev': '2026-11-05T09:59:00.000Z|dev-9',
          'reason': null,
          'winner': {
            'actor': 'user:u9',
            'userName': 'Siti',
            'editedAt': '2026-11-05T09:59:00.000Z',
          },
        };
        server.seq = 7;
        server.snapshot = {
          ...server.snapshot,
          'seq': 7,
          'content': {
            'pengumuman': [
              {'id': 'p1', 'title': 'Siti menang'},
            ],
          },
        };
        final op = await engine.enqueue(
          kind: 'content.put',
          entity: 'content:pengumuman',
          entityId: 'p1',
          payload: {'title': 'Saya'},
        );
        final v = await engine.sync();
        final conflicts = await engine.conflicts();
        expect(conflicts, hasLength(1));
        expect(conflicts.single['opId'], op.opId);
        expect(conflicts.single['reason'], 'superseded');
        expect(conflicts.single['winner']['userName'], 'Siti');
        expect(conflicts.single['mine'], {'title': 'Saya'});
        expect(v.conflicts, 1);
        expect(await engine.outbox.count, 0);
        expect(server.snapshotCalls, 1, reason: 'the lost edit is undone');
        final doc = await store.getDoc('content:pengumuman', 'p1');
        expect(doc!['title'], 'Siti menang');
        expect(doc.containsKey('pending'), isFalse);

        await engine.dismissConflict(op.opId);
        expect(engine.view.conflicts, 0);
      },
    );

    test(
      'forbidden is a visible conflict with the reason, not a silent drop',
      () async {
        await seed();
        server.verdict = (op) => {
          'opId': op['opId'],
          'status': 'refused',
          'rev': null,
          'reason': 'forbidden',
          'winner': null,
        };
        server.snapshot = {
          ...server.snapshot,
          'content': {
            'pengumuman': [
              {'id': 'p1', 'title': 'Lama'},
            ],
          },
        };
        await engine.enqueue(
          kind: 'content.put',
          entity: 'content:pengumuman',
          entityId: 'p1',
          payload: {'title': 'Tidak dibenarkan'},
        );
        await engine.sync();
        final c = (await engine.conflicts()).single;
        expect(c['reason'], 'forbidden');
        expect(await engine.outbox.count, 0);
        expect(
          (await store.getDoc('content:pengumuman', 'p1'))!['title'],
          'Lama',
        );
      },
    );

    test(
      'an audit note an older server does not know is dropped quietly, not shown as a conflict',
      () async {
        await seed();
        server.verdict = (op) => {
          'opId': op['opId'],
          'status': 'refused',
          'rev': null,
          'reason': 'invalid',
          'winner': null,
        };
        await engine.enqueue(
          kind: 'audit.put',
          entity: 'audit',
          entityId: 's1',
          payload: {
            'event': 'recording/deleted',
            'sessionId': 's1',
            'videoIds': ['abc'],
            'bytes': 10,
          },
        );
        await engine.sync();
        expect(await engine.outbox.count, 0);
        expect(await engine.conflicts(), isEmpty);
      },
    );

    test('an audit note is signed and sent like any op, touching no local doc',
        () async {
      await seed();
      final op = await engine.enqueue(
        kind: 'audit.put',
        entity: 'audit',
        entityId: 's1',
        payload: {
          'event': 'recording/deleted',
          'sessionId': 's1',
          'videoIds': <String>[],
          'bytes': 0,
        },
      );
      expect(op.json['baseRev'], isNull);
      expect(await store.list('audit'), isEmpty);
      expect(engine.view.pendingOut, 1);
    });

    test('device_revoked wipes the store and tells the caller', () async {
      await seed();
      server.verdict = (op) => {
        'opId': op['opId'],
        'status': 'refused',
        'rev': null,
        'reason': 'device_revoked',
        'winner': null,
      };
      for (var i = 0; i < 5; i++) {
        await engine.enqueue(
          kind: 'content.put',
          entity: 'content:pengumuman',
          entityId: 'p$i',
          payload: {'title': 'T$i'},
        );
      }
      final v = await engine.sync();
      expect(await store.bytes(), 0);
      expect(revoked, 1);
      expect(v.lastError, 'device_revoked');
      expect(SyncEngine.revokedMessage, 'Peranti ini telah dibatalkan');
      // The first refusal stops the batch loop; the engine is dead after.
      expect(delays, isEmpty);
    });

    test('a pull with a tombstone deletes the local doc', () async {
      await seed();
      server.seq = 6;
      server.entries = [
        {
          'seq': 6,
          'entity': 'content:pengumuman',
          'entityId': 'p1',
          'rev': '2026-11-05T09:00:00.000Z|dev-3',
          'editedAt': '2026-11-05T09:00:00.000Z',
          'origin': 'cloud',
          'opId': null,
          'after': null,
        },
      ];
      await engine.sync();
      expect(await store.getDoc('content:pengumuman', 'p1'), isNull);
      expect((await store.meta())['seq'], '6');
      expect(changed, 1);
    });

    test('a pull entry for an entity with a pending op is skipped', () async {
      await seed();
      transport.connectError = const BoxUnreachable('down');
      await engine.enqueue(
        kind: 'content.put',
        entity: 'content:pengumuman',
        entityId: 'p1',
        payload: {'title': 'Saya dahulu'},
      );
      // The push is refused with a batch-level 500 so the pending op stays.
      transport.connectError = null;
      server.failStatus = null;
      server.verdict = (op) => {
        'opId': 'other',
        'status': 'applied',
        'rev': 'x',
      };
      server.seq = 8;
      server.entries = [
        {
          'seq': 8,
          'entity': 'content:pengumuman',
          'entityId': 'p1',
          'rev': '2026-11-05T09:00:00.000Z|dev-3',
          'editedAt': '2026-11-05T09:00:00.000Z',
          'origin': 'cloud',
          'opId': null,
          'after': {'id': 'p1', 'title': 'Orang lain'},
        },
        {
          'seq': 9,
          'entity': 'content:pengumuman',
          'entityId': 'p3',
          'rev': '2026-11-05T09:00:00.000Z|dev-3',
          'editedAt': '2026-11-05T09:00:00.000Z',
          'origin': 'cloud',
          'opId': null,
          'after': {'id': 'p3', 'title': 'Baharu dari awan'},
        },
      ];
      await engine.sync();
      final mine = await store.getDoc('content:pengumuman', 'p1');
      expect(mine!['title'], 'Saya dahulu');
      expect(mine['pending'], isTrue);
      expect(
        (await store.getDoc('content:pengumuman', 'p3'))!['title'],
        'Baharu dari awan',
      );
    });

    test(
      'settings: a patch merges locally and an entry for appLock is ignored',
      () async {
        await store.putDoc('settings', 'clock', {
          '_feature': 'clock',
          'enabled': true,
          'face': {'size': 3, 'colour': 'x'},
        });
        await store.setMeta('seq@box', '1');
        await engine.enqueue(
          kind: 'settings.put',
          entity: 'settings',
          entityId: 'clock',
          payload: {
            'face': {'size': 5},
          },
        );
        final d = await store.getDoc('settings', 'clock');
        expect(d!['face'], {'size': 5, 'colour': 'x'});
        expect(d['enabled'], isTrue);
        server.entries = [
          {
            'seq': 2,
            'entity': 'settings',
            'entityId': 'appLock',
            'rev': 'r',
            'editedAt': 'e',
            'opId': null,
            'after': {'enabled': false},
          },
        ];
        server.seq = 2;
        await engine.sync();
        expect(await store.getDoc('settings', 'appLock'), isNull);
      },
    );

    test(
      'no snapshot yet: the first sync fetches it and keeps my waiting edit',
      () async {
        transport.connectError = const BoxUnreachable('down');
        await engine.enqueue(
          kind: 'content.put',
          entity: 'content:pengumuman',
          entityId: 'mine',
          payload: {'title': 'Dari rumah'},
        );
        await engine.sync();
        expect(engine.view.lastError, 'unreachable');

        transport.connectError = null;
        server.verdict = (op) => {
          'opId': 'other',
          'status': 'applied',
          'rev': 'x',
        };
        server.snapshot = {
          ...server.snapshot,
          'seq': 3,
          'surauId': 'sdm',
          'content': {
            'pengumuman': [
              {'id': 'a', 'title': 'A'},
              {'id': 'gone', 'deletedAt': '2026-11-01T00:00:00.000Z'},
            ],
          },
        };
        await engine.sync();
        expect(server.snapshotCalls, 1);
        expect((await store.meta())['seq'], '3');
        expect((await store.getDoc('content:pengumuman', 'a'))!['title'], 'A');
        expect(await store.getDoc('content:pengumuman', 'gone'), isNull);
        final mine = await store.getDoc('content:pengumuman', 'mine');
        expect(mine!['pending'], isTrue, reason: 'kept on top of the snapshot');
      },
    );
  });

  group('failure and waking', () {
    test(
      'offline: lastError unreachable and the delays are 15 s, 60 s, 5 min',
      () async {
        transport.connectError = const BoxUnreachable('down');
        await engine.enqueue(
          kind: 'content.put',
          entity: 'content:pengumuman',
          entityId: 'p2',
          payload: {'title': 'x'},
        );
        for (var i = 0; i < 4; i++) {
          await engine.sync();
        }
        expect(engine.view.lastError, 'unreachable');
        expect(engine.view.state, SyncState.offline);
        expect(delays, [
          const Duration(seconds: 15),
          const Duration(seconds: 60),
          const Duration(minutes: 5),
          const Duration(minutes: 5),
        ]);
        expect(wakes, 4, reason: 'edits wait: the cloud is asked to wake');
        expect(engine.view.pendingOut, 1);
      },
    );

    test('a success resets the backoff', () async {
      await seed();
      transport.connectError = const BoxUnreachable('down');
      await engine.sync();
      expect(delays, [const Duration(seconds: 15)]);
      transport.connectError = null;
      await engine.sync();
      transport.connectError = const BoxUnreachable('down');
      await engine.sync();
      expect(delays.last, const Duration(seconds: 15));
    });

    test(
      '503 waking is a state, not an error; it honours Retry-After',
      () async {
        await seed();
        await engine.enqueue(
          kind: 'content.put',
          entity: 'content:pengumuman',
          entityId: 'p1',
          payload: {'title': 'x'},
        );
        server.failStatus = 503;
        server.failHeaders = {'retry-after': '42'};
        final v = await engine.sync();
        expect(v.state, SyncState.waking);
        expect(v.lastError, isNull);
        expect(delays, [const Duration(seconds: 42)]);
        expect(wakes, 1);
        expect(await engine.outbox.count, 1);
      },
    );

    test('the transport saying waking is the same state', () async {
      transport.connectError = const CloudWakingSignal(retryAfterSec: 30);
      final v = await engine.sync();
      expect(v.state, SyncState.waking);
      expect(delays, [const Duration(seconds: 30)]);
    });

    test('no session for the base: needs_unlock, no retry loop', () async {
      transport.connectError = const NeedsUnlock();
      final v = await engine.sync();
      expect(v.lastError, 'needs_unlock');
      expect(delays, isEmpty);
    });

    test('a 401 reaches onSessionExpired and keeps the queue', () async {
      await seed();
      await engine.enqueue(
        kind: 'content.put',
        entity: 'content:pengumuman',
        entityId: 'p1',
        payload: {'title': 'x'},
      );
      server.failStatus = 401;
      final v = await engine.sync();
      expect(expired, 1);
      expect(v.lastError, 'session_expired');
      expect(await engine.outbox.count, 1);
    });

    test('a server error is a visible lastError with a retry', () async {
      await seed();
      server.failStatus = 500;
      final v = await engine.sync();
      expect(v.lastError, 'http_500');
      expect(delays, isNotEmpty);
    });
  });

  group('serialised', () {
    test('two sync() calls at once run one exchange', () async {
      await seed();
      await engine.enqueue(
        kind: 'content.put',
        entity: 'content:pengumuman',
        entityId: 'p1',
        payload: {'title': 'x'},
      );
      final a = engine.sync();
      final b = engine.sync();
      expect(identical(a, b), isTrue);
      await Future.wait([a, b]);
      expect(server.opBatches, hasLength(1));
      expect(transport.connects, 1);
    });
  });

  group('batches and assets', () {
    test('120 ops go out in batches of 50', () async {
      await seed();
      for (var i = 0; i < 120; i++) {
        await engine.enqueue(
          kind: 'content.put',
          entity: 'content:pengumuman',
          entityId: 'n$i',
          payload: {'title': 'T$i'},
        );
      }
      await engine.sync();
      expect(server.opBatches.map((b) => (b['ops'] as List).length), [
        50,
        50,
        20,
      ]);
      expect(await engine.outbox.count, 0);
    });

    test(
      'an image waits as an upload- blob and goes alone in its batch',
      () async {
        await seed();
        final bytes = Uint8List.fromList(List.generate(300, (i) => i % 256));
        final r = await engine.enqueueAsset(bytes, 'image/png');
        expect(r.id, sha256HexOf(bytes));
        await engine.enqueue(
          kind: 'content.put',
          entity: 'content:pengumuman',
          entityId: 'p1',
          payload: {'title': 'Dengan gambar', 'image': r.id},
        );
        final queued = (await engine.outbox.pending()).first;
        expect(queued.kind, 'asset.put');
        expect(await store.getBlob('upload-${queued.opId}'), isNotNull);
        expect(
          base64.decode((queued.payload as Map)['bytesBase64'] as String),
          bytes,
        );
        // The bytes are readable offline right away.
        expect(await store.getBlob('asset-${r.id}'), bytes);

        await engine.sync();
        expect(server.opBatches, hasLength(2));
        expect(
          (server.opBatches.first['ops'] as List).single['kind'],
          'asset.put',
        );
        expect(await store.getBlob('upload-${queued.opId}'), isNull);
      },
    );

    test('an image over the queue cap is refused aloud', () async {
      final big = Uint8List(maxQueuedAssetBytes + 1);
      await expectLater(
        engine.enqueueAsset(big, 'image/png'),
        throwsA(isA<AssetTooLarge>()),
      );
    });
  });

  test('autoSync starts a sync after enqueue', () async {
    engine.dispose();
    engine = make(auto: true);
    await seed();
    await engine.enqueue(
      kind: 'content.put',
      entity: 'content:pengumuman',
      entityId: 'p1',
      payload: {'title': 'x'},
    );
    await engine.sync(); // joins the one enqueue started
    expect(server.opBatches, hasLength(1));
  });
}
