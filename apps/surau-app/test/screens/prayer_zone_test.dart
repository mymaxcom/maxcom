// Zon JAKIM (Plan 13 Task 8): the searchable list by state with what this
// MAXCOM holds, the removed-zone warning, the suggestion, the refresh, and
// nothing at all outside Malaysia.

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:surau_app/app/router.dart';
import 'package:surau_app/features/live/fake_publisher.dart';
import 'package:surau_app/features/live/live_screen.dart' show livePublisherProvider;
import 'package:surau_app/features/prayer/location_screen.dart';
import 'package:surau_app/features/prayer/prayer_repository.dart';
import 'package:surau_app/features/prayer/sources_screen.dart';
import 'package:surau_app/features/prayer/zone_screen.dart';
import 'package:surau_app/screens/settings_list_screen.dart';

import '../features/shell/harness.dart';
import '../golden_sizes.dart';
import 'prayer_fakes.dart';

const _screen = ZoneScreen();

const _ke = {
  'location': <String, Object?>{
    'enabled': true,
    'country': 'KE',
    'timezone': 'Africa/Nairobi',
    'latitude': -1.2752,
    'longitude': 36.8486,
    'city': 'Eastleigh',
  },
};

void main() {
  testWidgets('the list filters by district and shows what is stored', (tester) async {
    await pumpPrayer(tester, _screen, location: AppRoutes.settingsZone);
    await tester.tap(find.byKey(const ValueKey('zon-picker')));
    await settle(tester);
    expect(find.text('Johor'), findsOneWidget, reason: 'grouped by state');
    await tester.enterText(find.byKey(const ValueKey('picker-search')), 'Petaling');
    await settle(tester);
    expect(find.text('Johor'), findsNothing);
    expect(find.text('Data ada: 2026, 2027'), findsWidgets);
    await tester.enterText(find.byKey(const ValueKey('picker-search')), 'Sabak');
    await settle(tester);
    expect(find.text('Tiada data: akan dimuat turun'), findsOneWidget);
  });

  testWidgets('choosing a zone with no data saves it and shows the box warning', (tester) async {
    final t = await pumpPrayer(
      tester,
      _screen,
      location: AppRoutes.settingsZone,
      setup: (h) {
        h.handlers['PUT /api/settings/zone'] = (_) async => jsonResponse(200, {
          ...h.settings,
          'warnings': ['Tiada data untuk zon ini; MAXCOM akan memuat turun'],
        });
      },
    );
    await tester.tap(find.byKey(const ValueKey('zon-picker')));
    await settle(tester);
    await tester.enterText(find.byKey(const ValueKey('picker-search')), 'Sabak');
    await settle(tester);
    await tester.tap(find.text('SGR02'));
    await settle(tester);
    expect(find.text('Data SGR02 akan dimuat turun selepas disimpan, jika MAXCOM ini memuat turun sendiri.'), findsOneWidget);
    await tapRevealed(tester, find.byKey(const ValueKey('zon-save')));
    expect(t.h.box.bodyOf('/api/settings/zone'), {'zone': 'SGR02'});
    expect(find.text('Tiada data untuk zon ini; MAXCOM akan memuat turun'), findsOneWidget);
  });

  testWidgets('a removed zone shows the warning banner', (tester) async {
    final repo = FakePrayerRepo()
      ..zoneList = const ZoneList(
        zones: fakeZones,
        warning: 'Zon SGR01 tiada lagi dalam senarai JAKIM; data tersimpan digunakan sehingga 31 Dis 2026',
      );
    await pumpPrayer(tester, _screen, location: AppRoutes.settingsZone, repo: repo);
    expect(find.textContaining('tiada lagi dalam senarai JAKIM'), findsOneWidget);
  });

  testWidgets('the suggestion waits for Guna, then Simpan writes it', (tester) async {
    final repo = FakePrayerRepo()
      ..zoneList = const ZoneList(zones: fakeZones, suggested: ZoneSuggestion(code: 'WLY01', distanceKm: 9.5));
    final t = await pumpPrayer(tester, _screen, location: AppRoutes.settingsZone, repo: repo);
    expect(find.text('Dicadangkan dari lokasi: WLY01'), findsOneWidget);
    expect(t.h.box.byPath('/api/settings/zone'), isNull);
    await tapRevealed(tester, find.byKey(const ValueKey('zon-suggest-use')));
    expect(t.h.box.byPath('/api/settings/zone'), isNull, reason: 'never applied by itself');
    await tapRevealed(tester, find.byKey(const ValueKey('zon-save')));
    expect(t.h.box.bodyOf('/api/settings/zone'), {'zone': 'WLY01'});
  });

  testWidgets('Kemas kini senarai zon reports the count; a failure reads in BM', (tester) async {
    final repo = FakePrayerRepo();
    await pumpPrayer(tester, _screen, location: AppRoutes.settingsZone, repo: repo);
    await tapRevealed(tester, find.byKey(const ValueKey('zon-refresh')));
    expect(repo.refreshes, 1);
    expect(find.text('Senarai zon dikemas kini: 60 zon'), findsOneWidget);
    repo.refreshError = const PrayerError(
      PrayerFailure.upstream,
      'Senarai zon tidak dapat dimuat turun sekarang. Cuba lagi nanti',
      status: 502,
    );
    await tapRevealed(tester, find.byKey(const ValueKey('zon-refresh')));
    expect(find.text('Senarai zon tidak dapat dimuat turun sekarang. Cuba lagi nanti'), findsOneWidget);
  });

  testWidgets('outside Malaysia the page holds no zone at all', (tester) async {
    await pumpPrayer(tester, _screen, location: AppRoutes.settingsZone, settings: _ke);
    expect(find.text('Zon JAKIM hanya untuk surau di Malaysia.'), findsOneWidget);
    expect(find.byKey(const ValueKey('zon-picker')), findsNothing);
  });

  testWidgets('the Tetapan list has the zone row in Malaysia only', (tester) async {
    Future<Finder> search(Map<String, Map<String, Object?>> settings) async {
      await pumpPrayer(tester, const SettingsListScreen(), location: AppRoutes.settings, settings: settings);
      await tester.enterText(find.byType(TextField).first, 'Zon waktu solat');
      await settle(tester);
      return find.byKey(const ValueKey('settings-row-zone'));
    }

    expect(await search(const {}), findsOneWidget);
    expect(await search(_ke), findsNothing);
  });

  testWidgets('the Sumber waktu solat feature row opens its own page', (tester) async {
    final h = await pumpShell(
      tester,
      roles: const ['admin'],
      overrides: [
        prayerRepositoryProvider.overrideWithValue(FakePrayerRepo()),
        livePublisherProvider.overrideWithValue(FakePublisher()),
      ],
    );
    await settle(tester);
    h.router.go(AppRoutes.settingsFor('prayerSources'));
    await settle(tester);
    expect(h.location, AppRoutes.settingsPrayerSources);
    expect(find.byType(SourcesScreen), findsOneWidget);
  });

  testWidgets('golden: Zon JAKIM', (tester) async {
    final repo = FakePrayerRepo()
      ..zoneList = const ZoneList(
        zones: fakeZones,
        fetchedAt: '2026-11-04T01:14:00.000Z',
        suggested: ZoneSuggestion(code: 'WLY01', distanceKm: 9.5),
      );
    final t = await pumpPrayer(tester, _screen, location: AppRoutes.settingsZone, repo: repo);
    await expectGoldens(tester, t.app, 'prayer_zone');
  });
}
