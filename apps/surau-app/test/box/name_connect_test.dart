@TestOn('vm')
library;

import 'dart:io';
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:surau_app/box/routes.dart';
import 'package:surau_app/box/trust_platform_io.dart' as platform;

// Fixtures of test/box/trust_nc_test.dart: a DNS-constrained root and a leaf
// with SAN IP:127.0.0.1, DNS:localhost, DNS:box.surau.local. The "ip-" pair
// is a second, unrelated root with its own leaf (a box of another surau).
const _dir = 'test/fixtures/tls-nc';

Future<HttpServer> _serve(String pfx, String pass) async {
  final bytes = File('$_dir/$pfx').readAsBytesSync();
  final password = File('$_dir/$pass').readAsStringSync().trim();
  final ctx = SecurityContext()
    ..useCertificateChainBytes(bytes, password: password)
    ..usePrivateKeyBytes(bytes, password: password);
  final s = await HttpServer.bindSecure(InternetAddress.loopbackIPv4, 0, ctx);
  s.listen((req) async {
    req.response.write('ok');
    await req.response.close();
  });
  addTearDown(() => s.close(force: true));
  return s;
}

Future<int> _get(
  Uint8List root,
  Uri url, {
  String? Function(String host)? addressOf,
}) async {
  final c = platform.createClient(
    root,
    const Duration(seconds: 5),
    addressOf: addressOf,
  );
  try {
    return (await c.get(url).timeout(const Duration(seconds: 10))).statusCode;
  } finally {
    c.close();
  }
}

void main() {
  setUpAll(() => HttpOverrides.global = null);

  final root = File('$_dir/root-ca.cer').readAsBytesSync();

  test('a name with a given address is verified by NAME against the pinned CA', () async {
    final s = await _serve('box.pfx', 'pfx.pass');
    final url = Uri.parse('https://box.surau.local:${s.port}/');
    final code = await _get(root, url, addressOf: (h) => h == 'box.surau.local' ? '127.0.0.1' : null);
    expect(code, 200);
  });

  test('the address given is never trusted: a name the leaf does not carry fails', () async {
    final s = await _serve('box.pfx', 'pfx.pass');
    final url = Uri.parse('https://box9-surau.local:${s.port}/');
    await expectLater(
      _get(root, url, addressOf: (h) => '127.0.0.1'),
      throwsA(anything),
    );
  });

  test('a box of another surau (wrong CA) is refused even by its own name', () async {
    final s = await _serve('ip-box.pfx', 'ip-pfx.pass');
    final url = Uri.parse('https://box.surau.local:${s.port}/');
    await expectLater(
      _get(root, url, addressOf: (h) => '127.0.0.1'),
      throwsA(anything),
    );
  });

  test('a name with no mapping is not connected to anything', () async {
    final s = await _serve('box.pfx', 'pfx.pass');
    final url = Uri.parse('https://box.surau.local:${s.port}/');
    await expectLater(_get(root, url, addressOf: (_) => null), throwsA(anything));
  });

  test('an unmapped IP origin still verifies by its IP SAN', () async {
    final s = await _serve('box.pfx', 'pfx.pass');
    final url = Uri.parse('https://127.0.0.1:${s.port}/');
    expect(await _get(root, url, addressOf: (_) => null), 200);
  });

  group('BoxRoutes', () {
    test('accepts only a box name and an IPv4, reports changes once', () {
      final r = BoxRoutes();
      expect(r.set('box1-surau.local', '10.0.0.5'), isTrue);
      expect(r.set('box1-surau.local', '10.0.0.5'), isFalse);
      expect(r.set('evil.com', '10.0.0.5'), isFalse);
      expect(r.set('box2-surau.local', 'evil.com'), isFalse);
      expect(r.addressOf('BOX1-surau.local'), '10.0.0.5');
      expect(r.addressOf('box2-surau.local'), isNull);
      expect(r.epoch.value, 1);
      r.remove('box1-surau.local');
      expect(r.addressOf('box1-surau.local'), isNull);
      expect(r.epoch.value, 2);
    });
  });
}
