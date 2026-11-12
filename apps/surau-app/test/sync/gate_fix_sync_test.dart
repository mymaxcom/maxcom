// Plan 6 gate fixes (worker A): per-base cursors (S1), follow-up run (Q1),
// lost upload bytes (Q13), asset cap (Q15), superseded delete (D1) and
// settings taken from the server (D2).

import 'dart:async';
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:surau_app/store/local_store.dart';
import 'package:surau_app/sync/sync_engine.dart';

import '../features/fakes.dart';
import 'sync_fakes.dart';

/// Keeps the query of every request so a test can read the `since=` used.
class QueryServer extends FakeSyncServer {
  final List<String> queries = [];

  @override
  Future<http.Response> handle(http.Request r) {
    queries.add('${r.url.path}?${r.url.query}');
    return super.handle(r);
  }
}

class SwitchTransport implements SyncTransport {
  SwitchTransport(this.current);

  SyncTransport current;

  @override
  Future<SyncLink> connect() => current.connect();
}

Map<String, dynamic> entry(int seq, String id, String title) => {
  'seq': seq,
  'entity': 'content:pengumuman',
  'entityId': id,
  'rev': '2026-11-05T10:00:00.000Z|dev-2',
  'editedAt': '2026-11-05T10:00:00.000Z',
  'opId': null,
  'after': {'title': title},
};

Map<String, dynamic> snapWith(
  Map<String, dynamic> base,
  int seq,
  List<Map<String, dynamic>> items,
) => {
  ...base,
  'seq': seq,
  'content': {'pengumuman': items},
};

void main() {
  late MemoryLocalStore store;
  late FakeDeviceKey key;
  late List<SyncEngine> made;
  var clock = DateTime.utc(2026, 11, 5, 10, 0, 0);

  SyncEngine make(SyncTransport t, {LocalStore? s}) {
    final e = SyncEngine(
      store: s ?? store,
      key: key,
      box: syncBox(),
      transport: t,
      now: () => clock = clock.add(const Duration(seconds: 1)),
      autoSync: false,
      schedule: (d, f) => Timer(const Duration(days: 1), () {}),
    );
    made.add(e);
    return e;
  }

  setUp(() async {
    store = MemoryLocalStore();
    await store.open('0123456789abcdef');
    key = FakeDeviceKey(present: true);
    made = [];
  });
  tearDown(() {
    for (final e in made) {
      e.dispose();
    }
  });

  group('S1: one cursor per base', () {
    test('box then cloud then box skips nothing on either side', () async {
      final box = QueryServer();
      final cloud = QueryServer();
      final sw = SwitchTransport(FakeTransport(box, via: 'box'));
      final engine = make(sw);

      box.seq = 10;
      box.snapshot = snapWith(box.snapshot, 10, [
        {'id': 'a', 'title': 'A'},
      ]);
      await engine.sync();
      expect(box.snapshotCalls, 1);
      expect((await store.meta())['seq@box'], '10');

      // The cloud's change_log ids are its own: lower than the box's.
      sw.current = FakeTransport(cloud, via: 'cloud');
      cloud.seq = 3;
      cloud.snapshot = snapWith(cloud.snapshot, 3, [
        {'id': 'c1', 'title': 'C1'},
      ]);
      await engine.sync();
      expect(cloud.snapshotCalls, 1, reason: 'no cursor at the cloud yet');
      expect(cloud.changesCalls, 0);
      expect((await store.meta())['seq@cloud'], '3');
      expect(await store.getDoc('content:pengumuman', 'c1'), isNotNull);

      // A cloud entry with an id HIGHER than the box cursor, and one lower.
      cloud.seq = 50;
      cloud.entries = [entry(4, 'c2', 'C2'), entry(40, 'c3', 'C3')];
      await engine.sync();
      expect(
        cloud.queries.where((q) => q.startsWith('/api/sync/changes')).last,
        contains('since=3&'),
      );
      expect(await store.getDoc('content:pengumuman', 'c2'), isNotNull);
      expect(await store.getDoc('content:pengumuman', 'c3'), isNotNull);

      // Back at the box: its own cursor (10), not the cloud's (50).
      sw.current = FakeTransport(box, via: 'box');
      box.seq = 11;
      box.entries = [entry(11, 'b2', 'B2')];
      await engine.sync();
      expect(box.snapshotCalls, 1);
      expect(
        box.queries.where((q) => q.startsWith('/api/sync/changes')).last,
        contains('since=10&'),
      );
      expect(await store.getDoc('content:pengumuman', 'b2'), isNotNull);
      expect((await store.meta())['seq@box'], '11');
      expect((await store.meta())['seq@cloud'], '50');
    });

    test('an old single cursor moves to the base in via', () async {
      final box = QueryServer();
      await store.setMeta('seq', '5');
      await store.setMeta('via', 'box');
      box.seq = 6;
      box.entries = [entry(6, 'x', 'X')];
      final engine = make(FakeTransport(box, via: 'box'));
      await engine.sync();
      expect(box.snapshotCalls, 0);
      expect(
        box.queries.where((q) => q.startsWith('/api/sync/changes')).single,
        contains('since=5&'),
      );
      expect((await store.meta())['seq@box'], '6');
    });

    test('an old cursor for the other base, or none, forces a snapshot', () async {
      for (final via in <String?>['cloud', null]) {
        final s = MemoryLocalStore();
        await s.open('0123456789abcdef');
        await s.setMeta('seq', '5');
        if (via != null) await s.setMeta('via', via);
        final box = QueryServer();
        final engine = make(FakeTransport(box, via: 'box'), s: s);
        await engine.sync();
        expect(box.snapshotCalls, 1, reason: 'via=$via');
        expect(box.changesCalls, 0);
      }
    });
  });

  test('Q1: an op queued while a sync runs goes out in the same sync()', () async {
    final server = FakeSyncServer();
    final engine = make(FakeTransport(server));
    await store.putDoc('content:pengumuman', 'p1', {
      'id': 'p1',
      'title': 'Lama',
      'rev': 'r0',
    });
    await store.setMeta('seq@box', '1');
    Future<dynamic>? second;
    var first = true;
    server.verdict = (op) {
      if (first) {
        first = false;
        second = engine.enqueue(
          kind: 'content.put',
          entity: 'content:pengumuman',
          entityId: 'p2',
          payload: {'title': 'Kedua'},
        );
      }
      return server.applied(op);
    };
    await engine.enqueue(
      kind: 'content.put',
      entity: 'content:pengumuman',
      entityId: 'p1',
      payload: {'title': 'Pertama'},
    );
    await engine.sync();
    await second;
    expect(server.opBatches, hasLength(2));
    expect(await engine.outbox.count, 0);
  });

  test('Q1: ops with no verdict do not make the run loop', () async {
    final server = FakeSyncServer();
    final engine = make(FakeTransport(server));
    await store.setMeta('seq@box', '1');
    server.verdict = (op) => {'opId': 'other', 'status': 'applied'};
    await engine.enqueue(
      kind: 'content.put',
      entity: 'content:pengumuman',
      entityId: 'p1',
      payload: {'title': 'A'},
    );
    await engine.sync();
    expect(server.opBatches, hasLength(1));
    expect(await engine.outbox.count, 1);
  });

  test('Q13: an upload whose bytes are gone becomes a visible conflict', () async {
    final server = FakeSyncServer();
    final engine = make(FakeTransport(server));
    await store.setMeta('seq@box', '1');
    await engine.enqueueAsset(Uint8List.fromList([1, 2, 3, 4]), 'image/png');
    final queued = (await engine.outbox.pending()).single;
    await store.deleteBlob('upload-${queued.opId}');
    final v = await engine.sync();
    expect(server.opBatches, isEmpty);
    expect(await engine.outbox.count, 0);
    expect(v.pendingOut, 0);
    expect(v.conflicts, 1);
    final c = (await engine.conflicts()).single;
    expect(c['reason'], 'blob_missing');
    expect(c['opId'], queued.opId);
  });

  test('Q15: the cap sits under the box asset limit (8 MiB)', () {
    expect(maxQueuedAssetBytes, lessThanOrEqualTo(8 * 1024 * 1024));
    expect(maxQueuedAssetBytes, greaterThan(7400000));
  });

  test('D1: a delete that lost to a newer edit gets the winner back', () async {
    final server = FakeSyncServer();
    final engine = make(FakeTransport(server));
    await store.putDoc('content:pengumuman', 'p1', {
      'id': 'p1',
      'title': 'Lama',
      'rev': '2026-11-04T09:00:00.000Z|dev-2',
    });
    await store.setMeta('seq@box', '5');
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
    server.snapshot = snapWith(server.snapshot, 7, [
      {'id': 'p1', 'title': 'Siti menang'},
    ]);
    final op = await engine.enqueue(
      kind: 'content.delete',
      entity: 'content:pengumuman',
      entityId: 'p1',
    );
    final v = await engine.sync();
    final doc = await store.getDoc('content:pengumuman', 'p1');
    expect(doc, isNotNull);
    expect(doc!['title'], 'Siti menang');
    expect(doc.containsKey('_deleted'), isFalse);
    expect(doc.containsKey('pending'), isFalse);
    final c = (await engine.conflicts()).single;
    expect(c['opId'], op.opId);
    expect(c['kind'], 'content.delete');
    expect(c['reason'], 'superseded');
    expect(v.conflicts, 1);
  });

  test('D2: after a settings op the local doc is the server\'s', () async {
    final server = FakeSyncServer();
    final engine = make(FakeTransport(server));
    await store.putDoc('settings', 'clock', {
      '_feature': 'clock',
      'enabled': true,
      'colour': 'green',
      'rev': 'r1',
    });
    await store.setMeta('seq@box', '5');
    // The box merged my `enabled` with someone else's `colour`.
    server.seq = 6;
    server.snapshot = {
      ...server.snapshot,
      'seq': 6,
      'settings': {
        'clock': {'enabled': false, 'colour': 'red'},
      },
    };
    await engine.enqueue(
      kind: 'settings.put',
      entity: 'settings',
      entityId: 'clock',
      payload: {'enabled': false},
    );
    await engine.sync();
    final d = await store.getDoc('settings', 'clock');
    expect(d!['enabled'], false);
    expect(d['colour'], 'red', reason: 'the other device\'s field survives');
    expect(d.containsKey('pending'), isFalse);
    expect(await engine.outbox.count, 0);
  });

  test('Q14: a notice from the store (outbox set aside) becomes a conflict', () async {
    final server = FakeSyncServer();
    final engine = make(FakeTransport(server));
    await store.setMeta('seq@box', '1');
    await store.setMeta(metaOutboxUnreadable, '2026-11-05T10:00:00.000Z');
    final v = await engine.sync();
    expect(v.conflicts, 1);
    final c = (await engine.conflicts()).single;
    expect(c['reason'], 'outbox_unreadable');
    expect((await store.meta()).containsKey(metaOutboxUnreadable), isFalse);
  });
}
