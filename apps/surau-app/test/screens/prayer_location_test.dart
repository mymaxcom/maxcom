// Lokasi surau (Plan 13 Task 8): country, time zone, search or typed
// coordinates, the JAKIM zone suggestion in Malaysia, and the rule that a
// surau outside Malaysia cannot save without coordinates.

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:surau_app/app/router.dart';
import 'package:surau_app/features/prayer/location_screen.dart';
import 'package:surau_app/features/prayer/prayer_repository.dart';
import 'package:surau_app/features/prayer/widgets/coordinate_fields.dart';

import '../features/shell/harness.dart';
import '../golden_sizes.dart';
import 'prayer_fakes.dart';

const _screen = LocationScreen();

FilledButton _save(WidgetTester tester) => tester.widget<FilledButton>(find.byKey(const ValueKey('loc-save')));

Future<void> _chooseKenya(WidgetTester tester) async {
  await tester.tap(find.byKey(const ValueKey('loc-country')));
  await settle(tester);
  await tester.enterText(find.byKey(const ValueKey('picker-search')), 'ken');
  await settle(tester);
  await tester.tap(find.text('Kenya').last);
  await settle(tester);
}

Future<void> _openCoordinates(WidgetTester tester) async {
  await tester.tap(find.text('Taip koordinat'));
  await settle(tester);
}

void main() {
  testWidgets('choosing Kenya hides the zone and needs coordinates; then it saves', (tester) async {
    final t = await pumpPrayer(tester, _screen, location: AppRoutes.settingsLocation);
    expect(find.byKey(const ValueKey('loc-zone-row')), findsOneWidget);
    await reveal(tester, find.byKey(const ValueKey('loc-save')));
    expect(_save(tester).onPressed, isNotNull);

    await tester.drag(find.byType(ListView).first, const Offset(0, 2000));
    await settle(tester);
    await _chooseKenya(tester);
    expect(find.text('Africa/Nairobi'), findsOneWidget);
    expect(find.byKey(const ValueKey('loc-zone-row')), findsNothing);
    await reveal(tester, find.byKey(const ValueKey('loc-save')));
    expect(_save(tester).onPressed, isNull, reason: 'the Malaysian coordinates were cleared');
    expect(find.text('Lokasi perlukan koordinat kerana waktu solat dikira'), findsOneWidget);

    await tester.drag(find.byType(ListView).first, const Offset(0, 2000));
    await settle(tester);
    await reveal(tester, find.text('Taip koordinat'));
    await _openCoordinates(tester);
    await tester.enterText(find.byKey(CoordinateFields.latitudeKey), '-1.2921, 36.8219');
    await settle(tester);
    await reveal(tester, find.byKey(const ValueKey('loc-save')));
    expect(_save(tester).onPressed, isNotNull);
    await tester.tap(find.byKey(const ValueKey('loc-save')));
    await settle(tester);
    expect(t.h.box.bodyOf('/api/settings/location'), {
      'country': 'KE',
      'timezone': 'Africa/Nairobi',
      'latitude': -1.2921,
      'longitude': 36.8219,
      'city': '',
    });
  });

  testWidgets('a pasted pair fills both fields at 4 places', (tester) async {
    await pumpPrayer(tester, _screen, location: AppRoutes.settingsLocation);
    await reveal(tester, find.text('Taip koordinat'));
    await _openCoordinates(tester);
    await tester.enterText(find.byKey(CoordinateFields.latitudeKey), '-1.29213, 36.8219');
    await settle(tester);
    expect(tester.widget<TextField>(find.byKey(CoordinateFields.latitudeKey)).controller!.text, '-1.2921');
    expect(tester.widget<TextField>(find.byKey(CoordinateFields.longitudeKey)).controller!.text, '36.8219');
  });

  testWidgets('a coordinate out of range is refused beside the field', (tester) async {
    await pumpPrayer(tester, _screen, location: AppRoutes.settingsLocation);
    await reveal(tester, find.text('Taip koordinat'));
    await _openCoordinates(tester);
    await tester.enterText(find.byKey(CoordinateFields.latitudeKey), '95');
    await settle(tester);
    expect(find.text('Latitud mesti antara -90 dan 90'), findsOneWidget);
  });

  testWidgets('a search result fills the city and coordinates, with the attribution', (tester) async {
    final repo = FakePrayerRepo()
      ..searchResult = const LocationSearch(
        results: [
          LocationHit(label: 'Eastleigh, Nairobi, Kenya', city: 'Eastleigh', lat: -1.2752, lon: 36.8486, country: 'KE'),
        ],
        attribution: '(c) OpenStreetMap contributors',
      );
    final t = await pumpPrayer(tester, _screen, location: AppRoutes.settingsLocation, repo: repo);
    await reveal(tester, find.byKey(const ValueKey('loc-search')));
    await tester.enterText(find.byKey(const ValueKey('loc-search')), 'Eastleigh');
    await tester.tap(find.byKey(const ValueKey('loc-search-go')));
    await settle(tester);
    expect(repo.searches, ['Eastleigh'], reason: 'one request per press');
    expect(find.text('(c) OpenStreetMap contributors'), findsOneWidget);

    await tapRevealed(tester, find.text('Eastleigh, Nairobi, Kenya'));
    expect(find.byKey(const ValueKey('loc-summary')), findsOneWidget);
    expect(tester.widget<TextField>(find.byKey(const ValueKey('loc-city'))).controller!.text, 'Eastleigh');
    await tapRevealed(tester, find.byKey(const ValueKey('loc-save')));
    expect(t.h.box.bodyOf('/api/settings/location'), {
      'country': 'KE',
      'timezone': 'Africa/Nairobi',
      'latitude': -1.2752,
      'longitude': 36.8486,
      'city': 'Eastleigh',
    });
  });

  testWidgets('an offline MAXCOM says so and offers typed coordinates', (tester) async {
    final repo = FakePrayerRepo()
      ..searchError = const PrayerError(PrayerFailure.offline, PrayerError.offlineMessage, status: 503);
    await pumpPrayer(tester, _screen, location: AppRoutes.settingsLocation, repo: repo);
    await reveal(tester, find.byKey(const ValueKey('loc-search')));
    await tester.enterText(find.byKey(const ValueKey('loc-search')), 'Gombak');
    await tester.tap(find.byKey(const ValueKey('loc-search-go')));
    await settle(tester);
    expect(find.text(PrayerError.offlineMessage), findsOneWidget);
    expect(find.text('MAXCOM tiada internet; taip koordinat'), findsOneWidget);
    expect(find.byKey(CoordinateFields.latitudeKey), findsOneWidget);
  });

  testWidgets('in Malaysia the nearest zone is suggested and Guna writes it', (tester) async {
    final t = await pumpPrayer(
      tester,
      _screen,
      location: AppRoutes.settingsLocation,
      settings: {
        'zone': {'enabled': true, 'zone': 'SGR02', 'autoFetch': true},
      },
    );
    await reveal(tester, find.byKey(const ValueKey('loc-suggest-use')));
    expect(find.text('Zon JAKIM dicadangkan: SGR01'), findsOneWidget);
    await tester.tap(find.byKey(const ValueKey('loc-suggest-use')));
    await settle(tester);
    expect(t.h.box.bodyOf('/api/settings/zone'), {'zone': 'SGR01'});
    expect(find.text('Zon JAKIM dicadangkan: SGR01'), findsNothing, reason: 'it is the zone now');
  });

  testWidgets('coordinates preselect the zone of the longitude; a zone the person picked is kept', (tester) async {
    final repo = FakePrayerRepo();
    await pumpPrayer(
      tester,
      _screen,
      location: AppRoutes.settingsLocation,
      repo: repo,
      settings: {
        'location': {
          'enabled': true,
          'country': 'ID',
          'timezone': 'Asia/Jakarta',
          'latitude': null,
          'longitude': null,
          'city': '',
        },
      },
    );
    final zoneRow = find.byKey(const ValueKey('loc-timezone'));
    await reveal(tester, find.text('Taip koordinat'));
    await _openCoordinates(tester);
    // Jakarta's longitude: stays Jakarta. Papua's: Jayapura. Two zones of one country.
    await tester.enterText(find.byKey(CoordinateFields.latitudeKey), '-6.2, 106.8');
    await settle(tester);
    expect(repo.timezoneAsks.last, ('ID', 106.8));
    expect(find.descendant(of: zoneRow, matching: find.text('Asia/Jakarta')), findsOneWidget);
    await tester.enterText(find.byKey(CoordinateFields.latitudeKey), '-2.5, 140.7');
    await settle(tester);
    expect(repo.timezoneAsks.last, ('ID', 140.7));
    expect(find.descendant(of: zoneRow, matching: find.text('Asia/Jayapura')), findsOneWidget);
    await tester.enterText(find.byKey(CoordinateFields.latitudeKey), '-5.1, 119.4');
    await settle(tester);
    expect(find.descendant(of: zoneRow, matching: find.text('Asia/Makassar')), findsOneWidget);

    // The person picks Jakarta themselves: new coordinates no longer move it.
    await tester.tap(zoneRow);
    await settle(tester);
    await tester.tap(find.text('Asia/Jakarta').last);
    await settle(tester);
    final asks = repo.timezoneAsks.length;
    await tester.enterText(find.byKey(CoordinateFields.latitudeKey), '-2.5, 140.7');
    await settle(tester);
    expect(find.descendant(of: zoneRow, matching: find.text('Asia/Jakarta')), findsOneWidget);
    expect(repo.timezoneAsks.length, asks, reason: 'no question once the person chose');
  });

  testWidgets('an AJK member sees the location but cannot change it', (tester) async {
    await pumpPrayer(tester, _screen, location: AppRoutes.settingsLocation, roles: const ['ajk']);
    expect(find.text('Malaysia'), findsWidgets);
    expect(find.byKey(const ValueKey('loc-save')), findsNothing);
  });

  testWidgets('golden: Lokasi surau', (tester) async {
    final t = await pumpPrayer(tester, _screen, location: AppRoutes.settingsLocation);
    await expectGoldens(tester, t.app, 'prayer_location');
  });

  testWidgets('golden: Lokasi surau outside Malaysia, not located', (tester) async {
    final t = await pumpPrayer(
      tester,
      _screen,
      location: AppRoutes.settingsLocation,
      settings: {
        'location': {
          'enabled': true,
          'country': 'KE',
          'timezone': 'Africa/Nairobi',
          'latitude': null,
          'longitude': null,
          'city': '',
        },
      },
    );
    await expectGoldens(tester, t.app, 'prayer_location_ke');
  });
}
