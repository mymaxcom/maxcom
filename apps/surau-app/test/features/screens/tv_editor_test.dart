// "Tetapan TV ini": the choices of one TV. A choice either follows the surau or is this TV's own; a save sends the
// entry of THAT TV only (`PUT /api/settings/tvProfiles` with `{tvs: {<tvId>: {...}}}`). Goldens: the editor in BM,
// English and Arabic.

import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:surau_app/app/app_lang.dart';
import 'package:surau_app/app/providers.dart';
import 'package:surau_app/features/live/fake_publisher.dart';
import 'package:surau_app/features/live/live_screen.dart' show livePublisherProvider;
import 'package:surau_app/features/screens/tv_profile.dart';

import '../../golden_sizes.dart';
import '../fakes.dart';
import '../shell/harness.dart';
import 'screens_list_test.dart' show boxesJson, device;

/// The saved choices of two TVs: the main box's own and Ruang Muslimat's.
Map<String, Object?> savedProfiles() => {
  'enabled': true,
  'tvs': {
    'self': {
      'templateId': 'minimal',
      'sounds': {'azan': true},
    },
    'dev-b2': {
      'name': 'Ruang Muslimat',
      'templateId': 'colourful',
      'lang': 'ar',
      'live': {'show': false, 'volume': 40},
      'hideKinds': ['tabung'],
      'sounds': {'azan': false},
    },
  },
};

Future<ShellHarness> openEditor(
  WidgetTester tester,
  String tvId, {
  AppLang lang = AppLang.ms,
  Map<String, Object?>? profiles,
  List<Map<String, Object?>>? puts,
}) async {
  final h = await pumpShell(
    tester,
    roles: const ['admin'],
    overrides: [
      appLangStoreProvider.overrideWithValue(MemoryAppLangStore(lang)),
      livePublisherProvider.overrideWithValue(FakePublisher()),
      appLockProvider.overrideWithValue(false),
    ],
  );
  h.settings['tvProfiles'] = profiles ?? savedProfiles();
  h.settings['liveOnKiosk'] = {'enabled': true, 'volume': 70};
  h.container.invalidate(settingsProvider);
  h.devices = [device('dev-b2', 'Ruang Muslimat', 'kiosk'), device('dev-b3', 'Foyer', 'kiosk')];
  h.handlers['GET /api/boxes'] = (r) async => jsonResponse(200, boxesJson());
  h.handlers['PUT /api/settings/tvProfiles'] = (r) async {
    final patch = jsonDecode(r.body) as Map<String, dynamic>;
    puts?.add(patch.cast<String, Object?>());
    final tvs = Map<String, Object?>.of(((h.settings['tvProfiles']! as Map)['tvs'] as Map).cast<String, Object?>());
    // as the box: every TV entry is replaced whole
    for (final e in (patch['tvs'] as Map).entries) {
      tvs[e.key as String] = e.value;
    }
    h.settings['tvProfiles'] = {'enabled': true, 'tvs': tvs};
    return jsonResponse(200, h.settings);
  };
  h.router.go('/screens/tv/$tvId');
  await settle(tester);
  return h;
}

Future<void> close(WidgetTester tester) async {
  await tester.pumpWidget(const SizedBox());
  await tester.pump(const Duration(milliseconds: 10));
}

Future<void> tapKey(WidgetTester tester, String key) async {
  final f = find.byKey(ValueKey(key));
  await reveal(tester, f);
  await tester.tap(f);
  await settle(tester);
}

/// Whether the chip is selected; the page is a lazy list, so the chip is brought into view first.
Future<bool> selected(WidgetTester tester, String key) async {
  await reveal(tester, find.byKey(ValueKey(key)));
  return tester.widget<ChoiceChip>(find.byKey(ValueKey(key))).selected;
}

Future<T> shown<T extends Widget>(WidgetTester tester, String key) async {
  await reveal(tester, find.byKey(ValueKey(key)));
  return tester.widget<T>(find.byKey(ValueKey(key)));
}

void main() {
  testWidgets('the saved entry of this TV, and nothing changed yet', (tester) async {
    await openEditor(tester, 'dev-b2');
    expect(find.text('Tetapan TV ini'), findsWidgets);
    expect(find.text('Untuk Ruang Muslimat sahaja. Yang lain ikut tetapan surau.'), findsOneWidget);
    expect(tester.widget<TextField>(find.byKey(const ValueKey('tv-ed-name'))).controller!.text, 'Ruang Muslimat');
    expect(await selected(tester, 'tv-ed-show-false'), isTrue);
    expect(await selected(tester, 'tv-ed-sound-follow'), isTrue, reason: 'no choice of its own: follows the surau');
    expect(find.text('Colourful'), findsOneWidget);
    expect(await selected(tester, 'tv-ed-lang-ar'), isTrue);
    expect((await shown<Slider>(tester, 'tv-ed-volume-slider')).value, 40);
    expect((await shown<FilterChip>(tester, 'tv-ed-hide-tabung')).selected, isTrue);
    expect((await shown<FilterChip>(tester, 'tv-ed-hide-video')).selected, isFalse);
    expect(await selected(tester, 'tv-ed-azan-false'), isTrue);
    expect(find.text('Diubah'), findsNothing);
    await reveal(tester, find.byKey(const ValueKey('tv-ed-save')));
    expect(tester.widget<FilledButton>(find.byKey(const ValueKey('tv-ed-save'))).onPressed, isNull, reason: 'nothing to save');
    await close(tester);
  });

  testWidgets('the main box\'s own TV is `self`', (tester) async {
    await openEditor(tester, 'self');
    expect(find.text('Minimal'), findsOneWidget);
    expect(await selected(tester, 'tv-ed-azan-true'), isTrue);
    await close(tester);
  });

  testWidgets('a save writes ONLY this TV\'s entry, whole, with the other TV left alone', (tester) async {
    final puts = <Map<String, Object?>>[];
    final h = await openEditor(tester, 'dev-b2', puts: puts);
    await tester.enterText(find.byKey(const ValueKey('tv-ed-name')), 'Ruang Muslimat Baru');
    await tester.pump();
    await tapKey(tester, 'tv-ed-sound-false');
    await tapKey(tester, 'tv-ed-lang-ms');
    await tapKey(tester, 'tv-ed-hide-video');
    await tapKey(tester, 'tv-ed-beeps-true');
    expect(find.text('Diubah'), findsWidgets);
    await tapKey(tester, 'tv-ed-save');
    expect(puts, hasLength(1));
    expect(puts.single, {
      'tvs': {
        'dev-b2': {
          'name': 'Ruang Muslimat Baru',
          'templateId': 'colourful',
          'lang': 'ms',
          'live': {'show': false, 'audio': false, 'volume': 40},
          'hideKinds': ['video', 'tabung'],
          'sounds': {'beeps': true, 'azan': false},
        },
      },
    });
    expect((puts.single['tvs']! as Map).containsKey('self'), isFalse);
    // the other TV's saved entry is untouched at the box
    expect((((h.settings['tvProfiles']! as Map)['tvs']! as Map)['self'] as Map)['templateId'], 'minimal');
    expect(find.text('Tetapan TV disimpan.'), findsOneWidget);
    await reveal(tester, find.byKey(const ValueKey('tv-ed-save')));
    expect(tester.widget<FilledButton>(find.byKey(const ValueKey('tv-ed-save'))).onPressed, isNull, reason: 'saved: no change left');
    await close(tester);
  });

  testWidgets('"Ikut surau" takes a choice out of the entry', (tester) async {
    final puts = <Map<String, Object?>>[];
    await openEditor(tester, 'dev-b2', puts: puts);
    await tapKey(tester, 'tv-ed-show-follow');
    await tapKey(tester, 'tv-ed-lang-follow');
    await tapKey(tester, 'tv-ed-volume-follow');
    await tapKey(tester, 'tv-ed-azan-follow');
    await tapKey(tester, 'tv-ed-save');
    final entry = ((puts.single['tvs']! as Map)['dev-b2']! as Map).cast<String, Object?>();
    expect(entry, {
      'name': 'Ruang Muslimat',
      'templateId': 'colourful',
      'hideKinds': ['tabung'],
    });
    await close(tester);
  });

  testWidgets('a TV with no entry: the name is the box\'s, an untouched name is not written, only what changed is', (tester) async {
    final puts = <Map<String, Object?>>[];
    await openEditor(tester, 'dev-b3', puts: puts);
    expect(tester.widget<TextField>(find.byKey(const ValueKey('tv-ed-name'))).controller!.text, 'Foyer');
    expect(await selected(tester, 'tv-ed-show-follow'), isTrue);
    expect(find.text('Ikut surau'), findsWidgets);
    await tapKey(tester, 'tv-ed-azan-false');
    await tapKey(tester, 'tv-ed-save');
    expect(puts.single, {
      'tvs': {
        'dev-b3': {
          'sounds': {'azan': false},
        },
      },
    });
    await close(tester);
  });

  testWidgets('the volume slider sets this TV\'s own volume', (tester) async {
    final puts = <Map<String, Object?>>[];
    await openEditor(tester, 'dev-b3', puts: puts);
    expect((await shown<Slider>(tester, 'tv-ed-volume-slider')).value, 70, reason: 'shows the surau value while it follows');
    final slider = find.byKey(const ValueKey('tv-ed-volume-slider'));
    await reveal(tester, slider);
    tester.widget<Slider>(slider).onChanged!(25);
    await settle(tester);
    await tapKey(tester, 'tv-ed-save');
    expect((((puts.single['tvs']! as Map)['dev-b3']! as Map)['live']), {'volume': 25});
    await close(tester);
  });

  testWidgets('the template is chosen from the surau\'s own themes, or follows the surau', (tester) async {
    final puts = <Map<String, Object?>>[];
    await openEditor(tester, 'dev-b2', puts: puts);
    await tapKey(tester, 'tv-ed-template');
    expect(find.text('Templat untuk TV ini'), findsOneWidget);
    await tester.tap(find.byKey(const ValueKey('tv-template-oldschool')));
    await settle(tester);
    expect(find.text('Old School'), findsOneWidget);
    await tapKey(tester, 'tv-ed-template');
    await tester.tap(find.byKey(const ValueKey('tv-template-follow')));
    await settle(tester);
    await tapKey(tester, 'tv-ed-save');
    expect((((puts.single['tvs']! as Map)['dev-b2']! as Map).containsKey('templateId')), isFalse);
    await close(tester);
  });

  testWidgets('fields this screen does not edit are kept as they were', (tester) async {
    final puts = <Map<String, Object?>>[];
    await openEditor(
      tester,
      'dev-b3',
      puts: puts,
      profiles: {
        'enabled': true,
        'tvs': {
          'dev-b3': {
            'orientation': 'portrait',
            'live': {'fit': 'contain', 'showStrip': false},
          },
        },
      },
    );
    await tapKey(tester, 'tv-ed-tilawah-false');
    await tapKey(tester, 'tv-ed-save');
    expect(((puts.single['tvs']! as Map)['dev-b3']), {
      'orientation': 'portrait',
      'live': {'fit': 'contain', 'showStrip': false},
      'sounds': {'tilawah': false},
    });
    await close(tester);
  });

  testWidgets('a refusal of the box is shown and the entry stays unsaved', (tester) async {
    final h = await openEditor(tester, 'dev-b2');
    h.handlers['PUT /api/settings/tvProfiles'] = (r) async => jsonResponse(400, {
      'errors': ['tvs.dev-b2.name must be 1..40 plain characters'],
    });
    await tapKey(tester, 'tv-ed-azan-follow');
    await tapKey(tester, 'tv-ed-save');
    expect(find.text('tvs.dev-b2.name must be 1..40 plain characters'), findsOneWidget);
    expect(tester.widget<FilledButton>(find.byKey(const ValueKey('tv-ed-save'))).onPressed, isNotNull);
    await close(tester);
  });

  testWidgets('English and Arabic words', (tester) async {
    await openEditor(tester, 'dev-b2', lang: AppLang.en);
    expect(find.text('Settings for this TV'), findsWidgets);
    expect(find.text('Broadcast volume'), findsOneWidget);
    await close(tester);
    await openEditor(tester, 'dev-b2', lang: AppLang.ar);
    expect(find.text('إعدادات هذه الشاشة'), findsWidgets);
    await close(tester);
  });

  test('the entry is read and written as the box stores it', () {
    final p = TvProfile.fromJson(savedProfiles()['tvs']);
    expect(p.name, isNull, reason: 'not an entry: the map of TVs');
    final q = TvProfile.fromJson((savedProfiles()['tvs']! as Map)['dev-b2']);
    expect(q.toJson(), (savedProfiles()['tvs']! as Map)['dev-b2']);
    // junk is dropped, never invented
    expect(
      TvProfile.fromJson({'lang': 'fr', 'live': {'volume': 400, 'show': 'yes'}, 'hideKinds': ['poster', 'nothing'], 'name': '  '}).toJson(),
      {
        'hideKinds': ['poster'],
      },
    );
  });

  for (final lang in AppLang.values) {
    testWidgets('golden: the editor in ${lang.name}', (tester) async {
      final h = await openEditor(tester, 'dev-b2', lang: lang);
      expect(tester.takeException(), isNull);
      await expectGoldens(tester, h.app, 'tv_editor_${lang.name}', sizes: const [GoldenSize.phone]);
      await close(tester);
    });
  }
}
