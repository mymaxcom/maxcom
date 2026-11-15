// Gate fixes (W5): a lost-bytes conflict is cleared when the same picture is
// queued again (Q2); a picture is queued before its local doc, so a failing
// queue write leaves no ghost doc (Q4).

import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:surau_app/store/local_store.dart';
import 'package:surau_app/sync/sync_engine.dart';
import 'package:surau_app/sync/canonical.dart';

import '../features/fakes.dart';
import 'sync_fakes.dart';

class _FailingQueueStore extends MemoryLocalStore {
  @override
  Future<void> putBlobWithDoc(
    String blobId,
    Uint8List bytes,
    String collection,
    String docId,
    Map<String, dynamic> doc,
  ) async => throw StateError('disk full');
}

Uint8List _pic(int seed, [int n = 300]) =>
    Uint8List.fromList(List.generate(n, (i) => (i * 7 + seed) % 256));

void main() {
  late FakeSyncServer server;
  late FakeDeviceKey key;

  SyncEngine make(LocalStore store) => SyncEngine(
    store: store,
    key: key,
    box: syncBox(),
    transport: FakeTransport(server),
    autoSync: false,
    schedule: (d, f) => throw StateError('no retry timer expected'),
  );

  setUp(() {
    server = FakeSyncServer();
    key = FakeDeviceKey(present: true);
  });

  test('a lost-bytes conflict goes when the same picture is queued again', () async {
    final store = MemoryLocalStore();
    await store.open('0123456789abcdef');
    await store.setMeta('seq@box', '1');
    final engine = make(store);
    final bytes = _pic(5);
    final id = sha256HexOf(bytes);
    await store.putDoc(Collections.conflicts, 'op-lost', {
      'opId': 'op-lost',
      'kind': 'asset.put',
      'entity': 'asset',
      'entityId': id,
      'reason': 'blob_missing',
      'at': '2026-11-13T00:00:00.000Z',
    });
    await store.putDoc(Collections.conflicts, 'op-other', {
      'opId': 'op-other',
      'kind': 'asset.put',
      'entity': 'asset',
      'entityId': 'someone-else',
      'reason': 'blob_missing',
      'at': '2026-11-13T00:00:00.000Z',
    });
    expect(await engine.conflicts(), hasLength(2));
    await engine.enqueueAsset(bytes, 'image/png');
    final left = await engine.conflicts();
    expect(left.map((c) => c['opId']), ['op-other']);
    expect(engine.view.conflicts, 1);
    engine.dispose();
  });

  test('a failing queue write leaves no finance photo doc behind', () async {
    final store = _FailingQueueStore();
    await store.open('0123456789abcdef');
    await store.setMeta('seq@box', '1');
    final engine = make(store);
    await expectLater(
      engine.enqueueFinancePhoto('entry-1', _pic(6)),
      throwsA(isA<StateError>()),
    );
    expect(await store.list(Collections.financePhotos), isEmpty);
    expect(await engine.outbox.count, 0);
    engine.dispose();
  });
}
