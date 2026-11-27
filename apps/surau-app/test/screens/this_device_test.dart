// This device: what the box knows about it, the technical details folded,
// changing the PIN, the fingerprint switch (Android), signing out while
// keeping the enrolment, and forgetting the device. Golden: this_device.

import 'dart:convert';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/misc.dart' show Override;
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:surau_app/app/app_lang.dart';
import 'package:surau_app/box/locator.dart';
import 'package:surau_app/features/live/fake_publisher.dart';
import 'package:surau_app/features/live/live_controller.dart' show livePublisherProvider;
import 'package:surau_app/box/wire.dart';
import 'package:surau_app/features/enrol/enrol_flow.dart';
import 'package:surau_app/features/unlock/offline_vault.dart';
import 'package:surau_app/features/unlock/session_keeper.dart';
import 'package:surau_app/store/local_store.dart';
import 'package:surau_app/sync/sync_providers.dart';

import '../features/fakes.dart';
import '../features/shell/harness.dart';
import '../golden_sizes.dart';

class _Here implements BoxLocator {
  @override
  Future<Located> locate(EnrolledBox b) async =>
      Located(base: b.box, via: 'box', health: HealthDto.fromJson(healthyJson));
}

Future<ShellHarness> openThisDevice(
  WidgetTester tester, {
  bool biometric = false,
  bool lock = true,
  List<Override> overrides = const [],
}) async {
  final h = ShellHarness(
    roles: const ['admin'],
    features: {'appLock': lock},
    overrides: overrides,
  );
  (h.deps.biometric as FakeBiometricPin).isAvailable = biometric;
  h.unlock();
  await pumpAtSize(tester, h.app, GoldenSize.phone);
  h.router.go('/this-device');
  await settle(tester);
  return h;
}

void main() {
  testWidgets('the device, its person, the folded details and the actions', (
    tester,
  ) async {
    final h = await openThisDevice(tester);
    expect(h.location, '/this-device');
    expect(find.text('Telefon Ali'), findsOneWidget);
    expect(find.text('Android'), findsOneWidget);
    expect(find.text('Ustaz Ali'), findsOneWidget);
    expect(find.text('Pentadbir'), findsOneWidget);
    expect(find.text('Surau Contoh'), findsOneWidget);
    expect(find.text('Butiran teknikal'), findsOneWidget);
    expect(find.textContaining('127.0.0.1'), findsNothing, reason: 'folded');
    expect(find.text('Tukar PIN'), findsOneWidget);
    expect(find.text('Guna cap jari'), findsNothing, reason: 'no biometrics here');
    expect(find.text('Log keluar'), findsOneWidget);
    expect(find.text('Lupakan peranti ini'), findsNothing);
    await expectGoldens(tester, h.app, 'this_device');

    await pumpAtSize(tester, h.app, GoldenSize.phone);
    await tester.tap(find.text('Butiran teknikal'));
    await settle(tester);
    expect(find.text('https://127.0.0.1:8443'), findsOneWidget);
  });

  testWidgets('lock off: no Tukar PIN, no fingerprint row, one line that says why', (
    tester,
  ) async {
    final h = await openThisDevice(tester, biometric: true, lock: false);
    expect(find.text('Tukar PIN'), findsNothing);
    expect(find.text('Guna cap jari'), findsNothing);
    expect(find.text('Kunci aplikasi dimatikan'), findsOneWidget);
    expect(
      find.text(
        'Sesiapa yang memegang peranti ini boleh membuka MAXCOM. Pentadbir boleh menghidupkan kunci di Konfigurasi.',
      ),
      findsOneWidget,
    );
    expect(find.text('Log keluar'), findsOneWidget);
    expect(find.text('Lupakan peranti ini'), findsNothing);
    await expectGoldens(tester, h.app, 'this_device_nolock');
  });

  testWidgets('lock on with biometrics: the fingerprint row is back', (tester) async {
    await openThisDevice(tester, biometric: true, lock: true);
    expect(find.text('Tukar PIN'), findsOneWidget);
    expect(find.text('Guna cap jari'), findsOneWidget);
    expect(find.text('Kunci aplikasi dimatikan'), findsNothing);
  });

  testWidgets('Tukar PIN sends {currentPin, newPin}; a mismatch never leaves', (
    tester,
  ) async {
    final h = await openThisDevice(tester);
    await tester.tap(find.text('Tukar PIN'));
    await settle(tester);
    await tester.enterText(find.byKey(const ValueKey('pin-current')), '123456');
    await tester.enterText(find.byKey(const ValueKey('pin-new')), '246813');
    await tester.enterText(find.byKey(const ValueKey('pin-again')), '246814');
    await tester.tap(find.widgetWithText(FilledButton, 'Tukar PIN'));
    await settle(tester);
    expect(find.text('PIN tidak sepadan'), findsOneWidget);
    expect(h.box.byPath('/api/auth/pin'), isNull);

    await tester.enterText(find.byKey(const ValueKey('pin-again')), '246813');
    await tester.tap(find.widgetWithText(FilledButton, 'Tukar PIN'));
    await settle(tester);
    final put = h.box.byPath('/api/auth/pin')!;
    expect(put.method, 'PUT');
    expect(jsonDecode(put.body), {'currentPin': '123456', 'newPin': '246813'});
    expect(find.text('PIN ditukar'), findsOneWidget);

    // The box's refusal is shown in its words.
    h.handlers['PUT /api/auth/pin'] = (r) async => jsonResponse(401, {
      'errors': ['PIN salah'],
    });
    await tester.tap(find.text('Tukar PIN'));
    await settle(tester);
    await tester.enterText(find.byKey(const ValueKey('pin-current')), '111222');
    await tester.enterText(find.byKey(const ValueKey('pin-new')), '246813');
    await tester.enterText(find.byKey(const ValueKey('pin-again')), '246813');
    await tester.tap(find.widgetWithText(FilledButton, 'Tukar PIN'));
    await settle(tester);
    expect(find.text('PIN salah'), findsOneWidget);
    expect(h.location, '/this-device', reason: 'a wrong PIN is not an expired session');
  });

  testWidgets('Guna cap jari: on asks for the PIN and seals it; off clears it', (
    tester,
  ) async {
    final h = await openThisDevice(tester, biometric: true);
    final bio = h.deps.biometric as FakeBiometricPin;
    expect(find.text('Guna cap jari'), findsOneWidget);
    await tester.tap(find.byType(Switch));
    await settle(tester);
    expect(find.text('Masukkan PIN anda'), findsOneWidget);
    await tester.enterText(find.byKey(const ValueKey('pin-seal')), '246813');
    await tester.tap(find.widgetWithText(FilledButton, 'Teruskan'));
    await settle(tester);
    expect(bio.sealed, '246813');
    expect(find.text('Cap jari dihidupkan'), findsOneWidget);

    await tester.tap(find.byType(Switch));
    await settle(tester);
    expect(bio.sealed, isNull);
    expect(find.text('Cap jari dimatikan'), findsOneWidget);
  });

  testWidgets('a cancelled fingerprint seal leaves the switch off', (
    tester,
  ) async {
    final h = await openThisDevice(tester, biometric: true);
    final bio = h.deps.biometric as FakeBiometricPin;
    bio.sealFails = true;
    await tester.tap(find.byType(Switch));
    await settle(tester);
    await tester.enterText(find.byKey(const ValueKey('pin-seal')), '246813');
    await tester.tap(find.widgetWithText(FilledButton, 'Teruskan'));
    await settle(tester);
    expect(bio.sealed, isNull);
    expect(tester.widget<Switch>(find.byType(Switch)).value, isFalse);
    expect(find.text('Cap jari dihidupkan'), findsNothing);
  });

  testWidgets('PIN change with a failed re-seal clears the old sealed PIN', (
    tester,
  ) async {
    final h = await openThisDevice(tester, biometric: true);
    final bio = h.deps.biometric as FakeBiometricPin;
    bio.sealed = '123456';
    bio.sealFails = true;
    await tester.tap(find.text('Tukar PIN'));
    await settle(tester);
    await tester.enterText(find.byKey(const ValueKey('pin-current')), '123456');
    await tester.enterText(find.byKey(const ValueKey('pin-new')), '246813');
    await tester.enterText(find.byKey(const ValueKey('pin-again')), '246813');
    await tester.tap(find.widgetWithText(FilledButton, 'Tukar PIN'));
    await settle(tester);
    expect(h.box.byPath('/api/auth/pin')?.method, 'PUT');
    expect(bio.sealed, isNull);
    expect(find.text('PIN ditukar'), findsOneWidget);
  });

  testWidgets('Log keluar tells the box, locks the app and keeps the enrolment', (
    tester,
  ) async {
    final h = await openThisDevice(tester);
    await tester.tap(find.text('Log keluar'));
    await settle(tester);
    expect(h.box.byPath('/api/auth/logout')?.method, 'POST');
    expect(h.location, '/unlock');
    expect(find.text('Assalamualaikum, Ustaz Ali'), findsOneWidget);
    expect((h.deps.key as FakeDeviceKey).clearCalls, 0);
  });

  testWidgets('[A1] there is no "Lupakan peranti ini": Keluar dari surau is the '
      'one way out, and nothing in the screen clears the key on its own', (
    tester,
  ) async {
    final h = await openThisDevice(tester);
    await tester.ensureVisible(find.byKey(const ValueKey('this-device-leave')));
    await settle(tester);
    expect(find.text('Lupakan peranti ini'), findsNothing);
    expect(find.byKey(const ValueKey('this-device-leave')), findsOneWidget);
    expect(find.text('Keluar dari surau'), findsOneWidget);
    expect((h.deps.key as FakeDeviceKey).clearCalls, 0);
    final src = File('lib/screens/this_device_screen.dart').readAsStringSync();
    expect(src.contains('key.clear()'), isFalse);
    expect(src.contains('.forget()'), isFalse);
  });

  group('[A2] after Tukar PIN nothing keeps the old PIN', () {
    testWidgets('the keeper sends the NEW PIN on its next silent unlock and the '
        'vault accepts the new and refuses the old', (tester) async {
      final vault = OfflineVault(
        store: MemoryLocalStore(),
        now: fixedNow,
        derive: (pin, salt, it) async => pbkdf2Sha256(pin, salt, it),
        iterations: 1000,
        minIterations: 1000,
      );
      await vault.savePin('123456');
      final h = await openThisDevice(
        tester,
        overrides: [
          baseLocatorProvider.overrideWithValue(_Here()),
          offlineVaultProvider.overrideWith((ref) async => vault),
        ],
      );
      h.container.read(pinMemoryProvider).value = '123456';
      await tester.tap(find.text('Tukar PIN'));
      await settle(tester);
      await tester.enterText(find.byKey(const ValueKey('pin-current')), '123456');
      await tester.enterText(find.byKey(const ValueKey('pin-new')), '246813');
      await tester.enterText(find.byKey(const ValueKey('pin-again')), '246813');
      await tester.tap(find.widgetWithText(FilledButton, 'Tukar PIN'));
      await settle(tester);
      expect(find.text('PIN ditukar'), findsOneWidget);
      expect(h.container.read(pinMemoryProvider).value, '246813');

      await h.container.read(sessionKeeperProvider).expired();
      final pins = [
        for (final r in h.box.seen)
          if (r.url.path == '/api/auth/unlock') jsonDecode(r.body)['pin'],
      ];
      expect(pins, ['246813']);
      expect(await vault.checkPin('123456'), isA<PinWrong>());
      expect(await vault.checkPin('246813'), isA<PinOk>());
    });
  });

  group('[A8] the fingerprint seals only a PIN the box (or the vault) accepted', () {
    Future<void> turnOn(WidgetTester tester, String pin) async {
      await tester.tap(find.byType(Switch));
      await settle(tester);
      await tester.enterText(find.byKey(const ValueKey('pin-seal')), pin);
      await tester.tap(find.widgetWithText(FilledButton, 'Teruskan'));
      await settle(tester);
    }

    testWidgets('a wrong PIN is refused in the dialog and never sealed', (
      tester,
    ) async {
      final h = await openThisDevice(tester, biometric: true);
      final bio = h.deps.biometric as FakeBiometricPin;
      h.handlers['POST /api/auth/unlock'] = (r) async => jsonResponse(401, {
        'errors': ['PIN salah'],
        'code': 'wrong_pin',
      });
      await turnOn(tester, '999999');
      expect(bio.sealed, isNull);
      expect(find.text('PIN salah'), findsOneWidget);
      expect(find.text('Masukkan PIN anda'), findsOneWidget, reason: 'the dialog stays');
      expect(find.text('Cap jari dihidupkan'), findsNothing);
    });

    testWidgets('the right PIN is sealed after the box accepted it', (tester) async {
      final h = await openThisDevice(tester, biometric: true);
      final bio = h.deps.biometric as FakeBiometricPin;
      await turnOn(tester, '246813');
      expect(bio.sealed, '246813');
      final sent = h.box.seen.where((r) => r.url.path == '/api/auth/unlock');
      expect(jsonDecode(sent.single.body)['pin'], '246813');
    });

    testWidgets('the box away: the offline vault decides', (tester) async {
      final vault = OfflineVault(
        store: MemoryLocalStore(),
        now: fixedNow,
        derive: (pin, salt, it) async => pbkdf2Sha256(pin, salt, it),
        iterations: 1000,
        minIterations: 1000,
      );
      await vault.savePin('246813');
      final h = await openThisDevice(
        tester,
        biometric: true,
        overrides: [offlineVaultProvider.overrideWith((ref) async => vault)],
      );
      final bio = h.deps.biometric as FakeBiometricPin;
      h.handlers['POST /api/auth/challenge'] = (r) async =>
          throw http.ClientException('away');
      await turnOn(tester, '111111');
      expect(bio.sealed, isNull);
      expect(find.text('PIN salah. 4 cubaan lagi.'), findsOneWidget);
      await tester.enterText(find.byKey(const ValueKey('pin-seal')), '246813');
      await tester.tap(find.widgetWithText(FilledButton, 'Teruskan'));
      await settle(tester);
      expect(bio.sealed, '246813');
    });

    testWidgets('the box away and no verifier: not sealed, and it says why', (
      tester,
    ) async {
      final h = await openThisDevice(tester, biometric: true);
      final bio = h.deps.biometric as FakeBiometricPin;
      h.handlers['POST /api/auth/challenge'] = (r) async =>
          throw http.ClientException('away');
      await turnOn(tester, '246813');
      expect(bio.sealed, isNull);
      expect(find.textContaining('tidak dapat disemak'), findsOneWidget);
    });
  });

  testWidgets('[PP-A8b] Tukar nama peranti ini renames this device and the header shows the new name', (tester) async {
    final h = await openThisDevice(tester);
    final sent = <Object?>[];
    h.handlers['PUT /api/auth/device/name'] = (r) async {
      final body = jsonDecode(r.body) as Map<String, dynamic>;
      sent.add(body);
      h.me = {
        ...meFixture(),
        'device': {'id': 'dev-1', 'name': body['name'], 'platform': 'android'},
      };
      return jsonResponse(200, {'ok': true});
    };
    await tester.tap(find.byKey(const ValueKey('this-device-rename')));
    await settle(tester);
    expect(find.text('Log perubahan lama kekal dengan nama lama peranti ini.'), findsOneWidget);
    // A direction override: refused, nothing is sent.
    await tester.enterText(find.byKey(const ValueKey('this-device-name-field')), 'Telefon \u202EAli');
    await tester.tap(find.byKey(const ValueKey('this-device-name-save')));
    await settle(tester);
    expect(sent, isEmpty);
    expect(find.text('Nama mesti 1 hingga 80 aksara'), findsOneWidget);
    await tester.enterText(find.byKey(const ValueKey('this-device-name-field')), '  Telefon   Ustaz Ali ');
    await tester.tap(find.byKey(const ValueKey('this-device-name-save')));
    await settle(tester);
    expect(sent, [
      {'name': 'Telefon Ustaz Ali'},
    ]);
    expect(find.text('Nama peranti disimpan.'), findsOneWidget);
    expect(find.text('Telefon Ustaz Ali'), findsOneWidget);
  });

  testWidgets('[PP-A8b] an older box (404 on the route) says to update MAX Kiosk Server', (tester) async {
    final h = await openThisDevice(tester);
    h.handlers['PUT /api/auth/device/name'] = (r) async => jsonResponse(404, {
      'errors': ['Not Found'],
    });
    await tester.tap(find.byKey(const ValueKey('this-device-rename')));
    await settle(tester);
    await tester.enterText(find.byKey(const ValueKey('this-device-name-field')), 'Telefon baharu');
    await tester.tap(find.byKey(const ValueKey('this-device-name-save')));
    await settle(tester);
    expect(find.text('Kemas kini MAX Kiosk Server untuk fungsi ini'), findsOneWidget);
  });

  testWidgets('[PP-A8b] own user ID, device ID and own phone number from /api/auth/me', (tester) async {
    final h = ShellHarness(roles: const ['admin'], features: const {'appLock': true});
    h.me = {
      ...meFixture(),
      'user': {'id': 'u1', 'name': 'Ustaz Ali', 'ref': 'U-0001', 'phone': '+60120000003'},
      'device': {'id': 'dev-1', 'name': 'Telefon Ali', 'platform': 'android', 'ref': 'D-0002'},
    };
    h.unlock();
    await pumpAtSize(tester, h.app, GoldenSize.phone);
    h.router.go('/this-device');
    await settle(tester);
    expect(find.text('U-0001'), findsOneWidget);
    expect(find.text('D-0002'), findsOneWidget);
    expect(find.byKey(const ValueKey('this-device-phone')), findsOneWidget);
    expect(find.text('\u2066+60 12-000 0003\u2069'), findsOneWidget);
  });

  testWidgets('[PP-A8b] Arabic: IDs and the phone number stay left to right', (tester) async {
    final h = ShellHarness(
      roles: const ['admin'],
      features: const {'appLock': true},
      overrides: [
        appLangStoreProvider.overrideWithValue(MemoryAppLangStore(AppLang.ar)),
        livePublisherProvider.overrideWithValue(FakePublisher()),
      ],
    );
    h.me = {
      ...meFixture(),
      'user': {'id': 'u1', 'name': 'Ustaz Ali', 'ref': 'U-0001', 'phone': '+60120000003'},
      'device': {'id': 'dev-1', 'name': 'Telefon Ali', 'platform': 'android', 'ref': 'D-0002'},
    };
    h.unlock();
    await pumpAtSize(tester, h.app, GoldenSize.phone);
    h.router.go('/this-device');
    await settle(tester);
    expect(find.text('D-0002'), findsOneWidget);
    await expectGoldens(tester, h.app, 'this_device_ar', sizes: const [GoldenSize.phone]);
  });
}
