import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:surau_app/store/local_store.dart';
import 'package:surau_app/store/local_store_android.dart';

/// XORs every byte; throws on a marker mismatch so tampering is noticed like
/// a GCM tag failure.
class FakeSealer implements LocalSealer {
  int resets = 0;
  bool keyGone = false;
  static const _mark = 0xA7;

  @override
  Future<Uint8List> seal(String boxId, Uint8List plain) async =>
      Uint8List.fromList([_mark, ...plain.map((b) => b ^ 0x5a)]);

  @override
  Future<Uint8List> open(String boxId, Uint8List sealed) async {
    if (keyGone || sealed.isEmpty || sealed[0] != _mark) {
      throw StateError('keystore_failed');
    }
    return Uint8List.fromList(sealed.skip(1).map((b) => b ^ 0x5a).toList());
  }

  @override
  Future<void> reset(String boxId) async => resets++;
}

void main() {
  late Directory tmp;
  late FakeSealer sealer;

  setUp(() {
    tmp = Directory.systemTemp.createTempSync('maxcom-store-');
    sealer = FakeSealer();
  });
  tearDown(() {
    if (tmp.existsSync()) tmp.deleteSync(recursive: true);
  });

  final makers = <String, LocalStore Function({int? cap})>{
    'memory': ({int? cap}) =>
        MemoryLocalStore(blobCap: cap ?? defaultBlobCapBytes),
    'android': ({int? cap}) => LocalStoreAndroid(
      root: tmp,
      sealer: sealer,
      blobCap: cap ?? defaultBlobCapBytes,
    ),
  };

  for (final entry in makers.entries) {
    group('LocalStore (${entry.key})', () {
      late LocalStore s;
      setUp(() async {
        s = entry.value();
        await s.open('box1');
      });

      test('put, get, list, delete round-trip', () async {
        expect(await s.getDoc('users', 'u1'), isNull);
        await s.putDoc('users', 'u1', {'name': 'Aminah', 'n': 1});
        await s.putDoc('users', 'u2', {'name': 'Bakar'});
        expect(await s.getDoc('users', 'u1'), {'name': 'Aminah', 'n': 1});
        expect((await s.list('users')).map((d) => d['name']).toSet(), {
          'Aminah',
          'Bakar',
        });
        await s.deleteDoc('users', 'u1');
        expect(await s.getDoc('users', 'u1'), isNull);
        expect(await s.list('users'), hasLength(1));
        expect(await s.list('devices'), isEmpty);
      });

      test(
        'collections with a colon and ids with odd characters work',
        () async {
          await s.putDoc(Collections.content('kuliah'), 'a/b c', {'x': 1});
          expect(await s.getDoc('content:kuliah', 'a/b c'), {'x': 1});
          expect(await s.list('content:kuliah'), hasLength(1));
          expect(await s.list('content:poster'), isEmpty);
        },
      );

      test('a returned document is a copy', () async {
        await s.putDoc('users', 'u1', {'a': 1});
        final d = (await s.getDoc('users', 'u1'))!;
        d['a'] = 2;
        expect(await s.getDoc('users', 'u1'), {'a': 1});
      });

      test('putAll replaces the collection', () async {
        await s.putDoc('users', 'old', {'v': 0});
        await s.putAll('users', {
          'a': {'v': 1},
          'b': {'v': 2},
        });
        expect(await s.getDoc('users', 'old'), isNull);
        expect(await s.list('users'), hasLength(2));
        await s.putAll('users', {});
        expect(await s.list('users'), isEmpty);
      });

      test('meta set, overwrite and remove', () async {
        expect(await s.meta(), isEmpty);
        await s.setMeta('cursor', '12');
        await s.setMeta('other', 'x');
        await s.setMeta('cursor', '13');
        expect(await s.meta(), {'cursor': '13', 'other': 'x'});
        await s.setMeta('other', null);
        expect(await s.meta(), {'cursor': '13'});
      });

      test('blobs round-trip and delete', () async {
        expect(await s.getBlob('a1'), isNull);
        await s.putBlob('a1', Uint8List.fromList([1, 2, 3]));
        expect(await s.getBlob('a1'), [1, 2, 3]);
        await s.deleteBlob('a1');
        expect(await s.getBlob('a1'), isNull);
      });

      test('wipe empties everything and bytes() is 0', () async {
        await s.putDoc('users', 'u1', {'name': 'Aminah'});
        await s.setMeta('k', 'v');
        await s.putBlob('a1', Uint8List(10));
        expect(await s.bytes(), greaterThan(0));
        await s.wipe();
        expect(await s.bytes(), 0);
        await s.open('box1');
        expect(await s.list('users'), isEmpty);
        expect(await s.meta(), isEmpty);
        expect(await s.getBlob('a1'), isNull);
      });

      test('oldest asset blob is evicted once over the cap', () async {
        final small = entry.value(cap: entry.key == 'android' ? 90 : 25); // android files carry a ~16 byte header
        await small.open('box2');
        await small.putBlob('b1', Uint8List(10));
        await Future<void>.delayed(const Duration(milliseconds: 30));
        await small.putBlob('b2', Uint8List(10));
        await Future<void>.delayed(const Duration(milliseconds: 30));
        await small.putBlob('upload-1', Uint8List(10));
        await Future<void>.delayed(const Duration(milliseconds: 30));
        await small.putBlob('b3', Uint8List(10));
        expect(await small.getBlob('b1'), isNull);
        expect(await small.getBlob('upload-1'), isNotNull);
        expect(await small.getBlob('b3'), isNotNull);
      });

      test('a bad box id is refused', () async {
        await expectLater(entry.value().open('../x'), throwsArgumentError);
        await expectLater(entry.value().open(''), throwsArgumentError);
      });
    });
  }

  group('LocalStoreAndroid files', () {
    late LocalStoreAndroid s;
    setUp(() async {
      s = LocalStoreAndroid(root: tmp, sealer: sealer);
      await s.open('box1');
    });

    List<File> files() =>
        Directory('${tmp.path}/maxcom/box1')
            .listSync(recursive: true)
            .whereType<File>()
            .toList();

    test('written bytes do not contain the stored JSON text', () async {
      await s.putDoc(Collections.surauInfo, 'x', {'name': 'Surau Al-Hidayah'});
      await s.setMeta('note', 'Surau Al-Hidayah');
      await s.putBlob(
        'a1',
        Uint8List.fromList(utf8.encode('Surau Al-Hidayah')),
      );
      final all = files();
      expect(all, isNotEmpty);
      for (final f in all) {
        expect(
          latin1.decode(f.readAsBytesSync()),
          isNot(contains('Surau')),
          reason: f.path,
        );
      }
    });

    test('files live under maxcom/<boxId>, no .tmp is left behind', () async {
      await s.putDoc('users', 'u1', {'a': 1});
      await s.putBlob('a1', Uint8List(4));
      final all = files();
      expect(all.where((f) => f.path.endsWith('.tmp')), isEmpty);
      expect(
        all.any((f) => f.path.replaceAll('\\', '/').endsWith('/users.bin')),
        isTrue,
      );
      expect(
        all.any((f) => f.path.replaceAll('\\', '/').contains('/blobs/')),
        isTrue,
      );
    });

    test('a tampered file reads as empty and sets needsSnapshot', () async {
      await s.putDoc('users', 'u1', {'a': 1});
      final fresh = LocalStoreAndroid(root: tmp, sealer: sealer);
      await fresh.open('box1');
      File('${tmp.path}/maxcom/box1/users.bin').writeAsBytesSync([9, 9, 9]);
      expect(await fresh.list('users'), isEmpty);
      expect((await fresh.meta())[metaNeedsSnapshot], '1');
    });

    test('valid seal around broken JSON counts as corrupt too', () async {
      await s.putDoc('users', 'u1', {'a': 1});
      File('${tmp.path}/maxcom/box1/users.bin').writeAsBytesSync(
        await sealer.seal('box1', Uint8List.fromList(utf8.encode('not json'))),
      );
      final fresh = LocalStoreAndroid(root: tmp, sealer: sealer);
      await fresh.open('box1');
      expect(await fresh.getDoc('users', 'u1'), isNull);
      expect((await fresh.meta())[metaNeedsSnapshot], '1');
    });

    test('key gone after a device reset reads as empty', () async {
      await s.putDoc('users', 'u1', {'a': 1});
      await s.setMeta('cursor', '5');
      final fresh = LocalStoreAndroid(root: tmp, sealer: sealer);
      await fresh.open('box1');
      sealer.keyGone = true;
      expect(await fresh.list('users'), isEmpty);
      expect((await fresh.meta())[metaNeedsSnapshot], '1');
      expect((await fresh.meta())['cursor'], isNull);
    });

    test('a store re-opened later sees what was written', () async {
      await s.putDoc('users', 'u1', {'a': 1});
      await s.setMeta('cursor', '5');
      final again = LocalStoreAndroid(root: tmp, sealer: sealer);
      await again.open('box1');
      expect(await again.getDoc('users', 'u1'), {'a': 1});
      expect(await again.meta(), {'cursor': '5'});
    });

    test('wipe deletes the folder and the Keystore key', () async {
      await s.putDoc('users', 'u1', {'a': 1});
      await s.wipe();
      expect(Directory('${tmp.path}/maxcom/box1').existsSync(), isFalse);
      expect(sealer.resets, 1);
    });

    test('two boxes keep separate folders', () async {
      await s.putDoc('users', 'u1', {'a': 1});
      final other = LocalStoreAndroid(root: tmp, sealer: sealer);
      await other.open('box2');
      expect(await other.list('users'), isEmpty);
    });

    test('concurrent writes all land', () async {
      await Future.wait([
        for (var i = 0; i < 20; i++) s.putDoc('users', 'u$i', {'i': i}),
      ]);
      expect(await s.list('users'), hasLength(20));
    });

    test('safeName is reversible-ish and path-safe', () {
      expect(LocalStoreAndroid.safeName('content:kuliah'), 'content~3akuliah');
      expect(LocalStoreAndroid.safeName('../x'), '~2e~2e~2fx');
    });
  });
}
