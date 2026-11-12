import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:surau_app/box/box_client.dart';
import 'package:surau_app/box/device_key.dart';
import 'package:surau_app/features/unlock/biometric_pin.dart';
import 'package:surau_app/features/unlock/unlock_flow.dart';

import '../fakes.dart';

void main() {
  late FakeDeviceKey key;
  late FakeBiometricPin bio;

  UnlockFlow flowFor(
    FakeBox box, {
    bool keyPresent = true,
    Future<void> Function(bool)? onAppLock,
  }) {
    key = FakeDeviceKey(present: keyPresent);
    bio = FakeBiometricPin();
    final enrolled = fixtureBox();
    return UnlockFlow(
      client: box.client(enrolled.box),
      key: key,
      box: enrolled,
      biometric: bio,
      onAppLock: onAppLock,
    );
  }

  test(
    'challenge, sign the exact unlock message, unlock with the PIN',
    () async {
      final box = FakeBox(happyBox);
      final flow = flowFor(box);
      final session = await flow.run(pin: '280419');

      expect(session.token, 'tok-1');
      expect(session.user.name, 'Ustaz Ali');
      expect(jsonDecode(box.byPath('/api/auth/challenge')!.body), {
        'deviceId': 'dev-1',
      });

      final expectedMsg = unlockMessage('0123456789abcdef', 'dev-1', 'nonce-1');
      expect(key.signed.single, expectedMsg);
      expect(
        utf8.decode(expectedMsg),
        'surau-unlock\n0123456789abcdef\ndev-1\nnonce-1',
      );

      final body = box.bodyOf('/api/auth/unlock');
      expect(body, {
        'deviceId': 'dev-1',
        'nonce': 'nonce-1',
        'signature': b64url(FakeDeviceKey.fakeSignature(expectedMsg)),
        'pin': '280419',
      });
      expect(body['signature'], isNot(contains('=')));
      expect(
        box.seen.every((r) => !r.headers.containsKey('authorization')),
        isTrue,
      );
      expect(bio.sealed, isNull);
    },
  );

  test(
    '423 becomes UnlockLocked with the box message and Retry-After',
    () async {
      final box = FakeBox((r) async {
        if (r.url.path == '/api/auth/challenge') return happyBox(r);
        return jsonResponse(
          423,
          {
            'errors': ['Akaun dikunci. Cuba lagi dalam 15 minit'],
          },
          headers: {'retry-after': '900'},
        );
      });
      final flow = flowFor(box);
      await expectLater(
        flow.run(pin: '280419'),
        throwsA(
          isA<UnlockLocked>()
              .having(
                (e) => e.message,
                'message',
                'Akaun dikunci. Cuba lagi dalam 15 minit',
              )
              .having((e) => e.retryAfterSec, 'retryAfterSec', 900),
        ),
      );
    },
  );

  test(
    '409 pinRequired becomes UnlockPinRequired; newPin is then sent alone',
    () async {
      final box = FakeBox((r) async {
        if (r.url.path == '/api/auth/challenge') return happyBox(r);
        final b = jsonDecode(r.body) as Map<String, dynamic>;
        if (b.containsKey('newPin')) return jsonResponse(200, sessionJson);
        return jsonResponse(409, {
          'errors': ['PIN baharu diperlukan'],
          'pinRequired': true,
        });
      });
      final flow = flowFor(box);
      await expectLater(
        flow.run(pin: '280419'),
        throwsA(isA<UnlockPinRequired>()),
      );

      final session = await flow.run(newPin: '280419');
      expect(session.token, 'tok-1');
      final last = jsonDecode(box.seen.last.body) as Map<String, dynamic>;
      expect(last['newPin'], '280419');
      expect(last.containsKey('pin'), isFalse);
      expect(last['deviceId'], 'dev-1');
    },
  );

  test('a weak newPin is refused locally, no request made', () async {
    final box = FakeBox(happyBox);
    final flow = flowFor(box);
    await expectLater(
      flow.run(newPin: '111111'),
      throwsA(isA<UnlockPinTooWeak>()),
    );
    await expectLater(
      flow.run(newPin: '987654'),
      throwsA(isA<UnlockPinTooWeak>()),
    );
    expect(box.seen, isEmpty);
  });

  test(
    '400 pin_exists while setting a new PIN becomes UnlockPinExists',
    () async {
      final box = FakeBox((r) async {
        if (r.url.path == '/api/auth/challenge') return happyBox(r);
        return jsonResponse(400, {
          'errors': ['PIN sudah ditetapkan. Masukkan PIN semasa'],
        });
      });
      final flow = flowFor(box);
      await expectLater(
        flow.run(newPin: '280419'),
        throwsA(isA<UnlockPinExists>()),
      );
    },
  );

  test(
    '401 PIN salah is UnlockWrongPin; 401 revoked is UnlockRevoked',
    () async {
      var message = 'PIN salah';
      final box = FakeBox((r) async {
        if (r.url.path == '/api/auth/challenge') return happyBox(r);
        return jsonResponse(401, {
          'errors': [message],
        });
      });
      final flow = flowFor(box);
      await expectLater(
        flow.run(pin: '280419'),
        throwsA(isA<UnlockWrongPin>()),
      );
      message = 'Peranti telah dibatalkan';
      await expectLater(flow.run(pin: '280419'), throwsA(isA<UnlockRevoked>()));
    },
  );

  test('the reason code from the box decides, not its wording', () async {
    var code = 'wrong_pin';
    final box = FakeBox((r) async {
      if (r.url.path == '/api/auth/challenge') return happyBox(r);
      return jsonResponse(401, {
        'errors': ['kata-kata lain'],
        'code': code,
      });
    });
    final flow = flowFor(box);
    await expectLater(flow.run(pin: '280419'), throwsA(isA<UnlockWrongPin>()));
    code = 'device_revoked';
    await expectLater(flow.run(pin: '280419'), throwsA(isA<UnlockRevoked>()));
    code = 'user_inactive';
    await expectLater(flow.run(pin: '280419'), throwsA(isA<UnlockRevoked>()));
    code = 'bad_signature';
    await expectLater(
      flow.run(pin: '280419'),
      throwsA(isA<UnlockNotVerified>()),
    );
  });

  test(
    'a 401 that is not a known refusal is not "revoked, enrol again"',
    () async {
      final box = FakeBox((r) async {
        if (r.url.path == '/api/auth/challenge') return happyBox(r);
        return jsonResponse(401, {
          'errors': ['Sesuatu yang lain'],
        });
      });
      final flow = flowFor(box);
      await expectLater(flow.run(pin: '280419'), throwsA(isA<BoxError>()));
    },
  );

  test('bad_nonce: a new challenge is fetched and the unlock retried once, silently', () async {
    var unlocks = 0;
    var challenges = 0;
    final box = FakeBox((r) async {
      if (r.url.path == '/api/auth/challenge') {
        challenges++;
        return jsonResponse(200, {
          'nonce': 'nonce-$challenges',
          'expiresAt': '2026-11-04T14:31:00.000Z',
        });
      }
      unlocks++;
      if (unlocks == 1) {
        return jsonResponse(401, {
          'errors': ['Cabaran (nonce) tidak sah, telah digunakan atau tamat'],
          'code': 'bad_nonce',
        });
      }
      return jsonResponse(200, sessionJson);
    });
    final flow = flowFor(box);
    final session = await flow.run(pin: '280419');
    expect(session.token, 'tok-1');
    expect(challenges, 2);
    expect(key.signed.map(utf8.decode).last, endsWith('nonce-2'));
  });

  test(
    'bad_nonce twice in a row is a retryable failure, not a revoked device',
    () async {
      final box = FakeBox((r) async {
        if (r.url.path == '/api/auth/challenge') return happyBox(r);
        return jsonResponse(401, {
          'errors': ['x'],
          'code': 'bad_nonce',
        });
      });
      final flow = flowFor(box);
      await expectLater(
        flow.run(pin: '280419'),
        throwsA(isA<UnlockNotVerified>()),
      );
      expect(
        box.seen.where((r) => r.url.path == '/api/auth/unlock'),
        hasLength(2),
      );
    },
  );

  test('biometric: cancel, lockout and a mismatch are told apart', () async {
    final box = FakeBox(happyBox);
    final flow = flowFor(box);
    bio
      ..isAvailable = true
      ..sealed = '280419';
    BiometricFailure? reasonOf(Object e) =>
        e is UnlockBiometricFailed ? e.reason : null;
    bio.openThrows = const BiometricCancelled();
    await expectLater(
      flow.runWithBiometric(),
      throwsA(predicate((e) => reasonOf(e!) == BiometricFailure.cancelled)),
    );
    bio.openThrows = const BiometricLockedOut();
    await expectLater(
      flow.runWithBiometric(),
      throwsA(predicate((e) => reasonOf(e!) == BiometricFailure.lockedOut)),
    );
    bio
      ..openThrows = null
      ..onOpen = () => null;
    await expectLater(
      flow.runWithBiometric(),
      throwsA(predicate((e) => reasonOf(e!) == BiometricFailure.notRecognised)),
    );
    expect(box.seen, isEmpty);
    expect(
      bio.sealed,
      '280419',
      reason: 'a cancel does not forget the sealed PIN',
    );
  });

  test(
    'a 401 on the challenge (revoked device) is UnlockRevoked too',
    () async {
      final box = FakeBox(
        (r) async => jsonResponse(401, {
          'errors': ['Peranti telah dibatalkan'],
        }),
      );
      final flow = flowFor(box);
      await expectLater(flow.run(pin: '280419'), throwsA(isA<UnlockRevoked>()));
      expect(key.signed, isEmpty);
    },
  );

  test('no device key: UnlockNoKey without touching the box', () async {
    final box = FakeBox(happyBox);
    final flow = flowFor(box, keyPresent: false);
    await expectLater(flow.run(pin: '280419'), throwsA(isA<UnlockNoKey>()));
    expect(box.seen, isEmpty);
  });

  test('BoxUnreachable passes through unchanged', () async {
    final box = FakeBox((r) async => throw const BoxUnreachable());
    final flow = flowFor(box);
    await expectLater(flow.run(pin: '280419'), throwsA(isA<BoxUnreachable>()));
  });

  test('run requires exactly one of pin or newPin', () async {
    final flow = flowFor(FakeBox(happyBox));
    expect(() => flow.run(), throwsArgumentError);
    expect(
      () => flow.run(pin: '280419', newPin: '280419'),
      throwsArgumentError,
    );
  });

  test('sealPin stores the PIN for biometrics only after success', () async {
    final failing = FakeBox((r) async {
      if (r.url.path == '/api/auth/challenge') return happyBox(r);
      return jsonResponse(401, {
        'errors': ['PIN salah'],
      });
    });
    final flow1 = flowFor(failing);
    await expectLater(
      flow1.run(pin: '280419', sealPin: true),
      throwsA(isA<UnlockWrongPin>()),
    );
    expect(bio.sealed, isNull);

    final flow2 = flowFor(FakeBox(happyBox));
    await flow2.run(pin: '280419', sealPin: true);
    expect(bio.sealed, '280419');
  });

  test('runWithBiometric opens the sealed PIN and unlocks with it', () async {
    final box = FakeBox(happyBox);
    final flow = flowFor(box);
    bio
      ..isAvailable = true
      ..sealed = '280419';
    final session = await flow.runWithBiometric();
    expect(session.token, 'tok-1');
    expect(box.bodyOf('/api/auth/unlock')['pin'], '280419');
    expect(bio.openCalls, 1);
  });

  test(
    'runWithBiometric: cancelled prompt is UnlockBiometricFailed, no request',
    () async {
      final box = FakeBox(happyBox);
      final flow = flowFor(box);
      bio
        ..isAvailable = true
        ..sealed = '280419'
        ..onOpen = () => null;
      await expectLater(
        flow.runWithBiometric(),
        throwsA(isA<UnlockBiometricFailed>()),
      );
      expect(box.seen, isEmpty);
    },
  );

  test('a stale sealed PIN (box says PIN salah) is cleared', () async {
    final box = FakeBox((r) async {
      if (r.url.path == '/api/auth/challenge') return happyBox(r);
      return jsonResponse(401, {
        'errors': ['PIN salah'],
      });
    });
    final flow = flowFor(box);
    bio
      ..isAvailable = true
      ..sealed = '280419';
    await expectLater(flow.runWithBiometric(), throwsA(isA<UnlockWrongPin>()));
    expect(bio.sealed, isNull);
  });

  test('canUseBiometric needs strong biometrics and a sealed PIN', () async {
    final flow = flowFor(FakeBox(happyBox));
    expect(await flow.canUseBiometric(), isFalse);
    bio.isAvailable = true;
    expect(await flow.canUseBiometric(), isFalse);
    bio.sealed = '280419';
    expect(await flow.canUseBiometric(), isTrue);
  });

  test('any 409 on unlock is pinRequired (the box answers 409 there for nothing else)', () async {
    final box = FakeBox((r) async {
      if (r.url.path == '/api/auth/challenge') return happyBox(r);
      return http.Response('conflict', 409);
    });
    final flow = flowFor(box);
    await expectLater(
      flow.run(pin: '280419'),
      throwsA(isA<UnlockPinRequired>()),
    );
  });

  test('other box errors (500) pass through as BoxError', () async {
    final box = FakeBox((r) async {
      if (r.url.path == '/api/auth/challenge') return happyBox(r);
      return http.Response('oops', 500);
    });
    final flow = flowFor(box);
    await expectLater(
      flow.run(pin: '280419'),
      throwsA(isA<BoxError>().having((e) => e.status, 'status', 500)),
    );
  });

  group('app lock', () {
    Future<http.Response> Function(http.Request) challengeWith(
      bool? appLock,
      Future<http.Response> Function(http.Request) rest,
    ) => (r) async {
      if (r.url.path == '/api/auth/challenge') {
        return jsonResponse(200, {
          'nonce': 'nonce-1',
          'expiresAt': 'x',
          'appLock': ?appLock,
        });
      }
      return rest(r);
    };

    test('noPin posts exactly deviceId, nonce and signature', () async {
      final seen = <bool>[];
      final box = FakeBox(
        challengeWith(false, (r) async => jsonResponse(200, sessionJson)),
      );
      final flow = flowFor(box, onAppLock: (on) async => seen.add(on));
      final session = await flow.run(noPin: true);
      expect(session.token, 'tok-1');
      final expectedMsg = unlockMessage('0123456789abcdef', 'dev-1', 'nonce-1');
      expect(box.bodyOf('/api/auth/unlock'), {
        'deviceId': 'dev-1',
        'nonce': 'nonce-1',
        'signature': b64url(FakeDeviceKey.fakeSignature(expectedMsg)),
      });
      expect(key.signed.single, expectedMsg);
      expect(seen, [
        false,
      ], reason: 'the challenge told the app the lock is off');
    });

    test('exactly one of pin, newPin or noPin', () async {
      final flow = flowFor(FakeBox(happyBox));
      await expectLater(flow.run(), throwsArgumentError);
      await expectLater(
        flow.run(pin: '280419', noPin: true),
        throwsArgumentError,
      );
      await expectLater(
        flow.run(newPin: '280419', noPin: true),
        throwsArgumentError,
      );
    });

    test('401 pin_missing becomes UnlockPinMissing and the app learns the lock is on', () async {
      final seen = <bool>[];
      final box = FakeBox(
        challengeWith(
          true,
          (r) async => jsonResponse(401, {
            'errors': ['PIN diperlukan'],
            'code': 'pin_missing',
          }),
        ),
      );
      final flow = flowFor(box, onAppLock: (on) async => seen.add(on));
      await expectLater(
        flow.run(noPin: true),
        throwsA(
          isA<UnlockPinMissing>().having(
            (e) => e.message,
            'message',
            'PIN diperlukan',
          ),
        ),
      );
      expect(seen, [true, true]);
    });

    test(
      '409 stays UnlockPinRequired and the app learns the lock is on',
      () async {
        final seen = <bool>[];
        final box = FakeBox(
          challengeWith(
            null,
            (r) async => jsonResponse(409, {
              'errors': ['PIN baharu diperlukan'],
              'code': 'pin_required',
              'pinRequired': true,
            }),
          ),
        );
        final flow = flowFor(box, onAppLock: (on) async => seen.add(on));
        await expectLater(
          flow.run(noPin: true),
          throwsA(isA<UnlockPinRequired>()),
        );
        expect(seen, [true]);
      },
    );

    test('a box with its lock off ignores a typed PIN, so nothing is sealed for the fingerprint', () async {
      final box = FakeBox(
        challengeWith(false, (r) async => jsonResponse(200, sessionJson)),
      );
      final flow = flowFor(box);
      await flow.run(pin: '280419', sealPin: true);
      expect(bio.sealed, isNull);
    });

    test('with the lock on a PIN the box accepted is still sealed', () async {
      final box = FakeBox(
        challengeWith(true, (r) async => jsonResponse(200, sessionJson)),
      );
      final flow = flowFor(box);
      await flow.run(pin: '280419', sealPin: true);
      expect(bio.sealed, '280419');
    });

    test('a failing onAppLock never fails the unlock; revoked is still revoked with noPin', () async {
      final box = FakeBox(
        challengeWith(false, (r) async => jsonResponse(200, sessionJson)),
      );
      final flow = flowFor(
        box,
        onAppLock: (_) async => throw StateError('disk full'),
      );
      expect((await flow.run(noPin: true)).token, 'tok-1');

      final revoked = FakeBox(
        challengeWith(
          false,
          (r) async => jsonResponse(401, {
            'errors': ['Peranti telah dibatalkan'],
            'code': 'device_revoked',
          }),
        ),
      );
      await expectLater(
        flowFor(revoked).run(noPin: true),
        throwsA(isA<UnlockRevoked>()),
      );
    });
  });
}
