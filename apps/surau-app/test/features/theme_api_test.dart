import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:surau_app/features/theme/theme_api.dart';

import 'fakes.dart' show jsonResponse;
import 'shell/harness.dart';

void main() {
  test('PackReport.fromJson reads errors with file and line, and the preview facts', () {
    final r = PackReport.fromJson({
      'ok': false,
      'name': 'hijau-siti',
      'version': 3,
      'base': 'creative',
      'images': {'kuliah': 'jpg'},
      'defaults': {'semua': {'shade': 30}},
      'errors': [
        {'code': 'css_url', 'file': 'theme.css', 'line': 12, 'messageMs': 'ms', 'messageEn': 'en'},
        {'code': 'not_zip', 'file': null, 'line': null, 'messageMs': 'a', 'messageEn': 'b'},
        'junk',
      ],
      'warnings': <Object?>[],
    });
    expect(r.ok, isFalse);
    expect(r.errors, hasLength(2));
    expect(r.errors.first.file, 'theme.css');
    expect(r.errors.first.line, 12);
    expect(r.errors.first.text(true), 'ms');
    expect(r.errors.first.text(false), 'en');
    expect(r.errors.last.file, isNull);
    expect(r.previewPack, {'base': 'creative', 'version': 3, 'images': {'kuliah': 'jpg'}, 'defaults': {'semua': {'shade': 30}}});
    expect(PackReport.fromJson(const {}).ok, isFalse);
  });

  test('themeOfferable truth table', () {
    ThemeSupportFull s(List<int?> contracts, {bool complete = true, List<String> builtIn = const ['default']}) => ThemeSupportFull(
      contract: 1,
      builtIn: const [],
      complete: complete,
      boxes: [for (final (i, c) in contracts.indexed) SupportBox(boxId: '$i', name: 'b$i', contract: c, builtIn: builtIn)],
    );
    expect(themeOfferable(s([1, 1]), contract: 1), isTrue);
    expect(themeOfferable(s([1, null]), contract: 1), isFalse);
    expect(themeOfferable(s([1], complete: false), contract: 1), isFalse);
    expect(themeOfferable(s([1, 1], builtIn: ['default', 'arabic']), contract: 1, builtIn: 'arabic'), isTrue);
    expect(themeOfferable(s([1, 1]), contract: 1, builtIn: 'arabic'), isFalse);
    expect(themeOfferable(s([2, 3]), contract: 2), isTrue);
    expect(themeOfferable(s([1]), contract: 2), isFalse);
  });

  testWidgets('ThemeApi.check posts the raw bytes with the pack content type; install, remove and download use the routes', (tester) async {
    final h = await pumpShell(tester, roles: const ['admin']);
    h.handlers['POST /api/themes/check'] = (r) async => jsonResponse(200, {'report': {'ok': true, 'name': 'a-b'}, 'stagedId': 'ab' * 16});
    h.handlers['POST /api/themes/install'] = (r) async => jsonResponse(201, {'name': 'a-b', 'version': 2, 'title': 'A B'});
    h.handlers['DELETE /api/themes/a-b'] = (r) async => http.Response('', 204);
    h.handlers['GET /api/themes/creative/pack'] = (r) async => http.Response.bytes([9, 8, 7], 200);
    final api = h.container.read(themeApiProvider)!;
    final c = await api.check(Uint8List.fromList([1, 2, 3]));
    expect(c.stagedId, 'ab' * 16);
    expect(c.report.ok, isTrue);
    final post = h.box.byPath('/api/themes/check')!;
    expect(post.headers['content-type'], startsWith(packMime));
    expect(post.bodyBytes, [1, 2, 3]);
    final i = await api.install('ab' * 16);
    expect(i.title, 'A B');
    await api.remove('a-b');
    expect(h.box.seen.any((r) => r.method == 'DELETE' && r.url.path == '/api/themes/a-b'), isTrue);
    final bytes = await api.download('creative', bake: false, as: 'creative-saya');
    expect(bytes, [9, 8, 7]);
    final get = h.box.seen.lastWhere((r) => r.url.path == '/api/themes/creative/pack');
    expect(get.url.queryParameters, {'bake': '0', 'as': 'creative-saya'});
  });
}
