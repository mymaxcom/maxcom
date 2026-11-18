// Waktu solat: how many days of prayer data the box holds for its zone,
// `Muat turun tahun <Y+1> dari e-Solat` and `Muat naik CSV`, with the
// box's count of rows added and replaced. Golden: prayer_data.

import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:surau_app/app/app_lang.dart';
import 'package:surau_app/app/router.dart';
import 'package:surau_app/box/box_client.dart';
import 'package:surau_app/features/common/error_text.dart';
import 'package:surau_app/features/csv_file_pick.dart';
import 'package:surau_app/features/prayer/location_screen.dart' show LocationScreen;
import 'package:surau_app/features/prayer/prayer_names.dart';
import 'package:surau_app/features/prayer/prayer_repository.dart';
import 'package:surau_app/features/prayer/widgets/month_grid.dart';
import 'package:surau_app/features/shell/menu.dart';
import 'package:surau_app/features/shell/permissions.dart';
import 'package:surau_app/screens/prayer_data_screen.dart';
import 'package:surau_app/l10n/s_lookup.dart';

import '../features/shell/harness.dart';
import '../golden_sizes.dart';
import 'prayer_fakes.dart' hide jsonResponse;
import 't9_fakes.dart';

/// The e-Solat button names the source from settings `dataSources.esolat.name`
/// (the registry default here); the year sits on the line above it.
const String fetchLabel = 'Muat turun dari e-Solat JAKIM ke dalam MAXCOM';

/// `GET /api/prayer/status` with the official years the box holds.
Map<String, Object?> statusBody({
  List<Map<String, Object?>> years = const [
    {'year': 2026, 'days': 365, 'fetchedAt': '2026-01-02T01:00:00.000Z'},
  ],
  String date = '2026-11-04',
}) => {
  'country': 'MY',
  'hasOfficial': true,
  'zone': 'SGR01',
  'timezone': 'Asia/Kuala_Lumpur',
  'located': true,
  'order': ['official', 'calc', 'file'],
  'today': {'date': date, 'source': 'official', 'emergency': false},
  'official': {'zone': 'SGR01', 'years': years},
  'warnings': <String>[],
};

void main() {
  testWidgets(
    '212 days ahead for SGR01; e-Solat import for 2027 reports the rows',
    (tester) async {
      final t = await pumpT9(
        tester,
        const PrayerDataScreen(),
        location: AppRoutes.prayerData,
        setup: (h) {
          // 2026 is complete and 2027 is partly loaded: the 212 days run into it.
          h.handlers['GET /api/prayer/status'] = (_) async => jsonResponse(
            200,
            statusBody(
              years: const [
                {'year': 2026, 'days': 365, 'fetchedAt': '2026-01-02T01:00:00.000Z'},
                {'year': 2027, 'days': 150, 'fetchedAt': '2026-10-02T01:00:00.000Z'},
              ],
            ),
          );
          h.handlers['POST /api/prayer/import'] = (_) async =>
              jsonResponse(200, {'inserted': 365, 'replaced': 0});
        },
      );
      expect(find.text('Waktu solat'), findsWidgets);
      expect(find.text('212'), findsOneWidget);
      expect(find.text('hari data waktu solat ke hadapan'), findsOneWidget);
      expect(find.text('Zon SGR01'), findsOneWidget);
      expect(
        find.text('Data hampir habis. Muat turun tahun seterusnya sekarang.'),
        findsNothing,
      );
      expect(find.text('Data tahun 2027'), findsOneWidget);
      expect(find.text(fetchLabel), findsOneWidget);
      await expectGoldens(tester, t.app, 'prayer_data');

      // 212 days run into next year: loading 2027 replaces what is there.
      expect(
        find.text('Data sedia ada untuk tahun 2027 akan diganti.'),
        findsOneWidget,
      );
      await tester.tap(find.text(fetchLabel));
      await settle(tester);
      expect(find.text('Ganti data sedia ada?'), findsOneWidget);
      expect(
        t.h.box.byPath('/api/prayer/import'),
        isNull,
        reason: 'waits for the confirm',
      );
      await tester.tap(find.text('Ganti'));
      await settle(tester);
      final body = jsonDecode(t.h.box.byPath('/api/prayer/import')!.body);
      expect(body, {'zone': 'SGR01', 'year': 2027, 'source': 'esolat'});
      expect(find.text('Data waktu solat dikemas kini'), findsOneWidget);
      expect(find.text('Ditambah 365, diganti 0'), findsOneWidget);
      expect(
        t.h.box.seen.where((r) => r.url.path == '/api/health').length,
        greaterThan(1),
        reason: 'health re-read so daysAhead updates',
      );
    },
  );

  group('sources', () {
    String day(String d) => '2026-11-${d.padLeft(2, '0')}';

    FakePrayerRepo repo() => FakePrayerRepo(
      status_: const PrayerStatus(
        country: 'MY',
        hasOfficial: true,
        zone: 'SGR01',
        located: true,
        order: ['official', 'calc', 'file'],
        today: TodayStatus(date: fakeToday, source: 'official'),
        officialZone: 'SGR01',
        officialYears: [
          OfficialYear(year: 2026, days: 365, fetchedAt: '2026-11-06T01:14:00.000Z'),
          OfficialYear(year: 2027, days: 150, fetchedAt: '2026-11-06T01:14:00.000Z'),
        ],
      ),
    )..daysOf = (from, to) => PrayerDays(
      days: from.startsWith('2026-11')
          ? [
              fakeDay(day('3')),
              fakeDay(fakeToday),
              fakeDay(day('5')),
              fakeDay(day('26'), corrected: const ['zohor'], officialChanged: const ['zohor']),
            ]
          : from.startsWith('2027-01')
          ? [fakeDay('2027-01-05', source: 'calc', emergency: true)]
          : [
              for (final m in ['01', '11'])
                fakeDay('2026-$m-10', source: m == '11' ? 'official' : 'calc'),
            ],
      crossCheck: from.startsWith('2026-11')
          ? CrossCheck(
              flagged: [CrossFlag(date: day('5'), source: 'official', diffs: const {'subuh': 3, 'zohor': 1})],
              medianDiff: const {'subuh': 3},
              compared: 30,
            )
          : const CrossCheck(),
      sources: const PrayerSources(order: ['official', 'calc', 'file'], country: 'MY', hasOfficial: true),
    );

    Color stripOf(WidgetTester tester, String date) {
      final box = tester.widget<Container>(find.byKey(ValueKey('pd-strip-$date')));
      return (box.decoration! as BoxDecoration).color!;
    }

    testWidgets('the grid colours each day by its source; the source line names JAKIM', (tester) async {
      await pumpPrayer(tester, const PrayerDataScreen(), location: AppRoutes.prayerData, repo: repo());
      expect(find.text('Sumber: JAKIM e-Solat, dimuat turun 6 Nov 2026'), findsOneWidget);
      await reveal(tester, find.byKey(ValueKey('pd-strip-${day('3')}')));
      expect(stripOf(tester, day('3')), prayerSourceColours['official']);
      await reveal(tester, find.byKey(ValueKey('pd-strip-${day('26')}')));
      expect(stripOf(tester, day('26')), prayerCorrectionColour);

      await tapRevealed(tester, find.byKey(const ValueKey('pd-next')));
      await tapRevealed(tester, find.byKey(const ValueKey('pd-next')));
      await reveal(tester, find.byKey(const ValueKey('pd-strip-2027-01-05')));
      expect(stripOf(tester, '2027-01-05'), prayerSourceColours['calc']);
    });

    testWidgets('a flagged prayer carries the yellow mark, the others do not', (tester) async {
      await pumpPrayer(tester, const PrayerDataScreen(), location: AppRoutes.prayerData, repo: repo());
      await reveal(tester, find.byKey(ValueKey('pd-strip-${day('5')}')));
      expect(find.byKey(ValueKey('pd-flag-${day('5')}-subuh')), findsOneWidget);
      expect(find.byKey(ValueKey('pd-flag-${day('5')}-zohor')), findsNothing, reason: '1 minute is within the limit');
      expect(find.textContaining('1 hari ditanda'), findsOneWidget);
    });

    testWidgets('the day sheet refuses an empty reason, then saves the correction', (tester) async {
      final fake = repo();
      await pumpPrayer(tester, const PrayerDataScreen(), location: AppRoutes.prayerData, repo: fake);
      await tapRevealed(tester, find.byKey(ValueKey('pd-day-$fakeToday')));
      expect(find.text('Rabu, 4 November 2026'), findsOneWidget);
      await tester.tap(find.byKey(const ValueKey('pd-cor-prayer-zohor')));
      await settle(tester);
      await tester.enterText(find.byKey(const ValueKey('pd-cor-time')), '13:10');
      await tester.tap(find.byKey(const ValueKey('pd-cor-save')));
      await settle(tester);
      expect(find.text('Sebab perlu sekurang-kurangnya 3 aksara'), findsOneWidget);
      expect(fake.corrections, isEmpty);

      await tester.enterText(find.byKey(const ValueKey('pd-cor-reason')), 'Notis pindaan JAKIM');
      await settle(tester);
      await tester.tap(find.byKey(const ValueKey('pd-cor-save')));
      await settle(tester);
      expect(fake.corrections.single, (fakeToday, 'zohor', '13:10', 'Notis pindaan JAKIM'));
      expect(find.byKey(const ValueKey('pd-cor-save')), findsNothing, reason: 'the sheet closes');
    });

    testWidgets('a corrected prayer whose official time moved says `Nilai rasmi berubah`; the others do not', (tester) async {
      final fake = repo();
      await pumpPrayer(tester, const PrayerDataScreen(), location: AppRoutes.prayerData, repo: fake);
      await tapRevealed(tester, find.byKey(ValueKey('pd-day-${day('26')}')));
      await tester.tap(find.byKey(const ValueKey('pd-cor-prayer-zohor')));
      await settle(tester);
      expect(find.byKey(const ValueKey('pd-official-changed')), findsOneWidget);
      expect(find.textContaining('Nilai rasmi berubah'), findsOneWidget);
      await tester.tap(find.byKey(const ValueKey('pd-cor-prayer-asar')));
      await settle(tester);
      expect(find.byKey(const ValueKey('pd-official-changed')), findsNothing, reason: 'asar has no correction');
    });

    testWidgets('a correction left out because it breaks the order says so and can still be removed', (tester) async {
      final fake = repo()
        ..daysOf = (from, to) => PrayerDays(
          days: [fakeDay(day('26'), correctionIgnored: const ['asar'])],
          crossCheck: const CrossCheck(),
          sources: const PrayerSources(order: ['official', 'calc', 'file'], country: 'MY', hasOfficial: true),
        );
      await pumpPrayer(tester, const PrayerDataScreen(), location: AppRoutes.prayerData, repo: fake);
      await tapRevealed(tester, find.byKey(ValueKey('pd-day-${day('26')}')));
      await tester.tap(find.byKey(const ValueKey('pd-cor-prayer-asar')));
      await settle(tester);
      expect(find.byKey(const ValueKey('pd-correction-ignored')), findsOneWidget);
      expect(find.byKey(const ValueKey('pd-cor-remove')), findsOneWidget);
      await tester.tap(find.byKey(const ValueKey('pd-cor-prayer-zohor')));
      await settle(tester);
      expect(find.byKey(const ValueKey('pd-correction-ignored')), findsNothing, reason: 'zohor has no ignored correction');
    });

    testWidgets('a corrected prayer can be removed', (tester) async {
      final fake = repo();
      await pumpPrayer(tester, const PrayerDataScreen(), location: AppRoutes.prayerData, repo: fake);
      await tapRevealed(tester, find.byKey(ValueKey('pd-day-${day('26')}')));
      await tester.tap(find.byKey(const ValueKey('pd-cor-prayer-zohor')));
      await settle(tester);
      await tester.tap(find.byKey(const ValueKey('pd-cor-remove')));
      await settle(tester);
      expect(fake.removedCorrections.single, (day('26'), 'zohor'));
    });

    testWidgets('the year view draws a cell per day in its source colour', (tester) async {
      await pumpPrayer(tester, const PrayerDataScreen(), location: AppRoutes.prayerData, repo: repo());
      await tapRevealed(tester, find.text('Tahun'));
      await reveal(tester, find.byKey(const ValueKey('pd-cell-2026-11-10')));
      final cell = tester.widget<Container>(find.byKey(const ValueKey('pd-cell-2026-11-10')));
      expect((cell.decoration! as BoxDecoration).color, prayerSourceColours['official']);
    });

    testWidgets('import pages are allowed for the person who may import', (tester) async {
      await pumpPrayer(tester, const PrayerDataScreen(), location: AppRoutes.prayerData, repo: repo());
      await reveal(tester, find.byKey(const ValueKey('pd-link-import')));
      expect(find.byKey(const ValueKey('pd-link-imports')), findsOneWidget);
      const flags = FeatureFlags.defaults;
      for (final p in [AppRoutes.prayerImport, AppRoutes.prayerImports]) {
        expect(routeAllowed(p, {'admin'}, flags), isTrue, reason: p);
        expect(routeAllowed(p, {'ajk'}, flags), isFalse, reason: p);
      }
    });

    testWidgets('golden: Data waktu solat with sources', (tester) async {
      final t = await pumpPrayer(tester, const PrayerDataScreen(), location: AppRoutes.prayerData, repo: repo());
      await expectGoldens(tester, t.app, 'prayer_data_sources');
    });
  });

  testWidgets('the button names the source the admin set in dataSources', (
    tester,
  ) async {
    await pumpT9(
      tester,
      const PrayerDataScreen(),
      location: AppRoutes.prayerData,
      setup: (h) {
        h.handlers['GET /api/settings'] = (_) async => jsonResponse(200, {
          ...t9Settings(),
          'dataSources': {
            'enabled': true,
            'esolat': {
              'name': 'JAKIM (pelayan sandaran)',
              'url': 'https://sandaran.contoh.my/esolat',
            },
          },
        });
      },
    );
    expect(
      find.text('Muat turun dari JAKIM (pelayan sandaran) ke dalam MAXCOM'),
      findsOneWidget,
    );
    expect(find.text(fetchLabel), findsNothing);
  });

  testWidgets('CSV upload sends the picked text for the zone', (tester) async {
    final t = await pumpT9(
      tester,
      PrayerDataScreen(
        csvPicker: (_) async => 'Tarikh,Imsak\n01-Jan-2027,05:50\n',
      ),
      location: AppRoutes.prayerData,
      setup: (h) {
        h.handlers['POST /api/prayer/import'] = (_) async =>
            jsonResponse(200, {'inserted': 1, 'replaced': 2});
      },
    );
    await tester.tap(find.text('Muat naik CSV'));
    await settle(tester);
    final body = jsonDecode(t.h.box.byPath('/api/prayer/import')!.body);
    expect(body, {'zone': 'SGR01', 'csv': 'Tarikh,Imsak\n01-Jan-2027,05:50\n', 'year': 2027});
    expect(find.text('Ditambah 1, diganti 2'), findsOneWidget);
  });

  testWidgets('the built-in picker is a paste sheet; empty text is refused', (
    tester,
  ) async {
    final t = await pumpT9(
      tester,
      const PrayerDataScreen(),
      location: AppRoutes.prayerData,
      setup: (h) {
        h.handlers['POST /api/prayer/import'] = (_) async =>
            jsonResponse(200, {'inserted': 3, 'replaced': 0});
      },
    );
    await tester.tap(find.text('Muat naik CSV'));
    await settle(tester);
    expect(find.text('Tampal kandungan CSV'), findsOneWidget);
    await tester.tap(find.text('Muat naik'));
    await settle(tester);
    expect(find.text('Tampal kandungan CSV dahulu.'), findsOneWidget);
    expect(t.h.box.byPath('/api/prayer/import'), isNull);

    await tester.enterText(find.byType(TextField), 'Tarikh,Imsak\n');
    await tester.tap(find.text('Muat naik'));
    await settle(tester);
    expect(jsonDecode(t.h.box.byPath('/api/prayer/import')!.body), {
      'zone': 'SGR01',
      'csv': 'Tarikh,Imsak\n',
      'year': 2027,
    });
    expect(find.text('Ditambah 3, diganti 0'), findsOneWidget);
  });

  testWidgets(
    'a 502 from e-Solat is shown in the box words; few days left warns',
    (tester) async {
      await pumpT9(
        tester,
        const PrayerDataScreen(),
        location: AppRoutes.prayerData,
        setup: (h) {
          h.health = {...healthyJson, 'daysAhead': 12};
          h.handlers['POST /api/prayer/import'] = (_) async =>
              jsonResponse(502, {
                'errors': ['e-Solat tidak dapat dihubungi'],
              });
        },
      );
      expect(find.text('12'), findsOneWidget);
      expect(
        find.text('Data hampir habis. Muat turun tahun seterusnya sekarang.'),
        findsOneWidget,
      );
      await tester.tap(find.text(fetchLabel));
      await settle(tester);
      expect(find.text('e-Solat tidak dapat dihubungi'), findsOneWidget);
    },
  );

  testWidgets('no zone known: the imports wait', (tester) async {
    await pumpT9(
      tester,
      const PrayerDataScreen(),
      location: AppRoutes.prayerData,
      setup: (h) {
        h.handlers['GET /api/settings'] = (_) async =>
            jsonResponse(200, settingsJson());
      },
    );
    expect(find.text('Zon waktu solat belum diketahui.'), findsOneWidget);
    final fetch = tester.widget<FilledButton>(
      find.ancestor(
        of: find.text(fetchLabel),
        matching: find.byType(FilledButton),
      ),
    );
    expect(fetch.onPressed, isNull);
  });

  testWidgets(
    '0 days this year: says so, targets this year, no replace warning',
    (tester) async {
      final t = await pumpT9(
        tester,
        const PrayerDataScreen(),
        location: AppRoutes.prayerData,
        setup: (h) {
          h.health = {...healthyJson, 'daysAhead': 0};
          h.handlers['GET /api/prayer/status'] = (_) async =>
              jsonResponse(200, statusBody(years: const []));
          h.handlers['POST /api/prayer/import'] = (_) async =>
              jsonResponse(200, {'inserted': 365, 'replaced': 0});
        },
      );
      expect(
        find.text('Belum ada data waktu solat untuk tahun 2026.'),
        findsOneWidget,
      );
      expect(find.textContaining('hampir habis'), findsNothing);
      expect(find.text('Data tahun 2026'), findsOneWidget);
      expect(find.textContaining('akan diganti'), findsNothing);
      await tester.tap(find.text(fetchLabel));
      await settle(tester);
      expect(find.text('Ganti data sedia ada?'), findsNothing);
      expect(jsonDecode(t.h.box.byPath('/api/prayer/import')!.body), {
        'zone': 'SGR01',
        'year': 2026,
        'source': 'esolat',
      });
      expect(find.text('Ditambah 365, diganti 0'), findsOneWidget);
    },
  );

  testWidgets(
    'the year selector switches the target; cancel in the confirm sends nothing',
    (tester) async {
      final t = await pumpT9(
        tester,
        const PrayerDataScreen(),
        location: AppRoutes.prayerData,
      );
      expect(find.text('Data tahun 2027'), findsOneWidget);
      await tester.tap(
        find.descendant(
          of: find.byKey(const ValueKey('prayer-year')),
          matching: find.text('2026'),
        ),
      );
      await settle(tester);
      expect(find.text('Data tahun 2026'), findsOneWidget);
      expect(
        find.text('Data sedia ada untuk tahun 2026 akan diganti.'),
        findsOneWidget,
      );
      await tester.tap(find.text(fetchLabel));
      await settle(tester);
      await tester.tap(find.text('Batal'));
      await settle(tester);
      expect(t.h.box.byPath('/api/prayer/import'), isNull);
    },
  );

  testWidgets(
    'a real file pick feeds the same import; too big and unreadable say so in BM',
    (tester) async {
      var next = const CsvFileResult.tooBig();
      final t = await pumpT9(
        tester,
        PrayerDataScreen(csvFilePicker: () async => next),
        location: AppRoutes.prayerData,
        setup: (h) {
          h.health = {...healthyJson, 'daysAhead': 0};
          h.handlers['POST /api/prayer/import'] = (_) async =>
              jsonResponse(200, {'inserted': 2, 'replaced': 0});
        },
      );
      await tester.tap(find.text('Muat naik CSV'));
      await settle(tester);
      expect(find.text('Pilih fail CSV'), findsOneWidget);
      expect(
        find.text('Tampal kandungan CSV'),
        findsOneWidget,
        reason: 'paste stays',
      );
      await tester.tap(find.text('Pilih fail CSV'));
      await settle(tester);
      expect(find.text('Fail terlalu besar. Had ialah 1 MB.'), findsOneWidget);
      next = const CsvFileResult.unreadable();
      await tester.tap(find.text('Pilih fail CSV'));
      await settle(tester);
      expect(find.text('Fail tidak dapat dibaca.'), findsOneWidget);
      const csv = 'Tarikh,Imsak\n01-Jan-2026,05:50\n';
      next = const CsvFileResult.text(csv);
      await tester.tap(find.text('Pilih fail CSV'));
      await settle(tester);
      expect(jsonDecode(t.h.box.byPath('/api/prayer/import')!.body), {
        'zone': 'SGR01',
        'csv': csv,
        'year': 2027,
      });
      expect(find.text('Ditambah 2, diganti 0'), findsOneWidget);
    },
  );

  group('release 2026.11.12', () {
    final ms = sFor(AppLang.ms);
    final en = sFor(AppLang.en);
    final ar = sFor(AppLang.ar);

    PrayerStatus statusOf({
      String country = 'MY',
      bool hasOfficial = true,
      String today = fakeToday,
      List<OfficialYear> years = const [],
      int resolved = 0,
      int official = 0,
      List<String> warnings = const [],
      List<PrayerWarning> warningCodes = const [],
    }) => PrayerStatus(
      country: country,
      hasOfficial: hasOfficial,
      zone: 'SGR01',
      located: true,
      order: const ['official', 'calc', 'file'],
      today: TodayStatus(date: today, source: 'official'),
      hasCounts: true,
      daysResolved: resolved,
      daysOfficial: official,
      officialYears: years,
      warnings: warnings,
      warningCodes: warningCodes,
    );

    testWidgets('[P1] 20 official days warn that the data is low though 400 days resolve', (tester) async {
      final t = await pumpPrayer(
        tester,
        const PrayerDataScreen(),
        location: AppRoutes.prayerData,
        repo: FakePrayerRepo(
          status_: statusOf(resolved: 400, official: 20, years: const [OfficialYear(year: 2026, days: 20)]),
        ),
        setup: (h) => h.health = {...healthyJson, 'daysAhead': 400},
      );
      expect(find.text('20'), findsOneWidget);
      expect(find.text('400'), findsNothing);
      expect(find.text(ms.prayerDataLow), findsOneWidget);
      expect(find.text('Data tahun 2026'), findsOneWidget, reason: 'the current year is incomplete');
      await expectGoldens(tester, t.app, 'prayer_data_low');
    });

    testWidgets('[P3] the CSV load sends the chosen year; a file of another year shows its range', (tester) async {
      final t = await pumpPrayer(
        tester,
        PrayerDataScreen(csvPicker: (_) async => 'Tarikh,Imsak\n01-Jan-2026,05:50\n'),
        location: AppRoutes.prayerData,
        repo: FakePrayerRepo(status_: statusOf(official: 400, years: const [OfficialYear(year: 2026, days: 365)])),
        setup: (h) {
          h.handlers['POST /api/prayer/import'] = (_) async => jsonResponse(400, {
            'errors': ['Fail ini bukan untuk tahun 2027 (2026-01-01 hingga 2026-12-31)'],
            'code': 'csv_year_mismatch',
            'detail': {'year': 2027, 'from': '2026-01-01', 'to': '2026-12-31'},
          });
        },
      );
      await tester.tap(find.text('Muat naik CSV'));
      await settle(tester);
      final body = jsonDecode(t.h.box.byPath('/api/prayer/import')!.body) as Map<String, dynamic>;
      expect(body['year'], 2027);
      expect(body['zone'], 'SGR01');
      expect(find.text(ms.errcCsvYearMismatch(2027, '2026-01-01', '2026-12-31')), findsOneWidget);
    });

    testWidgets('[P3] a loaded official file says it is in Rekod import', (tester) async {
      await pumpPrayer(
        tester,
        PrayerDataScreen(csvPicker: (_) async => 'Tarikh,Imsak\n01-Jan-2027,05:50\n'),
        location: AppRoutes.prayerData,
        repo: FakePrayerRepo(status_: statusOf(official: 400, years: const [OfficialYear(year: 2026, days: 365)])),
        setup: (h) {
          h.handlers['POST /api/prayer/import'] = (_) async =>
              jsonResponse(200, {'inserted': 365, 'replaced': 0, 'id': 'a1b2c3d4'});
        },
      );
      await tester.tap(find.text('Muat naik CSV'));
      await settle(tester);
      expect(find.textContaining(ms.ra2CsvRecorded), findsOneWidget);
    });

    for (final (lang, locale) in [(en, const Locale('en')), (ar, const Locale('ar'))]) {
      testWidgets('[P4] in ${locale.languageCode} the grid and the day sheet use the catalogue names', (tester) async {
        await pumpPrayer(
          tester,
          const PrayerDataScreen(),
          location: AppRoutes.prayerData,
          repo: FakePrayerRepo(status_: statusOf(official: 400, years: const [OfficialYear(year: 2026, days: 365)])),
          locale: locale,
          size: GoldenSize.ipadMiniLandscape,
        );
        expect(find.text('${lang.ra2Month11} 2026'), findsOneWidget);
        expect(find.text(lang.ra2PrayerSubuh), findsWidgets);
        expect(find.text('${lang.ra2WeekdayShort3} 4'), findsOneWidget);
        expect(find.text(ms.ra2PrayerSubuh), findsNothing);
        expect(find.text(ms.ra2Month11), findsNothing);
        await tapRevealed(tester, find.byKey(const ValueKey('pd-day-$fakeToday')));
        expect(find.text('${lang.ra2Weekday3}, 4 ${lang.ra2Month11} 2026'), findsOneWidget);
        expect(find.text(ms.ra2PrayerZohor), findsNothing);
        expect(tester.takeException(), isNull);
      });
    }

    test('[P4] short dates, months and weekdays come from the catalogue of each language', () {
      expect(shortDate(en, '2026-08-03'), '3 ${en.ra2MonthShort8} 2026');
      expect(shortDate(ar, '2026-08-03'), '3 ${ar.ra2MonthShort8} 2026');
      expect(shortDate(ms, 'not a date'), 'not a date');
      expect(monthLong(en, 8), 'August');
      expect(weekdayLong(en, 1), 'Monday');
      expect(prayerName(en, 'subuh'), 'Fajr');
      expect(methodLabel(en, 'mwl'), 'Muslim World League');
      for (final m in methodIds) {
        expect(methodLabel(en, m), isNot(m));
        expect(methodLabel(ar, m), isNot(m));
      }
    });

    test('[P5] a file row error renders from its code in ar; an unknown reason keeps the box sentence', () {
      final e = const ImportRowError(5, 'waktu subuh kosong', field: 'subuh', reason: 'empty');
      expect(e.text(ar), ar.ra2RowEmpty(ar.ra2PrayerSubuh));
      expect(e.text(en), en.ra2RowEmpty(en.ra2PrayerSubuh));
      expect(const ImportRowError(6, 'sebab baharu', field: 'x', reason: 'brand_new').text(ar), 'sebab baharu');
      expect(const ImportRowError(7, 'ayat lama').text(en), 'ayat lama', reason: 'an older box sends no reason');
      final apply = BoxError(400, 'baris 3: x', code: 'import_row_invalid', detail: {'row': 3, 'field': 'date', 'reason': 'duplicate'});
      expect(errorText(ar, apply), '${ar.impRow(3)}: ${ar.ra2RowDuplicate}');
    });

    test('[P5] a warning is worded from its code; an unknown code and an older box show the sentence', () {
      final st = PrayerStatus.fromJson({
        'warnings': ['Tiada data waktu solat untuk hari ini', 'Zon: ayat lain'],
        'warningCodes': [
          {'code': 'no_data_today', 'detail': <String, Object?>{}},
        ],
      });
      expect(st.warningTexts(ar), [ar.ra2WarnNoDataToday, 'Zon: ayat lain']);
      expect(st.warningTexts(en), [en.ra2WarnNoDataToday, 'Zon: ayat lain']);
      final unknown = PrayerStatus.fromJson({
        'warnings': ['Ayat baharu'],
        'warningCodes': [
          {'code': 'a_new_warning', 'detail': <String, Object?>{}},
        ],
      });
      expect(unknown.warningTexts(en), ['Ayat baharu']);
      final older = PrayerStatus.fromJson({
        'warnings': ['Ayat lama'],
      });
      expect(older.warningTexts(en), ['Ayat lama']);
      expect(prayerWarningText(en, 'zone_no_data', {'willFetch': true}), en.ra2WarnZoneNoDataFetch);
      expect(prayerWarningText(en, 'zone_no_data', {'willFetch': false}), en.ra2WarnZoneNoDataManual);
    });

    testWidgets('[P5] the status warning shows in the language of the app, not the box sentence', (tester) async {
      await pumpPrayer(
        tester,
        const PrayerDataScreen(),
        location: AppRoutes.prayerData,
        repo: FakePrayerRepo(
          status_: statusOf(
            official: 400,
            warnings: const ['Lokasi surau belum ditetapkan'],
            warningCodes: const [PrayerWarning(code: 'not_located', sentence: 'Lokasi surau belum ditetapkan')],
          ),
        ),
        locale: const Locale('ar'),
      );
      expect(find.text(ar.ra2WarnNotLocated), findsOneWidget);
      expect(find.text('Lokasi surau belum ditetapkan'), findsNothing);
    });

    testWidgets('[P5] the country list is asked in the language of the app', (tester) async {
      final repo = FakePrayerRepo();
      await pumpPrayer(
        tester,
        const LocationScreen(),
        location: AppRoutes.settingsLocation,
        repo: repo,
        locale: const Locale('ar'),
      );
      expect(repo.countryLangs, contains('ar'));
      expect(repo.countryLangs, isNot(contains('ms')));
    });

    testWidgets('[P7] a surau abroad is offered no e-Solat card and no official CSV', (tester) async {
      await pumpPrayer(
        tester,
        const PrayerDataScreen(),
        location: AppRoutes.prayerData,
        repo: FakePrayerRepo(status_: statusOf(country: 'GB', hasOfficial: false, resolved: 400)),
      );
      expect(find.byKey(const ValueKey('pd-no-official')), findsOneWidget);
      expect(find.text(ms.ra2NoOfficialCard), findsOneWidget);
      expect(find.text(fetchLabel), findsNothing);
      expect(find.text('Muat naik CSV'), findsNothing);
      expect(find.byKey(const ValueKey('prayer-year')), findsNothing);
    });

    testWidgets('[P12] the years offered come from the box date, not the phone clock', (tester) async {
      // The phone says 4 November 2026; the box is already on 1 January 2027.
      await pumpPrayer(
        tester,
        const PrayerDataScreen(),
        location: AppRoutes.prayerData,
        repo: FakePrayerRepo(status_: statusOf(today: '2027-01-01', official: 400)),
      );
      final pick = find.byKey(const ValueKey('prayer-year'));
      expect(find.descendant(of: pick, matching: find.text('2027')), findsOneWidget);
      expect(find.descendant(of: pick, matching: find.text('2028')), findsOneWidget);
      expect(find.descendant(of: pick, matching: find.text('2026')), findsNothing);
      expect(find.text('Data tahun 2027'), findsOneWidget);
    });
  });
}
