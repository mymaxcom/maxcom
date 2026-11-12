import 'dart:convert';
import 'dart:math';
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:surau_app/store/local_store.dart';
import 'package:surau_app/sync/live_only.dart';
import 'package:surau_app/sync/outbox.dart';

OutboxOp _op(String id, {String kind = 'content.put', Object? payload}) =>
    OutboxOp({
      'v': 1,
      'opId': id,
      'surauId': 'sdm',
      'boxId': 'b',
      'deviceId': 'd',
      'userId': 'u',
      'kind': kind,
      'entity': kind == 'asset.put' ? 'asset' : 'content:pengumuman',
      'entityId': 'x$id',
      'baseRev': null,
      'editedAt': '2026-11-05T10:00:00.000Z',
      'payload': payload ?? {'title': id},
      'sig': 's',
    });

void main() {
  group('UlidGenerator', () {
    test('26 Crockford characters, sorted by time then by call order', () {
      var ms = 1793870400000;
      final gen = UlidGenerator(
        random: Random(1),
        now: () => DateTime.fromMillisecondsSinceEpoch(ms, isUtc: true),
      );
      final ids = <String>[];
      for (var i = 0; i < 50; i++) {
        ids.add(gen.next()); // same millisecond for the first 50
      }
      ms += 1;
      ids.add(gen.next());
      for (final id in ids) {
        expect(id, matches(ulidPattern));
      }
      final sorted = List<String>.of(ids)..sort();
      expect(ids, sorted, reason: 'monotonic even within one millisecond');
      expect(ids.toSet(), hasLength(ids.length));
    });

    test('a clock that goes backwards still sorts after', () {
      var ms = 2000000000000;
      final gen = UlidGenerator(
        random: Random(2),
        now: () => DateTime.fromMillisecondsSinceEpoch(ms, isUtc: true),
      );
      final a = gen.next();
      ms -= 5000;
      final b = gen.next();
      expect(b.compareTo(a), greaterThan(0));
    });

    test('the time part is the millisecond clock', () {
      final gen = UlidGenerator(
        random: Random(3),
        now: () => DateTime.fromMillisecondsSinceEpoch(0, isUtc: true),
      );
      expect(gen.next().substring(0, 10), '0000000000');
    });
  });

  group('Outbox', () {
    late MemoryLocalStore store;
    late Outbox outbox;

    setUp(() async {
      store = MemoryLocalStore();
      await store.open('b');
      outbox = Outbox(store);
    });

    test('pending is in opId order and count follows add/remove', () async {
      await outbox.add(_op('01C'));
      await outbox.add(_op('01A'));
      await outbox.add(_op('01B'));
      expect((await outbox.pending()).map((o) => o.opId), [
        '01A',
        '01B',
        '01C',
      ]);
      expect(await outbox.count, 3);
      await outbox.remove('01B');
      expect((await outbox.pending()).map((o) => o.opId), ['01A', '01C']);
      expect(await outbox.count, 2);
    });

    test('survives a reopen on the same store', () async {
      await outbox.add(_op('01A'));
      final again = Outbox(store);
      expect((await again.pending()).single.json['payload'], {'title': '01A'});
    });

    test('targets lists entity|id without loading blobs', () async {
      await outbox.add(_op('01A'));
      expect(await outbox.targets(), {'content:pengumuman|x01A'});
    });

    test(
      'an asset keeps its bytes in an upload- blob, restored on read',
      () async {
        final bytes = Uint8List.fromList(List.generate(100, (i) => i));
        await outbox.add(
          _op(
            '01A',
            kind: 'asset.put',
            payload: {'mime': 'image/png', 'bytesBase64': base64.encode(bytes)},
          ),
        );
        final doc = await store.getDoc(Collections.outbox, '01A');
        expect(jsonEncode(doc), isNot(contains(base64.encode(bytes))));
        expect(await store.getBlob('${uploadBlobPrefix}01A'), bytes);
        final op = (await outbox.pending()).single;
        expect(
          base64.decode((op.payload as Map)['bytesBase64'] as String),
          bytes,
        );
        await outbox.remove('01A');
        expect(await store.getBlob('${uploadBlobPrefix}01A'), isNull);
      },
    );

    test('queued uploads are never evicted by the blob cap', () async {
      final small = MemoryLocalStore(blobCap: 150);
      await small.open('b');
      final ob = Outbox(small);
      await ob.add(
        _op(
          '01A',
          kind: 'asset.put',
          payload: {
            'mime': 'image/png',
            'bytesBase64': base64.encode(Uint8List(100)),
          },
        ),
      );
      await small.putBlob('asset-aaa', Uint8List(100));
      await small.putBlob('asset-bbb', Uint8List(100));
      expect(await small.getBlob('${uploadBlobPrefix}01A'), isNotNull);
      expect(await small.getBlob('asset-aaa'), isNull);
    });
  });

  group('live-only list', () {
    test('names every operation that needs a connection', () {
      for (final (m, p) in [
        ('POST', '/api/enrol/begin'),
        ('POST', '/api/devices/d1/revoke'),
        ('POST', '/api/users'),
        ('PUT', '/api/users/u1/pin'),
        ('PUT', '/api/settings/appLock'),
        ('POST', '/api/kiosk/pair/approve'),
        ('POST', '/api/live/youtube/signin'),
        ('POST', '/api/live/youtube/signout'),
        ('POST', '/api/live/start'),
        ('POST', '/api/live/stop'),
        ('POST', '/api/prayer/import'),
        ('POST', '/api/islamic/fetch'),
        ('GET', '/api/assets/abc/analyze'),
        ('POST', '/api/cloud/youtube/upload/begin'),
        ('POST', '/api/sync/now'),
        ('PUT', '/api/auth/pin'),
      ]) {
        expect(isLiveOnly(m, p), isTrue, reason: '$m $p');
      }
    });

    test('ordinary edits are not live-only', () {
      for (final (m, p) in [
        ('PUT', '/api/content/pengumuman/p1'),
        ('DELETE', '/api/content/kuliah/k1'),
        ('PUT', '/api/settings/clock'),
        ('PUT', '/api/users/u1/roles'),
        ('POST', '/api/users/u1/deactivate'),
        ('POST', '/api/assets'),
      ]) {
        expect(isLiveOnly(m, p), isFalse, reason: '$m $p');
      }
    });

    test('the BM message is the plan wording', () {
      expect(LiveOnly.message, 'Perlukan sambungan ke MAXCOM atau awan');
      expect(const LiveOnly('/x').toString(), contains('/x'));
    });

    test('no dash or arrow in a label', () {
      for (final e in liveOnlyList) {
        expect(e.label, isNot(matches(RegExp('[–—→]'))));
      }
    });
  });
}
