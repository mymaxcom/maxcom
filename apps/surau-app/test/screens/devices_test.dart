// Devices grouped by person with the TV screens apart, a revoked device
// never listed, revoking with a confirmation, and kiosk
// pairing approval with the requester's address and the code's age.
// Goldens: devices, pairing.

import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:surau_app/app/theme.dart';

import '../features/fakes.dart';
import '../features/shell/harness.dart';
import '../golden_sizes.dart';

Future<ShellHarness> open(WidgetTester tester, String path) async {
  final h = await pumpShell(tester, roles: const ['admin']);
  h.router.go(path);
  await settle(tester);
  return h;
}

void main() {
  testWidgets('the list: grouped by person, platform named, revoked not listed', (
    tester,
  ) async {
    final h = await open(tester, '/devices');
    expect(h.location, '/devices');
    expect(find.text('Ustaz Ali'), findsOneWidget);
    expect(find.text('Aminah binti Yusof'), findsOneWidget);
    expect(find.text('Encik Hafiz'), findsOneWidget);
    expect(find.text('Pak Mat'), findsNothing, reason: 'no devices');
    expect(find.text('Telefon Ali'), findsOneWidget);
    expect(find.text('Android'), findsOneWidget, reason: 'the revoked phone is not listed');
    expect(find.text('iPad (Safari)'), findsOneWidget);
    expect(find.text('Pelayar web'), findsOneWidget);
    expect(find.text('Skrin utama'), findsOneWidget);
    expect(find.text('Skrin TV'), findsWidgets, reason: 'the kiosk group');
    expect(find.text('Dibatalkan'), findsNothing);
    expect(find.text('Telefon lama'), findsNothing, reason: 'revoked: never listed');
    expect(find.text('Batalkan'), findsNWidgets(4));

    final live = tester.widget<Text>(find.text('iPad Aminah'));
    expect(live.style?.color, isNot(SurauColors.muted));

    await expectGoldens(tester, h.app, 'devices');
  });

  testWidgets('Batalkan: confirm, then the device leaves the list', (tester) async {
    final h = await open(tester, '/devices');
    final row = find.ancestor(
      of: find.text('iPad Aminah'),
      matching: find.byKey(const ValueKey('device-dev-2')),
    );
    await tester.tap(find.descendant(of: row, matching: find.text('Batalkan')));
    await settle(tester);
    expect(find.text('Batalkan iPad Aminah?'), findsOneWidget);
    await tester.tap(find.widgetWithText(TextButton, 'Batal'));
    await settle(tester);
    expect(h.box.byPath('/api/devices/dev-2/revoke'), isNull);

    h.devices = [
      for (final d in h.devices)
        if (d['id'] == 'dev-2') {...d, 'revoked': true} else d,
    ];
    await tester.tap(find.descendant(of: row, matching: find.text('Batalkan')));
    await settle(tester);
    await tester.tap(find.widgetWithText(FilledButton, 'Batalkan'));
    await settle(tester);
    expect(h.box.byPath('/api/devices/dev-2/revoke')?.method, 'POST');
    expect(find.text('iPad Aminah dibatalkan.'), findsOneWidget);
    expect(find.text('Dibatalkan'), findsNothing);
    expect(find.text('iPad Aminah'), findsNothing);
    expect(find.text('Batalkan'), findsNWidgets(3));
  });

  testWidgets('Padankan skrin: the waiting request, then approval with name', (
    tester,
  ) async {
    final h = await open(tester, '/devices');
    await tester.tap(find.text('Padankan skrin TV'));
    await settle(tester);
    expect(h.location, '/pairing');
    expect(find.text('Skrin yang menunggu'), findsOneWidget);
    expect(find.text('Dari 10.168.0.23, 25 saat yang lalu'), findsOneWidget);
    await expectGoldens(tester, h.app, 'pairing');

    await pumpAtSize(tester, h.app, GoldenSize.phone);
    await tester.tap(find.text('Luluskan'));
    await settle(tester);
    expect(find.text('Masukkan 6 digit yang ditunjukkan di TV.'), findsOneWidget);

    await tester.enterText(find.byKey(const ValueKey('pair-code')), '123456');
    await tester.enterText(find.byKey(const ValueKey('pair-name')), 'Skrin utama');
    await tester.tap(find.text('Luluskan'));
    await settle(tester);
    expect(jsonDecode(h.box.byPath('/api/kiosk/pair/approve')!.body), {
      'code': '123456',
      'deviceName': 'Skrin utama',
    });
    expect(find.text('Skrin dipadankan: Skrin utama'), findsOneWidget);
    expect(find.text('Permintaan dari 10.168.0.23, kod berumur 25 saat.'), findsOneWidget);
  });

  testWidgets('pairing refusals: 429 and a wrong code', (tester) async {
    final h = await open(tester, '/pairing');
    h.handlers['POST /api/kiosk/pair/approve'] = (r) async => jsonResponse(
      429,
      {
        'errors': ['Terlalu banyak percubaan. Sila tunggu'],
      },
      headers: {'retry-after': '60'},
    );
    await tester.enterText(find.byKey(const ValueKey('pair-code')), '123456');
    await tester.tap(find.text('Luluskan'));
    await settle(tester);
    expect(find.textContaining('Terlalu banyak percubaan'), findsOneWidget);
    expect(
      (jsonDecode(h.box.byPath('/api/kiosk/pair/approve')!.body) as Map).containsKey('deviceName'),
      isFalse,
      reason: 'no name given, none sent',
    );

    h.handlers['POST /api/kiosk/pair/approve'] = (r) async => jsonResponse(404, {
      'errors': ['Kod pasangan tidak sah atau telah tamat'],
    });
    await tester.tap(find.text('Luluskan'));
    await settle(tester);
    expect(find.text('Kod pasangan tidak sah atau telah tamat'), findsOneWidget);
  });

  testWidgets('no screen waiting reads as such', (tester) async {
    final h = await pumpShell(tester, roles: const ['admin']);
    h.pending = {'pairings': <Object?>[]};
    h.router.go('/pairing');
    await settle(tester);
    expect(find.text('Tiada skrin sedang menunggu kelulusan.'), findsOneWidget);
  });
}
