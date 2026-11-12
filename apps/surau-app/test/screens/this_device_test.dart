// This device: what the box knows about it, the technical details folded,
// changing the PIN, the fingerprint switch (Android), signing out while
// keeping the enrolment, and forgetting the device. Golden: this_device.

import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import '../features/fakes.dart';
import '../features/shell/harness.dart';
import '../golden_sizes.dart';

Future<ShellHarness> openThisDevice(
  WidgetTester tester, {
  bool biometric = false,
  bool lock = true,
}) async {
  final h = ShellHarness(roles: const ['admin'], features: {'appLock': lock});
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
    expect(find.text('Surau D\'Waqaf'), findsOneWidget);
    expect(find.text('Butiran teknikal'), findsOneWidget);
    expect(find.textContaining('127.0.0.1'), findsNothing, reason: 'folded');
    expect(find.text('Tukar PIN'), findsOneWidget);
    expect(find.text('Guna cap jari'), findsNothing, reason: 'no biometrics here');
    expect(find.text('Log keluar'), findsOneWidget);
    expect(find.text('Lupakan peranti ini'), findsOneWidget);
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
        'Sesiapa yang memegang peranti ini boleh membuka MAXCOM. Pentadbir boleh menghidupkan kunci di Tetapan.',
      ),
      findsOneWidget,
    );
    expect(find.text('Log keluar'), findsOneWidget);
    expect(find.text('Lupakan peranti ini'), findsOneWidget);
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

  testWidgets('Lupakan peranti ini: confirm, then key and enrolment are gone', (
    tester,
  ) async {
    final h = await openThisDevice(tester);
    await tester.ensureVisible(find.text('Lupakan peranti ini'));
    await settle(tester);
    await tester.tap(find.text('Lupakan peranti ini'));
    await settle(tester);
    expect(find.text('Lupakan peranti ini?'), findsOneWidget);
    await tester.tap(find.widgetWithText(TextButton, 'Batal'));
    await settle(tester);
    expect((h.deps.key as FakeDeviceKey).clearCalls, 0);

    await tester.ensureVisible(find.text('Lupakan peranti ini'));
    await settle(tester);
    await tester.tap(find.text('Lupakan peranti ini'));
    await settle(tester);
    await tester.tap(find.widgetWithText(FilledButton, 'Lupakan'));
    await settle(tester);
    expect((h.deps.key as FakeDeviceKey).clearCalls, 1);
    expect(h.location, '/enrol');
  });
}
