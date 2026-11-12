@TestOn('browser')
library;

import 'dart:js_interop';
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:surau_app/store/local_store_web.dart';
import 'package:web/web.dart' as web;

Future<List<String>> _databases() async {
  final list = await web.window.indexedDB.databases().toDart;
  return [for (final d in list.toDart) d.name];
}

void main() {
  late IndexedDbLocalStore s;

  setUp(() async {
    s = IndexedDbLocalStore();
    await s.open('webbox');
  });
  tearDown(() async => s.wipe());

  test('put, get, list, delete round-trip', () async {
    await s.putDoc('users', 'u1', {'name': 'Aminah'});
    await s.putDoc('users', 'u2', {'name': 'Bakar'});
    await s.putDoc('devices', 'd1', {'name': 'iPad'});
    expect(await s.getDoc('users', 'u1'), {'name': 'Aminah'});
    expect(await s.list('users'), hasLength(2));
    expect(await s.list('devices'), hasLength(1));
    await s.deleteDoc('users', 'u1');
    expect(await s.getDoc('users', 'u1'), isNull);
  });

  test('putAll replaces, meta and blobs work', () async {
    await s.putDoc('users', 'old', {'v': 0});
    await s.putAll('users', {
      'a': {'v': 1},
    });
    expect(await s.getDoc('users', 'old'), isNull);
    expect(await s.list('users'), hasLength(1));
    await s.setMeta('cursor', '3');
    expect(await s.meta(), {'cursor': '3'});
    await s.setMeta('cursor', null);
    expect(await s.meta(), isEmpty);
    await s.putBlob('a1', Uint8List.fromList([1, 2, 3]));
    expect(await s.getBlob('a1'), [1, 2, 3]);
    expect(await s.bytes(), greaterThan(0));
  });

  test('oldest asset blob is evicted over the cap', () async {
    final small = IndexedDbLocalStore(blobCap: 25);
    await small.open('webbox-small');
    await small.putBlob('b1', Uint8List(10));
    await small.putBlob('b2', Uint8List(10));
    await small.putBlob('b3', Uint8List(10));
    expect(await small.getBlob('b1'), isNull);
    expect(await small.getBlob('b3'), isNotNull);
    await small.wipe();
  });

  test('wipe deletes the database', () async {
    await s.putDoc('users', 'u1', {'a': 1});
    expect(await _databases(), contains('maxcom-local-webbox'));
    await s.wipe();
    expect(await _databases(), isNot(contains('maxcom-local-webbox')));
  });
}
