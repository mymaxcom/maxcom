// Queued pictures must not slow the app: a sync pass opens the bytes of the
// one op it is sending (never the whole queue), a queued picture is stored
// once and never evicted, the signature still covers the base64 the wire
// carries, and a picture push gets a longer read budget.

import 'dart:async';
import 'dart:convert';
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:surau_app/box/box_client.dart';
import 'package:surau_app/store/local_store.dart';
import 'package:surau_app/sync/canonical.dart';
import 'package:surau_app/sync/sync_engine.dart';

import '../features/fakes.dart';
import 'sync_fakes.dart';

/// A store that counts every blob it opens (decrypts, on Android).
class CountingStore extends MemoryLocalStore {
  CountingStore({super.blobCap});

  final List<String> opened = [];

  @override
  Future<Uint8List?> getBlob(String id) {
    opened.add(id);
    return super.getBlob(id);
  }
}

Uint8List _pic(int seed, [int n = 300]) =>
    Uint8List.fromList(List.generate(n, (i) => (i * 7 + seed) % 256));

void main() {
  late CountingStore store;
  late FakeSyncServer server;
  late FakeDeviceKey key;

  SyncEngine make({SyncTransport? transport, bool auto = false}) => SyncEngine(
    store: store,
    key: key,
    box: syncBox(),
    transport: transport ?? FakeTransport(server),
    autoSync: auto,
    schedule: (d, f) => throw StateError('no retry timer expected'),
  );

  setUp(() async {
    store = CountingStore();
    await store.open('0123456789abcdef');
    await store.setMeta('seq@box', '1');
    server = FakeSyncServer();
    key = FakeDeviceKey(present: true);
  });

  group('lazy bytes', () {
    test(
      'queued(), targets(), count and missingBlobOps open no blob',
      () async {
        final engine = make();
        for (var i = 0; i < 3; i++) {
          await engine.enqueueAsset(_pic(i), 'image/png');
        }
        store.opened.clear();
        final ob = engine.outbox;
        expect((await ob.queued()), hasLength(3));
        expect(await ob.targets(), hasLength(3));
        expect(await ob.count, 3);
        expect(await ob.missingBlobOps(), isEmpty);
        expect(store.opened, isEmpty);
        engine.dispose();
      },
    );

    test('a sync pass opens one picture at a time, each once', () async {
      final engine = make();
      final ids = <String>[];
      for (var i = 0; i < 3; i++) {
        ids.add((await engine.enqueueAsset(_pic(i), 'image/png')).id);
      }
      store.opened.clear();
      final openedWhenSent = <int>[];
      server.verdict = (op) {
        openedWhenSent.add(store.opened.length);
        return server.applied(op);
      };
      await engine.sync();
      expect(server.opBatches, hasLength(3));
      // When the 1st op reached the server one blob had been opened, when
      // the 2nd did two, and so on: never all of them up front.
      expect(openedWhenSent, [1, 2, 3]);
      expect(store.opened, ['asset-${ids[0]}', 'asset-${ids[1]}', 'asset-${ids[2]}']);
      expect(await engine.outbox.count, 0);
      engine.dispose();
    });

    test('a queue of plain edits opens no blob at all', () async {
      final engine = make();
      await engine.enqueue(
        kind: 'content.put',
        entity: 'content:pengumuman',
        entityId: 'p1',
        payload: {'title': 'A'},
      );
      await engine.sync();
      expect(store.opened, isEmpty);
      engine.dispose();
    });
  });

  group('one copy, never evicted', () {
    test('a picture is stored once, as asset-<id>', () async {
      final engine = make();
      final bytes = _pic(1);
      final r = await engine.enqueueAsset(bytes, 'image/png');
      final op = (await engine.outbox.queued()).single;
      expect(op.blobId, 'asset-${r.id}');
      expect(await store.getBlob('asset-${r.id}'), bytes);
      expect(await store.hasBlob('upload-${op.opId}'), isFalse);
      final doc = await store.getDoc(Collections.outbox, op.opId);
      expect(jsonEncode(doc), isNot(contains('bytesBase64')));
      engine.dispose();
    });

    test('the blob cap never evicts a queued picture', () async {
      store = CountingStore(blobCap: 500);
      await store.open('0123456789abcdef');
      await store.setMeta('seq@box', '1');
      final engine = make();
      final r = await engine.enqueueAsset(_pic(1, 400), 'image/png');
      // Other blobs push the total over the cap, newer than the queued one.
      await store.putBlob('asset-other1', _pic(2, 400));
      await store.putBlob('asset-other2', _pic(3, 400));
      expect(await store.hasBlob('asset-${r.id}'), isTrue);
      expect(await store.hasBlob('asset-other1'), isFalse);
      // Sent: the queue no longer needs it, so it is evictable again.
      await engine.sync();
      expect(await engine.outbox.count, 0);
      await store.putBlob('asset-other3', _pic(4, 400));
      expect(await store.hasBlob('asset-${r.id}'), isFalse);
      engine.dispose();
    });

    test('a queued finance photo keeps working and survives the cap', () async {
      store = CountingStore(blobCap: 500);
      await store.open('0123456789abcdef');
      await store.setMeta('seq@box', '1');
      final engine = make();
      final r = await engine.enqueueFinancePhoto('e1', _pic(5, 400));
      await store.putBlob('asset-other1', _pic(6, 400));
      await store.putBlob('asset-other2', _pic(7, 400));
      final blob = SyncEngine.financePhotoBlob(r.id);
      expect(await store.hasBlob(blob), isTrue);
      expect(
        (await store.getDoc(Collections.financePhotos, r.id))!['entryId'],
        'e1',
      );
      await engine.sync();
      final sent = (server.opBatches.single['ops'] as List).single as Map;
      expect(sent['kind'], 'finance.photo.put');
      expect(
        base64.decode((sent['payload'] as Map)['bytesBase64'] as String),
        _pic(5, 400),
      );
      engine.dispose();
    });

    test('an on-disk queue from 2026.11.6 (upload-<opId>) still sends', () async {
      final engine = make();
      final bytes = _pic(9);
      final id = sha256HexOf(bytes);
      // Exactly what 2026.11.6 wrote: op without bytes, bytes in upload-<opId>.
      final op = <String, dynamic>{
        'v': 1,
        'opId': '01HLEGACY0000000000000000A',
        'surauId': 'sdm',
        'boxId': '0123456789abcdef',
        'deviceId': 'dev-1',
        'userId': 'u1',
        'kind': 'asset.put',
        'entity': 'asset',
        'entityId': id,
        'baseRev': null,
        'editedAt': '2026-11-05T10:00:00.000Z',
        'payload': {'mime': 'image/png'},
        'sig': 'old-signature',
      };
      await store.putBlob('upload-${op['opId']}', bytes);
      await store.putDoc(Collections.outbox, op['opId'] as String, {
        'op': op,
        'blob': true,
      });
      await engine.sync();
      final sent = (server.opBatches.single['ops'] as List).single as Map;
      expect(sent['sig'], 'old-signature');
      expect(
        base64.decode((sent['payload'] as Map)['bytesBase64'] as String),
        bytes,
      );
      expect(await engine.outbox.count, 0);
      expect(await store.hasBlob('upload-${op['opId']}'), isFalse);
      engine.dispose();
    });

    test('a picture whose bytes vanish after the check becomes a conflict', () async {
      final engine = make();
      await engine.enqueueAsset(_pic(1), 'image/png');
      await engine.enqueueAsset(_pic(2), 'image/png');
      final first = (await engine.outbox.queued()).first;
      // Passes the existence check, then reads as gone (e.g. tampered file).
      final flaky = _FlakyStore(store, first.blobId!);
      final engine2 = SyncEngine(
        store: flaky,
        key: key,
        box: syncBox(),
        transport: FakeTransport(server),
        autoSync: false,
        schedule: (d, f) => throw StateError('no timer'),
      );
      await engine2.sync();
      expect((await engine2.conflicts()).single['reason'], 'blob_missing');
      // The second picture still went.
      expect(server.opBatches, hasLength(1));
      engine.dispose();
      engine2.dispose();
    });
  });

  group('the wire and the signature', () {
    test('a large picture is signed over, and sent as, the same base64', () async {
      final engine = make();
      final bytes = _pic(3, 300 * 1024); // over the background threshold
      final r = await engine.enqueueAsset(bytes, 'image/png');
      expect(r.id, sha256HexOf(bytes));
      await engine.sync();
      final sent =
          Map<String, dynamic>.of(((server.opBatches.single['ops'] as List).single as Map).cast<String, dynamic>());
      expect((sent['payload'] as Map)['bytesBase64'], base64.encode(bytes));
      final unsigned = Map<String, dynamic>.of(sent)..remove('sig');
      expect(key.signed.single, opMessage(unsigned));
      engine.dispose();
    });

    test('a small picture is signed over the same content as before', () async {
      final engine = make();
      final bytes = _pic(4);
      await engine.enqueueAsset(bytes, 'image/png');
      await engine.sync();
      final sent = (server.opBatches.single['ops'] as List).single as Map;
      expect(
        (sent['payload'] as Map).keys.toSet(),
        {'mime', 'bytesBase64'},
      );
      final unsigned = Map<String, dynamic>.of(sent.cast<String, dynamic>())
        ..remove('sig');
      expect(key.signed.single, opMessage(unsigned));
      engine.dispose();
    });
  });

  group('picture push budget', () {
    // Budgets far smaller than the real ones; the box answers after 300 ms.
    SyncTransport slow() => _SlowTransport(server, const Duration(milliseconds: 300));

    test('a picture push waits longer than a plain edit would', () async {
      final engine = make(transport: slow());
      await engine.enqueueAsset(_pic(1), 'image/png');
      final v = await engine.sync();
      expect(v.lastError, isNull);
      expect(await engine.outbox.count, 0);
      engine.dispose();
    });

    test('a plain edit keeps the short budget and backs off', () async {
      final timers = <Duration>[];
      final engine = SyncEngine(
        store: store,
        key: key,
        box: syncBox(),
        transport: slow(),
        autoSync: false,
        schedule: (d, f) {
          timers.add(d);
          return _NoTimer();
        },
      );
      await engine.enqueue(
        kind: 'content.put',
        entity: 'content:pengumuman',
        entityId: 'p1',
        payload: {'title': 'A'},
      );
      final v = await engine.sync();
      expect(v.lastError, 'unreachable');
      expect(timers, hasLength(1));
      expect(await engine.outbox.count, 1);
      engine.dispose();
    });
  });
}

class _NoTimer implements Timer {
  @override
  void cancel() {}
  @override
  bool get isActive => false;
  @override
  int get tick => 0;
}

/// Answers `/api/sync/ops` after [delay]; the client's read budget is 50 ms
/// (connect 10 ms), so only a request given a longer `read` gets through.
class _SlowTransport implements SyncTransport {
  _SlowTransport(this.server, this.delay);

  final FakeSyncServer server;
  final Duration delay;

  @override
  Future<SyncLink> connect() async {
    final base = Uri.parse('https://127.0.0.1:8443');
    final mock = MockClient((http.Request r) async {
      if (r.url.path == '/api/sync/ops') await Future<void>.delayed(delay);
      return server.handle(r);
    });
    return SyncLink(
      base: base,
      via: 'box',
      client: BoxClient(
        base,
        mock,
        connect: const Duration(milliseconds: 10),
        read: const Duration(milliseconds: 50),
      ),
      token: 'tok-1',
    );
  }
}

/// Reads of [badBlob] fail once the engine asks for the bytes, while
/// `hasBlob` still says it exists.
class _FlakyStore extends MemoryLocalStore {
  _FlakyStore(this._inner, this.badBlob);

  final MemoryLocalStore _inner;
  final String badBlob;

  @override
  Future<void> open(String boxId) => _inner.open(boxId);
  @override
  Future<Map<String, dynamic>?> getDoc(String c, String id) =>
      _inner.getDoc(c, id);
  @override
  Future<List<Map<String, dynamic>>> list(String c) => _inner.list(c);
  @override
  Future<void> putDoc(String c, String id, Map<String, dynamic> d) =>
      _inner.putDoc(c, id, d);
  @override
  Future<void> deleteDoc(String c, String id) => _inner.deleteDoc(c, id);
  @override
  Future<void> putAll(String c, Map<String, Map<String, dynamic>> d) =>
      _inner.putAll(c, d);
  @override
  Future<void> applyDocs(
    String c, {
    Map<String, Map<String, dynamic>> puts = const {},
    Set<String> deletes = const {},
  }) => _inner.applyDocs(c, puts: puts, deletes: deletes);
  @override
  Future<Map<String, String>> meta() => _inner.meta();
  @override
  Future<void> setMeta(String k, String? v) => _inner.setMeta(k, v);
  @override
  Future<Uint8List?> getBlob(String id) async =>
      id == badBlob ? null : _inner.getBlob(id);
  @override
  Future<void> putBlob(String id, Uint8List b) => _inner.putBlob(id, b);
  @override
  Future<bool> hasBlob(String id) => _inner.hasBlob(id);
  @override
  Future<void> deleteBlob(String id) => _inner.deleteBlob(id);
}
