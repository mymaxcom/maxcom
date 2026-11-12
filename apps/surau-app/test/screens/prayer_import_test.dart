// Import waktu solat (Plan 13 Task 9): pick, dry run, errors that block,
// the overlap choice, the e-Solat file that goes to the official path.

import 'dart:convert';
import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:surau_app/app/router.dart';
import 'package:surau_app/features/prayer/file_pick.dart';
import 'package:surau_app/features/prayer/import_screen.dart';
import 'package:surau_app/features/prayer/prayer_repository.dart';

import '../features/shell/harness.dart';
import '../golden_sizes.dart';
import 'prayer_fakes.dart';

PickedFile _file(String name, [String body = 'date,subuh\n']) =>
    PickedFile(name, Uint8List.fromList(utf8.encode(body)));

final List<ResolvedDay> _week = [
  for (var d = 1; d <= 7; d++) fakeDay('2026-12-0$d', source: 'file'),
];

ImportPreview _clean(String overlap) => ImportPreview(
  format: 'template-csv',
  sha256: 'a' * 64,
  columns: const ['date', 'subuh', 'syuruk', 'zohor', 'asar', 'maghrib', 'isyak'],
  rangeFrom: '2026-12-01',
  rangeTo: '2027-01-31',
  perMonth: const {'2026-12': 31, '2027-01': 31},
  firstWeek: _week,
  lastWeek: _week,
  overlaps: const {'official': 0, 'file': 31, 'calc': 31},
  wouldInsert: 31,
  wouldReplace: overlap == 'replace' ? 31 : 0,
  wouldSkip: overlap == 'replace' ? 0 : 31,
);

Finder get _save => find.byKey(const ValueKey('imp-save'));

ImportScreen _screenWith(PickedFile? file) => ImportScreen(filePicker: () async => file);

Future<void> _pick(WidgetTester tester) async {
  await tapRevealed(tester, find.byKey(const ValueKey('imp-pick')));
}

void main() {
  testWidgets('errors are listed with their rows and Simpan stays off', (tester) async {
    final repo = FakePrayerRepo()
      ..previewOf = (_) => const ImportPreview(
        format: 'template-csv',
        sha256: 'bb',
        errors: [
          ImportRowError(48, 'asar lebih awal daripada zohor'),
          ImportRowError(112, 'tarikh berulang'),
        ],
      );
    await pumpPrayer(tester, _screenWith(_file('ratiba.csv')), location: AppRoutes.prayerImport, repo: repo);
    await _pick(tester);
    expect(find.text('2 ralat. Tiada apa-apa disimpan.'), findsOneWidget);
    expect(find.text('Baris 48'), findsOneWidget);
    expect(find.text('asar lebih awal daripada zohor'), findsOneWidget);
    await reveal(tester, _save);
    expect(tester.widget<FilledButton>(_save).onPressed, isNull);
  });

  testWidgets('a clean file shows the preview and the count follows the choice', (tester) async {
    final repo = FakePrayerRepo()..previewOf = _clean;
    await pumpPrayer(tester, _screenWith(_file('ratiba.csv')), location: AppRoutes.prayerImport, repo: repo);
    await _pick(tester);
    expect(find.textContaining('62 hari, 1 Dis 2026 hingga 31 Jan 2027'), findsOneWidget);
    await reveal(tester, find.text('Disimpan: 62 hari. Ditambah 31, diganti 31, dilangkau 0.'));
    expect(find.text('Disimpan: 62 hari. Ditambah 31, diganti 31, dilangkau 0.'), findsOneWidget);

    await tapRevealed(tester, find.byKey(const ValueKey('imp-overlap-keep')));
    expect(repo.previewOverlaps, ['replace', 'keep'], reason: 'the box counts each choice');
    expect(find.text('Disimpan: 31 hari. Ditambah 31, diganti 0, dilangkau 31.'), findsOneWidget);
  });

  testWidgets('a file that the source order would never use says so, with a link to the sources', (tester) async {
    final repo = FakePrayerRepo()
      ..previewOf = (o) => ImportPreview(
        format: 'template-csv',
        sha256: 'a' * 64,
        rangeFrom: '2026-12-01',
        rangeTo: '2026-12-07',
        firstWeek: _week,
        lastWeek: _week,
        wouldInsert: 7,
        fileShadowed: true,
      );
    await pumpPrayer(tester, _screenWith(_file('ratiba.csv')), location: AppRoutes.prayerImport, repo: repo);
    await _pick(tester);
    await reveal(tester, find.byKey(const ValueKey('imp-file-unused')));
    expect(
      find.text('Jadual ini tidak akan digunakan selagi Kiraan setempat berada di atas Fail dalam Sumber waktu solat.'),
      findsOneWidget,
    );
    expect(find.byKey(const ValueKey('imp-file-unused-link')), findsOneWidget);
  });

  testWidgets('a file the order does use shows no such note', (tester) async {
    final repo = FakePrayerRepo()..previewOf = _clean;
    await pumpPrayer(tester, _screenWith(_file('ratiba.csv')), location: AppRoutes.prayerImport, repo: repo);
    await _pick(tester);
    expect(find.byKey(const ValueKey('imp-file-unused')), findsNothing);
  });

  testWidgets('Simpan asks first, then applies what the dry run showed', (tester) async {
    final repo = FakePrayerRepo()..previewOf = _clean;
    await pumpPrayer(tester, _screenWith(_file('ratiba 2027.csv')), location: AppRoutes.prayerImport, repo: repo);
    await _pick(tester);
    await tapRevealed(tester, _save);
    expect(find.textContaining('Simpan 62 hari ke'), findsOneWidget);
    expect(repo.applied, isEmpty, reason: 'nothing before the confirm');
    await tester.tap(find.byKey(const ValueKey('imp-confirm')));
    await settle(tester);
    expect(repo.applied.single, {'kind': 'csv', 'name': 'ratiba 2027.csv', 'overlap': 'replace', 'sha': 'a' * 64});
    expect(find.text('Import disimpan'), findsOneWidget);
  });

  testWidgets('an odd file name is tidied to what the box accepts', (tester) async {
    final repo = FakePrayerRepo()..previewOf = _clean;
    await pumpPrayer(tester, _screenWith(_file('jadual, masjid & surau.csv')), location: AppRoutes.prayerImport, repo: repo);
    await _pick(tester);
    await tapRevealed(tester, _save);
    await tester.tap(find.byKey(const ValueKey('imp-confirm')));
    await settle(tester);
    expect(repo.applied.single['name'], 'jadual_ masjid _ surau.csv');
  });

  testWidgets('an e-Solat file goes to the official path for the zone', (tester) async {
    final repo = FakePrayerRepo()
      ..previewOf = (_) => const ImportPreview(format: 'esolat-csv', hint: 'official', sha256: 'cc');
    await pumpPrayer(
      tester,
      _screenWith(_file('esolat.csv', 'Tarikh Miladi,Tarikh Hijri\n')),
      location: AppRoutes.prayerImport,
      repo: repo,
    );
    await _pick(tester);
    expect(find.text('Fail e-Solat: disimpan sebagai Sumber rasmi zon SGR01'), findsOneWidget);
    await tapRevealed(tester, _save);
    await tester.tap(find.byKey(const ValueKey('imp-confirm')));
    await settle(tester);
    expect(repo.officialImports.single, ('SGR01', 'Tarikh Miladi,Tarikh Hijri\n'));
    expect(repo.applied, isEmpty);
  });

  testWidgets('a file over the limit or of another type is refused in BM', (tester) async {
    final repo = FakePrayerRepo()..previewOf = _clean;
    await pumpPrayer(tester, _screenWith(PickedFile.tooBig('besar.xlsx')), location: AppRoutes.prayerImport, repo: repo);
    await _pick(tester);
    expect(find.text('Fail terlalu besar. Had CSV 1 MB, Excel 2 MB.'), findsOneWidget);
    expect(repo.previewOverlaps, isEmpty);
  });

  testWidgets('a box refusal of the file reads as it came', (tester) async {
    final repo = FakePrayerRepo()
      ..previewError = const PrayerError(PrayerFailure.invalid, 'Format fail tidak dikenali', status: 400);
    await pumpPrayer(tester, _screenWith(_file('lain.csv')), location: AppRoutes.prayerImport, repo: repo);
    await _pick(tester);
    expect(find.text('Format fail tidak dikenali'), findsOneWidget);
  });

  testWidgets('the template is fetched for the chosen year', (tester) async {
    final repo = FakePrayerRepo();
    final saved = <String>[];
    await pumpPrayer(
      tester,
      ImportScreen(filePicker: () async => null, templateSaver: (name, bytes) async => saved.add(name)),
      location: AppRoutes.prayerImport,
      repo: repo,
    );
    await tapRevealed(tester, find.byKey(const ValueKey('imp-template-csv')));
    expect(repo.templates, ['csv:2026']);
    expect(saved, ['waktu-solat-2026.csv']);
  });

  testWidgets('golden: import start and preview', (tester) async {
    final repo = FakePrayerRepo()..previewOf = _clean;
    final t = await pumpPrayer(tester, _screenWith(_file('ratiba-2027.csv')), location: AppRoutes.prayerImport, repo: repo);
    await expectGoldens(tester, t.app, 'prayer_import');
    // The shell's layout change at each size starts the page afresh.
    for (final size in GoldenSize.values) {
      await pumpAtSize(tester, t.app, size);
      if (find.text('Muat turun templat').evaluate().isNotEmpty) await _pick(tester);
      await tester.drag(find.byType(ListView).first, const Offset(0, 2000));
      await settle(tester);
      await expectLater(find.byWidget(t.app), matchesGoldenFile('prayer_import_preview_${size.name}.png'));
    }
  });
}
