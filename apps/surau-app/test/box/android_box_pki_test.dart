@TestOn('vm')
library;

import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:surau_app/box/trust.dart';

// Fixtures made by the Kotlin certificate authority of the Android box
// (apps/box-android, core/BoxCa.kt), NOT by scripts/box-ca.ps1: a P-256 root
// with a critical DNS-only NameConstraints, and a P-256 leaf with IP:127.0.0.1,
// IP:10.168.1.20, DNS:localhost, DNS:box.surau.local, server authentication.
// They are rewritten by `BoxCaTest.writeDartFixtures` (JVM test, run with the
// environment variable MAXCOM_WRITE_PKI_FIXTURES set to this folder). The keys
// are fixed test keys; nothing here protects anything.
//
//   root-ca.cer           root A (what the QR's caSha256 is the hash of)
//   box-leaf.cer          leaf signed by root A
//   box-key.pem           the leaf's PKCS#8 key (what tls.ts loads)
//   other-root-ca.cer     root B, a second surau's root
//   other-box-leaf.cer    leaf signed by root B for the same names and key
//   evil-box-leaf.cer     leaf signed by root A that also names evil.example
//   fixture-info.json     root hashes, leaf expiry
const _dir = 'test/fixtures/android-box-pki';

Uint8List _bytes(String name) => File('$_dir/$name').readAsBytesSync();

String _pem(Uint8List der, String label) {
  final b64 = base64.encode(der);
  final lines = <String>[];
  for (var i = 0; i < b64.length; i += 64) {
    lines.add(b64.substring(i, i + 64 > b64.length ? b64.length : i + 64));
  }
  return '-----BEGIN $label-----\n${lines.join('\n')}\n-----END $label-----\n';
}

/// An HTTPS server on loopback presenting [leaf] with the fixture key. It
/// answers `/api/pki/root.cer` with [rootDer] and everything else with `ok`.
Future<HttpServer> _serve(String leaf, Uint8List rootDer) async {
  final ctx = SecurityContext()
    ..useCertificateChainBytes(utf8.encode(_pem(_bytes(leaf), 'CERTIFICATE')))
    ..usePrivateKeyBytes(_bytes('box-key.pem'));
  final s = await HttpServer.bindSecure(InternetAddress.loopbackIPv4, 0, ctx);
  s.listen((req) async {
    try {
      if (req.uri.path == '/api/pki/root.cer') {
        req.response.add(rootDer);
      } else {
        req.response.write('ok');
      }
      await req.response.close();
    } on Object {
      // the client went away
    }
  });
  addTearDown(() => s.close(force: true));
  return s;
}

void main() {
  late final Map<String, dynamic> info;
  late final Uint8List rootA;

  setUpAll(() {
    // flutter_test fakes every HttpClient with status 400; we need real TLS.
    HttpOverrides.global = null;
    info = jsonDecode(File('$_dir/fixture-info.json').readAsStringSync())
        as Map<String, dynamic>;
    rootA = _bytes('root-ca.cer');
  });

  test('the fixture leaf is still valid (else remake the fixtures)', () {
    final notAfter = DateTime.parse(info['leafNotAfter'] as String);
    expect(
      DateTime.now().toUtc().isBefore(notAfter.subtract(const Duration(days: 7))),
      isTrue,
      reason:
          'The Android PKI fixture leaf expires ${info['leafNotAfter']}. Run '
          'BoxCaTest.writeDartFixtures (MAXCOM_WRITE_PKI_FIXTURES=<this folder>) '
          'and commit the new files.',
    );
  });

  test('caSha256 is the sha256 of the root the Kotlin code made', () {
    expect(sha256Hex(rootA), info['rootSha256']);
    expect(sha256Hex(_bytes('other-root-ca.cer')), info['otherRootSha256']);
    expect(sha256Hex(rootA), isNot(sha256Hex(_bytes('other-root-ca.cer'))));
  });

  test('the app downloads the root, checks caSha256, pins it and trusts the box',
      () async {
    final s = await _serve('box-leaf.cer', rootA);
    final box = Uri.parse('https://127.0.0.1:${s.port}');
    final trust = TrustStore();

    // Same path as PinnedEnrolTrust.establish: fetch without trust, accept
    // only the QR's hash.
    final der = await trust.fetchAndCheckRootCa(
      box,
      (info['rootSha256'] as String).toUpperCase(),
    );
    expect(der, rootA);
    await expectLater(
      trust.fetchAndCheckRootCa(box, info['otherRootSha256'] as String),
      throwsA(isA<TrustError>()),
    );

    // Then every request uses a client holding that one root and no system
    // roots: by IP name (the leaf's IP SAN) and by DNS name.
    final client = trust.pinnedClientSync(der);
    addTearDown(client.close);
    final byIp = await client.get(Uri.parse('https://127.0.0.1:${s.port}/'));
    expect(byIp.statusCode, 200);
    expect(byIp.body, 'ok');
    final byName = await client.get(Uri.parse('https://localhost:${s.port}/x'));
    expect(byName.statusCode, 200);
  });

  test('a client pinned to this root refuses a box of another root', () async {
    final s = await _serve('other-box-leaf.cer', _bytes('other-root-ca.cer'));
    final client = TrustStore().pinnedClientSync(rootA);
    addTearDown(client.close);
    await expectLater(
      client.get(Uri.parse('https://127.0.0.1:${s.port}/')),
      throwsA(anything),
    );
    await expectLater(
      client.get(Uri.parse('https://localhost:${s.port}/')),
      throwsA(anything),
    );
    // the same server is healthy: its own root is accepted
    final own = TrustStore().pinnedClientSync(_bytes('other-root-ca.cer'));
    addTearDown(own.close);
    expect((await own.get(Uri.parse('https://127.0.0.1:${s.port}/'))).statusCode, 200);
  });

  test('the root refuses a leaf it signed for a DNS name outside its constraints',
      () async {
    final s = await _serve('evil-box-leaf.cer', rootA);
    final client = TrustStore().pinnedClientSync(rootA);
    addTearDown(client.close);
    await expectLater(
      client.get(Uri.parse('https://localhost:${s.port}/')),
      throwsA(anything),
    );
    // the server itself works: a client that accepts any certificate gets 200,
    // so the refusal above is the name constraint and nothing else
    final lax = HttpClient()..badCertificateCallback = (_, _, _) => true;
    addTearDown(() => lax.close(force: true));
    final req = await lax.getUrl(Uri.parse('https://localhost:${s.port}/'));
    final res = await req.close();
    expect(res.statusCode, 200);
    await res.drain<void>();
  });
}
