// Plan 6 gate fixes (worker A): unreadable outbox is kept aside (Q14/S7), each
// sealed file is bound to its name and box (S7), one write per applied page.

import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:surau_app/store/local_store.dart';
import 'package:surau_app/store/local_store_android.dart';

class CountingSealer implements LocalSealer {
  int seals = 0;
  int resets = 0;
  static const _mark = 0xA7;

  @override
  Future<Uint8List> seal(String boxId, Uint8List plain) async {
    seals++;
    return Uint8List.fromList([_mark, ...plain.map((b) => b ^ 0x5a)]);
  }

  @override
  Future<Uint8List> open(String boxId, Uint8List sealed) async {
    if (sealed.isEmpty || sealed[0] != _mark) throw StateError('keystore');
    return Uint8List.fromList(sealed.skip(1).map((b) => b ^ 0x5a).toList());
  }

  @override
  Future<void> reset(String boxId) async => resets++;
}

void main() {
  late Directory tmp;
  late CountingSealer sealer;

  setUp(() {
    tmp = Directory.systemTemp.createTempSync('maxcom-gatefix-');
    sealer = CountingSealer();
  });
  tearDown(() {
    if (tmp.existsSync()) tmp.deleteSync(recursive: true);
  });

  Future<LocalStoreAndroid> open() async {
    final s = LocalStoreAndroid(root: tmp, sealer: sealer);
    await s.open('box1');
    return s;
  }

  File file(String name) => File('${tmp.path}/maxcom/box1/$name');

  test('an unreadable outbox is kept aside and reported, not dropped', () async {
    final a = await open();
    await a.putDoc(Collections.outbox, 'o1', {'op': 'x'});
    final garbage = Uint8List.fromList([1, 2, 3, 4, 5]);
    await file('outbox.bin').writeAsBytes(garbage);

    final b = await open();
    expect(await b.list(Collections.outbox), isEmpty);
    final meta = await b.meta();
    expect(meta[metaNeedsSnapshot], '1');
    expect(meta[metaOutboxUnreadable], isNotNull);
    expect(file('outbox.bin').existsSync(), isFalse);
    final aside = file('outbox.bin').parent
        .listSync()
        .whereType<File>()
        .where((f) => f.path.contains('outbox.bin.unreadable-'))
        .toList();
    expect(aside, hasLength(1));
    expect(await aside.single.readAsBytes(), garbage);
  });

  test('an unreadable ordinary collection still reads empty, no notice', () async {
    final a = await open();
    await a.putDoc('users', 'u1', {'id': 'u1'});
    await file('users.bin').writeAsBytes([9, 9, 9]);
    final b = await open();
    expect(await b.list('users'), isEmpty);
    final meta = await b.meta();
    expect(meta[metaNeedsSnapshot], '1');
    expect(meta.containsKey(metaOutboxUnreadable), isFalse);
  });

  test('a sealed file copied to another collection does not open', () async {
    final a = await open();
    await a.putDoc('settings', 'clock', {'a': 1});
    await file('settings.bin').copy(file('users.bin').path);
    final b = await open();
    expect(await b.list('users'), isEmpty);
    expect((await b.meta())[metaNeedsSnapshot], '1');
    expect(await b.list('settings'), hasLength(1));
  });

  test('a blob copied to another id does not open', () async {
    final a = await open();
    await a.putBlob('asset-one', Uint8List.fromList([1, 2, 3]));
    final src = File('${tmp.path}/maxcom/box1/blobs/asset-one.bin');
    await src.copy('${tmp.path}/maxcom/box1/blobs/asset-two.bin');
    final b = await open();
    expect(await b.getBlob('asset-one'), [1, 2, 3]);
    expect(await b.getBlob('asset-two'), isNull);
  });

  test('a file sealed before the header existed still opens, then gains it', () async {
    final first = await open();
    await first.putDoc('settings', 'seed', {'x': 1}); // creates the folder
    final legacy = await sealer.seal(
      'box1',
      Uint8List.fromList(
        utf8.encode(
          jsonEncode({
            'clock': {'on': true},
          }),
        ),
      ),
    );
    await file('settings.bin').writeAsBytes(legacy);
    final s = await open();
    expect((await s.getDoc('settings', 'clock'))!['on'], true);
    expect((await s.meta()).containsKey(metaNeedsSnapshot), isFalse);
    await s.putDoc('settings', 'other', {'y': 2});
    final plain = await sealer.open('box1', await file('settings.bin').readAsBytes());
    expect(utf8.decode(plain.sublist(0, 4)), 'MXB1');
    final again = await open();
    expect(await again.list('settings'), hasLength(2));
  });

  test('applyDocs writes the collection once for a whole page', () async {
    final s = await open();
    final before = sealer.seals;
    await s.applyDocs(
      'content:pengumuman',
      puts: {
        for (var i = 0; i < 30; i++) 'p$i': {'id': 'p$i', 'n': i},
      },
    );
    expect(sealer.seals - before, 1);
    await s.applyDocs('content:pengumuman', deletes: {'p0', 'p1'});
    expect(await s.list('content:pengumuman'), hasLength(28));
    final fresh = await open();
    expect(await fresh.list('content:pengumuman'), hasLength(28));
  });
}
