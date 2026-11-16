// Ubah suai, the Arabic screens and Tulisan Arab: the three Arabic-led screens in their own group, the controls of the
// Arabic text (face with a sample, size, mark colour, line spacing, translation place) and the rules that tie them to
// the font and to Tetapan. Golden: theme_editor_arab.

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:surau_app/app/providers.dart';
import 'package:surau_app/content/preview_host.dart';
import 'package:surau_app/features/registry.g.dart' show accentSwatches;
import 'package:surau_app/features/theme/theme_providers.dart';
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
    'builtIn': ['default', 'colourful', 'creative', 'oldschool', 'minimal', 'arabic'],
  },
};

Future<ShellHarness> open(
  WidgetTester tester, {
  GoldenSize size = GoldenSize.phone,
  Map<String, Object?> styles = const {},
  Map<String, Object?> packs = const {},
  String theme = 'creative',
}) async {
  final h = await pumpShell(tester, roles: const ['admin'], health: themedHealth, size: size);
  h.settings['kioskTemplate'] = {'enabled': true, 'templateId': theme};
  h.settings['themeStyle'] = {'enabled': true, 'styles': styles, 'packs': packs};
  h.handlers['GET /api/kiosk/bundle'] = (_) async => jsonResponse(200, t9Bundle());
  h.container.invalidate(settingsProvider);
  h.router.go('/settings/templat/$theme');
  await settle(tester);
  return h;
}

PreviewThemeRequest lastTheme(ShellHarness h) => h.previewRequests.last.theme!;

Future<void> pick(WidgetTester tester, String screen) async {
  await reveal(tester, k('theme-screen-$screen'));
  await tester.tap(k('theme-screen-$screen'));
  await settle(tester);
}

void main() {
  test('harakatAllowed', () {
    expect(harakatAllowed({'arFont': 'amiri'}), isTrue);
    expect(harakatAllowed({'arFont': 'amiri-quran'}), isTrue);
    expect(harakatAllowed({'arFont': 'hafs'}), isFalse);
    expect(harakatAllowed({}), isFalse);
  });

  test('the editor lists the three Arabic screens last; Arabic Art starts from Uthmani Hafs', () {
    expect(themeEditorScreens.sublist(themeEditorScreens.length - 3), ['arab-ayat', 'arab-zikir', 'arab-hadis']);
    expect(themeDefaultsOf('arabic').semua, {'arFont': 'hafs', 'goldOutline': 'on'});
  });

  test('arabLooksOn: Arabic Art and a pack with an arab-* screen file', () {
    expect(arabLooksOn(const {}, 'arabic'), isTrue);
    expect(arabLooksOn(const {}, 'creative'), isFalse);
    final settings = <String, dynamic>{
      'themeStyle': {
        'packs': {
          'hijau': {'screens': ['poster', 'arab-zikir']},
          'biru': {'screens': ['poster']},
        },
      },
    };
    expect(arabLooksOn(settings, 'hijau'), isTrue);
    expect(arabLooksOn(settings, 'biru'), isFalse);
  });

  testWidgets('the Arab group lists three screens; choosing one previews screen arab-ayat', (tester) async {
    final h = await open(tester);
    await pick(tester, 'arab-ayat');
    expect(lastTheme(h).screen, 'arab-ayat');
    expect(find.text('Ayat Arab'), findsWidgets);
    await pick(tester, 'arab-zikir');
    expect(lastTheme(h).screen, 'arab-zikir');
    await pick(tester, 'arab-hadis');
    expect(lastTheme(h).screen, 'arab-hadis');
  });

  testWidgets('a theme whose looks are off says so on an Arabic screen; Arabic Art does not', (tester) async {
    await open(tester);
    await pick(tester, 'arab-ayat');
    await reveal(tester, k('ctl-arab-looks-off'));
    expect(find.textContaining('rupa biasa'), findsOneWidget);
  });

  testWidgets('Arabic Art: no looks-off note', (tester) async {
    await open(tester, theme: 'arabic');
    await pick(tester, 'arab-ayat');
    await reveal(tester, k('ctl-arab-title'));
    expect(k('ctl-arab-looks-off'), findsNothing);
  });

  testWidgets('Warna baris is disabled with the note under Uthmani Hafs and enabled under Amiri Quran', (tester) async {
    final h = await open(tester, theme: 'arabic');
    await pick(tester, 'arab-ayat');
    await reveal(tester, k('ctl-harakat-follow'));
    expect(find.text('Warna baris memerlukan fon Amiri Quran atau Amiri. Uthmani Hafs dipapar dalam satu warna.'), findsOneWidget);
    expect(tester.widget<ChoiceChip>(k('ctl-harakat-follow')).onSelected, isNull);
    await reveal(tester, k('ctl-arfont-amiri-quran'));
    await tester.tap(k('ctl-arfont-amiri-quran'));
    await settle(tester);
    expect(lastTheme(h).entry.skrin['arab-ayat'], {'arFont': 'amiri-quran'});
    await reveal(tester, k('ctl-harakat-follow'));
    expect(find.textContaining('Warna baris memerlukan'), findsNothing);
    expect(tester.widget<ChoiceChip>(k('ctl-harakat-follow')).onSelected, isNotNull);
    final swatch = accentSwatches.first;
    await reveal(tester, k('ctl-harakat-$swatch'));
    await tester.tap(k('ctl-harakat-$swatch'));
    await settle(tester);
    expect(lastTheme(h).entry.skrin['arab-ayat'], {'arFont': 'amiri-quran', 'harakat': swatch});
  });

  testWidgets('a stored harakat colour stays (dormant) when the font goes back to Uthmani Hafs', (tester) async {
    final h = await open(
      tester,
      theme: 'arabic',
      styles: {
        'arabic': {
          'semua': {'arFont': 'amiri', 'harakat': '#d9b25f'},
          'skrin': <String, Object?>{},
        },
      },
    );
    await pick(tester, 'arab-ayat');
    await reveal(tester, k('ctl-arfont-hafs'));
    await tester.tap(k('ctl-arfont-hafs'));
    await settle(tester);
    expect(lastTheme(h).entry.semua['harakat'], '#d9b25f');
    expect(lastTheme(h).entry.skrin['arab-ayat'], {'arFont': 'hafs'});
    await reveal(tester, k('ctl-harakat-follow'));
    expect(tester.widget<ChoiceChip>(k('ctl-harakat-follow')).onSelected, isNull);
  });

  testWidgets('Saiz Arab 120 and Jarak baris 1.9 are stored as 120 and 19', (tester) async {
    final h = await open(tester, theme: 'arabic');
    await pick(tester, 'arab-ayat');
    await reveal(tester, k('ctl-arscale'));
    tester.widget<Slider>(k('ctl-arscale')).onChanged!(120);
    await settle(tester);
    await reveal(tester, k('ctl-arlh'));
    tester.widget<Slider>(k('ctl-arlh')).onChanged!(19);
    await settle(tester);
    expect(lastTheme(h).entry.skrin['arab-ayat'], {'arScale': 120, 'arLineHeight': 19});
    expect(find.text('120%'), findsWidgets);
    expect(find.text('1.9'), findsWidgets);
    // the ends of the sliders are labelled
    for (final t in ['Kecil', 'Besar', 'Rapat', 'Luas']) {
      expect(find.text(t), findsOneWidget, reason: t);
    }
  });

  testWidgets('Fon Arab offers three faces with the sample', (tester) async {
    await open(tester, theme: 'arabic');
    await pick(tester, 'arab-ayat');
    await reveal(tester, k('ctl-arfont-hafs'));
    for (final id in ['hafs', 'amiri-quran', 'amiri']) {
      expect(k('ctl-arfont-$id'), findsOneWidget, reason: id);
    }
    expect(find.text('ٱلْحَمْدُ لِلَّهِ'), findsNWidgets(3));
    expect(find.text('Uthmani Hafs'), findsOneWidget);
  });

  testWidgets('Terjemahan only places the translation (no Sembunyi): Tetapan alone decides whether it shows', (tester) async {
    await open(tester, theme: 'arabic');
    await pick(tester, 'arab-ayat');
    await reveal(tester, k('ctl-tarjamah-bawah'));
    expect(k('ctl-tarjamah-sisi'), findsOneWidget);
    expect(k('ctl-tarjamah-sembunyi'), findsNothing);
    expect(find.textContaining('Tetapan menentukan'), findsOneWidget);
    // Elsewhere the translation always sits below: nothing to choose, so nothing is offered.
    await pick(tester, 'ayat');
    expect(k('ctl-tarjamah-bawah'), findsNothing);
    expect(find.textContaining('Tetapan menentukan'), findsNothing);
    expect(k('ctl-tarjamah-sembunyi'), findsNothing);
  });

  group('an option is offered only on the screens where it acts', () {
    Future<void> hasArab(WidgetTester tester, String screen, {required bool harakat, required bool hafs, required bool side}) async {
      await pick(tester, screen);
      await reveal(tester, k('ctl-arab-title'));
      expect(k('ctl-harakat-follow'), harakat ? findsOneWidget : findsNothing, reason: '$screen Warna baris');
      expect(k('ctl-arfont-hafs'), hafs ? findsOneWidget : findsNothing, reason: '$screen Uthmani Hafs');
      expect(k('ctl-tarjamah-bawah'), side ? findsOneWidget : findsNothing, reason: '$screen Terjemahan');
      expect(k('ctl-arfont-amiri'), findsOneWidget, reason: '$screen Amiri');
    }

    testWidgets('Warna baris, Uthmani Hafs and Terjemahan per screen', (tester) async {
      await open(tester, theme: 'arabic');
      await hasArab(tester, 'ayat', harakat: false, hafs: true, side: false);
      await hasArab(tester, 'zikir', harakat: false, hafs: false, side: false);
      await hasArab(tester, 'hadis', harakat: true, hafs: false, side: false);
      await hasArab(tester, 'arab-ayat', harakat: true, hafs: true, side: true);
      await hasArab(tester, 'arab-hadis', harakat: true, hafs: false, side: true);
      await hasArab(tester, 'arab-zikir', harakat: true, hafs: false, side: false);
    });

    testWidgets('Saiz teks and Jajaran are not offered where they do nothing', (tester) async {
      await open(tester, theme: 'creative');
      for (final screen in ['biasa', 'live', 'poster']) {
        await pick(tester, screen);
        expect(k('ctl-scale-S'), findsNothing, reason: '$screen Saiz teks');
      }
      for (final screen in ['biasa', 'azan', 'masuk-waktu', 'iqamah', 'solat', 'jumaat', 'live', 'poster', 'takwim']) {
        await pick(tester, screen);
        expect(k('ctl-align-kiri'), findsNothing, reason: '$screen Jajaran');
      }
      for (final screen in ['kuliah', 'hadis', 'ayat', 'zikir', 'pengumuman']) {
        await pick(tester, screen);
        await reveal(tester, k('ctl-scale-S'));
        expect(k('ctl-scale-S'), findsOneWidget, reason: '$screen Saiz teks');
        await reveal(tester, k('ctl-align-kiri'));
        expect(k('ctl-align-kiri'), findsOneWidget, reason: '$screen Jajaran');
      }
    });

    testWidgets('an uploaded theme has no font of its own to choose', (tester) async {
      await open(tester, theme: 'mypack', packs: {
        'mypack': {'title': 'Tema saya', 'version': 1, 'contract': 1, 'base': 'default', 'screens': <String>[], 'fonts': ['myfont']},
      });
      await pick(tester, 'kuliah');
      await reveal(tester, k('ctl-font-amiri'));
      expect(k('ctl-font-myfont'), findsNothing);
    });
  });

  for (final base in ['default', 'oldschool', 'arabic', 'creative']) {
    testWidgets('Garis emas pada tajuk for an uploaded theme made on $base follows the base', (tester) async {
      await open(tester, theme: 'mypack', packs: {
        'mypack': {'title': 'Tema saya', 'version': 1, 'contract': 1, 'base': base, 'screens': <String>[]},
      });
      await pick(tester, 'kuliah');
      await reveal(tester, k('ctl-font-follow'));
      if (base == 'creative') {
        expect(k('ctl-gold-on'), findsNothing);
      } else {
        await reveal(tester, k('ctl-gold-off'));
        expect(k('ctl-gold-on'), findsOneWidget);
      }
    });
  }

  testWidgets('an uploaded theme made on Arabic Art shows its Arabic screens as in use', (tester) async {
    await open(tester, theme: 'mypack', packs: {
      'mypack': {'title': 'Tema saya', 'version': 1, 'contract': 1, 'base': 'arabic', 'screens': <String>[]},
    });
    await pick(tester, 'arab-ayat');
    await reveal(tester, k('ctl-arab-title'));
    expect(k('ctl-arab-looks-off'), findsNothing);
  });

  for (final t in ['default', 'oldschool', 'arabic']) {
    testWidgets('Garis emas pada tajuk is offered in $t (on by the theme) and saved per screen', (tester) async {
      final h = await open(tester, theme: t);
      await pick(tester, 'kuliah');
      await reveal(tester, k('ctl-gold-off'));
      expect(k('ctl-gold-on'), findsOneWidget);
      expect(find.text('Garis emas pada tajuk'), findsOneWidget);
      await tester.tap(k('ctl-gold-off'));
      await settle(tester);
      expect(lastTheme(h).entry.skrin['kuliah'], {'goldOutline': 'off'});
    });
  }
  for (final t in ['colourful', 'creative', 'minimal']) {
    testWidgets('Garis emas pada tajuk is not offered in $t (it draws nothing there)', (tester) async {
      await open(tester, theme: t);
      await pick(tester, 'kuliah');
      expect(k('ctl-gold-on'), findsNothing);
      expect(find.text('Garis emas pada tajuk'), findsNothing);
    });
  }

  testWidgets('Tulisan Arab does not appear on Kuliah', (tester) async {
    await open(tester);
    await pick(tester, 'kuliah');
    expect(k('ctl-arab-title'), findsNothing);
    expect(k('ctl-arscale'), findsNothing);
    await pick(tester, 'ayat');
    await reveal(tester, k('ctl-arab-title'));
    expect(k('ctl-arab-title'), findsOneWidget);
  });

  testWidgets('the Arabic controls on a wide screen', (tester) async {
    await open(tester, size: GoldenSize.ipadMiniLandscape, theme: 'arabic');
    await pick(tester, 'arab-ayat');
    await reveal(tester, k('ctl-arscale'));
    expect(k('ctl-arab-title'), findsOneWidget);
  });

  testWidgets('golden', (tester) async {
    final h = await open(tester, theme: 'arabic');
    await pick(tester, 'arab-ayat');
    await reveal(tester, k('ctl-arab-title'));
    await expectGoldens(tester, h.app, 'theme_editor_arab');
  });
}
