import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:surau_app/box/payload.dart';

String enc(Map<String, Object?> m) => 'surau1:${base64Url.encode(utf8.encode(jsonEncode(m))).replaceAll('=', '')}';

Map<String, Object?> good() => {
  'v': 1,
  'mode': 'ip',
  'box': 'https://10.168.0.154:8443',
  'boxId': '0123456789abcdef',
  'caSha256': 'abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789',
  'code': 'ABCD-EFGH-2345',
  'user': 'Ustaz Ali',
  'exp': 1893456000000,
};

void main() {
  // Same shape as the payload built by POST /api/enrol/begin (auth/routes.ts).
  const boxMade =
      'surau1:eyJ2IjoxLCJtb2RlIjoiaXAiLCJib3giOiJodHRwczovLzEwLjE2OC4wLjE1NDo4NDQzIiwiYm94SWQiOiIwMTIzNDU2Nzg5YWJjZGVmIiwiY2FTaGEyNTYiOiJhYmNkZWYwMTIzNDU2Nzg5YWJjZGVmMDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWYwMTIzNDU2Nzg5IiwiY29kZSI6IkFCQ0QtRUZHSC0yMzQ1IiwidXNlciI6IlVzdGF6IEFsaSIsImV4cCI6MTg5MzQ1NjAwMDAwMH0';

  test('parses a box-made payload', () {
    final p = EnrolPayload.parse(boxMade);
    expect(p.mode, 'ip');
    expect(p.box, 'https://10.168.0.154:8443');
    expect(p.boxId, '0123456789abcdef');
    expect(p.code, 'ABCD-EFGH-2345');
    expect(p.user, 'Ustaz Ali');
    expect(p.exp, 1893456000000);
    expect(p.caSha256, 'abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789');
  });

  test('pinSet: true, false and absent (older box)', () {
    expect(EnrolPayload.parse(enc(good()..['pinSet'] = true)).pinSet, isTrue);
    expect(EnrolPayload.parse(enc(good()..['pinSet'] = false)).pinSet, isFalse);
    expect(EnrolPayload.parse(enc(good())).pinSet, isNull);
    expect(EnrolPayload.parse(boxMade).pinSet, isNull);
    expect(() => EnrolPayload.parse(enc(good()..['pinSet'] = 'yes')), throwsFormatException);
  });

  test('appLock: false, true, absent (older box -> null) and a string is refused', () {
    expect(EnrolPayload.parse(enc(good()..['appLock'] = false)).appLock, isFalse);
    expect(EnrolPayload.parse(enc(good()..['appLock'] = true)).appLock, isTrue);
    expect(EnrolPayload.parse(enc(good())).appLock, isNull);
    expect(() => EnrolPayload.parse(enc(good()..['appLock'] = 'no')), throwsFormatException);
    expect(() => EnrolPayload.parse(enc(good()..['appLock'] = 0)), throwsFormatException);
  });

  test('plain http to a LAN address is refused', () {
    final m = good()..['box'] = 'http://10.168.0.154';
    expect(() => EnrolPayload.parse(enc(m)), throwsFormatException);
  });

  test('http loopback is accepted where allowed (debug builds), only as 127.0.0.1', () {
    final m = good()..['box'] = 'http://127.0.0.1:8787';
    expect(EnrolPayload.parse(enc(m), allowLoopback: true).box, 'http://127.0.0.1:8787');
    final l = good()..['box'] = 'http://localhost:8787';
    expect(() => EnrolPayload.parse(enc(l), allowLoopback: true), throwsFormatException);
  });

  test('http loopback is refused when not allowed (release builds)', () {
    final m = good()..['box'] = 'http://127.0.0.1:8787';
    expect(
      () => EnrolPayload.parse(enc(m), allowLoopback: false),
      throwsA(isA<FormatException>().having((e) => e.message, 'message', 'Kod QR pendaftaran tidak sah')),
    );
    final s = good()..['box'] = 'https://127.0.0.1:8443';
    expect(EnrolPayload.parse(enc(s), allowLoopback: false).box, 'https://127.0.0.1:8443');
  });

  test('requireCa: a payload without caSha256 is a bad QR where the app pins the CA', () {
    final n = good()..remove('caSha256');
    expect(EnrolPayload.parse(enc(n)).caSha256, isNull);
    expect(
      () => EnrolPayload.parse(enc(n), requireCa: true),
      throwsA(isA<FormatException>().having((e) => e.message, 'message', 'Kod QR pendaftaran tidak sah')),
    );
    final nul = good()..['caSha256'] = null;
    expect(() => EnrolPayload.parse(enc(nul), requireCa: true), throwsFormatException);
    expect(EnrolPayload.parse(enc(good()), requireCa: true).caSha256, isNotNull);
  });

  test('tampered base64 is refused with the BM message', () {
    expect(
      () => EnrolPayload.parse('$boxMade!'),
      throwsA(isA<FormatException>().having((e) => e.message, 'message', 'Kod QR pendaftaran tidak sah')),
    );
    expect(() => EnrolPayload.parse('surau1:abcde'), throwsFormatException);
    expect(() => EnrolPayload.parse('nope'), throwsFormatException);
  });

  test('upper-case caSha256 comes out lower-case; null allowed', () {
    final m = good()..['caSha256'] = 'ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789';
    expect(EnrolPayload.parse(enc(m)).caSha256, 'abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789');
    final n = good()..['caSha256'] = null;
    expect(EnrolPayload.parse(enc(n)).caSha256, isNull);
  });

  test('rejects defects', () {
    for (final patch in <Map<String, Object?>>[
      {'v': 2},
      {'mode': 'x'},
      {'boxId': 'xyz'},
      {'code': 'ABCD-EFGH'},
      {'code': 'ABCD-EFGH-2341'},
      {'user': 'a' * 81},
      {'exp': 'soon'},
      {'caSha256': 'abc'},
      {'box': 'https://u:p@10.168.0.154'},
      {'box': 'https://10.168.0.154/x'},
      {'box': 'https://10.168.0.154/?a=1'},
      {'box': 'https://10.168.0.154/#h'},
      {'box': 5},
    ]) {
      final m = good()..addAll(patch);
      expect(() => EnrolPayload.parse(enc(m)), throwsFormatException, reason: '$patch');
    }
  });

  test('origin is normalised and code without dashes accepted', () {
    final m = good()
      ..['box'] = 'https://Surau.Local:443/'
      ..['code'] = 'ABCDEFGH2345';
    final p = EnrolPayload.parse(enc(m));
    expect(p.box, 'https://surau.local');
    expect(p.code, 'ABCDEFGH2345');
  });
}
