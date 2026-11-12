// The offline profile and PIN verifier: kept in the sealed local store,
// PBKDF2-HMAC-SHA256 with a random 16-byte salt and >= 210 000 iterations,
// five wrong PINs lock offline unlock for five minutes (stored, so a restart
// keeps the lock), and no token is ever kept.

import 'dart:convert';
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:surau_app/features/unlock/offline_vault.dart';
import 'package:surau_app/store/local_store.dart';

/// The real derivation, inline (no isolate under the test runner).
Future<Uint8List> inline(String pin, Uint8List salt, int it) async =>
    pbkdf2Sha256(pin, salt, it);

void main() {
  var clock = DateTime.utc(2026, 11, 12, 8);
  DateTime now() => clock;

  OfflineVault vaultOn(LocalStore store, {int iterations = 1000}) =>
      OfflineVault(
        store: store,
        now: now,
        derive: inline,
        iterations: iterations,
        minIterations: iterations,
      );

  setUp(() => clock = DateTime.utc(2026, 11, 12, 8));

  test('PBKDF2-HMAC-SHA256 matches the RFC 7914 test vector', () {
    // RFC 7914 section 11: P="passwd", S="salt", c=1, dkLen=64 (first 32).
    final out = pbkdf2Sha256(
      'passwd',
      Uint8List.fromList(utf8.encode('salt')),
      1,
    );
    expect(
      out.map((b) => b.toRadixString(16).padLeft(2, '0')).join(),
      '55ac046e56e3089fec1691c22544b605f94185216dde0465e68b9d57c20dacbc',
    );
  });

  test('the profile round-trips and holds no token', () async {
    final store = MemoryLocalStore();
    final v = vaultOn(store);
    expect(await v.profile(), isNull);
    await v.saveProfile(
      OfflineProfile(
        userId: 'u1',
        name: 'Ustaz Ali',
        roles: const ['admin', 'ajk'],
        at: clock,
        surauName: 'Surau D\'Waqaf',
      ),
    );
    final p = await v.profile();
    expect(p!.userId, 'u1');
    expect(p.user.roles, ['admin', 'ajk']);
    expect(p.surauName, 'Surau D\'Waqaf');
    final raw = await store.getDoc(OfflineVault.collection, 'profile');
    expect(raw!.keys.toSet(), {'userId', 'name', 'roles', 'at', 'surauName'});
    expect(jsonEncode(raw), isNot(contains('token')));
  });

  test('default work is 210000 iterations with a 16-byte random salt, and '
      'the right PIN passes while a wrong one does not', () async {
    final store = MemoryLocalStore();
    final v = OfflineVault(store: store, now: now, derive: inline);
    await v.savePin('280419');
    final doc = (await store.getDoc(OfflineVault.collection, 'pin'))!;
    expect(doc['alg'], 'pbkdf2-sha256');
    expect(doc['it'], 210000);
    expect(base64.decode(doc['salt'] as String), hasLength(16));
    expect(base64.decode(doc['hash'] as String), hasLength(32));
    expect(jsonEncode(doc), isNot(contains('280419')));
    expect(await v.checkPin('280419'), isA<PinOk>());
    expect(await v.checkPin('111111'), isA<PinWrong>());
  });

  test('a new verifier gets a new salt', () async {
    final store = MemoryLocalStore();
    final v = vaultOn(store);
    await v.savePin('280419');
    final a = (await store.getDoc(OfflineVault.collection, 'pin'))!['salt'];
    await v.savePin('280419');
    final b = (await store.getDoc(OfflineVault.collection, 'pin'))!['salt'];
    expect(a, isNot(b));
  });

  test('five wrong PINs lock for five minutes, across a restart; then the '
      'right PIN works again', () async {
    final store = MemoryLocalStore();
    await vaultOn(store).savePin('280419');
    for (var i = 1; i <= 4; i++) {
      final r = await vaultOn(store).checkPin('000000');
      expect(r, isA<PinWrong>());
      expect((r as PinWrong).left, 5 - i);
    }
    final fifth = await vaultOn(store).checkPin('000000');
    expect(fifth, isA<PinLocked>());
    expect((fifth as PinLocked).until, clock.add(const Duration(minutes: 5)));

    // A new run (a fresh vault on the same store): still locked, even for
    // the right PIN.
    clock = clock.add(const Duration(minutes: 4, seconds: 59));
    expect(await vaultOn(store).checkPin('280419'), isA<PinLocked>());

    clock = clock.add(const Duration(seconds: 2));
    expect(await vaultOn(store).checkPin('280419'), isA<PinOk>());
    // The count started again.
    final r = await vaultOn(store).checkPin('000000');
    expect((r as PinWrong).left, 4);
  });

  test('the right PIN resets the count', () async {
    final store = MemoryLocalStore();
    final v = vaultOn(store);
    await v.savePin('280419');
    await v.checkPin('000000');
    await v.checkPin('000000');
    expect(await v.checkPin('280419'), isA<PinOk>());
    expect(((await v.checkPin('000000')) as PinWrong).left, 4);
  });

  test('no verifier, or one weaker than the minimum, is unknown', () async {
    final store = MemoryLocalStore();
    expect(await vaultOn(store).checkPin('280419'), isA<PinUnknown>());
    await vaultOn(store, iterations: 1000).savePin('280419');
    final strict = OfflineVault(
      store: store,
      now: now,
      derive: inline,
      minIterations: minPinIterations,
    );
    expect(await strict.checkPin('280419'), isA<PinUnknown>());
    expect(await strict.hasPin(), isFalse);
  });

  test('wiping the store (forget, revoked) removes both', () async {
    final store = MemoryLocalStore();
    final v = vaultOn(store);
    await v.saveProfile(
      OfflineProfile(userId: 'u1', name: 'A', roles: const [], at: clock),
    );
    await v.savePin('280419');
    await store.wipe();
    expect(await v.profile(), isNull);
    expect(await v.checkPin('280419'), isA<PinUnknown>());
  });
}
