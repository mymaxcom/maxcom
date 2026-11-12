import 'dart:async';
import 'dart:convert';
import 'dart:io' show SocketException;
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:surau_app/box/box_client.dart';

final box = Uri.parse('https://10.168.0.154:8443');

http.Response json(int status, Object body, {Map<String, String>? headers}) =>
    http.Response(
      jsonEncode(body),
      status,
      headers: {'content-type': 'application/json', ...?headers},
    );

BoxClient clientFor(
  MockClientHandler h, {
  Duration connect = const Duration(seconds: 2),
  Duration read = const Duration(seconds: 10),
}) => BoxClient(box, MockClient(h), connect: connect, read: read);

void main() {
  test(
    'unlock posts JSON to /api/auth/unlock and parses the session',
    () async {
      late http.Request seen;
      final c = clientFor((r) async {
        seen = r;
        return json(200, {
          'token': 'tok',
          'expiresAt': '2026-11-04T00:00:00.000Z',
          'user': {
            'id': 'u1',
            'name': 'Ali',
            'roles': ['admin'],
          },
        });
      });
      final s = await c.unlock(
        deviceId: 'dev1',
        nonce: 'n1',
        signatureB64url: 'sig',
        pin: '1234',
      );
      expect(seen.method, 'POST');
      expect(seen.url.toString(), 'https://10.168.0.154:8443/api/auth/unlock');
      expect(seen.headers['content-type'], startsWith('application/json'));
      expect(jsonDecode(seen.body), {
        'deviceId': 'dev1',
        'nonce': 'n1',
        'signature': 'sig',
        'pin': '1234',
      });
      expect(seen.headers.containsKey('authorization'), isFalse);
      expect(s.token, 'tok');
      expect(s.user.roles, ['admin']);
    },
  );

  test('challenge and enrolComplete shapes', () async {
    final seen = <http.Request>[];
    final c = clientFor((r) async {
      seen.add(r);
      if (r.url.path == '/api/auth/challenge') {
        return json(200, {'nonce': 'nn', 'expiresAt': 'x'});
      }
      return json(200, {
        'deviceId': 'd',
        'userId': 'u',
        'roles': ['ajk'],
        'pinRequired': false,
      });
    });
    final ch = await c.challenge('dev1');
    expect(ch.nonce, 'nn');
    expect(jsonDecode(seen[0].body), {'deviceId': 'dev1'});
    final r = await c.enrolComplete(
      code: 'ABCD-EFGH-2345',
      publicJwk: {'kty': 'EC', 'crv': 'P-256', 'x': 'a', 'y': 'b'},
      deviceName: 'Telefon',
      platform: 'android',
    );
    expect(r.deviceId, 'd');
    final body = jsonDecode(seen[1].body) as Map<String, dynamic>;
    expect(body.containsKey('pin'), isFalse);
    expect(body['platform'], 'android');
    expect(body['publicJwk'], {
      'kty': 'EC',
      'crv': 'P-256',
      'x': 'a',
      'y': 'b',
    });
  });

  test('401 on unlock becomes BoxError with the box message', () async {
    final c = clientFor(
      (r) async => json(401, {
        'errors': ['PIN salah'],
      }),
    );
    await expectLater(
      c.unlock(deviceId: 'd', nonce: 'n', signatureB64url: 's', pin: '0000'),
      throwsA(
        isA<BoxError>()
            .having((e) => e.status, 'status', 401)
            .having((e) => e.message, 'message', 'PIN salah')
            .having((e) => e is SessionExpired, 'not SessionExpired', false),
      ),
    );
  });

  test('429 carries Retry-After seconds', () async {
    final c = clientFor(
      (r) async => json(
        429,
        {
          'errors': ['Terlalu banyak percubaan. Sila tunggu'],
        },
        headers: {'retry-after': '30'},
      ),
    );
    await expectLater(
      c.challenge('d'),
      throwsA(
        isA<BoxError>()
            .having((e) => e.status, 'status', 429)
            .having((e) => e.retryAfterSec, 'retryAfterSec', 30),
      ),
    );
  });

  test('423 locked message passes through', () async {
    final c = clientFor(
      (r) async => json(423, {
        'errors': ['Akaun dikunci. Cuba lagi dalam 5 minit'],
      }),
    );
    await expectLater(
      c.unlock(deviceId: 'd', nonce: 'n', signatureB64url: 's', pin: '0000'),
      throwsA(
        isA<BoxError>().having(
          (e) => e.message,
          'message',
          contains('dikunci'),
        ),
      ),
    );
  });

  test('generic message when the body has none', () async {
    final c = clientFor((r) async => http.Response('oops', 500));
    await expectLater(
      c.getJson('/api/health'),
      throwsA(
        isA<BoxError>().having((e) => e.message, 'message', 'Permintaan gagal'),
      ),
    );
  });

  test('getJson with token: 401 is SessionExpired, header only', () async {
    late http.Request seen;
    final c = clientFor((r) async {
      seen = r;
      return json(401, {
        'errors': ['Sesi tamat. Sila buka kunci semula'],
      });
    });
    await expectLater(
      c.getJson('/api/users', token: 'abc'),
      throwsA(isA<SessionExpired>()),
    );
    expect(seen.headers['authorization'], 'Bearer abc');
    expect(seen.url.toString().contains('abc'), isFalse);
    expect(seen.url.hasQuery, isFalse);
  });

  test('getJson without token sends no Authorization header', () async {
    late http.Request seen;
    final c = clientFor((r) async {
      seen = r;
      return json(200, {'ok': true, 'version': 3});
    });
    final out = await c.getJson('/api/health');
    expect(out['version'], 3);
    expect(seen.headers.containsKey('authorization'), isFalse);
  });

  test('SocketException becomes BoxUnreachable', () async {
    final c = clientFor((r) async => throw const SocketException('down'));
    await expectLater(c.getJson('/api/health'), throwsA(isA<BoxUnreachable>()));
    await expectLater(
      c.postJson('/api/x', {'a': 1}, token: 't'),
      throwsA(isA<BoxUnreachable>()),
    );
  });

  test(
    'a slow response throws BoxUnreachable after the read timeout',
    () async {
      final c = clientFor(
        (r) async {
          await Future<void>.delayed(const Duration(milliseconds: 400));
          return json(200, {'ok': true});
        },
        connect: Duration.zero,
        read: const Duration(milliseconds: 50),
      );
      await expectLater(
        c.getJson('/api/health'),
        throwsA(isA<BoxUnreachable>()),
      );
    },
  );

  test('uploadAsset sends the raw bytes with the given Content-Type', () async {
    late http.Request seen;
    final c = clientFor((r) async {
      seen = r;
      return json(201, {
        'id': 'a' * 64,
        'mime': 'image/jpeg',
        'bytes': 4,
        'width': 10,
        'height': 20,
      });
    });
    final meta = await c.uploadAsset(
      Uint8List.fromList([1, 2, 3, 4]),
      'image/jpeg',
      token: 'tok',
    );
    expect(seen.method, 'POST');
    expect(seen.url.path, '/api/assets');
    expect(seen.headers['content-type'], 'image/jpeg');
    expect(seen.headers['content-type'], isNot(contains('multipart')));
    expect(seen.bodyBytes, [1, 2, 3, 4]);
    expect(seen.headers['authorization'], 'Bearer tok');
    expect(meta.width, 10);
  });

  test('putJson, postJson, delete and getBytes', () async {
    final seen = <http.Request>[];
    final c = clientFor((r) async {
      seen.add(r);
      if (r.method == 'GET') {
        return http.Response.bytes(
          [9, 8, 7],
          200,
          headers: {'content-type': 'audio/mpeg'},
        );
      }
      if (r.method == 'DELETE') return http.Response('', 204);
      return json(200, {'ok': true});
    });
    expect(
      (await c.putJson('/api/content/x', {'a': 1}, token: 't'))['ok'],
      true,
    );
    expect(
      (await c.postJson('/api/content/x', {'a': 1}, token: 't'))['ok'],
      true,
    );
    await c.delete('/api/content/x/1', token: 't');
    expect(await c.getBytes('/assets/${'a' * 64}', token: 't'), [9, 8, 7]);
    expect(seen.map((r) => r.method), ['PUT', 'POST', 'DELETE', 'GET']);
    expect(jsonDecode(seen[0].body), {'a': 1});
    expect(seen.every((r) => r.headers['authorization'] == 'Bearer t'), isTrue);
  });

  test('delete maps 403 to BoxError', () async {
    final c = clientFor(
      (r) async => json(403, {
        'errors': ['Tiada kebenaran untuk tindakan ini'],
      }),
    );
    await expectLater(
      c.delete('/api/x', token: 't'),
      throwsA(isA<BoxError>().having((e) => e.status, 'status', 403)),
    );
  });

  test('TimeoutException from the client is unreachable too', () async {
    final c = clientFor((r) async => throw TimeoutException('t'));
    await expectLater(c.getJson('/api/health'), throwsA(isA<BoxUnreachable>()));
  });

  group('one silent retry for idempotent reads only', () {
    test('a GET lost on the first connect succeeds on the retry', () async {
      var calls = 0;
      final c = clientFor((r) async {
        calls++;
        if (calls == 1) throw const SocketException('asleep');
        return json(200, {'ok': true});
      });
      expect((await c.getJson('/api/health'))['ok'], true);
      expect(calls, 2);
    });

    test(
      'a GET that fails twice is BoxUnreachable after exactly two attempts',
      () async {
        var calls = 0;
        final c = clientFor((r) async {
          calls++;
          throw const SocketException('down');
        });
        await expectLater(
          c.getJson('/api/health'),
          throwsA(isA<BoxUnreachable>()),
        );
        expect(calls, 2);
      },
    );

    test('getBytes and the auth challenge retry once', () async {
      var bytesCalls = 0;
      final b = clientFor((r) async {
        bytesCalls++;
        if (bytesCalls == 1) throw TimeoutException('t');
        return http.Response('abc', 200);
      });
      expect((await b.getBytes('/api/x')).length, 3);
      expect(bytesCalls, 2);

      var chCalls = 0;
      final c = clientFor((r) async {
        chCalls++;
        if (chCalls == 1) throw const SocketException('asleep');
        return json(200, {'nonce': 'nn', 'expiresAt': 'x'});
      });
      expect((await c.challenge('dev1')).nonce, 'nn');
      expect(chCalls, 2);
    });

    test('unlock, enrol complete and other writes are never retried', () async {
      for (final call in <Future<Object?> Function(BoxClient)>[
        (c) => c.unlock(
          deviceId: 'd',
          nonce: 'n',
          signatureB64url: 's',
          pin: '1234',
        ),
        (c) => c.enrolComplete(
          code: 'c',
          publicJwk: {'kty': 'EC'},
          deviceName: 'p',
          platform: 'android',
        ),
        (c) => c.postJson('/api/x', {'a': 1}, token: 't'),
        (c) => c.putJson('/api/x', {'a': 1}, token: 't'),
        (c) => c.delete('/api/x', token: 't'),
        (c) => c.uploadAsset(Uint8List.fromList([1]), 'image/jpeg', token: 't'),
      ]) {
        var calls = 0;
        final c = clientFor((r) async {
          calls++;
          throw const SocketException('down');
        });
        await expectLater(call(c), throwsA(isA<BoxUnreachable>()));
        expect(calls, 1);
      }
    });

    test('a box answer (4xx or 5xx) is never retried', () async {
      var calls = 0;
      final c = clientFor((r) async {
        calls++;
        return json(503, {
          'errors': ['x'],
        });
      });
      await expectLater(c.getJson('/api/health'), throwsA(isA<BoxError>()));
      expect(calls, 1);
    });

    test('the connect budget defaults to 8 s', () {
      expect(
        BoxClient(box, MockClient((r) async => json(200, {}))).connect,
        const Duration(seconds: 8),
      );
    });
  });
}
