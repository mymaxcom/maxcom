// Templat paparan with uploaded themes: badges, Muat turun tema, Padam tema, the invalid-theme badge from the
// box's health report, and the offer rule (an uploaded theme is offered only when every MAXCOM of the surau can wear it).

import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:surau_app/app/providers.dart';
import 'package:surau_app/features/live/fake_publisher.dart';
import 'package:surau_app/features/live/live_screen.dart' show livePublisherProvider;
import 'package:surau_app/features/theme/theme_api.dart' show themeSupportFullProvider;
import 'package:surau_app/screens/theme/theme_download_sheet.dart';

import '../features/fakes.dart' show jsonResponse;
import '../features/shell/harness.dart';

Finder k(String key) => find.byKey(ValueKey(key));

const List<String> builtIn = ['default', 'colourful', 'creative', 'oldschool', 'minimal'];
Map<String, Object?> health({Map<String, Object?>? themeHealth}) => {
  ...healthyJson,
  'themes': {'contract': 1, 'builtIn': builtIn},
  'themeHealth': ?themeHealth,
};
Map<String, Object?> pack({int version = 3, int contract = 1, String base = 'creative'}) => {
  'assetId': 'a' * 64,
  'version': version,
  'title': 'Hijau Siti',
  'base': base,
  'contract': contract,
  'bytes': 2000,
  'fonts': [],
  'screens': [],
  'images': {},
  'defaults': {},
};
Map<String, Object?> support(List<int?> contracts, {bool complete = true, List<String> boxBuiltIn = builtIn}) => {
  'contract': 1,
  'builtIn': builtIn,
  'boxes': [
    for (final (i, c) in contracts.indexed) {'boxId': 'b$i', 'name': 'Kotak $i', 'contract': c, 'builtIn': boxBuiltIn},
  ],
  'complete': complete,
};

Future<ShellHarness> open(
  WidgetTester tester, {
  String active = 'creative',
  Map<String, Object?>? themeHealth,
  Map<String, Object?>? supportJson,
  Map<String, Object?>? styles,
  bool withPack = true,
  String packBase = 'creative',
  List<String> roles = const ['admin'],
}) async {
  final h = await pumpShell(
    tester,
    roles: roles,
    health: health(themeHealth: themeHealth),
    overrides: [livePublisherProvider.overrideWithValue(FakePublisher())],
  );
  h.settings['kioskTemplate'] = {'enabled': true, 'templateId': active};
  h.settings['surauInfo'] = {'enabled': true, 'name': 'Surau Contoh'};
  h.settings['themeStyle'] = {
    'enabled': true,
    'styles': styles ?? {},
    'packs': withPack ? {'hijau-siti': pack(base: packBase)} : <String, Object?>{},
  };
  h.handlers['GET /api/themes/support'] = (r) async => jsonResponse(200, supportJson ?? support([1, 1]));
  h.container.invalidate(settingsProvider);
  h.container.invalidate(healthProvider);
  h.router.go('/settings/templat');
  await settle(tester);
  return h;
}

Future<void> openSheet(WidgetTester tester, String name) async {
  await reveal(tester, k('theme-card-$name'));
  await tester.tap(k('theme-card-$name'));
  await settle(tester);
}

void main() {
  test('names: the proposal and the rules', () {
    expect(proposedThemeName('creative', 'Surau Al-Hidayah'), 'creative-surau-al-hidayah');
    expect(proposedThemeName('oldschool', 'Masjid Jamek (Kg. Baru) & Anak-Anak Yatim Piatu'), hasLength(lessThanOrEqualTo(32)));
    expect(proposedThemeName('minimal', '!!!'), 'minimal');
    expect(proposedThemeName('minimal', ''), 'minimal');
    expect(themeNameUsable('hijau-siti'), isTrue);
    for (final bad in ['Creative', 'creative', 'arabic', '', '-a', 'a-', 'a_b', 'a b', 'a' * 33]) {
      expect(themeNameUsable(bad), isFalse, reason: bad);
    }
  });

  testWidgets('uploaded card: badge with version, download, delete', (tester) async {
    await open(tester);
    await reveal(tester, k('theme-card-hijau-siti'));
    expect(find.text('Dimuat naik, versi 3'), findsOneWidget);
    expect(find.text('Hijau Siti'), findsOneWidget);
    await openSheet(tester, 'hijau-siti');
    expect(k('theme-use'), findsOneWidget);
    expect(k('theme-download'), findsOneWidget);
    expect(k('theme-delete'), findsOneWidget);
  });

  testWidgets('built-in download asks for a name and sends bake=1 by default', (tester) async {
    final h = await open(tester);
    h.handlers['GET /api/themes/creative/pack'] = (r) async => http.Response.bytes([1, 2, 3], 200);
    await openSheet(tester, 'creative');
    await tester.tap(k('theme-download'));
    await settle(tester);
    expect(find.text('Muat turun tema'), findsWidgets);
    expect(find.text('Satu fail untuk disunting di luar MAXCOM atau dikongsi dengan surau lain.'), findsOneWidget);
    expect(tester.widget<TextField>(k('theme-download-name')).controller!.text, 'creative-surau-contoh');
    expect(tester.widget<SwitchListTile>(k('theme-download-bake')).value, isTrue);
    expect(find.text('Fail akan menghasilkan rupa yang sama seperti TV surau sekarang (0 skrin diubah, 0 gambar latar).'), findsOneWidget);
    await tester.tap(k('theme-download-go'));
    await settle(tester);
    final get = h.box.seen.lastWhere((r) => r.url.path == '/api/themes/creative/pack');
    expect(get.url.queryParameters, {'bake': '1', 'as': 'creative-surau-contoh'});
  });

  testWidgets('the sheet counts the screens and pictures the surau changed', (tester) async {
    await open(tester, styles: {
      'creative': {
        'semua': {'bgImage': 'c' * 64},
        'skrin': {'kuliah': {'shade': 40}, 'poster': {'bgImage': 'd' * 64}},
      },
    });
    await openSheet(tester, 'creative');
    await tester.tap(k('theme-download'));
    await settle(tester);
    expect(find.textContaining('(2 skrin diubah, 2 gambar latar)'), findsOneWidget);
  });

  testWidgets('switching Sertakan ubah suai saya off sends bake=0', (tester) async {
    final h = await open(tester);
    h.handlers['GET /api/themes/creative/pack'] = (r) async => http.Response.bytes([1], 200);
    await openSheet(tester, 'creative');
    await tester.tap(k('theme-download'));
    await settle(tester);
    await tester.tap(k('theme-download-bake'));
    await settle(tester);
    await tester.tap(k('theme-download-go'));
    await settle(tester);
    expect(h.box.seen.lastWhere((r) => r.url.path == '/api/themes/creative/pack').url.queryParameters['bake'], '0');
  });

  testWidgets('a bad proposed name cannot be submitted', (tester) async {
    final h = await open(tester);
    await openSheet(tester, 'creative');
    await tester.tap(k('theme-download'));
    await settle(tester);
    for (final bad in ['Creative', 'creative', 'arabic', 'a_b']) {
      await tester.enterText(k('theme-download-name'), bad);
      await tester.pump();
      expect(find.textContaining('Nama tidak sah.'), findsOneWidget, reason: bad);
      expect(tester.widget<FilledButton>(k('theme-download-go')).onPressed, isNull, reason: bad);
    }
    await tester.enterText(k('theme-download-name'), 'hijau-saya');
    await tester.pump();
    expect(tester.widget<FilledButton>(k('theme-download-go')).onPressed, isNotNull);
    expect(h.box.seen.where((r) => r.url.path.endsWith('/pack')), isEmpty);
  });

  testWidgets('an uploaded theme keeps its own name, read only', (tester) async {
    final h = await open(tester);
    h.handlers['GET /api/themes/hijau-siti/pack'] = (r) async => http.Response.bytes(Uint8List.fromList([1]), 200);
    await openSheet(tester, 'hijau-siti');
    await tester.tap(k('theme-download'));
    await settle(tester);
    final field = tester.widget<TextField>(k('theme-download-name'));
    expect(field.controller!.text, 'hijau-siti');
    expect(field.readOnly, isTrue);
    await tester.tap(k('theme-download-go'));
    await settle(tester);
    final q = h.box.seen.lastWhere((r) => r.url.path == '/api/themes/hijau-siti/pack').url.queryParameters;
    expect(q, {'bake': '1'}, reason: 'no "as" for an uploaded theme');
  });

  testWidgets('an uploaded theme is not offered while one box has no contract; the sentence is shown', (tester) async {
    await open(tester, supportJson: support([1, null]));
    await openSheet(tester, 'hijau-siti');
    expect(find.text('Belum boleh digunakan'), findsOneWidget);
    expect(find.text('Tema ini belum boleh digunakan: ada MAXCOM di surau yang perlu dikemas kini dahulu.'), findsOneWidget);
    expect(k('theme-use'), findsNothing);
  });

  testWidgets('Q4: an uploaded theme made on Arabic Art is not offered while a box does not carry Arabic Art', (tester) async {
    await open(tester, packBase: 'arabic', supportJson: support([1, 1]));
    await openSheet(tester, 'hijau-siti');
    expect(find.text('Belum boleh digunakan'), findsOneWidget);
    expect(k('theme-use'), findsNothing);
  });

  testWidgets('Q4: the same theme is offered when every box carries Arabic Art', (tester) async {
    await open(tester, packBase: 'arabic', supportJson: support([1, 1], boxBuiltIn: [...builtIn, 'arabic']));
    await openSheet(tester, 'hijau-siti');
    expect(find.text('Belum boleh digunakan'), findsNothing);
    expect(k('theme-use'), findsOneWidget);
  });

  testWidgets('complete false: not offered, the cloud sentence', (tester) async {
    await open(tester, supportJson: support([1, 1], complete: false));
    await openSheet(tester, 'hijau-siti');
    expect(find.text('Tidak dapat mengesahkan semua MAXCOM surau sekarang. Cuba lagi apabila talian awan pulih.'), findsOneWidget);
    expect(k('theme-use'), findsNothing);
  });

  testWidgets('a built-in theme is still offered when the list cannot be read', (tester) async {
    final h = await open(tester);
    h.handlers['GET /api/themes/support'] = (r) async => jsonResponse(500, {'errors': ['x']});
    h.container.invalidate(themeSupportFullProvider);
    await openSheet(tester, 'minimal');
    expect(k('theme-use'), findsOneWidget);
    expect(find.text('Belum boleh digunakan'), findsNothing);
  });

  testWidgets('Tema tidak sah badge and sentence from themeHealth', (tester) async {
    await open(tester, active: 'hijau-siti', themeHealth: {'theme': 'hijau-siti', 'version': 3, 'ok': false, 'screen': 'biasa', 'failed': ['clock']});
    await reveal(tester, k('theme-card-hijau-siti'));
    expect(k('theme-invalid-badge'), findsOneWidget);
    await tester.tap(k('theme-card-hijau-siti'));
    await settle(tester);
    expect(find.text('Tema tidak sah'), findsWidgets);
    expect(find.text('TV memakai tema asas kerana tema ini menyembunyikan jam, waktu solat atau logo. Betulkan fail tema dan muat naik versi baharu.'), findsOneWidget);
  });

  testWidgets('a good health report shows no badge', (tester) async {
    await open(tester, active: 'hijau-siti', themeHealth: {'theme': 'hijau-siti', 'version': 3, 'ok': true, 'screen': 'biasa', 'failed': []});
    await reveal(tester, k('theme-card-hijau-siti'));
    expect(k('theme-invalid-badge'), findsNothing);
  });

  testWidgets('delete: confirm, DELETE /api/themes/hijau-siti, card gone', (tester) async {
    final h = await open(tester);
    h.handlers['DELETE /api/themes/hijau-siti'] = (r) async {
      (h.settings['themeStyle'] as Map)['packs'] = <String, Object?>{};
      return http.Response('', 204);
    };
    await openSheet(tester, 'hijau-siti');
    await tester.tap(k('theme-delete'));
    await settle(tester);
    expect(find.text('Padam tema Hijau Siti? Ubah suai anda untuk tema ini disimpan.'), findsOneWidget);
    await tester.tap(k('theme-delete-yes'));
    await settle(tester);
    expect(h.box.seen.any((r) => r.method == 'DELETE' && r.url.path == '/api/themes/hijau-siti'), isTrue);
    expect(find.text('Tema dipadam'), findsOneWidget);
    expect(k('theme-card-hijau-siti'), findsNothing);
  });

  testWidgets('delete: cancelling sends nothing; a 409 keeps the card and shows the box sentence', (tester) async {
    final h = await open(tester);
    await openSheet(tester, 'hijau-siti');
    await tester.tap(k('theme-delete'));
    await settle(tester);
    await tester.tap(k('theme-delete-no'));
    await settle(tester);
    expect(h.box.seen.where((r) => r.method == 'DELETE'), isEmpty);
    h.handlers['DELETE /api/themes/hijau-siti'] = (r) async => jsonResponse(409, {'code': 'in_use', 'errors': ['Tema ini sedang digunakan. Pilih tema lain dahulu.']});
    await tester.tap(k('theme-delete'));
    await settle(tester);
    await tester.tap(k('theme-delete-yes'));
    await settle(tester);
    expect(find.text('Tema ini sedang digunakan. Pilih tema lain dahulu.'), findsOneWidget);
    expect(k('theme-card-hijau-siti'), findsOneWidget);
  });

  testWidgets('the active uploaded theme cannot be deleted; built-ins have no delete', (tester) async {
    await open(tester, active: 'hijau-siti');
    await openSheet(tester, 'hijau-siti');
    expect(tester.widget<OutlinedButton>(k('theme-delete')).onPressed, isNull);
    expect(find.text('Tema ini sedang digunakan. Pilih tema lain dahulu.'), findsOneWidget);
    await tester.tapAt(const Offset(5, 5));
    await settle(tester);
    await openSheet(tester, 'minimal');
    expect(k('theme-delete'), findsNothing);
    expect(find.text('Tema bawaan MAXCOM tidak boleh dipadam.'), findsOneWidget);
  });

  testWidgets('a role without settings:write sees no download, delete or upload', (tester) async {
    await open(tester, roles: const ['ajk']);
    await openSheet(tester, 'hijau-siti');
    expect(k('theme-download'), findsNothing);
    expect(k('theme-delete'), findsNothing);
    expect(k('theme-use'), findsNothing);
  });
}
