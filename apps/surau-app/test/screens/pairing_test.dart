// Skrin TV (plan PP, task A4): "MAXCOM di surau" (the box itself, no ID, no
// Padam) on top, the paired TV screens with their ID, "Hidup" when seen in
// the last 10 minutes, "Tidak aktif" and a direct Padam when the box flags
// them, the same sheet as Peranti; then "Padankan skrin baharu" with the
// pairing form as before (the waiting request, approval with a name,
// refusals). Goldens: pairing, pairing_ar.

import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/misc.dart' show Override;
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:surau_app/app/app_lang.dart';
import 'package:surau_app/features/live/fake_publisher.dart';
import 'package:surau_app/features/live/live_screen.dart' show livePublisherProvider;

import '../features/fakes.dart';
import '../features/shell/harness.dart';
import '../golden_sizes.dart';

Map<String, Object?> tv(String id, String name, String? ref, {bool revoked = false}) => {
  'id': id,
  'userId': 'u1',
  'name': name,
  'platform': 'kiosk',
  'revoked': revoked,
  'enrolledAt': id == 'tv-5' ? '2026-10-14T09:00:00.000Z' : '2026-11-02T09:00:00.000Z',
  'ref': ?ref,
};

List<Map<String, Object?>> screens() => [
  {'id': 'dev-1', 'userId': 'u1', 'name': 'Telefon Ali', 'platform': 'android', 'revoked': false, 'ref': 'D-0001'},
  tv('tv-5', 'Paparan surau', 'D-0005'),
  tv('tv-10', 'Paparan surau', 'D-0010'),
  tv('tv-9', 'TV dewan serbaguna', 'D-0009'),
  tv('tv-old', 'Skrin lama', 'D-0004', revoked: true),
];

/// The box's answer at 2026-11-04 14:30 UTC.
Map<String, Object?> activity() => {
  'now': '2026-11-04T14:30:00.000Z',
  'authority': 'box',
  'devices': [
    {'id': 'dev-1', 'userId': 'u1', 'kind': 'device', 'idleDays': 0, 'inactive': false},
    {
      'id': 'tv-5',
      'userId': 'u1',
      'kind': 'tv',
      'idleDays': 0,
      'inactive': false,
      'lastSeenAt': '2026-11-04T14:27:00.000Z',
    },
    {
      'id': 'tv-10',
      'userId': 'u1',
      'kind': 'tv',
      'idleDays': 0,
      'inactive': false,
      'lastSeenAt': '2026-11-04T14:29:00.000Z',
    },
    {
      'id': 'tv-9',
      'userId': 'u1',
      'kind': 'tv',
      'idleDays': 41,
      'inactive': true,
      'lastSeenAt': '2026-09-24T10:00:00.000Z',
    },
  ],
  'users': <Object?>[],
};

http.Response boxInfo() => jsonResponse(200, {
  'boxId': '0123456789abcdef',
  'keyFp': '4f2a9c1e77b0d3a1',
  'name': 'MAXCOM Dewan Utama',
  'state': 'active',
  'reason': 'none',
  'linked': false,
  'https': true,
  'caSha256': null,
});

Future<ShellHarness> open(
  WidgetTester tester, {
  bool newBox = true,
  List<Override> overrides = const [],
  String path = '/pairing',
}) async {
  final h = await pumpShell(tester, roles: const ['admin'], overrides: overrides);
  h.devices = screens();
  h.handlers['GET /api/box/info'] = (r) async => boxInfo();
  if (newBox) h.handlers['GET /api/people/activity'] = (r) async => jsonResponse(200, activity());
  h.router.go(path);
  await settle(tester);
  return h;
}

Finder row(String id) => find.byKey(ValueKey('device-$id'));

Future<void> tapIn(WidgetTester tester, Finder f) async {
  await reveal(tester, f);
  await tester.tap(f);
  await settle(tester);
}

void main() {
  testWidgets('[PP-A4] MAXCOM di surau and the TV screens are here, each screen with its ID', (tester) async {
    final h = await open(tester);
    final box = find.byKey(const ValueKey('tv-box-row'));
    expect(box, findsOneWidget);
    expect(find.descendant(of: box, matching: find.text('MAXCOM di surau')), findsOneWidget);
    expect(find.descendant(of: box, matching: find.text('MAXCOM Dewan Utama')), findsOneWidget);
    expect(find.descendant(of: box, matching: find.textContaining('0123 4567 89AB CDEF')), findsOneWidget);
    expect(
      find.descendant(of: box, matching: find.text('Skrin utama di surau. Sentiasa ada, tidak boleh dipadam.')),
      findsOneWidget,
    );
    expect(find.descendant(of: box, matching: find.text('Hidup')), findsOneWidget);
    // The box itself is no device record: no D- ID, no Padam, no sheet.
    expect(find.descendant(of: box, matching: find.textContaining('D-')), findsNothing);
    expect(find.descendant(of: box, matching: find.text('Padam')), findsNothing);
    expect(find.text('Kotak MAXCOM'), findsNothing);

    expect(find.text('Skrin tambahan (3)'), findsOneWidget);
    expect(row('dev-1'), findsNothing, reason: 'a phone is on the Peranti tab');
    expect(row('tv-old'), findsNothing, reason: 'revoked');
    // Two screens both named "Paparan surau" differ by ID.
    expect(find.descendant(of: row('tv-5'), matching: find.text('D-0005')), findsOneWidget);
    expect(find.descendant(of: row('tv-10'), matching: find.text('D-0010')), findsOneWidget);
    expect(
      find.descendant(of: row('tv-5'), matching: find.text('Dipadankan 14 Okt 2026, dilihat 3 minit lalu')),
      findsOneWidget,
    );
    expect(find.descendant(of: row('tv-5'), matching: find.text('Hidup')), findsOneWidget);
    expect(find.descendant(of: row('tv-9'), matching: find.text('Tidak dilihat 41 hari')), findsOneWidget);
    expect(find.descendant(of: row('tv-9'), matching: find.text('Tidak aktif')), findsOneWidget);
    expect(find.descendant(of: row('tv-9'), matching: find.text('Hidup')), findsNothing);
    expect(find.byKey(const ValueKey('device-remove-tv-9')), findsOneWidget);
    expect(find.byKey(const ValueKey('device-remove-tv-5')), findsNothing);

    expect(tester.takeException(), isNull);
    await expectGoldens(tester, h.app, 'pairing');
    await pumpAtSize(tester, h.app, GoldenSize.phone);
    await reveal(tester, find.byKey(const ValueKey('pair-code')));
    expect(find.text('Padankan skrin baharu'), findsOneWidget);
  });

  testWidgets('[PP-A4] TV screens are not on Peranti', (tester) async {
    await open(tester, path: '/devices');
    expect(row('dev-1'), findsOneWidget);
    for (final id in ['tv-5', 'tv-10', 'tv-9']) {
      expect(row(id), findsNothing, reason: id);
    }
  });

  testWidgets('[PP-A4] Padam of a TV not seen for 41 days, after the confirm', (tester) async {
    final h = await open(tester);
    await tapIn(tester, find.byKey(const ValueKey('device-remove-tv-9')));
    expect(find.text('Padam TV dewan serbaguna?'), findsOneWidget);
    await tester.tap(find.widgetWithText(TextButton, 'Batal'));
    await settle(tester);
    expect(h.box.byPath('/api/devices/tv-9/revoke'), isNull);
    await tapIn(tester, find.byKey(const ValueKey('device-remove-tv-9')));
    await tester.tap(find.widgetWithText(FilledButton, 'Padam'));
    await settle(tester);
    expect(h.box.byPath('/api/devices/tv-9/revoke')?.method, 'POST');
    expect(find.text('TV dewan serbaguna dipadam.'), findsOneWidget);
    expect(row('tv-9'), findsNothing);
    expect(find.text('Skrin tambahan (2)'), findsOneWidget);
  });

  testWidgets('[PP-A4] rename a TV through the sheet', (tester) async {
    final h = await open(tester);
    h.handlers['PUT /api/devices/tv-10/name'] = (r) async => jsonResponse(200, {'ok': true});
    await tapIn(tester, row('tv-10'));
    expect(find.byKey(const ValueKey('device-sheet')), findsOneWidget);
    await tester.enterText(find.byKey(const ValueKey('device-sheet-name')), 'Paparan serambi');
    await tester.tap(find.byKey(const ValueKey('device-sheet-save')));
    await settle(tester);
    expect(h.box.bodyOf('/api/devices/tv-10/name'), {'name': 'Paparan serambi'});
    expect(find.text('Nama peranti disimpan.'), findsOneWidget);
    expect(find.descendant(of: row('tv-10'), matching: find.text('Paparan serambi')), findsOneWidget);
  });

  testWidgets('[PP-A4] an older box: TV screens listed without flags', (tester) async {
    await open(tester, newBox: false);
    expect(row('tv-9'), findsOneWidget);
    expect(find.text('Tidak aktif'), findsNothing);
    expect(find.byKey(const ValueKey('device-remove-tv-9')), findsNothing);
    expect(find.descendant(of: row('tv-5'), matching: find.text('Hidup')), findsNothing);
    expect(find.descendant(of: find.byKey(const ValueKey('tv-box-row')), matching: find.text('Hidup')), findsOneWidget);
    expect(tester.takeException(), isNull);
  });

  testWidgets('[PP-A4] Arabic: mirrored, the box id and the screen IDs stay left to right', (tester) async {
    final h = await open(
      tester,
      overrides: [
        appLangStoreProvider.overrideWithValue(MemoryAppLangStore(AppLang.ar)),
        livePublisherProvider.overrideWithValue(FakePublisher()),
      ],
    );
    expect(find.text('MAXCOM في المصلى'), findsOneWidget);
    final id = tester.widget<SelectableText>(find.descendant(of: row('tv-5'), matching: find.byType(SelectableText)));
    expect(id.textDirection, TextDirection.ltr);
    expect(tester.widget<Directionality>(find.byKey(const ValueKey('tv-box-id'))).textDirection, TextDirection.ltr);
    expect(tester.takeException(), isNull);
    await expectGoldens(tester, h.app, 'pairing_ar', sizes: const [GoldenSize.phone]);
  });

  // ---- the pairing form, as before ----

  testWidgets('Padankan skrin: the waiting request, then approval with name', (tester) async {
    final h = await open(tester);
    await reveal(tester, find.text('Dari 10.168.0.23, 25 saat yang lalu'));
    expect(find.text('Skrin yang menunggu'), findsOneWidget);

    await tapIn(tester, find.text('Luluskan'));
    expect(find.text('Masukkan 6 digit yang ditunjukkan di TV.'), findsOneWidget);

    await reveal(tester, find.byKey(const ValueKey('pair-name')));
    await tester.enterText(find.byKey(const ValueKey('pair-code')), '123456');
    await tester.enterText(find.byKey(const ValueKey('pair-name')), 'Skrin utama');
    await tapIn(tester, find.text('Luluskan'));
    expect(jsonDecode(h.box.byPath('/api/kiosk/pair/approve')!.body), {'code': '123456', 'deviceName': 'Skrin utama'});
    expect(find.text('Skrin dipadankan: Skrin utama'), findsOneWidget);
    expect(find.text('Permintaan dari 10.168.0.23, kod berumur 25 saat.'), findsOneWidget);
  });

  testWidgets('pairing refusals: 429 and a wrong code', (tester) async {
    final h = await open(tester);
    h.handlers['POST /api/kiosk/pair/approve'] = (r) async => jsonResponse(
      429,
      {
        'errors': ['Terlalu banyak percubaan. Sila tunggu'],
      },
      headers: {'retry-after': '60'},
    );
    await reveal(tester, find.byKey(const ValueKey('pair-code')));
    await tester.enterText(find.byKey(const ValueKey('pair-code')), '123456');
    await tapIn(tester, find.text('Luluskan'));
    expect(find.textContaining('Terlalu banyak percubaan'), findsOneWidget);
    expect(
      (jsonDecode(h.box.byPath('/api/kiosk/pair/approve')!.body) as Map).containsKey('deviceName'),
      isFalse,
      reason: 'no name given, none sent',
    );

    h.handlers['POST /api/kiosk/pair/approve'] = (r) async => jsonResponse(404, {
      'errors': ['Kod pasangan tidak sah atau telah tamat'],
    });
    await tapIn(tester, find.text('Luluskan'));
    expect(find.text('Kod pasangan tidak sah atau telah tamat'), findsOneWidget);
  });

  testWidgets('no screen waiting reads as such', (tester) async {
    final h = await pumpShell(tester, roles: const ['admin']);
    h.pending = {'pairings': <Object?>[]};
    h.router.go('/pairing');
    await settle(tester);
    await reveal(tester, find.text('Tiada skrin sedang menunggu.'));
    expect(find.text('Tiada skrin sedang menunggu.'), findsOneWidget);
    expect(find.text('Skrin yang menunggu'), findsNothing);
  });
}
