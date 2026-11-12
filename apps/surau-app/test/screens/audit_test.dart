// The change log: newest first with the time in Malaysian words, who and
// what, a before/after key diff with the changed keys highlighted, a
// filter by entity and `Muat lagi` up to the box's cap. Golden: audit.

import 'package:flutter_test/flutter_test.dart';
import 'package:surau_app/l10n/generated/s_ms.dart';
import 'package:surau_app/screens/audit_screen.dart';

import '../features/shell/harness.dart';
import '../golden_sizes.dart';

void main() {
  auditLabelTests();
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
    expect(find.text('Tetapan: iqamah'), findsOneWidget);
    expect(
      find.text('Pengguna: Aminah binti Yusof'),
      findsOneWidget,
      reason: 'named, not u2',
    );
    expect(find.text('Peranti: Komputer Hafiz'), findsOneWidget);
    expect(find.text('10:20 malam'), findsOneWidget);
    expect(find.text('10:10 pagi, 3 Nov'), findsOneWidget);

    // Order: the settings change (id 12) above the role change (id 11).
    final settingsY = tester.getTopLeft(find.text('Tetapan: iqamah')).dy;
    final usersY = tester
        .getTopLeft(find.text('Pengguna: Aminah binti Yusof'))
        .dy;
    expect(settingsY, lessThan(usersY));

    // Expand: adjustDays changed, enabled not; keys as BM labels, never
    // raw camelCase (the entity title keeps the Islamic term "iqamah").
    expect(find.byType(AuditDiffRow), findsNothing);
    await tester.tap(find.text('Tetapan: iqamah'));
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
      expect(find.text('Tetapan: iqamah'), findsNothing);
      expect(find.text('Peranti: Komputer Hafiz'), findsNothing);
      expect(find.text('Pengguna: Aminah binti Yusof'), findsOneWidget);
      expect(find.text('Pengguna: Ustaz Ali'), findsOneWidget);
      await tester.tap(find.text('Semua'));
      await settle(tester);
      expect(find.text('Tetapan: iqamah'), findsOneWidget);

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
