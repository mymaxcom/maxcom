@TestOn('vm')
library;

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:surau_app/box/box_client.dart';
import 'package:surau_app/box/box_qr.dart';
import 'package:surau_app/box/setup_client.dart';
import 'package:surau_app/features/common/surau_info.dart';
import 'package:surau_app/features/enrol/enrol_flow.dart';
import 'package:surau_app/features/enrol/join_errors.dart';
import 'package:surau_app/features/setup/setup_flow.dart';

import '../support/box_qr_fixture.dart';
import 'fakes.dart';

late FakeDeviceKey key;
late FakeTrust trust;
late MemoryEnrolledBoxStore store;
late MemorySurauInfoStore infoStore;

SetupFlow flowFor(FakeBox box, {DateTime Function()? now}) {
  key = FakeDeviceKey();
  trust = FakeTrust();
  store = MemoryEnrolledBoxStore();
  infoStore = MemorySurauInfoStore();
  return SetupFlow(
    clientFor: box.client,
    key: key,
    trust: trust,
    store: store,
    surauInfoStore: infoStore,
    platform: 'android',
    now: now ?? fixedNow,
  );
}

FakeBox boxIn(String type, {String state = 'setup', int completeStatus = 201, Object? completeBody, String? keyFp}) => FakeBox((r) async {
  switch (r.url.path) {
    case '/api/box/info':
      return boxInfoResponse(type, state: state, keyFp: keyFp);
    case '/api/setup/complete':
    case '/api/recovery/complete':
      return completeStatus == 201
          ? jsonResponse(201, completeBody ?? completedBody)
          : jsonResponse(completeStatus, completeBody ?? {'errors': ['x'], 'code': 'already_set_up'});
    case '/api/setup/probe':
      return jsonResponse(200, {'ok': true});
  }
  return http.Response('{}', 404);
});

void main() {
  group('inspect', () {
    test('a valid setup QR: signature, expiry, trust, the box answers and matches', () async {
      final box = boxIn('setup');
      final flow = flowFor(box);
      final i = await flow.inspect(boxQrText('setup'), expect: ScannedKind.setup);
      expect(i.payload.type, 'setup');
      expect(i.info.state, 'setup');
      expect(trust.calls.single.$1.toString(), boxQrPayloadJson('setup')['box']);
      expect(trust.calls.single.$2, boxQrPayloadJson('setup')['caSha256']);
      expect(key.generateCalls, 0, reason: 'inspect writes nothing');
      expect(await store.load(), isNull);
    });

    test('the box saying a different key fingerprint is a mismatch', () async {
      final flow = flowFor(boxIn('setup', keyFp: '0123456789abcdef'));
      await expectLater(flow.inspect(boxQrText('setup'), expect: ScannedKind.setup), throwsA(isA<BoxQrMismatch>()));
    });

    test('an expired QR is refused before any network call', () async {
      final box = boxIn('setup');
      final flow = flowFor(box, now: () => DateTime.utc(2027, 1, 1));
      await expectLater(flow.inspect(boxQrText('setup'), expect: ScannedKind.setup), throwsA(isA<BoxQrExpired>()));
      expect(box.seen, isEmpty);
      expect(trust.calls, isEmpty);
    });

    test('setup on a box that is already set up, and recovery on a box with a Pentadbir', () async {
      await expectLater(
        flowFor(boxIn('setup', state: 'active')).inspect(boxQrText('setup'), expect: ScannedKind.setup),
        throwsA(isA<SetupAlreadyDone>()),
      );
      await expectLater(
        flowFor(boxIn('recovery', state: 'active')).inspect(boxQrText('recovery'), expect: ScannedKind.recovery),
        throwsA(isA<RecoveryNotNeeded>()),
      );
    });

    test('the wrong kind of QR for the page, and junk', () async {
      final flow = flowFor(boxIn('setup'));
      await expectLater(flow.inspect(boxQrText('recovery'), expect: ScannedKind.setup), throwsA(isA<WrongBoxQr>()));
      await expectLater(flow.inspect('hello', expect: ScannedKind.setup), throwsA(isA<BoxQrInvalid>()));
    });

    test('a box that cannot be reached, and a CA that does not match, pass through', () async {
      final down = FakeBox((r) async => throw http.ClientException('no route'));
      await expectLater(flowFor(down).inspect(boxQrText('setup'), expect: ScannedKind.setup), throwsA(isA<BoxUnreachable>()));
      final flow = flowFor(boxIn('setup'));
      trust.fail = true;
      await expectLater(flow.inspect(boxQrText('setup'), expect: ScannedKind.setup), throwsA(isA<TrustError>()));
    });
  });

  group('run (setup)', () {
    Future<(SetupFlow, BoxInspection)> ready({int status = 201, Object? body}) async {
      final flow = flowFor(boxIn('setup', completeStatus: status, completeBody: body));
      return (flow, await flow.inspect(boxQrText('setup'), expect: ScannedKind.setup));
    }

    test('201 keeps the key, remembers the box and the surau name, and returns the recovery code once', () async {
      final (flow, i) = await ready();
      final o = await flow.run(i, surauName: ' Surau Al-Hidayah ', adminName: 'Haji Ali', deviceName: 'vivo', boxName: 'MAXCOM Dewan Utama', pin: '482916');
      expect(o.recoveryCode, 'ABCD-EFGH-JKLM-NPQR');
      expect(key.generateCalls, 1);
      expect(key.clearCalls, 0);
      expect(key.present, isTrue);
      final saved = (await store.load())!;
      expect(saved.deviceId, 'dev-new');
      expect(saved.userName, 'Haji Ali');
      expect(saved.roles, ['admin']);
      expect(saved.boxId, boxQrPayloadJson('setup')['boxId']);
      expect(saved.caSha256, boxQrPayloadJson('setup')['caSha256']);
      expect(trust.commits, [boxQrPayloadJson('setup')['caSha256']], reason: 'the CA is stored only after the 201');
      expect((await infoStore.load())!.name, 'Surau Al-Hidayah');
    });

    test('the request carries the nonce, the trimmed names, the public key and the PIN', () async {
      final flow = flowFor(boxIn('setup'));
      final box = boxIn('setup');
      final f2 = SetupFlow(clientFor: box.client, key: FakeDeviceKey(), trust: FakeTrust(), store: MemoryEnrolledBoxStore(), platform: 'android', now: fixedNow);
      final i = await f2.inspect(boxQrText('setup'), expect: ScannedKind.setup);
      await f2.run(i, surauName: 'S ', adminName: ' A', deviceName: ' D ', boxName: 'B ', pin: '482916');
      final body = box.bodyOf('/api/setup/complete');
      expect(body['nonce'], boxQrPayloadJson('setup')['nonce']);
      expect(body['surauName'], 'S');
      expect(body['adminName'], 'A');
      expect(body['deviceName'], 'D');
      expect(body['boxName'], 'B');
      expect(body['pin'], '482916');
      expect(body['platform'], 'android');
      expect((body['publicJwk'] as Map).keys, containsAll(['kty', 'crv', 'x', 'y']));
      expect(body.containsKey('d'), isFalse);
      expect(flow, isNotNull);
    });

    test('409 already_set_up clears the key, saves nothing', () async {
      final (flow, i) = await ready(status: 409);
      await expectLater(
        flow.run(i, surauName: 'S', adminName: 'A', deviceName: 'D', boxName: 'B', pin: '482916'),
        throwsA(isA<SetupAlreadyDone>()),
      );
      expect(key.generateCalls, 1);
      expect(key.clearCalls, 1);
      expect(key.present, isFalse);
      expect(await store.load(), isNull);
      expect(await infoStore.load(), isNull);
      expect(trust.commits, isEmpty, reason: 'a refused join leaves no CA behind');
    });

    test('a lost reply (the box goes away after the request left) keeps the key and offers a retry', () async {
      final box = FakeBox((r) async {
        if (r.url.path == '/api/box/info') return boxInfoResponse('setup');
        throw http.ClientException('gone');
      });
      final flow = flowFor(box);
      final i = await flow.inspect(boxQrText('setup'), expect: ScannedKind.setup);
      await expectLater(
        flow.run(i, surauName: 'S', adminName: 'A', deviceName: 'D', boxName: 'B', pin: '482916'),
        throwsA(isA<SetupNotConfirmed>()),
      );
      expect(key.clearCalls, 0);
      expect(key.present, isTrue);
      expect(await store.load(), isNull);
    });

    test('a 5xx answer is also not a refusal: the key stays', () async {
      final (flow, i) = await ready(status: 503, body: {'errors': ['x']});
      await expectLater(
        flow.run(i, surauName: 'S', adminName: 'A', deviceName: 'D', boxName: 'B', pin: '482916'),
        throwsA(isA<SetupNotConfirmed>()),
      );
      expect(key.clearCalls, 0);
      expect(key.present, isTrue);
    });

    test('Cuba lagi sends the same request with the same key; the box answering then saves the box', () async {
      var posts = 0;
      final box = FakeBox((r) async {
        if (r.url.path == '/api/box/info') return boxInfoResponse('setup');
        if (r.url.path == '/api/setup/complete') {
          posts++;
          if (posts == 1) throw http.ClientException('reply lost');
          return jsonResponse(201, completedBody);
        }
        return http.Response('{}', 404);
      });
      final flow = flowFor(box);
      final i = await flow.inspect(boxQrText('setup'), expect: ScannedKind.setup);
      Future<SetupOutcome> go() => flow.run(i, surauName: 'S', adminName: 'A', deviceName: 'D', boxName: 'B', pin: '482916');
      await expectLater(go(), throwsA(isA<SetupNotConfirmed>()));
      final o = await go();
      expect(o.recoveryCode, 'ABCD-EFGH-JKLM-NPQR');
      expect(posts, 2);
      expect(key.generateCalls, 1, reason: 'the retry must not make a new key');
      expect(key.clearCalls, 0);
      final bodies = box.seen.where((r) => r.url.path == '/api/setup/complete').map((r) => r.body).toList();
      expect(bodies[1], bodies[0]);
      expect((await store.load())!.deviceId, 'dev-new');
    });

    test('a definite refusal after a lost reply clears the key', () async {
      var posts = 0;
      final box = FakeBox((r) async {
        if (r.url.path == '/api/box/info') return boxInfoResponse('setup');
        posts++;
        if (posts == 1) throw http.ClientException('reply lost');
        return jsonResponse(401, {'errors': ['x'], 'code': 'bad_code'});
      });
      final flow = flowFor(box);
      final i = await flow.inspect(boxQrText('setup'), expect: ScannedKind.setup);
      Future<SetupOutcome> go() => flow.run(i, surauName: 'S', adminName: 'A', deviceName: 'D', boxName: 'B', pin: '482916');
      await expectLater(go(), throwsA(isA<SetupNotConfirmed>()));
      await expectLater(go(), throwsA(isA<SetupCodeInvalid>()));
      expect(key.clearCalls, 1);
      expect(key.present, isFalse);
      expect(await store.load(), isNull);
    });

    test('a phone with a working enrolment is refused without touching its key', () async {
      final (flow, i) = await ready();
      await store.save(fixtureBox());
      key.present = true;
      await expectLater(
        flow.run(i, surauName: 'S', adminName: 'A', deviceName: 'D', boxName: 'B', pin: '482916'),
        throwsA(isA<EnrolAlreadyEnrolled>()),
      );
      expect(key.generateCalls, 0);
      expect(key.clearCalls, 0);
    });
  });

  group('recover', () {
    test('sends the recovery code and keeps the NEW recovery code from the answer', () async {
      final box = boxIn('recovery', state: 'recovery', completeBody: {...completedBody, 'recoveryCode': 'WXYZ-2345-6789-ABCD'});
      final flow = flowFor(box);
      final i = await flow.inspect(boxQrText('recovery'), expect: ScannedKind.recovery);
      final o = await flow.recover(i, recoveryCode: 'ABCDEFGHJKLMNPQR', adminName: 'Hajjah', deviceName: 'iPad', pin: '482916');
      expect(box.bodyOf('/api/recovery/complete')['recoveryCode'], 'ABCDEFGHJKLMNPQR');
      expect(o.recoveryCode, 'WXYZ-2345-6789-ABCD');
      expect((await store.load())!.userName, 'Hajjah');
      expect(key.present, isTrue);
    });

    test('a lost reply keeps the key; Cuba lagi sends the same request and gets the same device', () async {
      var posts = 0;
      final box = FakeBox((r) async {
        if (r.url.path == '/api/box/info') return boxInfoResponse('recovery', state: 'recovery');
        posts++;
        if (posts == 1) throw http.ClientException('reply lost');
        return jsonResponse(201, {...completedBody, 'recoveryCode': 'WXYZ-2345-6789-ABCD'});
      });
      final flow = flowFor(box);
      final i = await flow.inspect(boxQrText('recovery'), expect: ScannedKind.recovery);
      Future<SetupOutcome> go() => flow.recover(i, recoveryCode: 'ABCDEFGHJKLMNPQR', adminName: 'H', deviceName: 'D', pin: '482916');
      await expectLater(go(), throwsA(isA<SetupNotConfirmed>()));
      expect(key.clearCalls, 0);
      final o = await go();
      expect(o.recoveryCode, 'WXYZ-2345-6789-ABCD');
      expect(key.generateCalls, 1);
      final bodies = box.seen.where((r) => r.url.path == '/api/recovery/complete').map((r) => r.body).toList();
      expect(bodies[1], bodies[0]);
    });

    test('409 box_locked is a definite refusal with its own reason: the key is cleared', () async {
      final box = boxIn('recovery', state: 'recovery', completeStatus: 409, completeBody: {'errors': ['x'], 'code': 'box_locked'});
      final flow = flowFor(box);
      final i = await flow.inspect(boxQrText('recovery'), expect: ScannedKind.recovery);
      Object? caught;
      try {
        await flow.recover(i, recoveryCode: 'ABCDEFGHJKLMNPQR', adminName: 'H', deviceName: 'D', pin: '482916');
      } catch (e) {
        caught = e;
      }
      expect(caught, isA<BoxLocked>());
      expect(classifyJoinError(caught!), JoinErrorKind.locked);
      expect(key.clearCalls, 1);
      expect(await store.load(), isNull);
    });

    test('401 bad_code clears the key and says the code is wrong', () async {
      final box = boxIn('recovery', state: 'recovery', completeStatus: 401, completeBody: {'errors': ['x'], 'code': 'bad_code'});
      final flow = flowFor(box);
      final i = await flow.inspect(boxQrText('recovery'), expect: ScannedKind.recovery);
      await expectLater(
        flow.recover(i, recoveryCode: 'AAAAAAAAAAAAAAAA', adminName: 'H', deviceName: 'D', pin: '482916'),
        throwsA(isA<SetupCodeInvalid>()),
      );
      expect(key.clearCalls, 1);
      expect(await store.load(), isNull);
    });
  });

  group('probe', () {
    test('posts the probe nonce and writes nothing on the phone', () async {
      final box = boxIn('probe');
      final flow = flowFor(box);
      await flow.probe(boxQrText('probe'));
      expect(box.bodyOf('/api/setup/probe')['nonce'], boxQrPayloadJson('probe')['nonce']);
      expect(key.generateCalls, 0);
      expect(await store.load(), isNull);
    });
  });
}
