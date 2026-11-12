// Rekod import (Plan 13 Task 9): who imported what, and undo with its reason
// when the box refuses it.

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:surau_app/app/router.dart';
import 'package:surau_app/features/prayer/import_records_screen.dart';
import 'package:surau_app/features/prayer/prayer_repository.dart';

import '../features/shell/harness.dart';
import '../golden_sizes.dart';
import 'prayer_fakes.dart';

const _active = ImportRecord(
  id: '01JIMP1',
  kind: 'csv',
  fileName: 'ratiba-2027.csv',
  sha256: '3f9a1c2e00112233',
  rows: 396,
  dateFrom: '2026-12-01',
  dateTo: '2027-12-31',
  overlap: 'replace',
  inserted: 365,
  replaced: 31,
  actor: 'user:u1',
  createdAt: '2026-11-03T02:42:00.000Z',
);

const _undone = ImportRecord(
  id: '01JIMP0',
  kind: 'xlsx',
  fileName: 'draf.xlsx',
  sha256: 'c07d5a1900112233',
  rows: 365,
  dateFrom: '2027-01-01',
  dateTo: '2027-12-31',
  overlap: 'fillEmpty',
  actor: 'user:u1',
  createdAt: '2026-10-25T08:03:00.000Z',
  undoneAt: '2026-10-26T01:00:00.000Z',
);

const _screen = ImportRecordsScreen();

Finder get _undo => find.byKey(const ValueKey('rek-undo-01JIMP1'));

void main() {
  testWidgets('the list names the file, range, choice, person and state', (tester) async {
    final repo = FakePrayerRepo()..records = const [_active, _undone];
    await pumpPrayer(tester, _screen, location: AppRoutes.prayerImports, repo: repo);
    expect(find.text('ratiba-2027.csv'), findsOneWidget);
    expect(find.text('3f9a1c2e'), findsOneWidget);
    expect(find.text('1 Dis 2026 hingga 31 Dis 2027'), findsOneWidget);
    expect(find.text('Ganti'), findsOneWidget);
    expect(find.text('Ustaz Ali'), findsWidgets);
    expect(find.text('Aktif'), findsOneWidget);
    await reveal(tester, find.text('Dibatalkan 26 Okt 2026'));
    expect(find.text('Dibatalkan 26 Okt 2026'), findsOneWidget);
    expect(find.byKey(const ValueKey('rek-undo-01JIMP0')), findsNothing, reason: 'nothing left to undo');
  });

  testWidgets('undo says what it restores and asks first', (tester) async {
    final repo = FakePrayerRepo()..records = const [_active];
    await pumpPrayer(tester, _screen, location: AppRoutes.prayerImports, repo: repo);
    await tapRevealed(tester, _undo);
    expect(find.text('365 hari dibuang, 31 hari dipulihkan kepada data sebelum import ini.'), findsOneWidget);
    expect(repo.undone, isEmpty);
    await tester.tap(find.text('Batalkan import').last);
    await settle(tester);
    expect(repo.undone, ['01JIMP1']);
    expect(find.text('Import dibatalkan. 31 hari dipulihkan.'), findsOneWidget);
  });

  testWidgets('a refused undo shows the reason from the box', (tester) async {
    final repo = FakePrayerRepo()
      ..records = const [_active]
      ..undoError = const PrayerError(
        PrayerFailure.conflict,
        'Hari 2026-12-01 hingga 2026-12-31 telah diganti oleh import 2026-11-07',
        status: 409,
      );
    await pumpPrayer(tester, _screen, location: AppRoutes.prayerImports, repo: repo);
    await tapRevealed(tester, _undo);
    await tester.tap(find.text('Batalkan import').last);
    await settle(tester);
    expect(find.text('Tidak boleh dibatalkan lagi'), findsOneWidget);
    expect(find.text('Hari 2026-12-01 hingga 2026-12-31 telah diganti oleh import 2026-11-07'), findsOneWidget);
    await tester.tap(find.text('Faham'));
    await settle(tester);
    expect(find.text('Tidak boleh dibatalkan lagi'), findsNothing);
  });

  testWidgets('no imports yet says so', (tester) async {
    await pumpPrayer(tester, _screen, location: AppRoutes.prayerImports);
    expect(find.text('Belum ada import waktu solat.'), findsOneWidget);
  });

  testWidgets('golden: Rekod import', (tester) async {
    final repo = FakePrayerRepo()..records = const [_active, _undone];
    final t = await pumpPrayer(tester, _screen, location: AppRoutes.prayerImports, repo: repo);
    await expectGoldens(tester, t.app, 'prayer_records');
  });
}
