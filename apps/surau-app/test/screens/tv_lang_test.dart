// Bahasa skrin TV: Automatik, Bahasa Melayu, English and العربية (labels in the three app languages), the Arabic choice
// hidden with a short note on a box from before Arabic, and the one-time question when Arabic Art is chosen while the
// TV language is not Arabic. Goldens: tv_lang_*.

import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:surau_app/app/app_lang.dart';
import 'package:surau_app/app/providers.dart';
import 'package:surau_app/features/common/bidi.dart';
import 'package:surau_app/features/settings_widgets/tv_lang_choice.dart' show tvLangChoices;
import 'package:surau_app/features/theme/theme_api.dart' show themeSupportFullProvider;

import '../features/fakes.dart' show jsonResponse;
import '../features/shell/harness.dart';
import '../golden_sizes.dart';

Finder k(String key) => find.byKey(ValueKey(key));

const List<String> _six = ['default', 'colourful', 'creative', 'oldschool', 'minimal', 'arabic'];

Map<String, Object?> _health({required bool arabicBox}) => {
  ...healthyJson,
  'themes': {'contract': 1, 'builtIn': _six},
  'features': ['video', 'posterStretch', if (arabicBox) 'tvLangAr'],
};

Future<ShellHarness> _open(
  WidgetTester tester, {
  bool arabicBox = true,
  String lang = 'auto',
  String route = '/settings/language',
}) async {
  final h = await pumpShell(tester, roles: const ['admin'], health: _health(arabicBox: arabicBox));
  h.settings['kioskTemplate'] = {'enabled': true, 'templateId': 'creative'};
  h.settings['language'] = {'enabled': true, 'lang': lang};
  h.handlers['GET /api/themes/support'] = (r) async => jsonResponse(200, {
    'contract': 1,
    'builtIn': _six,
    'boxes': [
      {'boxId': 'b0', 'name': 'Kotak 0', 'contract': 1, 'builtIn': _six},
    ],
    'complete': true,
  });
  h.container.invalidate(settingsProvider);
  h.container.invalidate(healthProvider);
  h.container.invalidate(themeSupportFullProvider);
  h.router.go(route);
  await settle(tester);
  return h;
}

List<Map<String, dynamic>> _languagePuts(ShellHarness h) => [
  for (final r in h.box.seen.where((r) => r.method == 'PUT' && r.url.path == '/api/settings/language')) jsonDecode(r.body) as Map<String, dynamic>,
];

Future<void> _useArabicArt(WidgetTester tester) async {
  await reveal(tester, k('theme-card-arabic'));
  await tester.tap(k('theme-card-arabic'));
  await settle(tester);
  await tester.tap(k('theme-use'));
  await settle(tester);
}

void main() {
  test('tvLangChoices leaves Arabic out for a box without it, unless it is already chosen', () {
    const all = ['auto', 'ms', 'en', 'ar'];
    expect(tvLangChoices(all, boxHasArabic: true), all);
    expect(tvLangChoices(all, boxHasArabic: false), ['auto', 'ms', 'en']);
    expect(tvLangChoices(all, boxHasArabic: false, current: 'ar'), all);
  });

  test('bidiIsolate wraps once and bidiStrip takes it off', () {
    expect(bidiIsolate('قناة'), '\u2068قناة\u2069');
    expect(bidiIsolate(bidiIsolate('abc')), '\u2068abc\u2069');
    expect(bidiIsolate(''), '');
    expect(bidiStrip(bidiIsolate('abc')), 'abc');
  });

  test('bidiIsolate removes embeddings, overrides and isolates from the inside and always wraps', () {
    expect(bidiIsolate('a\u2069b\u202Ec\u2066d'), '\u2068abcd\u2069');
    expect(bidiIsolate('\u2068\u062A\u062B'), '\u2068\u062A\u062B\u2069');
    expect(bidiIsolate('\u202E\u2069'), '');
    expect(bidiStrip(bidiIsolate('\u202Eabc')), 'abc');
  });

  group('the setting', () {
    testWidgets('a current box offers all four, in BM; Arabic saves ar', (tester) async {
      final h = await _open(tester);
      expect(find.text('Bahasa skrin TV'), findsWidgets);
      expect(find.text('Kemas kini MAXCOM untuk Bahasa Arab'), findsNothing);
      await expectGoldens(tester, h.app, 'tv_lang_setting');
      await tester.tap(k('setting-lang'));
      await settle(tester);
      for (final label in ['Automatik', 'Bahasa Melayu', 'English', 'العربية']) {
        expect(find.text(label), findsWidgets, reason: label);
      }
      await tester.tap(find.text('العربية').last);
      await settle(tester);
      await tester.tap(find.text('Simpan'));
      await settle(tester);
      expect(_languagePuts(h), [
        {'lang': 'ar'},
      ]);
    });

    testWidgets('the labels read in English and in Arabic', (tester) async {
      final h = await _open(tester);
      await h.container.read(appLangProvider.notifier).set(AppLang.en);
      await settle(tester);
      expect(find.text('TV screen language'), findsWidgets);
      await tester.tap(k('setting-lang'));
      await settle(tester);
      for (final label in ['Automatic', 'Bahasa Melayu', 'English', 'العربية']) {
        expect(find.text(label), findsWidgets, reason: label);
      }
      await tester.tapAt(const Offset(5, 5));
      await settle(tester);
      await h.container.read(appLangProvider.notifier).set(AppLang.ar);
      // the language is changed from another page: open this one again so the menu reads its value in Arabic
      h.router.go('/settings');
      await settle(tester);
      h.router.go('/settings/language');
      await settle(tester);
      expect(find.text('لغة شاشة التلفاز'), findsWidgets);
      expect(find.text('تلقائي'), findsOneWidget);
      await expectGoldens(tester, h.app, 'tv_lang_setting_ar');
    });

    testWidgets('an older box: no Arabic choice and the short note', (tester) async {
      final h = await _open(tester, arabicBox: false);
      expect(find.text('Kemas kini MAXCOM untuk Bahasa Arab'), findsOneWidget);
      expect(find.byType(SegmentedButton<String>), findsOneWidget, reason: 'three choices side by side');
      expect(find.text('العربية'), findsNothing);
      await expectGoldens(tester, h.app, 'tv_lang_setting_older_box');
    });

    testWidgets('a box that answers 400 for ar names the update, in the app language', (tester) async {
      final h = await _open(tester);
      h.handlers['PUT /api/settings/language'] = (r) async => jsonResponse(400, {
        'errors': ['language.lang must be one of auto, ms, en'],
      });
      await tester.tap(k('setting-lang'));
      await settle(tester);
      await tester.tap(find.text('العربية').last);
      await settle(tester);
      await tester.tap(find.text('Simpan'));
      await settle(tester);
      expect(find.text('Kemas kini MAXCOM untuk Bahasa Arab'), findsWidgets);
    });
  });

  group('first in Konfigurasi', () {
    testWidgets('the row opens the setting, a search still finds it, and Skrin no longer lists it', (tester) async {
      final h = await _open(tester, route: '/settings');
      expect(k('settings-pinned'), findsOneWidget);
      await tester.enterText(k('settings-search'), 'bahasa');
      await settle(tester);
      expect(k('settings-row-language'), findsOneWidget);
      await tester.tap(k('settings-row-language'));
      await settle(tester);
      expect(h.location, '/settings/language');
      h.router.go('/settings');
      await settle(tester);
      if (k('settings-search-clear').evaluate().isNotEmpty) {
        await tester.tap(k('settings-search-clear'));
        await settle(tester);
      }
      await reveal(tester, k('settings-group-skrin'));
      await tester.tap(k('settings-group-skrin'));
      await settle(tester);
      expect(k('settings-row-language'), findsOneWidget, reason: 'drawn once, in the pinned card');
      expect(find.descendant(of: k('settings-pinned'), matching: k('settings-row-language')), findsOneWidget);
    });
  });

  group('Arabic Art asks once', () {
    testWidgets('Tidak: nothing changes and the question never comes back', (tester) async {
      final h = await _open(tester, route: '/settings/templat');
      await _useArabicArt(tester);
      expect(k('tvlang-ar-ask'), findsOneWidget);
      expect(find.text('Tukar bahasa skrin TV ke Bahasa Arab?'), findsOneWidget);
      await expectGoldens(tester, h.app, 'tv_lang_ask');
      await tester.tap(k('tvlang-ar-ask-no'));
      await settle(tester);
      expect(_languagePuts(h), isEmpty);
      expect(find.text('Tema ditukar'), findsOneWidget);
      // the same choice again: no question
      await _useArabicArt(tester);
      expect(k('tvlang-ar-ask'), findsNothing);
      expect(_languagePuts(h), isEmpty);
    });

    testWidgets('Ya: the TV language is saved as ar, and the question never comes back', (tester) async {
      final h = await _open(tester, route: '/settings/templat');
      await _useArabicArt(tester);
      await tester.tap(k('tvlang-ar-ask-yes'));
      await settle(tester);
      expect(_languagePuts(h), [
        {'lang': 'ar'},
      ]);
      await _useArabicArt(tester);
      expect(k('tvlang-ar-ask'), findsNothing);
    });

    testWidgets('Ya that cannot be saved: the sheet stays open with the error, no success, and it is asked again', (tester) async {
      final h = await _open(tester, route: '/settings/templat');
      h.handlers['PUT /api/settings/language'] = (r) async => jsonResponse(400, {
        'errors': ['language.lang must be one of auto, ms, en'],
      });
      await _useArabicArt(tester);
      await tester.tap(k('tvlang-ar-ask-yes'));
      await settle(tester);
      expect(find.text('Tema ditukar'), findsNothing);
      expect(k('theme-use'), findsOneWidget, reason: 'the sheet is still open');
      expect(find.text('Kemas kini MAXCOM untuk Bahasa Arab'), findsWidgets);
      // the box is fixed: the same choice asks again, and now it works
      h.handlers.remove('PUT /api/settings/language');
      await tester.tap(k('theme-use'));
      await settle(tester);
      expect(k('tvlang-ar-ask'), findsOneWidget);
      await tester.tap(k('tvlang-ar-ask-yes'));
      await settle(tester);
      expect(find.text('Tema ditukar'), findsOneWidget);
      expect(_languagePuts(h).last, {'lang': 'ar'});
    });

    testWidgets('closing the question with back is not an answer: nothing saved, asked again next time', (tester) async {
      final h = await _open(tester, route: '/settings/templat');
      await _useArabicArt(tester);
      Navigator.of(tester.element(k('tvlang-ar-ask'))).pop();
      await settle(tester);
      expect(_languagePuts(h), isEmpty);
      h.settings['kioskTemplate'] = {'enabled': true, 'templateId': 'creative'};
      h.container.invalidate(settingsProvider);
      await settle(tester);
      await _useArabicArt(tester);
      expect(k('tvlang-ar-ask'), findsOneWidget);
    });

    testWidgets('not asked when the TV language is already Arabic', (tester) async {
      final h = await _open(tester, lang: 'ar', route: '/settings/templat');
      await _useArabicArt(tester);
      expect(k('tvlang-ar-ask'), findsNothing);
      expect(_languagePuts(h), isEmpty);
    });

    testWidgets('not asked for another theme', (tester) async {
      await _open(tester, route: '/settings/templat');
      await reveal(tester, k('theme-card-minimal'));
      await tester.tap(k('theme-card-minimal'));
      await settle(tester);
      await tester.tap(k('theme-use'));
      await settle(tester);
      expect(k('tvlang-ar-ask'), findsNothing);
    });

    testWidgets('not asked on an older box', (tester) async {
      final h = await _open(tester, arabicBox: false, route: '/settings/templat');
      await _useArabicArt(tester);
      expect(k('tvlang-ar-ask'), findsNothing);
      expect(_languagePuts(h), isEmpty);
    });

    testWidgets('the question reads in English', (tester) async {
      final h = await _open(tester, route: '/settings/templat');
      await h.container.read(appLangProvider.notifier).set(AppLang.en);
      await settle(tester);
      await _useArabicArt(tester);
      expect(find.text('Change the TV screen language to Arabic?'), findsOneWidget);
      expect(find.text('Yes'), findsOneWidget);
      expect(find.text('No'), findsOneWidget);
      await expectGoldens(tester, h.app, 'tv_lang_ask_en');
    });

    testWidgets('the question reads in Arabic', (tester) async {
      final h = await _open(tester, route: '/settings/templat');
      await h.container.read(appLangProvider.notifier).set(AppLang.ar);
      await settle(tester);
      await _useArabicArt(tester);
      expect(find.text('هل تريد تغيير لغة شاشة التلفاز إلى العربية؟'), findsOneWidget);
      await expectGoldens(tester, h.app, 'tv_lang_ask_ar');
    });
  });
}
