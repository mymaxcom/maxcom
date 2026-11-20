// Ubah suai: the theme message, the clocks of the editor, and the editor itself over a fake box: live preview of
// unsaved values, Simpan with the freshly loaded map, Guna untuk semua skrin, Set semula, badges, layouts, a refusal.
// Golden: theme_editor.

import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:surau_app/app/providers.dart';
import 'package:surau_app/content/preview_host.dart';
import 'package:surau_app/features/theme/theme_style.dart';
import 'package:surau_app/screens/preview_screen.dart';

import '../features/shell/harness.dart';
import '../golden_sizes.dart';
import 't9_fakes.dart';

Finder k(String key) => find.byKey(ValueKey(key));

const Map<String, Object?> themedHealth = {
  ...healthyJson,
  'themes': {
    'contract': 1,
    'builtIn': ['default', 'colourful', 'creative', 'oldschool', 'minimal'],
  },
};

Future<ShellHarness> open(
  WidgetTester tester, {
  List<String> roles = const ['admin'],
  GoldenSize size = GoldenSize.phone,
  Map<String, Object?> styles = const {},
  String theme = 'creative',
}) async {
  final h = await pumpShell(tester, roles: roles, health: themedHealth, size: size);
  h.settings['kioskTemplate'] = {'enabled': true, 'templateId': theme};
  h.settings['themeStyle'] = {'enabled': true, 'styles': styles, 'packs': <String, Object?>{}};
  h.handlers['GET /api/kiosk/bundle'] = (_) async => jsonResponse(200, t9Bundle());
  h.container.invalidate(settingsProvider);
  h.router.go('/settings/templat/$theme');
  await settle(tester);
  return h;
}

List<Object> puts(ShellHarness h) => [
  for (final r in h.box.seen)
    if (r.method == 'PUT' && r.url.path == '/api/settings/themeStyle') r,
];

Map<String, dynamic> body(Object r) => jsonDecode((r as dynamic).body as String) as Map<String, dynamic>;

PreviewThemeRequest lastTheme(ShellHarness h) => h.previewRequests.last.theme!;

void main() {
  group('pure parts', () {
    test('previewThemeMessage carries theme, screen and the unsaved entry', () {
      final m = previewThemeMessage(
        const PreviewThemeRequest(theme: 'creative', screen: 'kuliah', entry: ThemeStyleEntry(semua: {'shade': 20})),
      );
      expect(m, {
        'type': 'surau-preview-theme',
        'theme': 'creative',
        'screen': 'kuliah',
        'entry': {'semua': {'shade': 20}, 'skrin': <String, Object?>{}},
      });
    });

    test('the theme script posts to the page origin only, built with jsonEncode', () {
      final js = previewThemeMessageJs(
        const PreviewThemeRequest(theme: 'creative', screen: 'kuliah', entry: ThemeStyleEntry()),
        origin: 'https://10.168.0.154:8443',
      );
      expect(js, startsWith('if (location.origin === "https://10.168.0.154:8443")'));
      expect(js, contains('window.postMessage('));
      expect(js, contains(', location.origin);'));
      expect(js, contains('"type":"surau-preview-theme"'));
    });

    test('previewCalmNow is 10:30 of the bundle day in the surau offset', () {
      final bundle = t9Bundle().cast<String, dynamic>();
      expect(formatKl(previewCalmNow(bundle)), '2026-11-03T10:30:00+08:00');
      expect(formatKl(previewCalmNow(bundle, utcOffsetMinutes: 180), utcOffsetMinutes: 180), '2026-11-03T10:30:00+03:00');
    });

    test('masukWaktu for the fixture is five seconds into the masuk waktu screen', () {
      final bundle = t9Bundle().cast<String, dynamic>();
      final now = previewNowFor(PreviewPhase.masukWaktu, bundle)!;
      expect(formatKl(now), '2026-11-03T16:20:05+08:00');
    });

    test('the editor screens are the nineteen of the plan, in order', () {
      expect(themeEditorScreens, [
        'biasa', 'azan', 'masuk-waktu', 'iqamah', 'solat', 'jumaat', 'live', 'poster', 'kuliah', 'program',
        'hadis', 'zikir', 'pengumuman', 'takwim', 'tabung', 'ayat', 'arab-ayat', 'arab-zikir', 'arab-hadis',
      ]);
    });
  });

  testWidgets('changing a control re-posts to the preview and saves nothing', (tester) async {
    final h = await open(tester);
    await tester.ensureVisible(k('theme-screen-kuliah'));
    await tester.pump();
    await tester.tap(k('theme-screen-kuliah'));
    await settle(tester);
    expect(lastTheme(h).screen, 'kuliah');
    tester.widget<Slider>(k('ctl-shade')).onChanged!(20);
    await settle(tester);
    expect(lastTheme(h).entry.skrin['kuliah'], {'shade': 20});
    expect(lastTheme(h).theme, 'creative');
    expect(puts(h), isEmpty);
    expect(find.text('Diubah'), findsWidgets);
    expect(tester.widget<ChoiceChip>(k('theme-screen-kuliah')).avatar, isNotNull, reason: 'the gold dot');
    expect(tester.widget<ChoiceChip>(k('theme-screen-hadis')).avatar, isNull);
  });

  testWidgets('Simpan sends only this theme, whatever another admin saved on another theme', (tester) async {
    final h = await open(tester, styles: {
      'minimal': {'semua': {'shade': 5}, 'skrin': <String, Object?>{}},
    });
    // While the editor is open another admin changes minimal.
    h.settings['themeStyle'] = {
      'enabled': true,
      'packs': <String, Object?>{},
      'styles': {
        'minimal': {'semua': {'shade': 70}, 'skrin': <String, Object?>{}},
      },
    };
    await tester.ensureVisible(k('theme-screen-kuliah'));
    await tester.pump();
    await tester.tap(k('theme-screen-kuliah'));
    await settle(tester);
    tester.widget<Slider>(k('ctl-shade')).onChanged!(30);
    await settle(tester);
    await reveal(tester, k('theme-save'));
    await tester.tap(k('theme-save'));
    await settle(tester);
    expect(puts(h), hasLength(1));
    expect(body(puts(h).single), {
      'styles': {
        'creative': {
          'semua': <String, Object?>{},
          'skrin': {'kuliah': {'shade': 30}},
        },
      },
    });
    expect(find.text('Gaya tema disimpan'), findsOneWidget);
  });

  testWidgets('Simpan from a cached read sends nothing and says so', (tester) async {
    final h = await open(tester);
    await tester.ensureVisible(k('theme-screen-kuliah'));
    await tester.pump();
    await tester.tap(k('theme-screen-kuliah'));
    await settle(tester);
    tester.widget<Slider>(k('ctl-shade')).onChanged!(30);
    await settle(tester);
    // The box goes away: the gateway answers the settings from its cache, marked stale.
    h.boxAway = true;
    await reveal(tester, k('theme-save'));
    await tester.tap(k('theme-save'));
    await settle(tester);
    expect(puts(h), isEmpty);
    await reveal(tester, k('theme-save'));
    expect(find.text('Tidak dapat memuatkan nilai terkini. Tiada yang disimpan. Cuba lagi.', skipOffstage: false), findsOneWidget);
    expect(tester.widget<FilledButton>(k('theme-save')).onPressed, isNotNull, reason: 'the edits are kept');
  });

  testWidgets('a value equal to the theme default is still written; Ikut tema removes it', (tester) async {
    final h = await open(tester);
    await tester.ensureVisible(k('theme-screen-kuliah'));
    await tester.pump();
    await tester.tap(k('theme-screen-kuliah'));
    await settle(tester);
    await reveal(tester, k('ctl-font-jakarta'));
    await tester.tap(k('ctl-font-jakarta'));
    await settle(tester);
    await reveal(tester, k('ctl-scale-S'));
    await tester.tap(k('ctl-scale-S'));
    await settle(tester);
    await reveal(tester, k('ctl-align-kiri'));
    await tester.tap(k('ctl-align-kiri'));
    await settle(tester);
    expect(lastTheme(h).entry.skrin['kuliah'], {'font': 'jakarta', 'scale': 'S', 'align': 'kiri'});
    expect(tester.widget<ChoiceChip>(k('ctl-align-follow')).selected, isFalse);
    await tester.tap(k('ctl-align-follow'));
    await settle(tester);
    await reveal(tester, k('ctl-font-follow'));
    await tester.tap(k('ctl-font-follow'));
    await settle(tester);
    expect(lastTheme(h).entry.skrin['kuliah'], {'scale': 'S'});
    expect(tester.widget<ChoiceChip>(k('ctl-align-follow')).selected, isTrue);
  });

  testWidgets('the layer darkness slider shows the theme default until the surau sets one', (tester) async {
    await open(tester);
    expect(tester.widget<Slider>(k('ctl-shade')).value, 35);
    expect(tester.widget<ChoiceChip>(k('ctl-shade-follow')).selected, isTrue);
    tester.widget<Slider>(k('ctl-shade')).onChanged!(50);
    await settle(tester);
    expect(tester.widget<Slider>(k('ctl-shade')).value, 50);
    expect(tester.widget<ChoiceChip>(k('ctl-shade-follow')).selected, isFalse);
    await reveal(tester, k('ctl-shade-follow'));
    await tester.tap(k('ctl-shade-follow'));
    await settle(tester);
    expect(tester.widget<Slider>(k('ctl-shade')).value, 35);
  });

  testWidgets('Guna untuk semua skrin then Simpan: semua filled, skrin empty', (tester) async {
    final h = await open(tester);
    await tester.ensureVisible(k('theme-screen-kuliah'));
    await tester.pump();
    await tester.tap(k('theme-screen-kuliah'));
    await settle(tester);
    tester.widget<Slider>(k('ctl-shade')).onChanged!(40);
    await settle(tester);
    await reveal(tester, k('theme-apply-all'));
    await tester.tap(k('theme-apply-all'));
    await settle(tester);
    expect(find.text('Guna rupa skrin ini untuk semua skrin tema Creative?'), findsOneWidget);
    await tester.tap(k('confirm-yes'));
    await settle(tester);
    expect(lastTheme(h).entry.semua, {'shade': 40});
    expect(lastTheme(h).entry.skrin, isEmpty);
    await reveal(tester, k('theme-save'));
    await tester.tap(k('theme-save'));
    await settle(tester);
    expect(body(puts(h).single), {
      'styles': {
        'creative': {'semua': {'shade': 40}, 'skrin': <String, Object?>{}},
      },
    });
  });

  testWidgets('Guna untuk semua skrin names the other screens whose own choices it deletes, and Batal keeps them', (tester) async {
    final h = await open(tester, styles: {
      'creative': {
        'semua': <String, Object?>{},
        'skrin': {'kuliah': {'shade': 20}, 'hadis': {'scale': 'L'}, 'ayat': {'align': 'kiri'}},
      },
    });
    await tester.ensureVisible(k('theme-screen-kuliah'));
    await tester.pump();
    await tester.tap(k('theme-screen-kuliah'));
    await settle(tester);
    await reveal(tester, k('theme-apply-all'));
    await tester.tap(k('theme-apply-all'));
    await settle(tester);
    expect(find.textContaining('Pilihan sendiri bagi 2 skrin lain akan dipadam'), findsOneWidget);
    await tester.tap(k('confirm-no'));
    await settle(tester);
    expect(lastTheme(h).entry.skrin.keys, containsAll(['kuliah', 'hadis', 'ayat']), reason: 'cancelled: nothing changed');
    await tester.tap(k('theme-apply-all'));
    await settle(tester);
    await tester.tap(k('confirm-yes'));
    await settle(tester);
    expect(lastTheme(h).entry.semua, {'shade': 20});
    expect(lastTheme(h).entry.skrin, isEmpty);
  });

  testWidgets("Set semula removes only this screen's values; Simpan sends the rest of this theme", (tester) async {
    final h = await open(tester, styles: {
      'creative': {
        'semua': {'align': 'kanan'},
        'skrin': {'kuliah': {'align': 'kiri', 'shade': 20}, 'hadis': {'scale': 'L'}},
      },
      'minimal': {'semua': {'shade': 5}, 'skrin': <String, Object?>{}},
    });
    await tester.ensureVisible(k('theme-screen-kuliah'));
    await tester.pump();
    await tester.tap(k('theme-screen-kuliah'));
    await settle(tester);
    expect(tester.widget<ChoiceChip>(k('ctl-align-kiri')).selected, isTrue);
    await reveal(tester, k('theme-reset'));
    await tester.tap(k('theme-reset'));
    await settle(tester);
    expect(find.text('Kembali kepada rupa tema bagi skrin Kuliah?'), findsOneWidget);
    await tester.tap(k('confirm-yes'));
    await settle(tester);
    expect(lastTheme(h).entry.skrin.keys, ['hadis']);
    expect(lastTheme(h).entry.semua, {'align': 'kanan'});
    expect(tester.widget<ChoiceChip>(k('ctl-align-kanan')).selected, isTrue, reason: 'now inherited from all screens');
    await reveal(tester, k('theme-save'));
    await tester.tap(k('theme-save'));
    await settle(tester);
    expect(body(puts(h).single), {
      'styles': {
        'creative': {
          'semua': {'align': 'kanan'},
          'skrin': {'hadis': {'scale': 'L'}},
        },
      },
    });
  });

  testWidgets('Set semula semua skrin sends an empty entry for this theme only', (tester) async {
    final h = await open(tester, styles: {
      'creative': {'semua': {'shade': 20}, 'skrin': <String, Object?>{}},
      'minimal': {'semua': {'shade': 5}, 'skrin': <String, Object?>{}},
    });
    await reveal(tester, k('theme-reset-all'));
    await tester.tap(k('theme-reset-all'));
    await settle(tester);
    expect(find.text('Kembali kepada rupa asal tema Creative?'), findsOneWidget);
    await tester.tap(k('confirm-yes'));
    await settle(tester);
    expect(lastTheme(h).entry.isEmpty, isTrue);
    await reveal(tester, k('theme-save'));
    await tester.tap(k('theme-save'));
    await settle(tester);
    expect(body(puts(h).single), {
      'styles': {
        'creative': {'semua': <String, Object?>{}, 'skrin': <String, Object?>{}},
      },
    });
  });

  testWidgets('a content screen pins the calm clock; Iqamah pins the iqamah clock', (tester) async {
    final h = await open(tester);
    await tester.ensureVisible(k('theme-screen-hadis'));
    await tester.pump();
    await tester.tap(k('theme-screen-hadis'));
    await settle(tester);
    expect(formatKl(h.previewRequests.last.now!), '2026-11-03T10:30:00+08:00');
    await tester.ensureVisible(k('theme-screen-iqamah'));
    await tester.pump();
    await tester.tap(k('theme-screen-iqamah'));
    await settle(tester);
    expect(formatKl(h.previewRequests.last.now!), '2026-11-03T16:25:00+08:00');
    await tester.ensureVisible(k('theme-screen-masuk-waktu'));
    await tester.pump();
    await tester.tap(k('theme-screen-masuk-waktu'));
    await settle(tester);
    expect(formatKl(h.previewRequests.last.now!), '2026-11-03T16:20:05+08:00');
  });

  testWidgets('iPad width: list and preview left, controls right', (tester) async {
    await open(tester, size: GoldenSize.ipadMiniLandscape);
    expect(k('theme-editor-wide'), findsOneWidget);
    expect(find.text('Waktu solat'), findsOneWidget);
    expect(find.text('Kandungan'), findsWidgets);
    expect(k('theme-save'), findsWidgets);
  });

  testWidgets('phone width: preview on top, chips, controls below', (tester) async {
    await open(tester);
    expect(k('theme-editor-narrow'), findsOneWidget);
    expect(k('theme-screen-kuliah'), findsOneWidget);
  });

  testWidgets('the box refuses (400): message shown, edits kept', (tester) async {
    final h = await open(tester);
    h.handlers['PUT /api/settings/themeStyle'] = (_) async => jsonResponse(400, {
      'errors': ['styles.creative.semua.shade must be an integer 0..80'],
    });
    await reveal(tester, k('ctl-shade'));
    tester.widget<Slider>(k('ctl-shade')).onChanged!(30);
    await settle(tester);
    await reveal(tester, k('theme-save'));
    await tester.tap(k('theme-save'));
    await settle(tester);
    expect(find.text('styles.creative.semua.shade must be an integer 0..80'), findsOneWidget);
    expect(lastTheme(h).entry.skrin['biasa'], {'shade': 30});
    await reveal(tester, k('theme-save'));
    expect(tester.widget<FilledButton>(k('theme-save')).onPressed, isNotNull, reason: 'the edits are kept, Simpan stays on');
  });

  testWidgets('golden: theme_editor', (tester) async {
    final h = await open(tester, styles: {
      'creative': {
        'semua': {'accent': '#f9b544'},
        'skrin': {'kuliah': {'shade': 40, 'scale': 'L'}},
      },
    });
    await tester.ensureVisible(k('theme-screen-kuliah'));
    await tester.pump();
    await tester.tap(k('theme-screen-kuliah'));
    await settle(tester);
    await expectGoldens(tester, h.app, 'theme_editor');
  });
}
