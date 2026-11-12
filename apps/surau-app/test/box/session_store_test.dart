import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:surau_app/box/session_store.dart';
import 'package:surau_app/box/trust.dart';
import 'package:surau_app/features/common/surau_info.dart';
import 'package:surau_app/features/enrol/enrol_flow.dart';

final _box = EnrolledBox(
  box: Uri.parse('https://10.168.0.154:8443'),
  boxId: 'a1b2c3d4e5f60718',
  deviceId: 'dev1',
  userId: 'u1',
  userName: 'Ali',
  roles: const ['admin', 'treasurer'],
  caSha256: 'ab' * 32,
);

void main() {
  late SharedPreferences prefs;
  late SessionStore store;

  setUp(() async {
    SharedPreferences.setMockInitialValues({});
    prefs = await SharedPreferences.getInstance();
    store = SessionStore(prefs);
  });

  test('nothing saved loads null', () async {
    expect(await store.load(), isNull);
    expect(await SurauInfoPrefsStore(prefs).load(), isNull);
  });

  test('save then load round-trips every field', () async {
    await store.save(_box);
    final got = (await SessionStore(prefs).load())!;
    expect(got.box, _box.box);
    expect(got.boxId, _box.boxId);
    expect(got.deviceId, 'dev1');
    expect(got.userName, 'Ali');
    expect(got.roles, ['admin', 'treasurer']);
    expect(got.caSha256, _box.caSha256);
  });

  test('keys are under surau.box.* and hold no token or key', () async {
    await store.save(_box);
    await SurauInfoPrefsStore(prefs)
        .save(const SurauInfo(name: 'Surau D\'Waqaf'));
    expect(prefs.getKeys(), isNotEmpty);
    expect(prefs.getKeys().every((k) => k.startsWith('surau.box.')), isTrue);
    final all = prefs.getKeys().map((k) => '${prefs.get(k)}').join();
    expect(all.toLowerCase(), isNot(contains('token')));
    expect(all.toLowerCase(), isNot(contains('private')));
  });

  test('corrupt stored JSON loads null and is dropped', () async {
    await prefs.setString('surau.box.enrolled', '{not json');
    expect(await store.load(), isNull);
    expect(prefs.containsKey('surau.box.enrolled'), isFalse);
    await prefs.setString('surau.box.enrolled', '{"box":"x"}');
    expect(await store.load(), isNull);
  });

  test('surau info round-trips through the SurauInfoStore side', () async {
    await store.save(_box);
    await SurauInfoPrefsStore(prefs).save(const SurauInfo(
        name: 'Surau D\'Waqaf',
        help: HelpContact(name: 'Encik Hafiz', phone: '012-345 6789')));
    final i = (await SurauInfoPrefsStore(prefs).load())!;
    expect(i.name, 'Surau D\'Waqaf');
    expect(i.help!.phone, '012-345 6789');
  });

  test('CA DER is stored by hash and re-verified on load', () async {
    final der = Uint8List.fromList(List.generate(40, (i) => i));
    final sha = sha256Hex(der);
    await store.saveCaDer(sha, der);
    expect(await store.loadCaDer(sha), der);
    expect(await store.loadCaDer('f' * 64), isNull);
    // Tamper with the stored bytes: the hash check refuses them.
    final key = prefs.getKeys().firstWhere((k) => k.contains('.ca.'));
    await prefs.setString(key, 'AAAA');
    expect(await store.loadCaDer(sha), isNull);
  });

  test('saveCaDer refuses bytes that do not hash to the key', () async {
    expect(() => store.saveCaDer('0' * 64, Uint8List.fromList([1, 2])),
        throwsArgumentError);
  });

  test('forget and clear remove the box, CA and info', () async {
    final der = Uint8List.fromList([9, 9, 9]);
    await store.save(_box);
    await SurauInfoPrefsStore(prefs).save(const SurauInfo(name: 'X Y'));
    await store.saveCaDer(sha256Hex(der), der);
    await store.forget();
    expect(prefs.getKeys().where((k) => k.startsWith('surau.box.')), isEmpty);
    expect(await store.load(), isNull);
    await store.save(_box);
    await store.clear();
    expect(await store.load(), isNull);
  });

  test('store is usable as both seams', () {
    final EnrolledBoxStore a = store;
    final SurauInfoStore b = SurauInfoPrefsStore(prefs);
    expect(a, isNotNull);
    expect(b, isNotNull);
  });
}
