// Peranti (plan PP, task A3): phones, tablets and computers only, grouped
// under their owner with the owner's ID; every device with its ID under the
// name; the box's own day counts and "Tidak aktif" flags; "Padam semua" for
// the unused ones; one sheet to rename or delete; the open enrolment codes;
// search by name or ID; an older box (no activity route) shows the list as
// before. TV screens and the MAXCOM row live on the Skrin TV tab
// (pairing_test.dart).
// Goldens: devices, devices_ar, device_sheet.

import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/misc.dart' show Override;
import 'package:flutter_test/flutter_test.dart';
import 'package:surau_app/app/app_lang.dart';
import 'package:surau_app/app/theme.dart';
import 'package:surau_app/features/live/fake_publisher.dart';
import 'package:surau_app/features/live/live_screen.dart' show livePublisherProvider;
import 'package:surau_app/sync/sync_engine.dart';
import 'package:surau_app/sync/sync_providers.dart';

import '../features/fakes.dart';
import '../features/shell/harness.dart';
import '../golden_sizes.dart';

Map<String, Object?> person(String id, String name, String ref, {List<String> roles = const ['ajk']}) => {
  'id': id,
  'name': name,
  'roles': roles,
  'active': true,
  'pinRequired': false,
  'pinLockedUntil': null,
  'ref': ref,
};

Map<String, Object?> dev(
  String id,
  String userId,
  String name, {
  String platform = 'android',
  String? ref,
  bool revoked = false,
}) => {
  'id': id,
  'userId': userId,
  'name': name,
  'platform': platform,
  'revoked': revoked,
  'enrolledAt': '2026-09-02T09:00:00.000Z',
  'ref': ?ref,
};

/// Two people both named "Ustaz Ahmad", told apart by their ID.
List<Map<String, Object?>> people() => [
  person('u1', 'Ustaz Ahmad', 'U-0001', roles: const ['admin']),
  person('u2', 'Puan Aminah', 'U-0002', roles: const ['treasurer']),
  person('u3', 'Encik Rahman', 'U-0003', roles: const ['media']),
  person('u5', 'Ustaz Ahmad', 'U-0005'),
];

List<Map<String, Object?>> phones() => [
  dev('dev-1', 'u1', 'Telefon Ustaz Ahmad', ref: 'D-0001'),
  dev('dev-2', 'u1', 'iPad pejabat surau', platform: 'ios-web', ref: 'D-0002'),
  dev('dev-3', 'u2', 'Telefon lama Aminah', ref: 'D-0003'),
  dev('dev-7', 'u2', 'Telefon Puan Aminah', ref: 'D-0007'),
  dev('dev-6', 'u3', 'Telefon Encik Rahman', ref: 'D-0006'),
  dev('dev-4', 'u3', 'Komputer pejabat', platform: 'web', ref: 'D-0004'),
  dev('dev-8', 'u5', 'Telefon', ref: 'D-0008'),
  dev('dev-5', 'u1', 'Paparan surau', platform: 'kiosk', ref: 'D-0005'),
  dev('dev-x', 'u2', 'Telefon hilang', ref: 'D-0011', revoked: true),
];

Map<String, Object?> act(
  String id,
  String userId,
  int idle, {
  bool inactive = false,
  String kind = 'device',
  String? seen,
}) => {'id': id, 'userId': userId, 'kind': kind, 'idleDays': idle, 'inactive': inactive, 'lastSeenAt': ?seen};

/// The box's answer, by the box's clock (2026-11-04 14:30 UTC).
Map<String, Object?> activity() => {
  'now': '2026-11-04T14:30:00.000Z',
  'authority': 'box',
  'devices': [
    act('dev-1', 'u1', 0),
    act('dev-2', 'u1', 5),
    act('dev-3', 'u2', 163, inactive: true),
    act('dev-7', 'u2', 1),
    act('dev-6', 'u3', 3),
    act('dev-4', 'u3', 74, inactive: true),
    act('dev-8', 'u5', 97, inactive: true),
    act('dev-5', 'u1', 0, kind: 'tv', seen: '2026-11-04T14:27:00.000Z'),
  ],
  'users': <Object?>[],
};

Map<String, Object?> openCodes() => {
  'codes': [
    {
      'id': 41,
      'userId': 'u9',
      'userRef': 'U-C0001',
      'userName': 'Kak Siti',
      'deviceName': 'Telefon Kak Siti',
      'expiresAt': '2026-11-04T14:52:00.000Z',
      'createdByName': 'Ustaz Ahmad',
    },
  ],
};

List<Override> arabic() => [
  appLangStoreProvider.overrideWithValue(MemoryAppLangStore(AppLang.ar)),
  livePublisherProvider.overrideWithValue(FakePublisher()),
];

List<Override> viaCloud() => [
  syncViewProvider.overrideWith(
    (ref) => Stream.value(SyncView(lastSync: DateTime.utc(2026, 11, 4, 14, 0), via: 'cloud')),
  ),
];

/// Opens Peranti as a Pentadbir. With [newBox] false the box has no
/// activity route (404, an older box).
Future<ShellHarness> open(
  WidgetTester tester, {
  bool newBox = true,
  bool codes = false,
  List<Override> overrides = const [],
  List<Map<String, Object?>>? devices,
  void Function(ShellHarness h)? before,
}) async {
  final h = await pumpShell(tester, roles: const ['admin'], overrides: overrides);
  h.users = people();
  h.devices = devices ?? phones();
  if (newBox) {
    h.handlers['GET /api/people/activity'] = (r) async => jsonResponse(200, activity());
    h.handlers['GET /api/enrol/open'] = (r) async => jsonResponse(200, codes ? openCodes() : {'codes': <Object?>[]});
  }
  before?.call(h);
  h.router.go('/devices');
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
  testWidgets('[PP-A3] no TV screen and no MAXCOM row; grouped under owner name and ID; ID under the name', (
    tester,
  ) async {
    final h = await open(
      tester,
      codes: true,
      before: (b) => b.handlers['GET /api/box/info'] = (r) async => jsonResponse(200, {
        'boxId': '0123456789abcdef',
        'name': 'MAXCOM Dewan Utama',
        'state': 'active',
        'reason': 'none',
        'linked': false,
        'https': true,
        'caSha256': null,
      }),
    );

    expect(find.byKey(const ValueKey('devices-box-row')), findsNothing);
    expect(find.text('MAXCOM Dewan Utama'), findsNothing);
    expect(row('dev-5'), findsNothing, reason: 'a TV screen is on the Skrin TV tab');
    expect(find.text('Paparan surau'), findsNothing);
    expect(find.text('Padankan skrin TV'), findsNothing, reason: 'the pairing button left this tab');
    expect(row('dev-x'), findsNothing, reason: 'revoked: never listed');
    for (final id in ['dev-1', 'dev-2', 'dev-3', 'dev-7', 'dev-6', 'dev-4', 'dev-8']) {
      expect(row(id), findsOneWidget, reason: id);
    }

    // The owner's name AND ID head each group: two "Ustaz Ahmad" differ.
    expect(find.byKey(const ValueKey('devices-group-u1')), findsOneWidget);
    expect(find.byKey(const ValueKey('devices-group-u5')), findsOneWidget);
    expect(
      find.descendant(of: find.byKey(const ValueKey('devices-group-u1')), matching: find.text('U-0001')),
      findsOneWidget,
    );
    expect(
      find.descendant(of: find.byKey(const ValueKey('devices-group-u5')), matching: find.text('U-0005')),
      findsOneWidget,
    );

    // The device ID sits under its name, never beside it.
    final name = tester.getRect(find.text('Telefon Ustaz Ahmad'));
    final id = tester.getRect(find.descendant(of: row('dev-1'), matching: find.text('D-0001')));
    expect(id.top, greaterThanOrEqualTo(name.bottom - 1));

    // Day counts are the box's.
    expect(find.descendant(of: row('dev-1'), matching: find.text('Android, aktif hari ini')), findsOneWidget);
    expect(find.descendant(of: row('dev-7'), matching: find.text('Android, aktif semalam')), findsOneWidget);
    expect(find.descendant(of: row('dev-2'), matching: find.text('iPad (Safari), aktif 5 hari lalu')), findsOneWidget);
    final live = tester.widget<Text>(find.text('Telefon Puan Aminah'));
    expect(live.style?.color, isNot(SurauColors.muted));
    expect(tester.takeException(), isNull);
    await expectGoldens(tester, h.app, 'devices');

    await pumpAtSize(tester, h.app, GoldenSize.phone);
    const removedNote = 'Peranti yang dipadam hilang dari senarai serta-merta. Catatannya kekal dalam Log perubahan.';
    await reveal(tester, find.text(removedNote));
    expect(find.text(removedNote), findsOneWidget);
    expect(
      find.text(
        'Peranti yang tidak digunakan 180 hari dan pengguna yang dinyahaktifkan 365 hari dipadam secara automatik. Sejarah kekal.',
      ),
      findsOneWidget,
    );
  });

  testWidgets('[PP-A3] the inactive badge and a direct Padam only on flagged rows; the unused card', (tester) async {
    await open(tester);
    for (final id in ['dev-3', 'dev-4', 'dev-8']) {
      expect(
        find.descendant(of: row(id), matching: find.text('Tidak aktif')),
        findsOneWidget,
        reason: id,
      );
      expect(find.byKey(ValueKey('device-remove-$id')), findsOneWidget, reason: id);
    }
    for (final id in ['dev-1', 'dev-2', 'dev-7', 'dev-6']) {
      expect(
        find.descendant(of: row(id), matching: find.text('Tidak aktif')),
        findsNothing,
        reason: id,
      );
      expect(find.byKey(ValueKey('device-remove-$id')), findsNothing, reason: id);
    }
    expect(find.descendant(of: row('dev-3'), matching: find.text('Android, tidak digunakan 163 hari')), findsOneWidget);
    // 180 - 163 = 17 days left: within 30 days of the automatic delete.
    expect(find.descendant(of: row('dev-3'), matching: find.text('Dipadam automatik dalam 17 hari')), findsOneWidget);
    expect(find.descendant(of: row('dev-4'), matching: find.textContaining('Dipadam automatik')), findsNothing);

    final card = find.byKey(const ValueKey('devices-unused-card'));
    expect(find.descendant(of: card, matching: find.text('3 peranti tidak digunakan lebih 60 hari')), findsOneWidget);
    expect(
      find.descendant(
        of: card,
        matching: find.text('Rekod lama kekal. Pemiliknya boleh mendaftar semula dengan kod QR baharu.'),
      ),
      findsOneWidget,
    );
  });

  testWidgets('[PP-A3] Padam semua sends exactly the flagged ids and names what was skipped and why', (tester) async {
    final h = await open(tester);
    h.handlers['POST /api/devices/revoke-inactive'] = (r) async => jsonResponse(200, {
      'revoked': ['dev-3', 'dev-4'],
      'skipped': [
        {'id': 'dev-8', 'reason': 'in_use'},
      ],
    });
    await tapIn(tester, find.byKey(const ValueKey('devices-remove-all')));
    expect(find.text('Padam 3 peranti yang tidak digunakan?'), findsOneWidget);
    await tester.tap(find.widgetWithText(TextButton, 'Batal'));
    await settle(tester);
    expect(h.box.byPath('/api/devices/revoke-inactive'), isNull, reason: 'cancel sends nothing');

    await tapIn(tester, find.byKey(const ValueKey('devices-remove-all')));
    await tester.tap(find.widgetWithText(FilledButton, 'Padam'));
    await settle(tester);
    final sent = (h.box.bodyOf('/api/devices/revoke-inactive')['ids'] as List).cast<String>().toSet();
    expect(sent, {'dev-3', 'dev-4', 'dev-8'});

    final result = find.byKey(const ValueKey('devices-removed-result'));
    // ignore: avoid_print
    print([for (final e in find.byType(Text).evaluate()) (e.widget as Text).data]);
    expect(find.descendant(of: result, matching: find.text('2 dipadam, 1 dilangkau')), findsOneWidget);
    expect(find.descendant(of: result, matching: find.textContaining('baru digunakan')), findsOneWidget);
    expect(find.descendant(of: result, matching: find.textContaining('D-0008')), findsOneWidget);
    expect(row('dev-3'), findsNothing);
    expect(row('dev-4'), findsNothing);
    expect(row('dev-8'), findsOneWidget);
  });

  testWidgets('[PP-A3] a single Padam refused as the last Pentadbir phone says so and the row stays', (tester) async {
    final h = await open(tester);
    h.handlers['POST /api/devices/dev-8/revoke'] = (r) async => jsonResponse(409, {
      'errors': ['last admin device'],
      'code': 'last_admin_device',
    });
    await tapIn(tester, find.byKey(const ValueKey('device-remove-dev-8')));
    expect(find.text('Padam Telefon?'), findsOneWidget);
    await tester.tap(find.widgetWithText(FilledButton, 'Padam'));
    await settle(tester);
    expect(h.box.byPath('/api/devices/dev-8/revoke')?.method, 'POST');
    expect(find.text('Daftar peranti Pentadbir lain dahulu'), findsOneWidget);
    expect(row('dev-8'), findsOneWidget);
  });

  testWidgets('[PP-A3] the sheet: rename updates the row; a too long name sends nothing; Padam peranti ini', (
    tester,
  ) async {
    final h = await open(tester);
    h.handlers['PUT /api/devices/dev-2/name'] = (r) async {
      final name = (jsonDecode(r.body) as Map<String, dynamic>)['name'];
      h.devices = [
        for (final d in h.devices)
          if (d['id'] == 'dev-2') {...d, 'name': name} else d,
      ];
      return jsonResponse(200, {'ok': true});
    };
    await tapIn(tester, row('dev-2'));
    final sheet = find.byKey(const ValueKey('device-sheet'));
    expect(sheet, findsOneWidget);
    expect(find.descendant(of: sheet, matching: find.text('D-0002')), findsOneWidget);
    expect(find.descendant(of: sheet, matching: find.textContaining('Milik')), findsOneWidget);
    expect(
      find.descendant(of: sheet, matching: find.text('Log perubahan lama kekal dengan nama lama peranti ini.')),
      findsOneWidget,
    );
    expect(find.descendant(of: sheet, matching: find.text('Padam peranti ini')), findsOneWidget);
    expect(
      find.descendant(
        of: sheet,
        matching: find.text(
          'Peranti ini tidak lagi boleh membuka aplikasi. Untuk guna semula, daftar dengan kod QR baharu.',
        ),
      ),
      findsOneWidget,
    );
    await expectGoldens(tester, h.app, 'device_sheet', sizes: const [GoldenSize.phone]);

    await tester.enterText(find.byKey(const ValueKey('device-sheet-name')), 'x' * 81);
    await tester.tap(find.byKey(const ValueKey('device-sheet-save')));
    await settle(tester);
    expect(find.text('Nama mesti 1 hingga 80 aksara'), findsOneWidget);
    expect(h.box.byPath('/api/devices/dev-2/name'), isNull);

    await tester.enterText(find.byKey(const ValueKey('device-sheet-name')), '  iPad   meja bendahari ');
    await tester.tap(find.byKey(const ValueKey('device-sheet-save')));
    await settle(tester);
    expect(h.box.bodyOf('/api/devices/dev-2/name'), {'name': 'iPad meja bendahari'});
    expect(find.byKey(const ValueKey('device-sheet')), findsNothing);
    expect(find.text('Nama peranti disimpan.'), findsOneWidget);
    expect(find.descendant(of: row('dev-2'), matching: find.text('iPad meja bendahari')), findsOneWidget);

    // Padam from the sheet: confirm, then the row leaves.
    await tapIn(tester, row('dev-7'));
    await tester.tap(find.byKey(const ValueKey('device-sheet-remove')));
    await settle(tester);
    expect(find.text('Padam Telefon Puan Aminah?'), findsOneWidget);
    await tester.tap(find.widgetWithText(FilledButton, 'Padam'));
    await settle(tester);
    expect(h.box.byPath('/api/devices/dev-7/revoke')?.method, 'POST');
    expect(find.text('Telefon Puan Aminah dipadam.'), findsOneWidget);
    expect(row('dev-7'), findsNothing);
  });

  testWidgets('[PP-A3] an older box (no activity): rows as before, tap opens the sheet, rename says update', (
    tester,
  ) async {
    final h = await open(tester, newBox: false);
    expect(find.byKey(const ValueKey('devices-unused-card')), findsNothing);
    expect(find.text('Tidak aktif'), findsNothing);
    expect(find.byKey(const ValueKey('device-remove-dev-3')), findsNothing);
    expect(find.descendant(of: row('dev-3'), matching: find.text('Android')), findsOneWidget);
    expect(find.byKey(const ValueKey('devices-open-codes')), findsNothing);

    await tapIn(tester, row('dev-3'));
    await tester.enterText(find.byKey(const ValueKey('device-sheet-name')), 'Telefon Aminah');
    await tester.tap(find.byKey(const ValueKey('device-sheet-save')));
    await settle(tester);
    expect(h.box.byPath('/api/devices/dev-3/name')?.method, 'PUT');
    expect(find.text('Kemas kini MAX Kiosk Server untuk fungsi ini'), findsOneWidget);
    expect(tester.takeException(), isNull);
  });

  testWidgets('[PP-A3] an open code is listed with Tamatkan kod', (tester) async {
    final h = await open(tester, codes: true);
    h.handlers['POST /api/enrol/cancel'] = (r) async => jsonResponse(200, {'cancelled': true});
    final codes = find.byKey(const ValueKey('devices-open-codes'));
    await reveal(tester, find.byKey(const ValueKey('code-end-41')));
    expect(find.text('Kod belum digunakan (1)'), findsOneWidget);
    expect(find.descendant(of: codes, matching: find.text('Kak Siti')), findsOneWidget);
    expect(find.descendant(of: codes, matching: find.text('U-C0001')), findsOneWidget);
    // 14:52 by the box's clock of 14:30.
    expect(find.descendant(of: codes, matching: find.textContaining('tamat dalam 22 minit')), findsOneWidget);
    await tapIn(tester, find.byKey(const ValueKey('code-end-41')));
    expect(h.box.bodyOf('/api/enrol/cancel'), {'id': 41, 'userId': 'u9'});
    expect(find.text('Kod ditamatkan.'), findsOneWidget);
  });

  testWidgets('[PP-A3] [PP-D10] through the cloud: enrolling is off, no flags, one line', (tester) async {
    await open(
      tester,
      overrides: viaCloud(),
      before: (h) =>
          h.handlers['GET /api/people/activity'] = (r) async =>
              jsonResponse(200, {...activity(), 'authority': 'cloud'}),
    );
    final enrol = tester.widget<ButtonStyleButton>(
      find.ancestor(of: find.text('Daftar peranti baharu'), matching: find.bySubtype<ButtonStyleButton>()),
    );
    expect(enrol.onPressed, isNull);
    expect(find.text('Anda di luar rangkaian surau. Kod QR hanya boleh dibuat di Wi-Fi surau.'), findsOneWidget);
    expect(find.text('Status aktif ditunjukkan apabila anda di Wi-Fi surau.'), findsOneWidget);
    expect(find.text('Tidak aktif'), findsNothing);
    expect(find.byKey(const ValueKey('devices-unused-card')), findsNothing);
  });

  testWidgets('[PP-A3] search by device name, owner name or ID; two "Telefon" differ by ID', (tester) async {
    await open(
      tester,
      devices: [
        ...phones(),
        dev('dev-9', 'u3', 'Telefon', ref: 'D-0009'),
      ],
    );
    expect(find.descendant(of: row('dev-8'), matching: find.text('D-0008')), findsOneWidget);
    expect(find.descendant(of: row('dev-9'), matching: find.text('D-0009')), findsOneWidget);

    final search = find.byKey(const ValueKey('devices-search'));
    for (final typed in ['d7', 'D-0007', 'D 7']) {
      await tester.enterText(search, typed);
      await settle(tester);
      expect(row('dev-7'), findsOneWidget, reason: typed);
      for (final other in ['dev-1', 'dev-2', 'dev-3', 'dev-6', 'dev-4', 'dev-8', 'dev-9']) {
        expect(row(other), findsNothing, reason: '$typed: $other');
      }
    }
    await tester.enterText(search, 'rahman');
    await settle(tester);
    expect(row('dev-6'), findsOneWidget);
    expect(row('dev-4'), findsOneWidget);
    expect(row('dev-9'), findsOneWidget);
    expect(row('dev-1'), findsNothing);
    await tester.enterText(search, 'u5');
    await settle(tester);
    expect(row('dev-8'), findsOneWidget);
    expect(row('dev-1'), findsNothing);
  });

  for (final lang in ['ms', 'ar']) {
    testWidgets('[PP-A3] 320 dp wide, an 80-character Arabic name ($lang): no overflow, badge and Padam visible', (
      tester,
    ) async {
      final longName = 'هاتف ${'م' * 70} قديم'.substring(0, 80);
      final h = await open(
        tester,
        overrides: lang == 'ar' ? arabic() : const [],
        devices: [
          ...phones().where((d) => d['id'] != 'dev-3'),
          dev('dev-3', 'u2', longName, ref: 'D-0003'),
        ],
      );
      tester.view.physicalSize = const Size(320 * 2, 800 * 2);
      tester.view.devicePixelRatio = 2;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);
      await tester.pumpWidget(h.app);
      await settle(tester);
      await tester.ensureVisible(row('dev-3'));
      await tester.pumpAndSettle();
      expect(tester.takeException(), isNull);
      final badge = tester.getRect(find.byKey(const ValueKey('device-badge-dev-3')));
      final action = tester.getRect(find.byKey(const ValueKey('device-remove-dev-3')));
      for (final r in [badge, action]) {
        expect(r.left, greaterThanOrEqualTo(0));
        expect(r.right, lessThanOrEqualTo(320));
      }
      // The ID reads left to right inside the Arabic layout too.
      final id = tester.widget<SelectableText>(
        find.descendant(of: row('dev-3'), matching: find.byType(SelectableText)),
      );
      expect(id.textDirection, TextDirection.ltr);
      expect(id.data, 'D-0003');
    });
  }

  testWidgets('[PP-A3] Arabic layout golden', (tester) async {
    final h = await open(tester, overrides: arabic(), codes: true);
    expect(find.text('غير نشط'), findsWidgets);
    await expectGoldens(tester, h.app, 'devices_ar', sizes: const [GoldenSize.phone]);
  });
}
