import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:surau_app/box/payload.dart';

String _qr(Map<String, Object?> extra) {
  final m = <String, Object?>{
    'v': 1,
    'mode': 'ip',
    'box': 'https://10.168.0.154:8443',
    'boxId': '0123456789abcdef',
    'caSha256': 'a' * 64,
    'code': 'ABCD-EFGH-2345',
    'user': 'Ustaz Ali',
    'exp': 1893456000000,
    ...extra,
  };
  return 'surau1:${base64Url.encode(utf8.encode(jsonEncode(m))).replaceAll('=', '')}';
}

void main() {
  test('a payload without cloud has none', () {
    expect(EnrolPayload.parse(_qr({})).cloud, isNull);
  });

  test('the cloud origin is read, normalised like the box origin', () {
    final p = EnrolPayload.parse(_qr({'cloud': 'https://203.0.113.10:443'}));
    expect(p.cloud, 'https://203.0.113.10');
  });

  test('a cloud that is not a clean https origin refuses the whole QR', () {
    for (final bad in [
      'http://203.0.113.10',
      'https://u:p@203.0.113.10',
      'https://203.0.113.10/path',
      'https://203.0.113.10?x=1',
      7,
    ]) {
      expect(
        () => EnrolPayload.parse(_qr({'cloud': bad}), allowLoopback: false),
        throwsFormatException,
        reason: '$bad',
      );
    }
  });
}
