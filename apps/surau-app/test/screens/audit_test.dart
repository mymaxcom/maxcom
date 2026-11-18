// The change log: newest first with the time in Malaysian words, who and
// what, a before/after key diff with the changed keys highlighted, a
// filter by entity and `Muat lagi` up to the box's cap. Golden: audit.

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:surau_app/l10n/generated/s_ms.dart';
import 'package:surau_app/screens/audit_screen.dart';

import '../features/fakes.dart' show jsonResponse;
import '../features/shell/harness.dart';
import '../golden_sizes.dart';

void main() {
  auditLabelTests();
  ppA8AuditTests();
  testWidgets('chips and titles use BM labels for every kind the box logs', (
    tester,
  ) async {
    Map<String, Object?> e(int id, String entity, String? eid, Object? after) =>
        {
          'id': id,
          'at': '2026-11-04T14:20:00.000Z',
          'actor': 'system',
          'entity': entity,
          'entityId': eid,
          'before': null,
          'after': after,
        };
    final h = await pumpShell(tester, roles: const ['admin']);
    h.audit = [
      e(5, 'prayer_days', 'SGR01', {
        'count': 365,
        'from': '2027-01-01',
        'to': '2027-12-31',
      }),
      e(4, 'content:tilawahSlot', 'a1', {'surah': 36}),
      e(3, 'content:worldTime', 'a2', {'city': 'Makkah'}),
      e(2, 'islamic', 'islamic.fetch', {'detail': 'quran'}),
      e(1, 'brand_new:thing', 'x', {'k': 1}),
    ];
    h.router.go('/audit');
    await settle(tester);
    for (final raw in [
      'prayer_days',
      'content:tilawahSlot',
      'content:worldTime',
      'prayer_days: SGR01',
    ]) {
      expect(find.textContaining(raw), findsNothing, reason: raw);
    }
    expect(find.text('Data waktu solat: SGR01'), findsOneWidget);
    expect(
      find.text('Kandungan: Slot tilawah'),
      findsNWidgets(2),
      reason: 'chip + title',
    );
    expect(find.text('Kandungan: Waktu dunia: Makkah'), findsOneWidget);
    expect(find.text('Kandungan Islamik: Muat turun'), findsOneWidget);
    expect(find.text('Brand new thing: x'), findsOneWidget);
  });

  testWidgets('rows newest first, in plain words, with the diff on tap', (
    tester,
  ) async {
    final h = await pumpShell(tester, roles: const ['admin']);
    h.router.go('/audit');
    await settle(tester);
    expect(h.location, '/audit');
    expect(find.text('Log perubahan'), findsWidgets);

    // Who, what, when; the box's "system" actor in BM.
    expect(find.text('Ustaz Ali'), findsNWidgets(2));
    expect(find.text('Encik Hafiz'), findsOneWidget);
    expect(find.text('Sistem'), findsOneWidget);
    expect(find.text('Konfigurasi: iqamah'), findsOneWidget);
    expect(
      find.text('Pengguna: Aminah binti Yusof'),
      findsOneWidget,
      reason: 'named, not u2',
    );
    expect(find.text('Peranti: Komputer Hafiz'), findsOneWidget);
    expect(find.text('10:20 malam'), findsOneWidget);
    expect(find.text('10:10 pagi, 3 Nov'), findsOneWidget);

    // Order: the settings change (id 12) above the role change (id 11).
    final settingsY = tester.getTopLeft(find.text('Konfigurasi: iqamah')).dy;
    final usersY = tester
        .getTopLeft(find.text('Pengguna: Aminah binti Yusof'))
        .dy;
    expect(settingsY, lessThan(usersY));

    // Expand: adjustDays changed, enabled not; keys as BM labels, never
    // raw camelCase (the entity title keeps the Islamic term "iqamah").
    expect(find.byType(AuditDiffRow), findsNothing);
    await tester.tap(find.text('Konfigurasi: iqamah'));
    await settle(tester);
    final rows = tester
        .widgetList<AuditDiffRow>(find.byType(AuditDiffRow))
        .toList();
    expect(rows.map((r) => r.keyName), ['Laras hari Hijrah', 'Dihidupkan']);
    expect(
      rows.firstWhere((r) => r.keyName == 'Laras hari Hijrah').changed,
      isTrue,
    );
    expect(rows.firstWhere((r) => r.keyName == 'Dihidupkan').changed, isFalse);
    expect(find.text('adjustDays'), findsNothing);
    expect(find.text('enabled'), findsNothing);
    expect(find.text('Hidup'), findsNWidgets(2));
    expect(find.text('Sebelum'), findsOneWidget);
    expect(find.text('Selepas'), findsOneWidget);

    await expectGoldens(tester, h.app, 'audit');
  });

  testWidgets(
    'a creation shows only the after side; the filter narrows; Muat lagi grows the limit',
    (tester) async {
      final h = await pumpShell(tester, roles: const ['admin']);
      h.router.go('/audit');
      await settle(tester);
      expect(h.box.byPath('/api/audit')!.url.query, 'limit=200');

      await tester.tap(find.text('Peranti: Komputer Hafiz'));
      await settle(tester);
      final rows = tester
          .widgetList<AuditDiffRow>(find.byType(AuditDiffRow))
          .toList();
      expect(rows.map((r) => r.keyName), [
        'ID',
        'Nama',
        'Jenis peranti',
        'Dibatalkan',
      ]);
      expect(rows.every((r) => r.changed), isTrue);
      expect(find.text('kosong'), findsNWidgets(4));
      expect(
        find.text('Pelayar web'),
        findsOneWidget,
        reason: 'platform web in words',
      );
      expect(find.text('Mati'), findsOneWidget, reason: 'revoked false');

      await tester.tap(find.text('Pengguna'));
      await settle(tester);
      expect(find.text('Konfigurasi: iqamah'), findsNothing);
      expect(find.text('Peranti: Komputer Hafiz'), findsNothing);
      expect(find.text('Pengguna: Aminah binti Yusof'), findsOneWidget);
      expect(find.text('Pengguna: Ustaz Ali'), findsOneWidget);
      await tester.tap(find.text('Semua'));
      await settle(tester);
      expect(find.text('Konfigurasi: iqamah'), findsOneWidget);

      expect(
        find.text('Muat lagi'),
        findsNothing,
        reason: 'fewer rows than the limit',
      );
    },
  );

  testWidgets('Muat lagi asks for the next 200, up to 1000', (tester) async {
    final h = await pumpShell(tester, roles: const ['admin']);
    h.audit = [
      for (var i = 0; i < 200; i++)
        {
          'id': 1000 - i,
          'at': '2026-11-04T14:00:00.000Z',
          'actor': 'user:u1',
          'userName': 'Ustaz Ali',
          'deviceId': null,
          'entity': 'settings',
          'entityId': 'clock',
          'before': {'showSeconds': false},
          'after': {'showSeconds': true},
        },
    ];
    h.router.go('/audit');
    await settle(tester);
    expect(h.box.byPath('/api/audit')!.url.query, 'limit=200');
    expect(find.text('Muat lagi'), findsOneWidget);
    await tester.ensureVisible(find.text('Muat lagi'));
    await settle(tester);
    await tester.tap(find.text('Muat lagi'));
    await settle(tester);
    expect(
      h.box.seen.where((r) => r.url.path == '/api/audit').last.url.query,
      'limit=400',
    );
  });

  testWidgets('nothing recorded yet', (tester) async {
    final h = await pumpShell(tester, roles: const ['admin']);
    h.audit = [];
    h.router.go('/audit');
    await settle(tester);
    expect(find.text('Belum ada perubahan direkodkan.'), findsOneWidget);
  });
}

void auditLabelTests() {
  final s = SMs();
  group('audit BM labels', () {
    test('every entity the box emits has a BM chip label', () {
      expect(entityLabel(s, 'prayer_days'), 'Data waktu solat');
      expect(entityLabel(s, 'content:tilawahSlot'), 'Kandungan: Slot tilawah');
      expect(entityLabel(s, 'content:worldTime'), 'Kandungan: Waktu dunia');
      expect(entityLabel(s, 'users'), 'Pengguna');
      expect(entityLabel(s, 'islamic'), 'Kandungan Islamik');
    });

    test('unknown keys fall back to readable words and never throw', () {
      expect(entityLabel(s, 'content:futureKind'), 'Kandungan: Future kind');
      expect(entityLabel(s, 'some_new_thing'), 'Some new thing');
      expect(entityLabel(s, ''), '');
      expect(readableKey('::'), '::');
    });

    test('prayer_days snapshot keys are labelled', () {
      expect(auditKeyLabel(s, 'prayer_days', 'count'), 'Bilangan hari');
      expect(auditKeyLabel(s, 'prayer_days', 'from'), 'Dari');
      expect(auditKeyLabel(s, 'prayer_days', 'whatever'), 'whatever');
    });
  });
}

/// Peranti and Pengguna A8: IDs beside the names, a deletion line with
/// "Pulihkan" while the person is still deleted, and no phone number ever.
/// Numbers are the plan's test range only.
List<Map<String, Object?>> ppA8AuditFixture({bool deleted = true}) => [
  {
    'id': 21,
    'at': '2026-11-04T14:20:00.000Z',
    'actor': 'user:u1',
    'userName': 'Ustaz Ali',
    'actorRef': 'U-0001',
    'entity': 'users',
    'entityId': 'u7',
    'entityRef': 'U-0007',
    'entityDeleted': deleted,
    'before': {'id': 'u7', 'name': 'Haji Osman', 'roles': ['ajk'], 'active': true},
    'after': {'id': 'u7', 'name': 'Haji Osman', 'roles': ['ajk'], 'active': false, 'deleted': true},
  },
  {
    'id': 20,
    'at': '2026-11-04T14:10:00.000Z',
    'actor': 'user:u1',
    'userName': 'Ustaz Ali',
    'actorRef': 'U-0001',
    'entity': 'users',
    'entityId': 'u7',
    'entityRef': 'U-0007',
    'entityDeleted': deleted,
    'before': {'id': 'u7', 'name': 'Haji Osman', 'roles': ['ajk'], 'active': true},
    'after': {'id': 'u7', 'name': 'Haji Osman', 'roles': ['ajk', 'media'], 'active': true},
  },
  {
    'id': 19,
    'at': '2026-11-04T14:00:00.000Z',
    'actor': 'user:u1',
    'userName': 'Ustaz Ali',
    'actorRef': 'U-0001',
    'entity': 'devices',
    'entityId': 'dev-9',
    'entityRef': 'D-0009',
    'before': {'id': 'dev-9', 'name': 'Telefon Haji Osman', 'platform': 'android', 'revoked': false},
    'after': {'id': 'dev-9', 'name': 'Telefon Haji Osman', 'platform': 'android', 'revoked': true},
  },
  {
    'id': 18,
    'at': '2026-11-04T13:50:00.000Z',
    'actor': 'user:u1',
    'userName': 'Ustaz Ali',
    'actorRef': 'U-0001',
    'entity': 'users',
    'entityId': 'u2',
    'entityRef': 'U-0002',
    'phoneChanged': true,
    // An answer that (wrongly) still holds the number: the app never shows it.
    'before': {'id': 'u2', 'name': 'Puan Aminah', 'phone': '+60120000011'},
    'after': {'id': 'u2', 'name': 'Puan Aminah', 'phone': '+60120000012'},
  },
];

void ppA8AuditTests() {
  testWidgets('[PP-A8] "Pulihkan" only on a users delete line while the person is deleted, after the confirm', (
    tester,
  ) async {
    final h = await pumpShell(tester, roles: const ['admin']);
    h.audit = ppA8AuditFixture();
    var restores = 0;
    h.handlers['POST /api/users/u7/restore'] = (r) async {
      restores++;
      h.audit = ppA8AuditFixture(deleted: false);
      return jsonResponse(200, {'id': 'u7', 'name': 'Haji Osman', 'roles': ['ajk'], 'active': false});
    };
    h.router.go('/audit');
    await settle(tester);
    expect(find.text('Pengguna dipadam: Haji Osman'), findsOneWidget);
    expect(find.text('Peranti dipadam: Telefon Haji Osman'), findsOneWidget);
    expect(find.byKey(const ValueKey('audit-restore-21')), findsOneWidget);
    expect(find.byKey(const ValueKey('audit-restore-20')), findsNothing, reason: 'not on a role change');
    expect(find.byKey(const ValueKey('audit-restore-19')), findsNothing, reason: 'never on a device line');
    expect(find.text('Pulihkan'), findsOneWidget);

    await tester.tap(find.byKey(const ValueKey('audit-restore-21')));
    await settle(tester);
    expect(find.text('Pulihkan Haji Osman?'), findsOneWidget);
    expect(find.textContaining('Haji Osman (U-0007) kembali ke senarai sebagai dinyahaktifkan'), findsOneWidget);
    await tester.tap(find.text('Batal'));
    await settle(tester);
    expect(restores, 0);

    await tester.tap(find.byKey(const ValueKey('audit-restore-21')));
    await settle(tester);
    await tester.tap(find.widgetWithText(FilledButton, 'Pulihkan'));
    await settle(tester);
    expect(restores, 1);
    expect(find.textContaining('Haji Osman dipulihkan sebagai dinyahaktifkan'), findsOneWidget);
    expect(find.byKey(const ValueKey('audit-restore-21')), findsNothing, reason: 'entityDeleted is false now');
  });

  testWidgets('[PP-A8] a line holding a phone number renders no digit of it', (tester) async {
    final h = await pumpShell(tester, roles: const ['admin']);
    h.audit = ppA8AuditFixture();
    h.router.go('/audit');
    await settle(tester);
    expect(find.byKey(const ValueKey('audit-phone-18')), findsOneWidget);
    expect(find.text('Nombor telefon ditukar'), findsOneWidget);
    await tester.tap(find.text('Pengguna: Puan Aminah'));
    await settle(tester);
    for (final w in tester.widgetList<Text>(find.byType(Text))) {
      final t = w.data ?? w.textSpan?.toPlainText() ?? '';
      expect(t.contains('0000011') || t.contains('0000012') || t.contains('000 0011'), isFalse, reason: t);
    }
  });

  testWidgets('[PP-A8b] IDs beside the names in Log perubahan (actor and the user or device)', (tester) async {
    final h = await pumpShell(tester, roles: const ['admin']);
    h.audit = ppA8AuditFixture();
    h.router.go('/audit');
    await settle(tester);
    expect(find.byKey(const ValueKey('audit-actor-ref-21')), findsOneWidget);
    expect(find.text('U-0001'), findsNWidgets(4));
    expect(find.text('U-0007'), findsNWidgets(2));
    expect(find.text('D-0009'), findsOneWidget);
    expect(find.text('U-0002'), findsOneWidget);
  });
}
