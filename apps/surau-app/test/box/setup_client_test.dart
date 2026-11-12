@TestOn('vm')
library;

import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:surau_app/box/box_client.dart';
import 'package:surau_app/box/box_qr.dart';
import 'package:surau_app/box/setup_client.dart';

final box = Uri.parse('https://10.168.0.154:8443');

http.Response json(int status, Object body, {Map<String, String>? headers}) =>
    http.Response(jsonEncode(body), status, headers: {'content-type': 'application/json', ...?headers});

SetupClient clientFor(MockClientHandler h) => SetupClient(BoxClient(box, MockClient(h)));

const jwk = {'kty': 'EC', 'crv': 'P-256', 'x': 'x', 'y': 'y'};

SetupRequest setupReq() => const SetupRequest(
  nonce: 'n',
  surauName: 'Surau Al-Hidayah',
  boxName: 'MAXCOM Dewan Utama',
  adminName: 'Haji Ali',
  deviceName: 'vivo Y36',
  publicJwk: jwk,
  platform: 'android',
  pin: '482916',
);

RecoveryRequest recoveryReq() => const RecoveryRequest(
  nonce: 'n',
  recoveryCode: 'ABCD-EFGH-JKLM-NPQR',
  adminName: 'Haji Ali',
  deviceName: 'iPad',
  publicJwk: jwk,
  platform: 'ios-web',
  pin: '482916',
);

const okBody = {
  'deviceId': 'd1',
  'userId': 'u1',
  'roles': ['admin'],
  'pinRequired': false,
  'appLock': true,
  'recoveryCode': 'ABCD-EFGH-JKLM-NPQR',
  'surauId': 'abcdefghijkl',
  'boxName': 'MAXCOM Dewan Utama',
  'surauName': 'Surau Al-Hidayah',
};

void main() {
  test('boxInfo reads the public answer', () async {
    late http.Request seen;
    final info = await clientFor((r) async {
      seen = r;
      return json(200, {
        'boxId': '0123456789abcdef',
        'keyFp': 'fedcba9876543210',
        'name': 'MAXCOM 0123',
        'state': 'setup',
        'reason': 'none',
        'linked': false,
        'https': true,
        'caSha256': 'a' * 64,
      });
    }).boxInfo();
    expect(seen.method, 'GET');
    expect(seen.url.path, '/api/box/info');
    expect(info.state, 'setup');
    expect(info.fingerprintGroups, 'FEDC BA98 7654 3210');
    expect(info.https, isTrue);
  });

  test('setupComplete sends the exact body (with a PIN) and parses the 201', () async {
    late http.Request seen;
    final r = await clientFor((req) async {
      seen = req;
      return json(201, okBody);
    }).setupComplete(setupReq());
    expect(seen.method, 'POST');
    expect(seen.url.path, '/api/setup/complete');
    expect(jsonDecode(seen.body), {
      'nonce': 'n',
      'surauName': 'Surau Al-Hidayah',
      'boxName': 'MAXCOM Dewan Utama',
      'adminName': 'Haji Ali',
      'deviceName': 'vivo Y36',
      'publicJwk': jwk,
      'platform': 'android',
      'pin': '482916',
    });
    expect(r.recoveryCode, 'ABCD-EFGH-JKLM-NPQR');
    expect(r.deviceId, 'd1');
    expect(r.roles, ['admin']);
  });

  test('setupComplete maps 409 already_set_up, 401 bad_code and 429', () async {
    await expectLater(
      clientFor((r) async => json(409, {'errors': ['x'], 'code': 'already_set_up'})).setupComplete(setupReq()),
      throwsA(isA<SetupAlreadyDone>()),
    );
    await expectLater(
      clientFor((r) async => json(401, {'errors': ['x'], 'code': 'bad_code'})).setupComplete(setupReq()),
      throwsA(isA<SetupCodeInvalid>()),
    );
    await expectLater(
      clientFor((r) async => json(429, {'errors': ['x']}, headers: {'retry-after': '120'})).setupComplete(setupReq()),
      throwsA(isA<TooManyAttempts>().having((e) => e.retryAfterSec, 'retryAfterSec', 120)),
    );
    // anything else stays a plain BoxError
    await expectLater(
      clientFor((r) async => json(400, {'errors': ['PIN mesti 6 digit'], 'code': 'pin_policy'})).setupComplete(setupReq()),
      throwsA(isA<BoxError>().having((e) => e.code, 'code', 'pin_policy')),
    );
  });

  test('recoveryComplete sends the code and maps its refusals', () async {
    late http.Request seen;
    final r = await clientFor((req) async {
      seen = req;
      return json(201, okBody);
    }).recoveryComplete(recoveryReq());
    expect(seen.url.path, '/api/recovery/complete');
    expect(jsonDecode(seen.body)['recoveryCode'], 'ABCD-EFGH-JKLM-NPQR');
    expect(r.recoveryCode, isNotEmpty);
    await expectLater(
      clientFor((r) async => json(409, {'errors': ['x'], 'code': 'not_in_recovery'})).recoveryComplete(recoveryReq()),
      throwsA(isA<RecoveryNotNeeded>()),
    );
    await expectLater(
      clientFor((r) async => json(401, {'errors': ['x'], 'code': 'bad_code'})).recoveryComplete(recoveryReq()),
      throwsA(isA<SetupCodeInvalid>()),
    );
    await expectLater(
      clientFor((r) async => json(429, {'errors': ['x']})).recoveryComplete(recoveryReq()),
      throwsA(isA<TooManyAttempts>()),
    );
  });

  test('probe posts the nonce', () async {
    late http.Request seen;
    await clientFor((r) async {
      seen = r;
      return json(200, {'ok': true});
    }).probe('abc');
    expect(seen.url.path, '/api/setup/probe');
    expect(jsonDecode(seen.body), {'nonce': 'abc'});
  });

  test('a box that cannot be reached stays BoxUnreachable', () async {
    await expectLater(
      clientFor((r) async => throw http.ClientException('no route')).boxInfo(),
      throwsA(isA<BoxUnreachable>()),
    );
  });

  group('checkBoxMatches', () {
    final p = BoxQrPayload.parse(_setupText, requireCa: false);
    BoxInfo info(String boxId, String keyFp) => BoxInfo(
      boxId: boxId,
      keyFp: keyFp,
      name: 'x',
      state: 'setup',
      reason: 'none',
      linked: false,
      https: true,
      caSha256: null,
    );

    test('passes when boxId and keyFp agree', () => checkBoxMatches(p, info(p.boxId, p.keyFp)));

    test('throws on a different keyFp or a different boxId', () {
      expect(() => checkBoxMatches(p, info(p.boxId, '0123456789abcdef')), throwsA(isA<BoxQrMismatch>()));
      expect(() => checkBoxMatches(p, info('0123456789abcdef', p.keyFp)), throwsA(isA<BoxQrMismatch>()));
    });
  });
}

// A real signed setup payload from the shared vectors (read in place).
final String _setupText = () {
  final f = jsonDecode(File('../../packages/core/test/fixtures/box-qr-vectors.json').readAsStringSync()) as Map<String, dynamic>;
  final cases = (f['cases'] as List).cast<Map<String, dynamic>>();
  return cases.firstWhere((c) => (c['payload'] as Map)['type'] == 'setup')['text'] as String;
}();
