@TestOn('vm')
library;

import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'dart:typed_data';

import 'package:surau_app/box/box_qr.dart';
import 'package:surau_app/box/device_key.dart' show b64url;
import 'package:surau_app/box/device_key_software.dart';
import 'package:surau_app/sync/canonical.dart';

// The shared vectors, read in place: the same file packages/core/test/boxQr.test.ts pins.
List<Map<String, dynamic>> _cases() {
  final f = File('../../packages/core/test/fixtures/box-qr-vectors.json');
  final j = jsonDecode(f.readAsStringSync()) as Map<String, dynamic>;
  return (j['cases'] as List).cast<Map<String, dynamic>>();
}

String _enc(Map<String, dynamic> m) => 'maxcom1:${base64Url.encode(utf8.encode(jsonEncode(m))).replaceAll('=', '')}';

Map<String, dynamic> _payloadOf(Map<String, dynamic> c) => Map<String, dynamic>.of(c['payload'] as Map<String, dynamic>);

String _hex(List<int> b) => b.map((x) => x.toRadixString(16).padLeft(2, '0')).join();

void main() {
  final cases = _cases();

  test('there are ten vectors', () => expect(cases.length, 10));

  for (final c in cases) {
    test('parses, matches the pinned message and verifies: ${c['name']}', () {
      final p = BoxQrPayload.parse(c['text'] as String, requireCa: false);
      final want = c['payload'] as Map<String, dynamic>;
      expect(p.type, want['type']);
      expect(p.boxId, want['boxId']);
      expect(p.keyFp, c['keyFp']);
      expect(p.name, want['name']);
      expect(p.box, want['box']);
      expect(p.caSha256, want['caSha256']);
      expect(p.linked, want['linked']);
      expect(p.cloud, want['cloud']);
      expect(p.nonce, want['nonce']);
      expect(p.iat, want['iat']);
      expect(p.exp, want['exp']);
      expect(_hex(p.message), c['messageHex']);
      expect(p.verifySignature(), isTrue);
    });
  }

  test('a box on the default HTTPS port is written without it: https://host parses, https://host:443 does not', () async {
    // the box (apps/box-server stateRoutes boxOrigin) omits :443; the TS parser (packages/core boxQr.ts) agrees
    final key = SoftwareDeviceKey.random();
    final pub = await key.publicJwk();
    Future<String> signed(String box) async {
      final m = _payloadOf(cases.first);
      m
        ..['pub'] = {'kty': 'EC', 'crv': 'P-256', 'x': pub['x'], 'y': pub['y']}
        ..['keyFp'] = keyFingerprint(m['pub'] as Map<String, dynamic>)
        ..['box'] = box
        ..remove('sig');
      final head = 'maxcom-qr\n${m['boxId']}\n${m['type']}\n';
      final msg = utf8.encode('$head${sha256HexOf(utf8.encode(canonicalJson(m)))}');
      m['sig'] = b64url(await key.sign(Uint8List.fromList(msg)));
      return _enc(m);
    }

    expect(BoxQrPayload.parse(await signed('https://10.168.0.20'), requireCa: false).box, 'https://10.168.0.20');
    expect(BoxQrPayload.parse(await signed('https://10.168.0.20:8443'), requireCa: false).box, 'https://10.168.0.20:8443');
    final with443 = await signed('https://10.168.0.20:443');
    expect(() => BoxQrPayload.parse(with443, requireCa: false), throwsA(isA<BoxQrInvalid>()));
  });

  test('a flipped signature character is refused', () {
    final m = _payloadOf(cases.first);
    final sig = m['sig'] as String;
    m['sig'] = (sig[0] == 'A' ? 'B' : 'A') + sig.substring(1);
    expect(() => BoxQrPayload.parse(_enc(m), requireCa: false), throwsA(isA<BoxQrInvalid>()));
  });

  test('a changed field breaks the signature even when the shape is fine', () {
    final m = _payloadOf(cases.first)..['name'] = 'MAXCOM Lain';
    expect(() => BoxQrPayload.parse(_enc(m), requireCa: false), throwsA(isA<BoxQrInvalid>()));
    final m2 = _payloadOf(cases.first)..['linked'] = true;
    expect(() => BoxQrPayload.parse(_enc(m2), requireCa: false), throwsA(isA<BoxQrInvalid>()));
    final m3 = _payloadOf(cases.first)..['exp'] = (_payloadOf(cases.first)['exp'] as int) + 3600;
    expect(() => BoxQrPayload.parse(_enc(m3), requireCa: false), throwsA(isA<BoxQrInvalid>()));
  });

  test('a keyFp that is not sha256(pub) is refused', () {
    final m = _payloadOf(cases.first)..['keyFp'] = '0123456789abcdef';
    expect(() => BoxQrPayload.parse(_enc(m), requireCa: false), throwsA(isA<BoxQrInvalid>()));
  });

  test('a swapped public key (keyFp recomputed would differ) is refused', () {
    final a = _payloadOf(cases.first);
    final other = Map<String, dynamic>.of(a['pub'] as Map<String, dynamic>);
    other['x'] = other['y'];
    a['pub'] = other;
    expect(() => BoxQrPayload.parse(_enc(a), requireCa: false), throwsA(isA<BoxQrInvalid>()));
  });

  test('unknown keys, plain http, a path, exp <= iat, a short nonce and a long name are refused', () {
    void bad(void Function(Map<String, dynamic>) edit) {
      final m = _payloadOf(cases.first);
      edit(m);
      expect(() => BoxQrPayload.parse(_enc(m), requireCa: false), throwsA(isA<BoxQrInvalid>()));
    }

    bad((m) => m['extra'] = 1);
    bad((m) => m['box'] = 'http://10.168.0.20:8443');
    bad((m) => m['box'] = 'https://10.168.0.20:8443/x');
    bad((m) => m['box'] = 'https://user@10.168.0.20:8443');
    bad((m) => m['cloud'] = 'https://api.mymaxcom.my/path');
    bad((m) => m['exp'] = m['iat']);
    bad((m) => m['nonce'] = 'short');
    bad((m) => m['name'] = 'x' * 61);
    bad((m) => m['name'] = '');
    bad((m) => m['v'] = 2);
    bad((m) => m['type'] = 'admin');
    bad((m) => m['caSha256'] = 'xyz');
    bad((m) => m['linked'] = 'yes');
    bad((m) => (m['pub'] as Map<String, dynamic>)['d'] = 'x');
  });

  test('junk, a wrong prefix and an oversized text are refused', () {
    expect(() => BoxQrPayload.parse('surau1:abc', requireCa: false), throwsA(isA<BoxQrInvalid>()));
    expect(() => BoxQrPayload.parse('maxcom1:!!!', requireCa: false), throwsA(isA<BoxQrInvalid>()));
    expect(() => BoxQrPayload.parse('maxcom1:${'A' * 5000}', requireCa: false), throwsA(isA<BoxQrInvalid>()));
    expect(() => BoxQrPayload.parse('maxcom1:${base64Url.encode(utf8.encode('[1,2]')).replaceAll('=', '')}', requireCa: false),
        throwsA(isA<BoxQrInvalid>()));
  });

  test('requireCa (Android) refuses a box with no HTTPS address or no CA fingerprint', () {
    final noHttps = cases.firstWhere((c) => (c['payload'] as Map)['box'] == '');
    expect(() => BoxQrPayload.parse(noHttps['text'] as String, requireCa: true), throwsA(isA<BoxQrInvalid>()));
    final ok = cases.firstWhere((c) => (c['payload'] as Map)['box'] != '' && (c['payload'] as Map)['caSha256'] != null);
    expect(BoxQrPayload.parse(ok['text'] as String, requireCa: true).box, startsWith('https://'));
  });

  test('kindOf tells the prefixes and the type apart', () {
    String textOf(String type) => cases.firstWhere((c) => (c['payload'] as Map)['type'] == type)['text'] as String;
    expect(kindOf(textOf('setup')), ScannedKind.setup);
    expect(kindOf(textOf('recovery')), ScannedKind.recovery);
    expect(kindOf(textOf('probe')), ScannedKind.probe);
    expect(kindOf('surau1:eyJ2IjoxfQ'), ScannedKind.enrol);
    expect(kindOf('  ${textOf('setup')}  '), ScannedKind.setup);
    expect(kindOf('https://example.com'), ScannedKind.unknown);
    expect(kindOf('maxcom1:???'), ScannedKind.unknown);
    expect(kindOf(_enc({'type': 'bogus'})), ScannedKind.unknown);
    expect(kindOf(''), ScannedKind.unknown);
  });

  test('isExpired follows the phone clock; fingerprint groups are four by four', () {
    final p = BoxQrPayload.parse(cases.first['text'] as String, requireCa: false);
    expect(p.isExpired(DateTime.fromMillisecondsSinceEpoch((p.exp - 1) * 1000)), isFalse);
    expect(p.isExpired(DateTime.fromMillisecondsSinceEpoch(p.exp * 1000)), isTrue);
    expect(p.isExpired(DateTime.fromMillisecondsSinceEpoch((p.exp + 3600) * 1000)), isTrue);
    expect(fingerprintGroupsOf('4f2a9c1e77b0d3a1'), '4F2A 9C1E 77B0 D3A1');
    expect(p.fingerprintGroups, matches(RegExp(r'^[0-9A-F]{4}( [0-9A-F]{4}){3}$')));
  });
}
