// Templat paparan: the five built-in themes with their English names, the active one on top with a live
// preview, Guna tema ini, the count of customised screens, an older box, a read-only role. Golden: theme_gallery.

import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:surau_app/app/providers.dart';

import 'package:surau_app/features/theme/theme_api.dart' show themeSupportFullProvider;

import '../features/fakes.dart' show jsonResponse;
import '../features/shell/harness.dart';
import '../golden_sizes.dart';

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
  Map<String, Object?>? health = themedHealth,
  String active = 'creative',
  Map<String, Object?>? themeStyle,
}) async {
  final h = await pumpShell(tester, roles: roles, health: health);
  h.settings['kioskTemplate'] = {'enabled': true, 'templateId': active};
  if (themeStyle != null) h.settings['themeStyle'] = {'enabled': true, 'packs': <String, Object?>{}, ...themeStyle};
  h.container.invalidate(settingsProvider);
  h.container.invalidate(healthProvider);
  h.router.go('/settings/templat');
  await settle(tester);
  return h;
}

Map<String, dynamic> puts(ShellHarness h) => {
  for (final r in h.box.seen.where((r) => r.method == 'PUT' && r.url.path.startsWith('/api/settings/')))
    r.url.pathSegments.last: jsonDecode(r.body) as Map<String, dynamic>,
};

void main() {
  testWidgets('lists the five built-ins with English names and marks the active one', (tester) async {
    final h = await open(tester);
    expect(h.location, '/settings/templat');
    expect(find.text('Creative'), findsNWidgets(2), reason: 'the active card and the grid');
    for (final name in ['Default', 'Colourful', 'Old School', 'Minimal']) {
      expect(find.text(name), findsOneWidget, reason: name);
    }
    expect(find.text('Aktif'), findsOneWidget);
    expect(find.text('Semua tema (5)'), findsOneWidget);
    await reveal(tester, k('theme-card-minimal'));
    expect(find.text('Bawaan MAXCOM'), findsNWidgets(5));
    // The active theme is previewed live, on the Biasa screen, with the surau's own values.
    final req = h.previewRequests.last;
    expect(req.theme!.theme, 'creative');
    expect(req.theme!.screen, 'biasa');
    await expectGoldens(tester, h.app, 'theme_gallery');
  });

  testWidgets('Arabic Art is listed only when every box of the surau has it', (tester) async {
    const six = ['default', 'colourful', 'creative', 'oldschool', 'minimal', 'arabic'];
    const five = ['default', 'colourful', 'creative', 'oldschool', 'minimal'];
    Map<String, Object?> support(List<List<String>> boxes) => {
      'contract': 1,
      'builtIn': six,
      'boxes': [for (final (i, b) in boxes.indexed) {'boxId': 'b$i', 'name': 'Kotak $i', 'contract': 1, 'builtIn': b}],
      'complete': true,
    };
    final h = await open(tester);
    h.handlers['GET /api/themes/support'] = (r) async => jsonResponse(200, support([six, five]));
    h.container.invalidate(themeSupportFullProvider);
    await settle(tester);
    expect(find.text('Arabic Art'), findsNothing);
    h.handlers['GET /api/themes/support'] = (r) async => jsonResponse(200, support([six, six]));
    h.container.invalidate(themeSupportFullProvider);
    await settle(tester);
    await reveal(tester, k('theme-card-arabic'));
    expect(find.text('Arabic Art'), findsOneWidget);
    expect(find.text('BAHARU'), findsOneWidget);
  });

  testWidgets('Guna tema ini saves kioskTemplate and nothing else', (tester) async {
    final h = await open(tester);
    await reveal(tester, k('theme-card-minimal'));
    await tester.tap(k('theme-card-minimal'));
    await settle(tester);
    expect(h.previewRequests.last.theme!.theme, 'minimal');
    await tester.tap(k('theme-use'));
    await settle(tester);
    expect(puts(h), {
      'kioskTemplate': {'templateId': 'minimal'},
    });
    expect(find.text('Tema ditukar'), findsOneWidget);
  });

  testWidgets('counts customised screens of the active theme', (tester) async {
    await open(
      tester,
      themeStyle: {
        'styles': {
          'creative': {
            'semua': <String, Object?>{},
            'skrin': {
              'kuliah': {'shade': 20},
              'hadis': {'scale': 'L'},
              'ayat': {'align': 'tengah'},
              'poster': {'shade': 10},
            },
          },
        },
      },
    );
    expect(find.text('4 skrin diubah suai.'), findsOneWidget);
  });

  testWidgets('an older box: no Ubah suai, the update notice, built-ins still choosable', (tester) async {
    final h = await open(tester, health: healthyJson);
    expect(find.text('Ubah suai'), findsNothing);
    expect(k('theme-needs-update'), findsOneWidget);
    expect(find.text('Kemas kini MAXCOM di surau untuk mengubah suai tema.'), findsOneWidget);
    await reveal(tester, k('theme-card-oldschool'));
    await tester.tap(k('theme-card-oldschool'));
    await settle(tester);
    expect(k('theme-use'), findsOneWidget);
    expect(h.previewRequests, isNotEmpty);
  });

  testWidgets('a role without settings:write sees the gallery read only', (tester) async {
    await open(tester, roles: const ['ajk']);
    expect(find.text('Ubah suai'), findsNothing);
    expect(find.text('Creative'), findsWidgets);
    await reveal(tester, k('theme-card-minimal'));
    await tester.tap(k('theme-card-minimal'));
    await settle(tester);
    expect(find.text('Guna tema ini'), findsNothing);
  });

  testWidgets('Tetapan does not list Gaya tema; Templat paparan opens the gallery', (tester) async {
    final h = await pumpShell(tester, roles: const ['admin'], health: themedHealth);
    h.router.go('/settings');
    await settle(tester);
    // Open every group so every row is built.
    for (final g in ['skrin']) {
      final head = find.byKey(ValueKey('settings-group-$g'));
      if (head.evaluate().isNotEmpty) {
        await tester.ensureVisible(head);
        await tester.tap(head);
        await settle(tester);
      }
    }
    expect(find.text('Gaya tema'), findsNothing);
    expect(k('settings-row-themeStyle'), findsNothing);
    h.router.go('/settings/kioskTemplate');
    await settle(tester);
    expect(h.location, '/settings/templat');
  });
}
