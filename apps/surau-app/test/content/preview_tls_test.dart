import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:surau_app/content/preview_tls.dart';

Uint8List der(int seed) => Uint8List.fromList([for (var i = 0; i < 64; i++) (seed + i) & 0xff]);

void main() {
  final preview = Uri.parse('https://10.168.0.154:8443/?preview=1');
  final leaf = der(1);

  Future<SslVerdict> judge({
    String url = 'https://10.168.0.154:8443/',
    Uint8List? presented,
    Uint8List? expected,
    LeafFetcher? refresh,
    Uri? previewUrl,
  }) =>
      judgeSslError(
        previewUrl: previewUrl ?? preview,
        failingUrl: url,
        presented: presented ?? leaf,
        expected: expected,
        refresh: refresh,
      );

  group('sameHttpsOrigin', () {
    test('exact scheme, host and port', () {
      expect(sameHttpsOrigin(preview, 'https://10.168.0.154:8443/app.js'), isTrue);
      expect(sameHttpsOrigin(preview, 'https://10.168.0.154:8444/'), isFalse);
      expect(sameHttpsOrigin(preview, 'https://10.168.0.155:8443/'), isFalse);
      expect(sameHttpsOrigin(preview, 'http://10.168.0.154:8443/'), isFalse);
      expect(sameHttpsOrigin(preview, 'https://10.168.0.154:8443.evil.example/'), isFalse);
      expect(sameHttpsOrigin(preview, 'https://evil.example/'), isFalse);
      expect(sameHttpsOrigin(preview, 'not a url'), isFalse);
    });

    test('never for an http preview', () {
      final p = Uri.parse('http://10.168.0.154:8080/');
      expect(sameHttpsOrigin(p, 'http://10.168.0.154:8080/'), isFalse);
    });
  });

  group('judgeSslError', () {
    test('same origin and identical DER proceeds, with no refresh', () async {
      var refreshed = 0;
      final v = await judge(expected: Uint8List.fromList(leaf), refresh: () async {
        refreshed++;
        return null;
      });
      expect(v.proceed, isTrue);
      expect(refreshed, 0);
    });

    test('another host cancels, even with a matching DER', () async {
      final v = await judge(url: 'https://evil.example/', expected: leaf);
      expect(v.proceed, isFalse);
    });

    test('http cancels', () async {
      final v = await judge(url: 'http://10.168.0.154:8443/', expected: leaf);
      expect(v.proceed, isFalse);
    });

    test('another port cancels', () async {
      final v = await judge(url: 'https://10.168.0.154:9443/', expected: leaf);
      expect(v.proceed, isFalse);
    });

    test('a different DER cancels after exactly one refresh', () async {
      var refreshed = 0;
      final v = await judge(
        presented: der(9),
        expected: leaf,
        refresh: () async {
          refreshed++;
          return Uint8List.fromList(leaf);
        },
      );
      expect(v.proceed, isFalse);
      expect(refreshed, 1);
      expect(v.presentedSha, isNot(v.expectedSha));
    });

    test('a renewed leaf proceeds after one refresh and is remembered', () async {
      final renewed = der(40);
      var refreshed = 0;
      final v = await judge(
        presented: renewed,
        expected: leaf,
        refresh: () async {
          refreshed++;
          return renewed;
        },
      );
      expect(v.proceed, isTrue);
      expect(refreshed, 1);
      expect(v.expected, renewed);
    });

    test('an unknown expected leaf cancels when the refresh finds none', () async {
      expect((await judge(expected: null)).proceed, isFalse);
      expect((await judge(expected: null, refresh: () async => null)).proceed, isFalse);
      expect(
        (await judge(expected: null, refresh: () async => throw StateError('offline'))).proceed,
        isFalse,
      );
    });

    test('an unknown expected leaf is fetched once and then compared', () async {
      final v = await judge(expected: null, refresh: () async => Uint8List.fromList(leaf));
      expect(v.proceed, isTrue);
    });

    test('no presented certificate cancels', () async {
      final v = await judgeSslError(
        previewUrl: preview,
        failingUrl: 'https://10.168.0.154:8443/',
        presented: null,
        expected: leaf,
        refresh: null,
      );
      expect(v.proceed, isFalse);
      final e = await judgeSslError(
        previewUrl: preview,
        failingUrl: 'https://10.168.0.154:8443/',
        presented: Uint8List(0),
        expected: leaf,
        refresh: null,
      );
      expect(e.proceed, isFalse);
    });

    test('an off-origin failure never calls the refresh', () async {
      var refreshed = 0;
      await judge(url: 'https://evil.example/', expected: null, refresh: () async {
        refreshed++;
        return leaf;
      });
      expect(refreshed, 0);
    });

    test('same length, one byte different cancels', () async {
      final other = Uint8List.fromList(leaf)..[63] ^= 1;
      final v = await judge(presented: other, expected: leaf);
      expect(v.proceed, isFalse);
    });
  });

  test('shortSha shows the first 16 hex characters', () {
    expect(shortSha('0123456789abcdef0123'), '0123456789abcdef');
    expect(shortSha(null), '-');
  });
}
