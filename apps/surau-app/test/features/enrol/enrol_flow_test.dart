import 'package:flutter_test/flutter_test.dart';
import 'package:surau_app/box/box_client.dart';
import 'package:surau_app/features/enrol/enrol_flow.dart';
import 'package:surau_app/features/enrol/pin_policy.dart';

import '../fakes.dart';

void main() {
  group('isValidPin (same rule as the box)', () {
    test('accepts six digits that are not trivial', () {
      expect(isValidPin('280419'), isTrue);
      expect(isValidPin('135790'), isTrue);
      expect(isValidPin('100000'), isTrue);
    });

    test('refuses wrong length, letters, same digit and runs', () {
      expect(isValidPin('28041'), isFalse);
      expect(isValidPin('2804190'), isFalse);
      expect(isValidPin('28O419'), isFalse);
      expect(isValidPin('000000'), isFalse);
      expect(isValidPin('777777'), isFalse);
      expect(isValidPin('123456'), isFalse);
      expect(isValidPin('456789'), isFalse);
      expect(isValidPin('654321'), isFalse);
      expect(isValidPin('987654'), isFalse);
      expect(isValidPin(''), isFalse);
    });
  });

  group('detectEnrolPlatform', () {
    test('android, iPad/iPhone Safari and other browsers', () {
      expect(detectEnrolPlatform(isWeb: false, userAgent: ''), 'android');
      expect(
        detectEnrolPlatform(
          isWeb: true,
          userAgent: 'Mozilla/5.0 (iPad; CPU OS 17_4 like Mac OS X) AppleWebKit/605.1.15 Safari/604.1',
        ),
        'ios-web',
      );
      expect(
        detectEnrolPlatform(isWeb: true, userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X)'),
        'ios-web',
      );
      expect(
        detectEnrolPlatform(isWeb: true, userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/130'),
        'web',
      );
    });
  });

  group('EnrolFlow.run', () {
    late FakeDeviceKey key;
    late FakeTrust trust;
    late MemoryEnrolledBoxStore store;

    EnrolFlow flowFor(FakeBox box, {String platform = 'android'}) {
      key = FakeDeviceKey();
      trust = FakeTrust();
      store = MemoryEnrolledBoxStore();
      return EnrolFlow(
        clientFor: box.client,
        key: key,
        trust: trust,
        store: store,
        platform: platform,
        now: () => DateTime.utc(2026, 11, 4),
      );
    }

    test('new PIN: sends pin and a JWK with exactly kty, crv, x, y', () async {
      final box = FakeBox(happyBox);
      final flow = flowFor(box);
      final out = await flow.run(fixturePayload(), deviceName: 'Telefon Ali', hasPinAlready: false, newPin: '280419');
      final body = box.bodyOf('/api/enrol/complete');
      expect(body['pin'], '280419');
      expect(body['code'], 'ABCD-EFGH-2345');
      expect(body['deviceName'], 'Telefon Ali');
      expect(body['platform'], 'android');
      expect((body['publicJwk'] as Map).keys.toSet(), {'kty', 'crv', 'x', 'y'});
      expect(box.byPath('/api/enrol/complete')!.url.origin, 'https://127.0.0.1:8443');
      expect(trust.calls.single.$1.toString(), 'https://127.0.0.1:8443');
      expect(trust.calls.single.$2, startsWith('abcdef0123'));
      expect(out.pinPending, isFalse);
      expect(out.box.deviceId, 'dev-1');
      expect(out.box.userName, 'Ustaz Ali');
      expect(out.box.boxId, '0123456789abcdef');
      expect((await store.load())?.deviceId, 'dev-1');
      expect(trust.commits, hasLength(1), reason: 'the CA is stored after the enrolment completed');
      expect(key.present, isTrue);
      expect(key.clearCalls, 0);
    });

    test('where the app pins the CA, a payload without caSha256 is refused before anything happens', () async {
      final box = FakeBox(happyBox);
      final flow = flowFor(box);
      final pinning = FakeTrust(pinsCa: true);
      final strict = EnrolFlow(
        clientFor: box.client,
        key: key,
        trust: pinning,
        store: store,
        platform: 'android',
        now: () => DateTime.utc(2026, 11, 4),
      );
      await expectLater(
        strict.run(fixturePayload(caSha256: null), deviceName: 'Telefon Ali', hasPinAlready: false, newPin: '280419'),
        throwsA(isA<FormatException>()),
      );
      expect(pinning.calls, isEmpty);
      expect(box.seen, isEmpty);
      expect(key.present, isFalse);
      // The browser build keeps working without one.
      await flow.run(fixturePayload(caSha256: null), deviceName: 'Telefon Ali', hasPinAlready: false, newPin: '280419');
    });

    test('lock off: no PIN is chosen or sent, the box record remembers it', () async {
      final box = FakeBox((r) async {
        if (r.url.path == '/api/enrol/complete') {
          return jsonResponse(200, {
            'deviceId': 'dev-1',
            'userId': 'u1',
            'roles': ['admin'],
            'pinRequired': false,
            'appLock': false,
          });
        }
        return happyBox(r);
      });
      final flow = flowFor(box);
      final out = await flow.run(fixturePayload(appLock: false), deviceName: 'Telefon Ali', hasPinAlready: true);
      expect(box.bodyOf('/api/enrol/complete').containsKey('pin'), isFalse);
      expect(out.box.appLock, isFalse);
      expect(out.pinPending, isFalse);
      expect((await store.load())?.appLock, isFalse);
    });

    test('lock off: hasPinAlready may be null, and an old build PIN is not sent either', () async {
      final box = FakeBox(happyBox);
      final flow = flowFor(box);
      await flow.run(fixturePayload(appLock: false), deviceName: 'x');
      expect(box.bodyOf('/api/enrol/complete').containsKey('pin'), isFalse);
    });

    test('lock on or unknown: the PIN rules are unchanged and the record says appLock true', () async {
      final box = FakeBox(happyBox);
      final flow = flowFor(box);
      await expectLater(flow.run(fixturePayload(), deviceName: 'x'), throwsA(isA<ArgumentError>()));
      final out = await flow.run(fixturePayload(appLock: true), deviceName: 'x', hasPinAlready: false, newPin: '280419');
      expect(box.bodyOf('/api/enrol/complete')['pin'], '280419');
      expect(out.box.appLock, isTrue);
    });

    test('the stored record round-trips appLock and defaults to true when absent', () {
      final off = fixtureBox(appLock: false);
      expect(EnrolledBox.fromJson(off.toJson()).appLock, isFalse);
      final j = off.toJson()..remove('appLock');
      expect(EnrolledBox.fromJson(j).appLock, isTrue);
    });

    test('existing PIN: no pin key in the body', () async {
      final box = FakeBox(happyBox);
      final flow = flowFor(box, platform: 'ios-web');
      await flow.run(fixturePayload(), deviceName: 'iPad', hasPinAlready: true);
      final body = box.bodyOf('/api/enrol/complete');
      expect(body.containsKey('pin'), isFalse);
      expect(body['platform'], 'ios-web');
    });

    test('box says pinRequired: outcome.pinPending is true', () async {
      final box = FakeBox(
        (r) async => jsonResponse(200, {
          'deviceId': 'dev-1',
          'userId': 'u1',
          'roles': ['ajk'],
          'pinRequired': true,
        }),
      );
      final flow = flowFor(box);
      final out = await flow.run(fixturePayload(), deviceName: 'x', hasPinAlready: true);
      expect(out.pinPending, isTrue);
      expect((await store.load())?.roles, ['ajk']);
    });

    test('a weak new PIN is refused before any request', () async {
      final box = FakeBox(happyBox);
      final flow = flowFor(box);
      await expectLater(
        flow.run(fixturePayload(), deviceName: 'x', hasPinAlready: false, newPin: '123456'),
        throwsA(isA<EnrolPinTooWeak>()),
      );
      expect(box.seen, isEmpty);
      expect(key.generateCalls, 0);
    });

    test('a TrustError aborts before generate()', () async {
      final box = FakeBox(happyBox);
      final flow = flowFor(box);
      trust.fail = true;
      await expectLater(flow.run(fixturePayload(), deviceName: 'x', hasPinAlready: true), throwsA(isA<TrustError>()));
      expect(key.generateCalls, 0);
      expect(box.seen, isEmpty);
      expect(await store.load(), isNull);
    });

    test('an expired payload is refused before trust or network', () async {
      final box = FakeBox(happyBox);
      final flow = flowFor(box);
      await expectLater(
        flow.run(fixturePayload(exp: 1000), deviceName: 'x', hasPinAlready: true),
        throwsA(isA<EnrolExpired>()),
      );
      expect(trust.calls, isEmpty);
      expect(box.seen, isEmpty);
    });

    test('a bad payload is a FormatException with the box wording', () async {
      final flow = flowFor(FakeBox(happyBox));
      await expectLater(
        flow.run('surau1:abc', deviceName: 'x', hasPinAlready: true),
        throwsA(isA<FormatException>().having((e) => e.message, 'message', 'Kod QR pendaftaran tidak sah')),
      );
    });

    test('box refuses the code: key cleared, nothing stored, error kept', () async {
      final box = FakeBox(
        (r) async => jsonResponse(401, {
          'errors': ['Kod pendaftaran tidak sah atau telah tamat'],
        }),
      );
      final flow = flowFor(box);
      await expectLater(
        flow.run(fixturePayload(), deviceName: 'x', hasPinAlready: true),
        throwsA(isA<BoxError>().having((e) => e.status, 'status', 401)),
      );
      expect(key.generateCalls, 1);
      expect(key.clearCalls, 1);
      expect(trust.commits, isEmpty, reason: 'a refused enrolment leaves no CA behind');
      expect(key.present, isFalse);
      expect(await store.load(), isNull);
    });

    test('400 PIN already set becomes EnrolPinExists (code stays usable)', () async {
      final box = FakeBox(
        (r) async => jsonResponse(400, {
          'errors': ['PIN sudah ditetapkan untuk pengguna ini'],
        }),
      );
      final flow = flowFor(box);
      await expectLater(
        flow.run(fixturePayload(), deviceName: 'x', hasPinAlready: false, newPin: '280419'),
        throwsA(isA<EnrolPinExists>()),
      );
      expect(key.clearCalls, 1);
    });

    test('already enrolled: run refuses, the key and the record stay intact', () async {
      final box = FakeBox(happyBox);
      final flow = flowFor(box);
      await flow.run(fixturePayload(), deviceName: 'x', hasPinAlready: true);
      expect(key.generateCalls, 1);
      final before = await store.load();
      // The same (now spent) code is submitted again.
      await expectLater(
        flow.run(fixturePayload(), deviceName: 'x', hasPinAlready: true),
        throwsA(isA<EnrolAlreadyEnrolled>()),
      );
      expect(key.generateCalls, 1, reason: 'no new key');
      expect(key.clearCalls, 0, reason: 'the good key is never cleared');
      expect(key.present, isTrue);
      expect((await store.load())?.deviceId, before?.deviceId);
      expect(box.seen.where((r) => r.url.path == '/api/enrol/complete').length, 1);
    });

    test('after the record is forgotten, enrolling again is allowed', () async {
      final box = FakeBox(happyBox);
      final flow = flowFor(box);
      await flow.run(fixturePayload(), deviceName: 'x', hasPinAlready: true);
      await store.clear(); // "Daftar semula"
      await flow.run(fixturePayload(), deviceName: 'x', hasPinAlready: true);
      expect(key.generateCalls, 2);
      expect(await store.load(), isNotNull);
    });

    test('unreachable box clears the key and passes BoxUnreachable on', () async {
      final box = FakeBox((r) async => throw const BoxUnreachable());
      final flow = flowFor(box);
      await expectLater(
        flow.run(fixturePayload(), deviceName: 'x', hasPinAlready: true),
        throwsA(isA<BoxUnreachable>()),
      );
      expect(key.clearCalls, 1);
    });
  });

  group('EnrolledBox', () {
    test('round-trips through JSON', () {
      final b = fixtureBox();
      final back = EnrolledBox.fromJson(b.toJson());
      expect(back.box, b.box);
      expect(back.boxId, b.boxId);
      expect(back.deviceId, b.deviceId);
      expect(back.userId, b.userId);
      expect(back.userName, b.userName);
      expect(back.roles, b.roles);
      expect(back.caSha256, b.caSha256);
    });

    test('fingerprint groups the first 32 hex chars in fours', () {
      expect(fixtureBox().caFingerprint, 'abcd ef01 2345 6789 abcd ef01 2345 6789');
      expect(EnrolledBox.fingerprintOf(null), isNull);
    });
  });
}
