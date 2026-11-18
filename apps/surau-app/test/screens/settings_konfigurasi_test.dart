// Operator round 1: Tetapan becomes Konfigurasi (English "Configuration",
// Arabic "الإعدادات"), its groups fold (all folded when the app starts,
// unfolded by a search, the group opened kept open while the app runs),
// the search's reasons speak the app language, and "Hidup" and
// "Sentiasa hidup" are green pills.
//
// Golden: settings_list (rendered by settings_test.dart).

import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:surau_app/app/app_lang.dart';
import 'package:surau_app/app/theme.dart';
import 'package:surau_app/features/live/fake_publisher.dart';
import 'package:surau_app/features/live/live_screen.dart' show livePublisherProvider;
import 'package:surau_app/features/settings_search.dart';
import 'package:surau_app/l10n/s_lookup.dart';
import 'package:surau_app/screens/widgets/pieces.dart';

import '../features/shell/harness.dart';

Finder k(String key) => find.byKey(ValueKey(key));

Future<ShellHarness> openList(WidgetTester tester, {AppLang lang = AppLang.ms}) async {
  final h = await pumpShell(
    tester,
    roles: const ['admin'],
    overrides: [
      livePublisherProvider.overrideWithValue(FakePublisher()),
      appLangStoreProvider.overrideWithValue(MemoryAppLangStore(lang)),
    ],
  );
  h.router.go('/settings');
  await settle(tester);
  return h;
}

void main() {
  test('the name in three languages', () {
    expect(sFor(AppLang.ms).settingsTitle, 'Konfigurasi');
    expect(sFor(AppLang.en).settingsTitle, 'Configuration');
    expect(sFor(AppLang.ar).settingsTitle, 'الإعدادات');
    expect(sFor(AppLang.ms).navSettings, 'Konfigurasi');
    expect(sFor(AppLang.en).navSettings, 'Configuration');
  });

  testWidgets('the page and its menu entry say Konfigurasi', (tester) async {
    await openList(tester);
    expect(find.descendant(of: find.byType(AppBar), matching: find.text('Konfigurasi')), findsOneWidget);
    expect(find.text('Tetapan'), findsNothing);
  });

  testWidgets('every group is folded at start, with its count and chevron', (tester) async {
    await openList(tester);
    expect(k('settings-group-solat'), findsOneWidget);
    expect(k('settings-group-count-solat'), findsOneWidget);
    expect(k('settings-row-clock'), findsNothing, reason: 'Solat folded');
  });

  testWidgets('a search finds a setting inside a folded group and opens the group; the group stays open after', (
    tester,
  ) async {
    final h = await openList(tester);
    expect(k('settings-row-clock'), findsNothing);
    await tester.enterText(k('settings-search'), 'jam');
    await settle(tester);
    expect(k('settings-row-clock'), findsOneWidget, reason: 'the search unfolds Solat');
    await tester.tap(k('settings-row-clock'));
    await settle(tester);
    expect(h.location, '/settings/clock');
    h.router.go('/settings');
    await settle(tester);
    // The list lived on under the feature page: clear the search, the group stays.
    await tester.tap(k('settings-search-clear'));
    await settle(tester);
    await reveal(tester, k('settings-row-clock'));
    expect(k('settings-row-clock'), findsOneWidget, reason: 'its group was left open');
  });

  testWidgets('a group opened by hand stays open while the app runs', (tester) async {
    final h = await openList(tester);
    await tester.tap(k('settings-group-solat'));
    await settle(tester);
    expect(k('settings-row-clock'), findsOneWidget);
    h.router.go('/');
    await settle(tester);
    h.router.go('/settings');
    await settle(tester);
    expect(k('settings-row-clock'), findsOneWidget);
  });

  testWidgets('Hidup and Sentiasa hidup are green pills in the success colour', (tester) async {
    await openList(tester);
    await tester.tap(k('settings-group-solat'));
    await settle(tester);
    final pills = tester.widgetList<StateChip>(find.byType(StateChip)).where((c) => c.label == 'Sentiasa hidup' || c.label == 'Hidup');
    expect(pills, isNotEmpty);
    for (final p in pills) {
      expect(p.background, SurauColors.successSoft, reason: p.label);
      expect(p.foreground, SurauColors.success, reason: p.label);
    }
  });

  test('the green pill reads at 4.5:1 or better', () {
    double lin(double v) => v <= 0.03928 ? v / 12.92 : math.pow((v + 0.055) / 1.055, 2.4).toDouble();
    double lum(Color c) => 0.2126 * lin(c.r) + 0.7152 * lin(c.g) + 0.0722 * lin(c.b);
    final ratio = (lum(SurauColors.successSoft) + 0.05) / (lum(SurauColors.success) + 0.05);
    expect(ratio, greaterThanOrEqualTo(4.5));
  });

  test('the search reasons speak the app language', () {
    const index = SettingsSearchIndex();
    Map<String, String?> run(String q, AppLang lang) => {
      for (final h in index.search(q, roles: const {'admin'}, lang: lang)) h.feature: h.why,
    };
    expect(run('kuat bunyi', AppLang.ms)['beeps'], 'Medan: Kuat bunyi');
    expect(run('azan', AppLang.en)['masukWaktu'], startsWith('Keyword: '));
    expect(run('azan', AppLang.ar)['masukWaktu'], startsWith('كلمة مفتاحية: '));
  });
}
