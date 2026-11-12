import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:surau_app/content/preview_message.dart';

void main() {
  final box = Uri.parse('https://10.168.0.154:8443');

  group('previewUri', () {
    test('is the box root with preview=1 and nothing else', () {
      final u = previewUri(box);
      expect(u.scheme, 'https');
      expect(u.host, '10.168.0.154');
      expect(u.port, 8443);
      expect(u.path, '/');
      expect(u.queryParameters, {'preview': '1'});
      expect(u.fragment, '');
    });

    test('drops the box path, query and credentials', () {
      final u = previewUri(Uri.parse('https://user:pw@box.local:8443/app/?x=1#f'));
      expect(u.toString(), 'https://box.local:8443/?preview=1');
    });

    test('keeps a default port implicit', () {
      expect(previewUri(Uri.parse('https://box.local')).toString(), 'https://box.local/?preview=1');
    });

    test('a pinned time becomes ?now= in +08:00 with proof=1', () {
      final u = previewUri(box, now: DateTime.utc(2026, 11, 3, 7, 52));
      expect(u.queryParameters['preview'], '1');
      expect(u.queryParameters['now'], '2026-11-03T15:52:00+08:00');
      expect(u.queryParameters['proof'], '1');
      // the plus sign must travel encoded, or the kiosk reads it as a space
      expect(u.query, contains('now=2026-11-03T15%3A52%3A00%2B08%3A00'));
    });

    test('the surau offset is written when given (+03:00), same instant', () {
      final u = previewUri(box, now: DateTime.utc(2026, 11, 3, 7, 52), utcOffsetMinutes: 180);
      expect(u.queryParameters['now'], '2026-11-03T10:52:00+03:00');
      expect(DateTime.parse(u.queryParameters['now']!).toUtc(), DateTime.utc(2026, 11, 3, 7, 52));
    });

    test('a local time is converted to Kuala Lumpur, not shifted by the phone zone', () {
      final local = DateTime.parse('2026-11-03T23:30:00-05:00'); // 04:30 UTC next day
      final u = previewUri(box, now: local);
      expect(u.queryParameters['now'], '2026-11-04T12:30:00+08:00');
    });

    test('refuses a box that is not http or https', () {
      expect(() => previewUri(Uri.parse('file:///x')), throwsArgumentError);
      expect(() => previewUri(Uri.parse('javascript:alert(1)')), throwsArgumentError);
      expect(() => previewUri(Uri.parse('/relative')), throwsArgumentError);
    });
  });

  const origin = 'https://10.168.0.154:8443';
  // The call inside the origin guard: `if (location.origin === "<origin>") { <call> }`.
  String callOf(String js) {
    final start = js.indexOf('window.postMessage(');
    expect(start, greaterThan(0));
    return js.substring(start, js.lastIndexOf(' }'));
  }

  String bodyOf(String js) {
    final call = callOf(js);
    return call.substring('window.postMessage('.length, call.length - ', location.origin);'.length);
  }

  group('previewMessageJs', () {
    test('posts the token only while the page is on the box origin (N3)', () {
      final js = previewMessageJs('tok_ABC-123', origin: origin);
      expect(js, startsWith('if (location.origin === "$origin") { window.postMessage('));
      expect(js, endsWith(', location.origin); }'));
    });

    test('a hostile origin string is quoted, not concatenated', () {
      final js = previewMessageJs('tok', origin: '"; alert(1); //');
      expect(js, startsWith(r'if (location.origin === "\"; alert(1); //") {'));
      expect(js.split(String.fromCharCode(10)).length, 1);
    });

    test('previewOrigin matches location.origin', () {
      expect(previewOrigin(Uri.parse('https://10.168.0.154:8443/?preview=1')), 'https://10.168.0.154:8443');
      expect(previewOrigin(Uri.parse('https://Surau.Local:443/')), 'https://surau.local');
      expect(previewOrigin(Uri.parse('http://127.0.0.1:8787/x')), 'http://127.0.0.1:8787');
      expect(previewOrigin(Uri.parse('https://[::1]:8443/')), 'https://[::1]:8443');
    });

    test('posts the surau-preview message to the page\'s own origin, never *', () {
      final js = previewMessageJs('tok_ABC-123', origin: origin);
      expect(callOf(js), startsWith('window.postMessage('));
      expect(callOf(js), endsWith(', location.origin);'));
      expect(js, isNot(contains("'*'")));
      expect(js, isNot(contains('"*"')));
      expect(jsonDecode(bodyOf(js)), {'type': 'surau-preview', 'token': 'tok_ABC-123'});
    });

    test('escapes a token with quotes and backslashes instead of concatenating it', () {
      final evil = [
        '"});alert(1);//',
        String.fromCharCode(92), // backslash
        String.fromCharCode(39), // single quote
        '`',
        String.fromCharCode(10), // newline
      ].join();
      final js = previewMessageJs(evil, origin: origin);
      final body = bodyOf(js);
      // it parses back to exactly the original string: nothing escaped out of the literal
      expect((jsonDecode(body) as Map)['token'], evil);
      expect(js, isNot(contains('alert(1);//\n')));
      expect(js.split('\n').length, 1);
    });

    test('the Dart message map matches the JS one', () {
      expect(previewMessage('abc'), {'type': 'surau-preview', 'token': 'abc'});
    });
  });

  group('poster message (Pratonton di TV)', () {
    final id = 'c' * 64;

    test('carries only the type, a box asset id and the title', () {
      final p = PreviewPoster(assetId: id, title: 'Kempen Derma');
      expect(previewPosterMessage(p), {'type': 'surau-preview-poster', 'assetId': id, 'title': 'Kempen Derma'});
    });

    test('the JS form is JSON-encoded to the page\'s own origin, never *', () {
      final evil = ['"});alert(1);//', String.fromCharCode(92), '`', String.fromCharCode(10)].join();
      final js = previewPosterMessageJs(
        PreviewPoster(assetId: id, title: evil),
        origin: origin,
      );
      expect(js, startsWith('if (location.origin === "$origin") { window.postMessage('));
      expect(callOf(js), endsWith(', location.origin);'));
      expect(js, isNot(contains('"*"')));
      final body = bodyOf(js);
      final m = jsonDecode(body) as Map;
      expect(m['type'], 'surau-preview-poster');
      expect(m['assetId'], id);
      // control characters are blanked before the title ever leaves the app
      expect(m['title'], '"});alert(1);//${String.fromCharCode(92)}`');
      expect(js.split('\n').length, 1);
    });

    test('refuses anything but a lower-case 64-hex asset id', () {
      expect(PreviewPoster.tryFrom(id, 'x'), isNotNull);
      for (final bad in [
        '',
        'abc',
        'C' * 64,
        'c' * 65,
        '/assets/${'c' * 64}',
        'https://evil.example/x.png',
        12,
        null,
      ]) {
        expect(PreviewPoster.tryFrom(bad, 'x'), isNull, reason: '$bad');
      }
      expect(() => PreviewPoster(assetId: 'javascript:alert(1)', title: 'x'), throwsArgumentError);
      expect(isAssetId(id), isTrue);
      expect(isAssetId('C' * 64), isFalse);
    });

    test('the title is trimmed, stripped of control characters and cut at 80; a non-string is empty', () {
      final p = PreviewPoster.tryFrom(id, '  Tajuk\u0000\n${'x' * 200}  ')!;
      expect(p.title.length, 80);
      expect(p.title, startsWith('Tajuk  '));
      expect(p.title.contains('\n'), isFalse);
      expect(PreviewPoster.tryFrom(id, 42)!.title, '');
      expect(PreviewPoster.tryFrom(id, null)!.title, '');
      expect(PreviewPoster(assetId: id, title: 'a') == PreviewPoster(assetId: id, title: 'a'), isTrue);
      expect(PreviewPoster(assetId: id, title: 'a') == PreviewPoster(assetId: id, title: 'b'), isFalse);
    });
  });

  group('isPreviewToken', () {
    test('matches the kiosk and box pattern', () {
      expect(isPreviewToken('aZ09_-'), isTrue);
      expect(isPreviewToken(''), isFalse);
      expect(isPreviewToken('a b'), isFalse);
      expect(isPreviewToken('a.b'), isFalse);
      expect(isPreviewToken('a' * 200), isTrue);
      expect(isPreviewToken('a' * 201), isFalse);
    });
  });
}
