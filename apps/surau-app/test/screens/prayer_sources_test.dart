// Sumber waktu solat (Plan 13 Task 8): the order of the sources, the local
// calculation's settings, today's preview and the cross-check.

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:surau_app/app/router.dart';
import 'package:surau_app/features/prayer/prayer_repository.dart';
import 'package:surau_app/features/prayer/sources_screen.dart';
import 'package:surau_app/features/prayer/widgets/country_picker.dart';

import '../features/shell/harness.dart';
import '../golden_sizes.dart';
import 'prayer_fakes.dart';

const _screen = SourcesScreen();

Map<String, Object?> _calc({Map<String, int> adjust = const {}}) => {
  'enabled': true,
  'method': 'auto',
  'madhab': 'auto',
  'highLatitude': 'auto',
  'adjustMinutes': {
    for (final p in const ['imsak', 'subuh', 'syuruk', 'zohor', 'asar', 'maghrib', 'isyak']) p: adjust[p] ?? 0,
  },
  'imsakMinutes': 10,
};

const Map<String, Object?> _order = {
  'enabled': true,
  'sourceOrder': ['official', 'calc', 'file'],
  'crossCheck': true,
};

Map<String, Map<String, Object?>> _myn({Map<String, int> adjust = const {}}) => {
  'prayerCalc': _calc(adjust: adjust),
  'prayerSources': _order,
};

Future<String> _stepper(WidgetTester tester, String prayer) async {
  final value = find.byKey(ValueKey('src-adj-$prayer-value'));
  await reveal(tester, value);
  return tester.widget<Text>(value).data!;
}

void main() {
  testWidgets('moving JAKIM down warns, and the order is saved as shown', (tester) async {
    final t = await pumpPrayer(tester, _screen, location: AppRoutes.settingsPrayerSources, settings: _myn());
    expect(find.text('Data rasmi JAKIM tidak lagi diutamakan'), findsNothing);
    await tester.tap(find.byKey(const ValueKey('order-down-official')));
    await settle(tester);
    expect(find.text('Data rasmi JAKIM tidak lagi diutamakan'), findsOneWidget);
    await tapRevealed(tester, find.byKey(const ValueKey('src-save')));
    expect(t.h.box.bodyOf('/api/settings/prayerSources'), {
      'sourceOrder': ['calc', 'official', 'file'],
    });
    expect(t.h.box.byPath('/api/settings/prayerCalc'), isNull, reason: 'nothing changed there');
  });

  testWidgets('outside Malaysia the official row is hidden and stays last in what is saved', (tester) async {
    final repo = FakePrayerRepo(
      status_: const PrayerStatus(country: 'KE', hasOfficial: false, located: true, order: ['file', 'calc', 'official']),
    );
    final t = await pumpPrayer(
      tester,
      _screen,
      location: AppRoutes.settingsPrayerSources,
      repo: repo,
      settings: {
        'prayerCalc': _calc(),
        'prayerSources': const {'enabled': true, 'sourceOrder': ['file', 'calc', 'official'], 'crossCheck': true},
        'location': const {'enabled': true, 'country': 'KE', 'timezone': 'Africa/Nairobi', 'latitude': -1.27, 'longitude': 36.84, 'city': 'Eastleigh'},
      },
    );
    expect(find.byKey(const ValueKey('order-row-official')), findsNothing);
    await tester.tap(find.byKey(const ValueKey('order-down-file')));
    await settle(tester);
    await tapRevealed(tester, find.byKey(const ValueKey('src-save')));
    expect(t.h.box.bodyOf('/api/settings/prayerSources'), {
      'sourceOrder': ['calc', 'file', 'official'],
    });
  });

  testWidgets('whether the official row shows follows the box status, not the country code', (tester) async {
    // a country other than MY for which the box reports an official source: the row is there
    final repo = FakePrayerRepo(
      status_: const PrayerStatus(country: 'KE', hasOfficial: true, located: true, order: ['official', 'calc', 'file']),
    );
    await pumpPrayer(
      tester,
      _screen,
      location: AppRoutes.settingsPrayerSources,
      repo: repo,
      settings: {
        'prayerCalc': _calc(),
        'prayerSources': const {'enabled': true, 'sourceOrder': ['official', 'calc', 'file'], 'crossCheck': true},
        'location': const {'enabled': true, 'country': 'KE', 'timezone': 'Africa/Nairobi', 'latitude': -1.27, 'longitude': 36.84, 'city': 'Eastleigh'},
      },
    );
    expect(find.byKey(const ValueKey('order-row-official')), findsOneWidget);
  });

  testWidgets('the method names JAKIM 18/18 when automatic', (tester) async {
    await pumpPrayer(tester, _screen, location: AppRoutes.settingsPrayerSources, settings: _myn());
    await reveal(tester, find.byKey(const ValueKey('src-method')));
    expect(find.text('Auto (JAKIM 18/18)'), findsOneWidget);
  });

  testWidgets('the high latitude rule is dimmed at latitude 3 with the reason', (tester) async {
    await pumpPrayer(tester, _screen, location: AppRoutes.settingsPrayerSources, settings: _myn());
    await reveal(tester, find.byKey(const ValueKey('src-highlat')));
    expect(find.text('Tiada kesan di bawah latitud 48 darjah'), findsOneWidget);
    expect(tester.widget<PickerField>(find.byKey(const ValueKey('src-highlat'))).onTap, isNull);
  });

  testWidgets('the high latitude rule is active at latitude 60', (tester) async {
    await pumpPrayer(
      tester,
      _screen,
      location: AppRoutes.settingsPrayerSources,
      settings: {
        ..._myn(),
        'location': const {'enabled': true, 'country': 'NO', 'timezone': 'Europe/Oslo', 'latitude': 60.0, 'longitude': 10.0, 'city': 'Oslo'},
      },
    );
    await reveal(tester, find.byKey(const ValueKey('src-highlat')));
    expect(find.text('Tiada kesan di bawah latitud 48 darjah'), findsNothing);
    expect(tester.widget<PickerField>(find.byKey(const ValueKey('src-highlat'))).onTap, isNotNull);
  });

  testWidgets('Guna cadangan ADDS the median to the saved adjustment, and only Simpan sends it', (tester) async {
    final repo = FakePrayerRepo()
      ..cross = const CrossCheck(
        flagged: [CrossFlag(date: fakeToday, source: 'official', diffs: {'subuh': 3})],
        maxDiff: {'subuh': 4, 'zohor': 1},
        medianDiff: {'imsak': 3, 'subuh': 3, 'syuruk': 0, 'zohor': -1, 'asar': 0, 'maghrib': 1, 'isyak': 0},
        compared: 30,
      );
    final t = await pumpPrayer(
      tester,
      _screen,
      location: AppRoutes.settingsPrayerSources,
      repo: repo,
      settings: _myn(adjust: const {'subuh': 2, 'zohor': 3}),
    );
    final use = find.byKey(const ValueKey('src-suggest'));
    await tapRevealed(tester, use);
    expect(await _stepper(tester, 'subuh'), '+5', reason: '2 saved plus a median of 3, not replaced by 3');
    expect(await _stepper(tester, 'zohor'), '+2', reason: '3 saved plus a median of -1');
    expect(await _stepper(tester, 'maghrib'), '+1');
    expect(await _stepper(tester, 'asar'), '0');
    expect(t.h.box.byPath('/api/settings/prayerCalc'), isNull, reason: 'not saved until Simpan');

    await tapRevealed(tester, use);
    expect(await _stepper(tester, 'subuh'), '+5', reason: 'the residual is against what is saved: no double add');

    await tapRevealed(tester, find.byKey(const ValueKey('src-save')));
    expect(t.h.box.bodyOf('/api/settings/prayerCalc'), {
      'adjustMinutes': {'imsak': 3, 'subuh': 5, 'zohor': 2, 'maghrib': 1},
    });
  });

  testWidgets('steppers stop at their limits', (tester) async {
    await pumpPrayer(
      tester,
      _screen,
      location: AppRoutes.settingsPrayerSources,
      settings: _myn(adjust: const {'isyak': 30}),
    );
    await reveal(tester, find.byKey(const ValueKey('src-adj-isyak-plus')));
    expect(tester.widget<IconButton>(find.byKey(const ValueKey('src-adj-isyak-plus'))).onPressed, isNull);
    expect(tester.widget<IconButton>(find.byKey(const ValueKey('src-adj-isyak-minus'))).onPressed, isNotNull);
  });

  testWidgets('today shows the source, the calculation and the difference', (tester) async {
    await pumpPrayer(tester, _screen, location: AppRoutes.settingsPrayerSources, settings: _myn());
    await reveal(tester, find.byKey(const ValueKey('src-preview-subuh')));
    final row = find.byKey(const ValueKey('src-preview-subuh'));
    expect(find.descendant(of: row, matching: find.text('05:54')), findsOneWidget);
    expect(find.descendant(of: row, matching: find.text('05:51')), findsOneWidget);
    expect(find.descendant(of: row, matching: find.text('+3')), findsOneWidget);
  });

  testWidgets('a refused save reads beside the button', (tester) async {
    await pumpPrayer(
      tester,
      _screen,
      location: AppRoutes.settingsPrayerSources,
      settings: _myn(),
      setup: (h) {
        h.handlers['PUT /api/settings/prayerSources'] = (_) async => jsonResponse(400, {
          'errors': ['sourceOrder must list each source once'],
        });
      },
    );
    await tester.tap(find.byKey(const ValueKey('order-down-official')));
    await settle(tester);
    await tapRevealed(tester, find.byKey(const ValueKey('src-save')));
    expect(find.text('sourceOrder must list each source once'), findsOneWidget);
  });

  testWidgets('an AJK member reads the page with no way to change it', (tester) async {
    await pumpPrayer(tester, _screen, location: AppRoutes.settingsPrayerSources, settings: _myn(), roles: const ['ajk']);
    expect(find.byKey(const ValueKey('src-save')), findsNothing);
    expect(tester.widget<IconButton>(find.byKey(const ValueKey('order-down-official'))).onPressed, isNull);
  });

  testWidgets('golden: Sumber waktu solat', (tester) async {
    final repo = FakePrayerRepo()
      ..cross = const CrossCheck(
        flagged: [CrossFlag(date: fakeToday, source: 'official', diffs: {'subuh': 3})],
        maxDiff: {'imsak': 3, 'subuh': 3, 'zohor': 1, 'maghrib': 1},
        medianDiff: {'imsak': 3, 'subuh': 3},
        compared: 30,
      );
    final t = await pumpPrayer(tester, _screen, location: AppRoutes.settingsPrayerSources, repo: repo, settings: _myn());
    await expectGoldens(tester, t.app, 'prayer_sources');
  });
}
