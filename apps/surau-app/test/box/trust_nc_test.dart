@TestOn('vm')
library;

import 'dart:io';
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:surau_app/box/trust_platform_io.dart' as platform;

// Fixtures made by scripts/box-ca.ps1 itself (ECDSA P-256 root with a CRITICAL
// DNS-only NameConstraints: localhost, box.surau.local; leaf SAN IP:127.0.0.1,
// DNS:localhost, DNS:box.surau.local; EKU serverAuth). The "ip-" pair was made
// by the older script that also permitted IP:127.0.0.1/32.
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
  return s;
}

Future<int> _get(Uint8List rootDer, Uri url) async {
  final client = platform.createClient(rootDer, const Duration(seconds: 5));
  try {
    final res = await client.get(url).timeout(const Duration(seconds: 10));
    return res.statusCode;
  } finally {
    client.close();
  }
}

void main() {
  // flutter_test fakes every HttpClient with status 400; we need real TLS.
  setUpAll(() => HttpOverrides.global = null);

  test('pinned root with DNS-only NameConstraints verifies a leaf reached by IP',
      () async {
    final s = await _serve('box.pfx', 'pfx.pass');
    addTearDown(() => s.close(force: true));
    final root = File('$_dir/root-ca.cer').readAsBytesSync();
    expect(await _get(root, Uri.parse('https://127.0.0.1:${s.port}/')), 200);
    expect(await _get(root, Uri.parse('https://localhost:${s.port}/')), 200);
  });

  test('a root that also permits an IP subtree FAILS in BoringSSL (do not re-add)',
      () async {
    final s = await _serve('ip-box.pfx', 'ip-pfx.pass');
    addTearDown(() => s.close(force: true));
    final root = File('$_dir/ip-root-ca.cer').readAsBytesSync();
    await expectLater(
      _get(root, Uri.parse('https://127.0.0.1:${s.port}/')),
      throwsA(anything),
    );
  });
}
