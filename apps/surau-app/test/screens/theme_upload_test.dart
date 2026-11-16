// Muat naik tema: pick a .maxtheme, the box checks it, preview, Pasang, step 3. Refused files show the box's
// reason; warnings do not block; Pasang never changes the TV. Goldens: theme_upload_ok, _refused, _warn.

import 'dart:convert';
import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:surau_app/app/providers.dart';
import 'package:surau_app/features/live/fake_publisher.dart';
import 'package:surau_app/features/live/live_screen.dart' show livePublisherProvider;
import 'package:surau_app/features/theme/theme_api.dart';

import '../features/fakes.dart' show jsonResponse;
import '../features/shell/harness.dart';
import '../golden_sizes.dart';

Finder k(String key) => find.byKey(ValueKey(key));

const String stagedId = 'abababababababababababababababab';
const Map<String, Object?> themedHealth = {
  ...healthyJson,
  'themes': {
    'contract': 1,
    'builtIn': ['default', 'colourful', 'creative', 'oldschool', 'minimal'],
  },
};

Map<String, Object?> issue(String code, String ms, String en, {String? file, int? line}) => {
  'code': code,
  'file': file,
  'line': line,
  'messageMs': ms,
  'messageEn': en,
};

Map<String, Object?> okReport({List<Map<String, Object?>> warnings = const [], bool update = false}) => {
  'ok': true,
  'name': 'hijau-siti',
  'title': 'Hijau Siti',
  'version': 3,
  'base': 'creative',
  'contract': 1,
  'fileCount': 14,
  'bytes': 2516582,
  'screens': ['poster', 'kuliah'],
  'fonts': ['naskh-siti'],
  'images': {'kuliah': 'jpg'},
  'defaults': {
    'semua': {'accent': '#0a8f4e'},
  },
  'isUpdate': update,
  'installedVersion': update ? 2 : null,
  'errors': [],
  'warnings': warnings,
};

Map<String, Object?> refusedReport(List<Map<String, Object?>> errors) => {
  'ok': false,
  'name': null,
  'fileCount': 0,
  'bytes': 0,
  'screens': [],
  'fonts': [],
  'images': {},
  'defaults': {},
  'isUpdate': false,
  'errors': errors,
  'warnings': [],
};

const needsNewer =
    'Tema ini memerlukan MAXCOM yang lebih baharu. Tema dibuat untuk kontrak 2; MAXCOM di surau ini menyokong kontrak 1.';
const outside =
    'Alamat luar tidak dibenarkan. theme.css baris 12 memuat fail dari luar tema. Letak gambar dalam folder images/ dan fon dalam folder fonts/.';


Future<ShellHarness> open(
  WidgetTester tester, {
  required ThemeFileResult? Function() pick,
  List<String> roles = const ['admin'],
  Map<String, Object?>? check,
  Map<String, Object?> support = const {
    'contract': 1,
    'builtIn': ['default', 'colourful', 'creative', 'oldschool', 'minimal'],
    'boxes': [
      {'boxId': 'a', 'name': 'Kotak A', 'contract': 1, 'builtIn': ['default', 'colourful', 'creative', 'oldschool', 'minimal']},
      {'boxId': 'b', 'name': 'Kotak B', 'contract': 1, 'builtIn': ['default', 'colourful', 'creative', 'oldschool', 'minimal']},
    ],
    'complete': true,
  },
  GoldenSize size = GoldenSize.phone,
}) async {
  final h = await pumpShell(
    tester,
    roles: roles,
    health: themedHealth,
    size: size,
    overrides: [livePublisherProvider.overrideWithValue(FakePublisher()), themeFilePickerProvider.overrideWithValue(() async => pick())],
  );
  h.settings['kioskTemplate'] = {'enabled': true, 'templateId': 'creative'};
  h.settings['themeStyle'] = {'enabled': true, 'styles': <String, Object?>{}, 'packs': <String, Object?>{}};
  h.container.invalidate(settingsProvider);
  h.container.invalidate(healthProvider);
  h.handlers['POST /api/themes/check'] = (r) async => jsonResponse(200, {'report': check ?? okReport(), 'stagedId': check != null && check['ok'] == false ? null : stagedId});
  h.handlers['POST /api/themes/install'] = (r) async => jsonResponse(201, {'name': 'hijau-siti', 'version': 3, 'title': 'Hijau Siti'});
  h.handlers['GET /api/themes/support'] = (r) async => jsonResponse(200, support);
  h.router.go('/settings/templat/muat-naik');
  await settle(tester);
  return h;
}

Map<String, dynamic> puts(ShellHarness h) => {
  for (final r in h.box.seen.where((r) => r.method == 'PUT' && r.url.path.startsWith('/api/settings/')))
    r.url.pathSegments.last: jsonDecode(r.body) as Map<String, dynamic>,
};

ThemeFileResult file() => ThemeFileResult.file('hijau-siti.maxtheme', Uint8List.fromList(List.filled(2000, 7)));

Future<void> pickAndCheck(WidgetTester tester) async {
  await tester.tap(k('theme-upload-pick'));
  await settle(tester);
  await tester.tap(k('theme-upload-check'));
  await settle(tester);
}

void main() {
  testWidgets('valid pack: check, preview of the staged pack, Pasang, step 3; kioskTemplate untouched', (tester) async {
    final h = await open(tester, pick: file);
    expect(find.text('Langkah 1 daripada 3'), findsOneWidget);
    expect(find.text('Pilih fail tema'), findsOneWidget);
    await tester.tap(k('theme-upload-pick'));
    await settle(tester);
    expect(find.text('hijau-siti.maxtheme'), findsOneWidget);
    expect(find.textContaining('MAXCOM di surau akan menyemak fail ini'), findsOneWidget);
    await tester.tap(k('theme-upload-check'));
    await settle(tester);
    // the raw file went to the box with the pack content type
    final post = h.box.seen.firstWhere((r) => r.url.path == '/api/themes/check');
    expect(post.headers['content-type'], startsWith(packMime));
    expect(post.bodyBytes.length, 2000);
    expect(find.text('Tema sah dan sedia dipasang'), findsOneWidget);
    expect(find.text('Langkah 2 daripada 3'), findsOneWidget);
    expect(find.text('Hijau Siti'), findsOneWidget);
    expect(find.text('3 (tema baharu)'), findsOneWidget);
    expect(find.text('Creative'), findsWidgets);
    expect(find.text('14 fail, 2.4 MB'), findsOneWidget);
    // the page is asked to wear the staged pack
    final req = h.previewRequests.last.theme!;
    expect(req.theme, 'hijau-siti');
    expect(req.staged, stagedId);
    expect(req.pack, {'base': 'creative', 'version': 3, 'images': {'kuliah': 'jpg'}, 'defaults': {'semua': {'accent': '#0a8f4e'}}});
    await expectGoldens(tester, h.app, 'theme_upload_ok');
    await reveal(tester, k('theme-upload-install'));
    await tester.tap(k('theme-upload-install'));
    await settle(tester);
    expect(jsonDecode(h.box.seen.firstWhere((r) => r.url.path == '/api/themes/install').body), {'stagedId': stagedId});
    expect(find.text('Hijau Siti dipasang'), findsOneWidget);
    expect(find.textContaining('TV masih memakai Creative'), findsOneWidget);
    expect(puts(h), isEmpty, reason: 'Pasang never changes the TV');
  });

  testWidgets('Guna sekarang is the separate save of kioskTemplate, offered when every box can wear the theme', (tester) async {
    final h = await open(tester, pick: file);
    await pickAndCheck(tester);
    await reveal(tester, k('theme-upload-install'));
    await tester.tap(k('theme-upload-install'));
    await settle(tester);
    await reveal(tester, k('theme-upload-use'));
    await tester.tap(k('theme-upload-use'));
    await settle(tester);
    expect(puts(h), {
      'kioskTemplate': {'templateId': 'hijau-siti'},
    });
    expect(h.location, '/settings/templat');
  });

  testWidgets('Guna sekarang is not offered while one box cannot wear the theme', (tester) async {
    final h = await open(
      tester,
      pick: file,
      support: const {
        'contract': 1,
        'builtIn': [],
        'boxes': [
          {'boxId': 'a', 'name': 'Kotak A', 'contract': 1, 'builtIn': <Object?>[]},
          {'boxId': 'b', 'name': 'Kotak B', 'contract': null, 'builtIn': <Object?>[]},
        ],
        'complete': true,
      },
    );
    await pickAndCheck(tester);
    await reveal(tester, k('theme-upload-install'));
    await tester.tap(k('theme-upload-install'));
    await settle(tester);
    expect(find.text('Hijau Siti dipasang'), findsOneWidget);
    expect(find.textContaining('ada MAXCOM di surau yang perlu dikemas kini dahulu'), findsOneWidget);
    expect(tester.widget<FilledButton>(k('theme-upload-use')).onPressed, isNull);
    expect(puts(h), isEmpty);
  });

  testWidgets('refused: newer contract shows the exact sentence and no Pasang button', (tester) async {
    final h = await open(
      tester,
      pick: file,
      check: refusedReport([issue('needs_newer', needsNewer, 'This theme needs a newer MAXCOM.', file: 'theme.json')]),
    );
    await pickAndCheck(tester);
    expect(find.text('Tema ini memerlukan MAXCOM yang lebih baharu. Tema dibuat untuk kontrak 2; MAXCOM di surau ini menyokong kontrak 1.'), findsWidgets);
    expect(k('theme-upload-install'), findsNothing);
    expect(k('theme-upload-close'), findsOneWidget);
    expect(h.previewRequests.where((r) => r.theme?.staged != null), isEmpty);
    expect(h.box.seen.where((r) => r.url.path == '/api/themes/install'), isEmpty);
    await expectGoldens(tester, h.app, 'theme_upload_refused');
  });

  testWidgets('refused: outside address lists the file and line the box named', (tester) async {
    await open(
      tester,
      pick: file,
      check: refusedReport([
        issue('css_url', outside, 'Outside addresses are not allowed.', file: 'theme.css', line: 12),
        issue('css_import', 'screens/poster.css baris 1: @import tidak dibenarkan.', '@import is not allowed.', file: 'screens/poster.css', line: 1),
      ]),
    );
    await pickAndCheck(tester);
    expect(find.textContaining('theme.css baris 12 memuat fail dari luar tema'), findsWidgets);
    expect(find.textContaining('screens/poster.css baris 1: @import tidak dibenarkan.'), findsOneWidget);
    expect(k('theme-issue-css_url'), findsOneWidget);
    expect(k('theme-issue-css_import'), findsOneWidget);
    expect(k('theme-upload-install'), findsNothing);
  });

  testWidgets('warnings: Pasang juga installs', (tester) async {
    final h = await open(
      tester,
      pick: file,
      check: okReport(warnings: [
        issue('css_newer', 'Kotak T95 (Chrome 91). screens/poster.css baris 8 guna :has(). Gaya ini tidak akan kelihatan pada kotak ini. Waktu solat dan jam tidak terjejas.', 'x', file: 'screens/poster.css', line: 8),
        issue('bad_font', 'Fon besar. fonts/naskh-siti.woff2 1.1 MB. Paparan pertama mungkin lambat sedikit.', 'x', file: 'fonts/naskh-siti.woff2'),
      ]),
    );
    await pickAndCheck(tester);
    expect(find.text('Boleh dipasang, dengan 2 amaran'), findsOneWidget);
    expect(find.textContaining('screens/poster.css baris 8 guna :has()'), findsOneWidget);
    expect(find.textContaining('Fon besar.'), findsOneWidget);
    expect(k('theme-upload-install'), findsOneWidget);
    expect(find.text('Pasang juga'), findsOneWidget);
    await expectGoldens(tester, h.app, 'theme_upload_warn');
    await reveal(tester, k('theme-upload-install'));
    await tester.tap(k('theme-upload-install'));
    await settle(tester);
    expect(find.text('Hijau Siti dipasang'), findsOneWidget);
  });

  testWidgets('an update shows the version it replaces', (tester) async {
    await open(tester, pick: file, check: okReport(update: true));
    await pickAndCheck(tester);
    expect(find.text('3 (kemas kini daripada versi 2)'), findsOneWidget);
  });

  testWidgets('pick problems: too big, wrong type, unreadable, backed out', (tester) async {
    ThemeFileResult? next = const ThemeFileResult.tooBig();
    final h = await open(tester, pick: () => next);
    await tester.tap(k('theme-upload-pick'));
    await settle(tester);
    expect(find.text('Fail melebihi 15 MB.'), findsOneWidget);
    expect(tester.widget<FilledButton>(k('theme-upload-check')).onPressed, isNull);
    next = const ThemeFileResult.wrongType();
    await tester.tap(k('theme-upload-pick'));
    await settle(tester);
    expect(find.text('Pilih fail yang berakhir dengan .maxtheme.'), findsOneWidget);
    next = const ThemeFileResult.unreadable();
    await tester.tap(k('theme-upload-pick'));
    await settle(tester);
    expect(find.text('Fail tidak dapat dibaca.'), findsOneWidget);
    next = null;
    await tester.tap(k('theme-upload-pick'));
    await settle(tester);
    expect(find.text('Fail tidak dapat dibaca.'), findsOneWidget, reason: 'backing out changes nothing');
    expect(h.box.seen.where((r) => r.url.path == '/api/themes/check'), isEmpty);
  });

  testWidgets('a file over the limit that the box refuses with 413 shows the same sentence', (tester) async {
    final h = await open(tester, pick: file);
    h.handlers['POST /api/themes/check'] = (r) async => jsonResponse(413, {'errors': ['x'], 'report': refusedReport([])});
    await pickAndCheck(tester);
    expect(find.text('Fail melebihi 15 MB.'), findsOneWidget);
    expect(find.text('Langkah 1 daripada 3'), findsOneWidget);
  });

  testWidgets('install answers 410: the expiry sentence, back to step 1', (tester) async {
    final h = await open(tester, pick: file);
    h.handlers['POST /api/themes/install'] = (r) async => jsonResponse(410, {'code': 'gone', 'errors': ['Semakan sudah tamat tempoh. Semak fail sekali lagi.']});
    await pickAndCheck(tester);
    await reveal(tester, k('theme-upload-install'));
    await tester.tap(k('theme-upload-install'));
    await settle(tester);
    expect(find.text('Semakan sudah tamat tempoh. Semak fail sekali lagi.'), findsOneWidget);
    expect(find.text('Langkah 1 daripada 3'), findsOneWidget);
  });

  testWidgets('install answers 429 (ten installs an hour): the box sentence stays on the page', (tester) async {
    final h = await open(tester, pick: file);
    h.handlers['POST /api/themes/install'] = (r) async => jsonResponse(429, {'code': 'too_many_installs', 'errors': ['Terlalu banyak pemasangan tema. Had 10 sejam. Cuba lagi dalam sejam.']});
    await pickAndCheck(tester);
    await reveal(tester, k('theme-upload-install'));
    await tester.tap(k('theme-upload-install'));
    await settle(tester);
    expect(find.textContaining('Terlalu banyak pemasangan tema.'), findsOneWidget);
    expect(find.text('Langkah 2 daripada 3'), findsOneWidget);
  });

  testWidgets('refused: a font in the file shows the box sentence and no Pasang button', (tester) async {
    await open(
      tester,
      pick: file,
      check: refusedReport([
        issue(
          'bad_font',
          'Fon tidak dibenarkan dalam tema (MAXCOM versi ini): fonts/naskh-siti.woff2. Fon dipilih dalam menu Ubah suai.',
          'Fonts are not allowed in a theme (this MAXCOM version): fonts/naskh-siti.woff2.',
          file: 'fonts/naskh-siti.woff2',
        ),
      ]),
    );
    await pickAndCheck(tester);
    expect(find.textContaining('Fon tidak dibenarkan dalam tema'), findsWidgets);
    expect(k('theme-issue-bad_font'), findsOneWidget);
    expect(k('theme-upload-install'), findsNothing);
  });

  testWidgets('install answers 409 (a newer version arrived): the box sentence stays on the page', (tester) async {
    final h = await open(tester, pick: file);
    h.handlers['POST /api/themes/install'] = (r) async => jsonResponse(409, {'code': 'version_not_higher', 'errors': ['Versi sama atau lebih rendah. Hijau Siti versi 3 sudah dipasang. Naikkan nombor versi dalam theme.json.']});
    await pickAndCheck(tester);
    await reveal(tester, k('theme-upload-install'));
    await tester.tap(k('theme-upload-install'));
    await settle(tester);
    expect(find.textContaining('Versi sama atau lebih rendah.'), findsOneWidget);
    expect(find.text('Langkah 2 daripada 3'), findsOneWidget);
  });

  testWidgets('a role without settings:write has no Muat naik tema button and sees no upload form', (tester) async {
    final h = await open(tester, pick: file, roles: const ['ajk']);
    expect(find.text('Tiada kebenaran untuk tindakan ini'), findsWidgets);
    expect(k('theme-upload-pick'), findsNothing);
    h.router.go('/settings/templat');
    await settle(tester);
    expect(k('theme-upload-open'), findsNothing);
  });

  testWidgets('the gallery opens the upload page', (tester) async {
    final h = await open(tester, pick: file);
    h.router.go('/settings/templat');
    await settle(tester);
    await reveal(tester, k('theme-upload-open'));
    await tester.tap(k('theme-upload-open'));
    await settle(tester);
    expect(h.location, '/settings/templat/muat-naik');
  });
}

