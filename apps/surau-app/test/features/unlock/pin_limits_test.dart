// The remembered PIN's limits and what the app does with a revoked phone,
// over the whole app's providers and a fake box: with the app lock on the PIN
// is dropped after 2 h without use or 12 h after the unlock (A3), the new PIN
// replaces the old one everywhere after Tukar PIN (A2), and any "revoked"
// answer wipes the local copy and the offline vault (K2).

import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:surau_app/app/providers.dart';
import 'package:surau_app/box/box_client.dart';
import 'package:surau_app/box/locator.dart';
import 'package:surau_app/box/wire.dart';
import 'package:surau_app/features/enrol/enrol_flow.dart';
import 'package:surau_app/features/unlock/offline_vault.dart';
import 'package:surau_app/features/unlock/session_keeper.dart';
import 'package:surau_app/store/local_store.dart';
import 'package:surau_app/sync/sync_providers.dart';

import '../fakes.dart';
import '../shell/harness.dart';

class _Here implements BoxLocator {
  @override
  Future<Located> locate(EnrolledBox b) async => Located(
    base: b.box,
    via: 'box',
    health: HealthDto.fromJson(healthyJson),
  );
}

Future<OfflineVault> _vault(LocalStore store) async => OfflineVault(
  store: store,
  now: fixedNow,
  derive: (pin, salt, it) async => pbkdf2Sha256(pin, salt, it),
  iterations: 1000,
  minIterations: 1000,
);

void main() {
  var clock = DateTime.utc(2026, 11, 18, 8);
  late LocalStore store;
  late OfflineVault vault;
  late PinMemory memory;
  late ShellHarness h;

  setUp(() async {
    clock = DateTime.utc(2026, 11, 18, 8);
    store = MemoryLocalStore();
    vault = await _vault(store);
    memory = PinMemory(now: () => clock);
  });

  Future<ShellHarness> harness({bool lock = true}) async {
    h = ShellHarness(
      roles: const ['admin'],
      features: {'appLock': lock},
      overrides: [
        baseLocatorProvider.overrideWithValue(_Here()),
        pinMemoryProvider.overrideWithValue(memory),
        offlineVaultProvider.overrideWith((ref) async => vault),
        localStoreProvider.overrideWith((ref) async => store),
      ],
    );
    h.unlock();
    await h.container.read(settingsProvider.future);
    return h;
  }

  List<String> unlockPins(ShellHarness h) => [
    for (final r in h.box.seen)
      if (r.url.path == '/api/auth/unlock')
        (jsonDecode(r.body) as Map<String, dynamic>)['pin'] as String? ?? '',
  ];

  group('[A3] the remembered PIN has the limits of the server', () {
    test('1 h 59 min without use: the silent unlock still sends the PIN', () async {
      await harness();
      memory.value = '280419';
      clock = clock.add(const Duration(hours: 1, minutes: 59));
      await h.container.read(sessionKeeperProvider).expired();
      expect(unlockPins(h), ['280419']);
    });

    test('2 h without use: the PIN is dropped, nothing is sent, the person is '
        'sent to the unlock screen', () async {
      await harness();
      memory.value = '280419';
      clock = clock.add(const Duration(hours: 2, minutes: 1));
      await h.container.read(sessionKeeperProvider).expired();
      expect(unlockPins(h), isEmpty);
      expect(h.box.seen.where((r) => r.url.path == '/api/auth/unlock'), isEmpty);
      expect(h.container.read(sessionProvider), isNull);
      expect(memory.value, isNull);
    });

    test('12 h after the unlock: dropped even when the app was used all along',
        () async {
      await harness();
      memory.value = '280419';
      for (var i = 0; i < 11; i++) {
        clock = clock.add(const Duration(hours: 1));
        memory.touch();
      }
      expect(memory.value, '280419', reason: '11 h, used each hour');
      clock = clock.add(const Duration(hours: 1, minutes: 1));
      memory.touch();
      expect(memory.value, isNull);
      await h.container.read(sessionKeeperProvider).expired();
      expect(unlockPins(h), isEmpty);
    });

    test('use restarts the 2 h clock; coming back after 2 h does not', () {
      memory.value = '280419';
      clock = clock.add(const Duration(hours: 1, minutes: 50));
      memory.touch();
      clock = clock.add(const Duration(hours: 1, minutes: 50));
      expect(memory.value, '280419');
      clock = clock.add(const Duration(hours: 2, minutes: 1));
      memory.touch();
      expect(memory.value, isNull, reason: 'a resume after 2 h drops it');
    });

    test('the lock OFF: nothing is asked, the unlock carries no PIN', () async {
      await harness(lock: false);
      await h.container.read(enrolledBoxProvider.notifier).setAppLock(false);
      clock = clock.add(const Duration(hours: 30));
      await h.container.read(sessionKeeperProvider).expired();
      final sent = h.box.seen.where((r) => r.url.path == '/api/auth/unlock');
      expect(sent, hasLength(1), reason: 'device key only, no unlock screen');
      expect(unlockPins(h), ['']);
      expect(h.container.read(sessionProvider), isNotNull);
    });
  });

  group('[K2] a revoked answer wipes the copy and shuts the offline door', () {
    Future<void> seed() async {
      await store.putDoc(Collections.settings, 'clock', {'enabled': true});
      await vault.saveProfile(
        OfflineProfile(userId: 'u1', name: 'Ustaz Ali', roles: const ['admin'], at: clock),
      );
      await vault.savePin('280419');
    }

    Future<void> expectWiped() async {
      expect(await store.getDoc(Collections.settings, 'clock'), isNull);
      expect(await vault.profile(), isNull);
      expect(await vault.checkPin('280419'), isA<PinClosed>());
      expect(h.container.read(revokedProvider), isTrue);
    }

    http.Response revoked() => jsonResponse(401, {
      'errors': ['Peranti telah dibatalkan'],
      'code': 'device_revoked',
    });

    test("the keeper's silent unlock", () async {
      await harness();
      await seed();
      memory.value = '280419';
      h.handlers['POST /api/auth/unlock'] = (r) async => revoked();
      await h.container.read(sessionKeeperProvider).expired();
      await expectWiped();
      expect(h.container.read(sessionProvider), isNull);
    });

    test('the box unreachable wipes nothing', () async {
      await harness();
      await seed();
      memory.value = '280419';
      h.boxAway = true;
      h.handlers['POST /api/auth/unlock'] = (r) async =>
          throw http.ClientException('away');
      await h.container.read(sessionKeeperProvider).expired();
      expect(await store.getDoc(Collections.settings, 'clock'), isNotNull);
      expect(await vault.profile(), isNotNull);
      expect(await vault.checkPin('280419'), isA<PinOk>());
      expect(h.container.read(revokedProvider), isFalse);
    });
  });

  test('[A2] replace keeps the clocks and only changes the PIN', () {
    memory.value = '280419';
    clock = clock.add(const Duration(hours: 1));
    memory.replace('246813');
    expect(memory.value, '246813');
    clock = clock.add(const Duration(hours: 1, minutes: 1));
    expect(memory.value, isNull, reason: 'the idle clock was not restarted');
    memory.replace('135790');
    expect(memory.value, isNull, reason: 'nothing to replace once dropped');
  });
}
