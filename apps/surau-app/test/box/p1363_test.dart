import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:surau_app/box/device_key.dart';

Uint8List hex(String s) {
  final out = Uint8List(s.length ~/ 2);
  for (var i = 0; i < out.length; i++) {
    out[i] = int.parse(s.substring(i * 2, i * 2 + 2), radix: 16);
  }
  return out;
}

void main() {
  group('derToP1363', () {
    test('leading 0x00 on r (high bit) gives 64 bytes', () {
      // r = 0x80 followed by 31 bytes (DER pads 0x00), s = 0x01
      final r = 'aa' * 32;
      final der = hex('3026' '0221' '00$r' '0201' '01');
      // length: 0x02 0x21 (33) + 0x02 0x01 0x01 = 35 + 3 = 38 = 0x26
      final out = derToP1363(der);
      expect(out.length, 64);
      expect(out.sublist(0, 32), hex(r));
      expect(out.sublist(32, 63), List.filled(31, 0));
      expect(out[63], 1);
    });

    test('short r and s are left padded with zeros', () {
      final der = hex('3006' '020105' '020107');
      final out = derToP1363(der);
      expect(out.length, 64);
      expect(out[31], 5);
      expect(out[63], 7);
      expect(out.sublist(0, 31).every((b) => b == 0), isTrue);
      expect(out.sublist(32, 63).every((b) => b == 0), isTrue);
    });

    test('long-form length (0x81) is rejected as non-DER for P-256', () {
      final r = 'bb' * 32;
      final s = 'cc' * 32;
      expect(() => derToP1363(hex('3081' '46' '0221' '00$r' '0221' '00$s')),
          throwsFormatException);
    });

    test('two 33-byte padded integers (70 byte body) convert', () {
      final r = 'bb' * 32;
      final s = 'cc' * 32;
      expect(derToP1363(hex('3046' '0221' '00$r' '0221' '00$s')), hex('$r$s'));
    });

    test('rejects malformed DER', () {
      final good = hex('3006' '020105' '020107');
      expect(() => derToP1363(Uint8List(0)), throwsFormatException);
      expect(() => derToP1363(hex('3106020105020107')), throwsFormatException); // tag
      expect(() => derToP1363(hex('300602010502010700')), throwsFormatException); // trailing
      expect(() => derToP1363(hex('30050201050201')), throwsFormatException); // truncated
      expect(() => derToP1363(hex('3006020105030107')), throwsFormatException); // not INTEGER
      expect(() => derToP1363(hex('3006020100020107')), throwsFormatException); // r = 0
      expect(() => derToP1363(hex('3006028105020107')), throwsFormatException); // long int len
      expect(() => derToP1363(hex('30060201850201ff')), throwsFormatException); // r negative
      final big = hex('3026' '0221' '01${'aa' * 32}' '020101'); // r > 32 bytes
      expect(() => derToP1363(big), throwsFormatException);
      expect(derToP1363(good).length, 64);
    });

    test('Node vectors: every edge case converts to the expected P1363', () {
      final v = jsonDecode(
        File('test/fixtures/vectors/node-signed.json').readAsStringSync(),
      ) as Map<String, dynamic>;
      final cases = v['derCases'] as List<dynamic>;
      expect(cases.length, greaterThanOrEqualTo(6));
      for (final c in cases.cast<Map<String, dynamic>>()) {
        final out = derToP1363(hex(c['derHex'] as String));
        expect(out, hex(c['p1363Hex'] as String), reason: c['name'] as String);
      }
    });
  });

  group('base64url', () {
    test('64 bytes has no padding and no + or /', () {
      final bytes = Uint8List.fromList(List.generate(64, (i) => 0xfb + (i % 5)));
      final s = b64url(bytes);
      expect(s.contains('='), isFalse);
      expect(s.contains('+'), isFalse);
      expect(s.contains('/'), isFalse);
      expect(s.length, 86);
      expect(unB64url(s), bytes);
    });

    test('unB64url rejects padding, standard alphabet and junk', () {
      expect(() => unB64url('AAAA=='), throwsFormatException);
      expect(() => unB64url('+/+/'), throwsFormatException);
      expect(() => unB64url('A'), throwsFormatException);
      expect(() => unB64url('AA AA'), throwsFormatException);
    });
  });

  group('unlockMessage', () {
    test('is the exact utf8 text', () {
      final m = unlockMessage('a1b2c3d4e5f60718', 'dev1', 'nonce');
      expect(utf8.decode(m), 'surau-unlock\na1b2c3d4e5f60718\ndev1\nnonce');
    });
  });
}
