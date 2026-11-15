@TestOn('vm')
library;

import 'dart:io';
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:surau_app/box/trust_platform_io.dart' as platform;

// Fixtures made by scripts/gen-test-pki-v2.ps1: a V2 root (ECDSA P-256, CRITICAL
// DNS-only NameConstraints: localhost + box1-surau.local ... box99-surau.local,
// as BoxCa.kt PERMITTED_DNS_V2), a leaf for box2-surau.local (+ localhost,
// IP 127.0.0.1) and a leaf for evil-surau.local signed by the same root.
const _dir = 'test/fixtures/tls-nc-v2';

Future<HttpServer> _serve(String pfx) async {
  final bytes = File('$_dir/$pfx').readAsBytesSync();
  final password = File('$_dir/pfx.pass').readAsStringSync().trim();
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

Future<int> _get(Uint8List root, Uri url) async {
  final c = platform.createClient(
    root,
    const Duration(seconds: 5),
    addressOf: (h) => '127.0.0.1',
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

  test('V2 root (99 named subtrees) verifies the box2 leaf by name', () async {
    final s = await _serve('box2.pfx');
    expect(await _get(root, Uri.parse('https://box2-surau.local:${s.port}/')), 200);
  });

  test('V2 root verifies the box2 leaf by localhost', () async {
    final s = await _serve('box2.pfx');
    expect(await _get(root, Uri.parse('https://localhost:${s.port}/')), 200);
  });

  test('a leaf outside the permitted names (evil-surau.local) is rejected', () async {
    final s = await _serve('evil.pfx');
    await expectLater(
      _get(root, Uri.parse('https://evil-surau.local:${s.port}/')),
      throwsA(anything),
    );
  });

  test('another box name is not accepted on the box2 leaf', () async {
    final s = await _serve('box2.pfx');
    await expectLater(
      _get(root, Uri.parse('https://box3-surau.local:${s.port}/')),
      throwsA(anything),
    );
  });
}
