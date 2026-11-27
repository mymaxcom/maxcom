import 'dart:convert';

import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:surau_app/box/box_client.dart';
import 'package:surau_app/box/device_key.dart';
import 'package:surau_app/box/device_key_software.dart';
import 'package:surau_app/features/enrol/enrol_flow.dart';
import 'package:surau_app/features/common/surau_info.dart';
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

    test('a QR with name and ips: the record keeps the name hint and the box IP as lastIp', () async {
      final base = fixturePayload();
      final m = jsonDecode(utf8.decode(base64Url.decode(base64Url.normalize(base.substring(7))))) as Map<String, dynamic>;
      m['name'] = 'box1-surau.local';
      m['ips'] = ['127.0.0.1', '10.1.1.1'];
      final text = 'surau1:${base64Url.encode(utf8.encode(jsonEncode(m))).replaceAll('=', '')}';
      final out = await flowFor(FakeBox(happyBox)).run(text, deviceName: 'T', hasPinAlready: false, newPin: '280419');
      expect(out.box.name, 'box1-surau.local');
      expect(out.box.lastIp, '127.0.0.1');
      expect(out.box.box.toString(), 'https://127.0.0.1:8443');
    });

    test('native, as the server sends it: box is the IP origin, name is the hint, lastIp is that IP', () async {
      final base = fixturePayload();
      final m = jsonDecode(utf8.decode(base64Url.decode(base64Url.normalize(base.substring(7))))) as Map<String, dynamic>;
      m['box'] = 'https://10.1.1.2:8443';
      m['name'] = 'box1-surau.local';
      m['ips'] = ['10.1.1.1', '10.1.1.2'];
      final text = 'surau1:${base64Url.encode(utf8.encode(jsonEncode(m))).replaceAll('=', '')}';
      final box = FakeBox(happyBox);
      final out = await flowFor(box).run(text, deviceName: 'T', hasPinAlready: false, newPin: '280419');
      expect(out.box.box.toString(), 'https://10.1.1.2:8443');
      expect(out.box.name, 'box1-surau.local');
      expect(out.box.lastIp, '10.1.1.2');
      expect(box.byPath('/api/enrol/complete')!.url.origin, 'https://10.1.1.2:8443');
    });

    test('a payload with surau info saves it; one without clears the copy of the surau left', () async {
      final infoStore = MemorySurauInfoStore(const SurauInfo(name: 'Surau Lama'));
      EnrolFlow withStore() => EnrolFlow(
        clientFor: FakeBox(happyBox).client,
        key: FakeDeviceKey(),
        trust: FakeTrust(),
        store: MemoryEnrolledBoxStore(),
        platform: 'android',
        surauInfoStore: infoStore,
        now: () => DateTime.utc(2026, 11, 4),
      );
      await withStore().run(fixturePayload(), deviceName: 'T', hasPinAlready: false, newPin: '280419');
      expect((await infoStore.load())!.name, 'Surau Contoh');
      await infoStore.save(const SurauInfo(name: 'Surau Lama'));
      await withStore().run(fixturePayload(legacy: true), deviceName: 'T', hasPinAlready: false, newPin: '280419');
      expect(await infoStore.load(), isNull);
    });

    group('a payload whose box is the box name', () {
      String nameBox() {
        final base = fixturePayload();
        final m = jsonDecode(utf8.decode(base64Url.decode(base64Url.normalize(base.substring(7))))) as Map<String, dynamic>;
        m['box'] = 'https://box1-surau.local:8443';
        m['name'] = 'box1-surau.local';
        m['ips'] = ['10.1.1.1', '10.1.1.2'];
        return 'surau1:${base64Url.encode(utf8.encode(jsonEncode(m))).replaceAll('=', '')}';
      }

      Future<(EnrolOutcome, FakeBox)> runAt(String? page) async {
        final box = FakeBox(happyBox);
        key = FakeDeviceKey();
        trust = FakeTrust();
        store = MemoryEnrolledBoxStore();
        final flow = EnrolFlow(
          clientFor: box.client,
          key: key,
          trust: trust,
          store: store,
          platform: page == null ? 'android' : 'ios-web',
          pageOrigin: page == null ? null : Uri.parse(page),
          now: () => DateTime.utc(2026, 11, 4),
        );
        return (await flow.run(nameBox(), deviceName: 'T', hasPinAlready: false, newPin: '280419'), box);
      }

      test('web at the name page: keeps the name origin', () async {
        final (out, _) = await runAt('https://box1-surau.local:8443/app/');
        expect(out.box.box.toString(), 'https://box1-surau.local:8443');
        expect(out.box.name, 'box1-surau.local');
      });

      test('web at an IP page that the payload lists: keeps that page origin', () async {
        final (out, box) = await runAt('https://10.1.1.2:8443/app/');
        expect(out.box.box.toString(), 'https://10.1.1.2:8443');
        expect(out.box.lastIp, '10.1.1.2');
        expect(box.byPath('/api/enrol/complete')!.url.origin, 'https://10.1.1.2:8443');
      });

      test('web at an unlisted IP page: the payload is refused (a page can only enrol its own box)', () async {
        await expectLater(runAt('https://10.9.9.9:8443/app/'), throwsA(isA<FormatException>()));
        expect(key.generateCalls, 0);
        expect(key.generatePendingCalls, 0);
      });
    });

    group('web page origin', () {
      String named() {
        final base = fixturePayload();
        final m = jsonDecode(utf8.decode(base64Url.decode(base64Url.normalize(base.substring(7))))) as Map<String, dynamic>;
        m['name'] = 'box1-surau.local';
        m['ips'] = ['127.0.0.1', '10.1.1.1'];
        return 'surau1:${base64Url.encode(utf8.encode(jsonEncode(m))).replaceAll('=', '')}';
      }

      Future<(EnrolOutcome, FakeBox)> runAt(String? page, String text) async {
        final box = FakeBox(happyBox);
        key = FakeDeviceKey();
        trust = FakeTrust();
        store = MemoryEnrolledBoxStore();
        final flow = EnrolFlow(
          clientFor: box.client,
          key: key,
          trust: trust,
          store: store,
          platform: 'ios-web',
          pageOrigin: page == null ? null : Uri.parse(page),
          now: () => DateTime.utc(2026, 11, 4),
        );
        final out = await flow.run(text, deviceName: 'T', hasPinAlready: false, newPin: '280419');
        return (out, box);
      }

      test('page opened at the box name: enrol at the name (same origin)', () async {
        final (out, box) = await runAt('https://box1-surau.local:8443/app/', named());
        expect(box.byPath('/api/enrol/complete')!.url.origin, 'https://box1-surau.local:8443');
        expect(out.box.box.toString(), 'https://box1-surau.local:8443');
        expect(out.box.name, 'box1-surau.local');
        expect(trust.calls.single.$1.toString(), 'https://box1-surau.local:8443');
      });

      test('page opened at an IP the QR lists: enrol at that IP', () async {
        final (out, box) = await runAt('https://10.1.1.1:8443/app/', named());
        expect(box.byPath('/api/enrol/complete')!.url.origin, 'https://10.1.1.1:8443');
        expect(out.box.box.toString(), 'https://10.1.1.1:8443');
      });

      test('an unrelated page origin or another port is refused: a page enrols only its own box', () async {
        for (final page in ['https://evil.example:8443/app/', 'https://box1-surau.local:9999/app/', 'http://box1-surau.local:8443/app/', 'https://127.0.0.1:9999/app/']) {
          await expectLater(runAt(page, named()), throwsA(isA<FormatException>()), reason: page);
          expect(key.generateCalls, 0, reason: page);
        }
      });

      test('no page origin (Android) keeps payload.box', () async {
        final (out, _) = await runAt(null, named());
        expect(out.box.box.toString(), 'https://127.0.0.1:8443');
      });
    });

    test('a QR without a name leaves name null', () async {
      final out = await flowFor(FakeBox(happyBox)).run(fixturePayload(), deviceName: 'T', hasPinAlready: false, newPin: '280419');
      expect(out.box.name, isNull);
      expect(out.box.lastIp, '127.0.0.1');
    });

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

    test('replacing: a refused code leaves the old enrolment record in place; a good code replaces it', () async {
      final old = EnrolledBox(
        box: Uri.parse('https://10.168.50.11:8443'),
        boxId: 'b2b2b2b2b2b2b2b2',
        deviceId: 'dev-old',
        userId: 'u-old',
        userName: 'Encik Kamal',
        roles: const ['ajk'],
        caSha256: 'a' * 64,
      );
      // the main box refuses the code: the old record is not touched
      final refusing = FakeBox((r) async => jsonResponse(401, {'code': 'bad_code', 'errors': ['bad_code']}));
      var flow = flowFor(refusing);
      await store.save(old);
      key.present = true;
      flow = EnrolFlow(clientFor: refusing.client, key: key, trust: trust, store: store, platform: 'android', replacing: true, now: () => DateTime.utc(2026, 11, 4));
      await expectLater(flow.run(fixturePayload(), deviceName: 'x', hasPinAlready: true), throwsA(isA<BoxError>()));
      expect((await store.load())?.deviceId, 'dev-old', reason: 'the old record stands until a new enrolment succeeded');
      // a good code replaces it
      final good = FakeBox(happyBox);
      flow = EnrolFlow(clientFor: good.client, key: key, trust: trust, store: store, platform: 'android', replacing: true, now: () => DateTime.utc(2026, 11, 4));
      final out = await flow.run(fixturePayload(), deviceName: 'x', hasPinAlready: true);
      expect(out.box.deviceId, 'dev-1');
      expect((await store.load())?.deviceId, 'dev-1');
    });

    group('replacing keeps the old device key until the new enrolment is saved', () {
      final old = EnrolledBox(
        box: Uri.parse('https://10.168.50.11:8443'),
        boxId: 'b2b2b2b2b2b2b2b2',
        deviceId: 'dev-old',
        userId: 'u-old',
        userName: 'Encik Kamal',
        roles: const ['ajk'],
        caSha256: 'a' * 64,
      );

      Future<(SoftwareDeviceKey, Map<String, String>)> oldKey() async {
        final k = SoftwareDeviceKey.random();
        return (k, await k.publicJwk());
      }

      EnrolFlow replacingFlow(FakeBox box, DeviceKey k) {
        trust = FakeTrust();
        return EnrolFlow(
          clientFor: box.client,
          key: k,
          trust: trust,
          store: store,
          platform: 'android',
          replacing: true,
          now: () => DateTime.utc(2026, 11, 4),
        );
      }

      Future<void> expectOldKeyStands(SoftwareDeviceKey k, Map<String, String> jwk) async {
        expect(await k.exists(), isTrue);
        expect(await k.publicJwk(), jwk);
        final msg = Uint8List.fromList(utf8.encode('probe'));
        expect(verifyP256(jwk, msg, await k.sign(msg)), isTrue, reason: 'the old key still signs');
      }

      test('a refused code: the old key still exists and signs, the record stands', () async {
        store = MemoryEnrolledBoxStore();
        await store.save(old);
        final (k, jwk) = await oldKey();
        final refusing = FakeBox((r) async => jsonResponse(401, {'code': 'bad_code', 'errors': ['bad_code']}));
        await expectLater(
          replacingFlow(refusing, k).run(fixturePayload(), deviceName: 'x', hasPinAlready: true),
          throwsA(isA<BoxError>()),
        );
        await expectOldKeyStands(k, jwk);
        expect((await store.load())?.deviceId, 'dev-old');
        expect(trust.commits, isEmpty, reason: 'nothing of the new box is kept before it succeeded');
      });

      test('a network failure: the old key still exists and signs', () async {
        store = MemoryEnrolledBoxStore();
        await store.save(old);
        final (k, jwk) = await oldKey();
        final down = FakeBox((r) async => throw const BoxUnreachable('down'));
        await expectLater(
          replacingFlow(down, k).run(fixturePayload(), deviceName: 'x', hasPinAlready: true),
          throwsA(isA<BoxUnreachable>()),
        );
        await expectOldKeyStands(k, jwk);
      });

      test('the new record could not be saved: the old key still signs', () async {
        store = _OldRecordFailingSaveStore(old);
        final (k, jwk) = await oldKey();
        await expectLater(
          replacingFlow(FakeBox(happyBox), k).run(fixturePayload(), deviceName: 'x', hasPinAlready: true),
          throwsA(isA<StateError>()),
        );
        await expectOldKeyStands(k, jwk);
        expect((await store.load())?.deviceId, 'dev-old');
      });

      test('success: the new key replaces the old one and the record is the new box', () async {
        store = MemoryEnrolledBoxStore();
        await store.save(old);
        final (k, jwk) = await oldKey();
        final out = await replacingFlow(FakeBox(happyBox), k).run(fixturePayload(), deviceName: 'x', hasPinAlready: true);
        expect(out.box.deviceId, 'dev-1');
        expect((await store.load())?.deviceId, 'dev-1');
        expect(await k.exists(), isTrue);
        expect(await k.publicJwk(), isNot(jwk), reason: 'the key in use is now the new one');
        // nothing pending is left behind
        await expectLater(k.commitPending(), throwsA(isA<StateError>()));
      });

      test('the fake key sees generatePending, then commitPending only after the save', () async {
        store = MemoryEnrolledBoxStore();
        await store.save(old);
        final fk = FakeDeviceKey(present: true);
        await replacingFlow(FakeBox(happyBox), fk).run(fixturePayload(), deviceName: 'x', hasPinAlready: true);
        expect(fk.generateCalls, 0);
        expect(fk.generatePendingCalls, 1);
        expect(fk.commitPendingCalls, 1);
        expect(fk.discardPendingCalls, 0);
        expect(fk.clearCalls, 0);
      });
    });

    test('without replacing, the same phone is still refused (the working key is never replaced by accident)', () async {
      final box = FakeBox(happyBox);
      final flow = flowFor(box);
      await store.save(
        EnrolledBox(box: Uri.parse('https://10.168.50.11:8443'), boxId: 'b2b2b2b2b2b2b2b2', deviceId: 'dev-old', userId: 'u', userName: 'N', roles: const ['ajk'], caSha256: 'a' * 64),
      );
      key.present = true;
      await expectLater(flow.run(fixturePayload(), deviceName: 'x', hasPinAlready: true), throwsA(isA<EnrolAlreadyEnrolled>()));
      expect((await store.load())?.deviceId, 'dev-old');
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

  group('EnrolFlow.run, native, payload box is the box name', () {
    const name = 'box1-surau.local';
    const goodId = '0123456789abcdef';
    late FakeTrust trust;
    late MemoryEnrolledBoxStore store;
    late FakeDeviceKey key;

    String payload({List<String>? ips = const ['10.1.1.1', '10.1.1.2'], String box = 'https://box1-surau.local:8443'}) {
      final base = fixturePayload();
      final m = jsonDecode(utf8.decode(base64Url.decode(base64Url.normalize(base.substring(7))))) as Map<String, dynamic>;
      m['box'] = box;
      m['name'] = name;
      if (ips != null) m['ips'] = ips;
      return 'surau1:${base64Url.encode(utf8.encode(jsonEncode(m))).replaceAll('=', '')}';
    }

    /// [idAt]: the boxId each IP answers with at `/api/box/info` (as seen
    /// through the route the flow seeded for the name).
    (EnrolFlow, FakeBox) flow(Map<String, String> idAt, {bool pins = true}) {
      late FakeBox box;
      box = FakeBox((r) async {
        if (r.url.path == '/api/box/info') {
          final ip = trust.routes[name];
          return ip == null || !idAt.containsKey(ip)
              ? jsonResponse(404, {'errors': ['tiada']})
              : jsonResponse(200, {'boxId': idAt[ip]});
        }
        return happyBox(r);
      });
      key = FakeDeviceKey();
      trust = FakeTrust(pinsCa: pins);
      store = MemoryEnrolledBoxStore();
      return (
        EnrolFlow(
          clientFor: box.client,
          key: key,
          trust: trust,
          store: store,
          platform: 'android',
          now: () => DateTime.utc(2026, 11, 4),
        ),
        box,
      );
    }

    Future<EnrolOutcome> run(EnrolFlow f, String text) =>
        f.run(text, deviceName: 'T', hasPinAlready: false, newPin: '280419');

    test('seeds the route, checks the boxId, enrols at the name and stores name, box and lastIp', () async {
      final (f, box) = flow({'10.1.1.1': goodId});
      final out = await run(f, payload());
      expect(trust.routeLog, ['+$name=10.1.1.1']);
      expect(trust.calls.map((c) => c.$1.toString()), ['https://10.1.1.1:8443']);
      expect(box.byPath('/api/box/info'), isNotNull);
      expect(box.byPath('/api/enrol/complete')!.url.origin, 'https://$name:8443');
      expect(out.box.box.toString(), 'https://$name:8443');
      expect(out.box.name, name);
      expect(out.box.lastIp, '10.1.1.1');
      expect((await store.load())!.box.host, name);
      expect(trust.commits, isNotEmpty);
    });

    test('a wrong boxId at the first IP removes that route and the next IP wins', () async {
      final (f, _) = flow({'10.1.1.1': 'ffffffffffffffff', '10.1.1.2': goodId});
      final out = await run(f, payload());
      expect(trust.routeLog, ['+$name=10.1.1.1', '-$name', '+$name=10.1.1.2']);
      expect(trust.routes, {name: '10.1.1.2'});
      expect(out.box.lastIp, '10.1.1.2');
      expect(out.box.box.host, name);
    });

    test('a root that does not check out at an IP skips it', () async {
      final (f, _) = flow({'10.1.1.2': goodId});
      // flow() builds the trust; fail the first IP afterwards
      trust.failAt.add('10.1.1.1');
      final out = await run(f, payload());
      expect(trust.calls.map((c) => c.$1.host), ['10.1.1.1', '10.1.1.2']);
      expect(out.box.lastIp, '10.1.1.2');
    });

    test('no IP passes: falls back to the payload box as it is, no route left', () async {
      final (f, box) = flow({'10.1.1.1': 'ffffffffffffffff', '10.1.1.2': 'eeeeeeeeeeeeeeee'});
      final out = await run(f, payload());
      expect(trust.routes, isEmpty);
      expect(trust.calls.last.$1.toString(), 'https://$name:8443');
      expect(box.byPath('/api/enrol/complete')!.url.origin, 'https://$name:8443');
      expect(out.box.box.host, name);
      expect(out.box.name, name);
      expect(out.box.lastIp, '10.1.1.1');
    });

    test('a payload without ips falls back unchanged (no probe)', () async {
      final (f, box) = flow({'10.1.1.1': goodId});
      final out = await run(f, payload(ips: null));
      expect(trust.routeLog, isEmpty);
      expect(box.byPath('/api/box/info'), isNull);
      expect(trust.calls.map((c) => c.$1.toString()), ['https://$name:8443']);
      expect(out.box.lastIp, isNull);
    });

    test('an IP-origin payload is not promoted to the name', () async {
      final (f, box) = flow({'10.1.1.1': goodId});
      final out = await run(f, payload(box: 'https://10.1.1.2:8443'));
      expect(trust.routeLog, isEmpty);
      expect(box.byPath('/api/box/info'), isNull);
      expect(out.box.box.toString(), 'https://10.1.1.2:8443');
      expect(out.box.name, name);
      expect(out.box.lastIp, '10.1.1.2');
    });

    test('where the app does not pin the CA (web) nothing is probed', () async {
      final (f, box) = flow({'10.1.1.1': goodId}, pins: false);
      final out = await run(f, payload());
      expect(trust.routeLog, isEmpty);
      expect(box.byPath('/api/box/info'), isNull);
      expect(out.box.box.host, name);
    });

    test('the box refusing the code drops the seeded route again', () async {
      late FakeBox box;
      box = FakeBox((r) async {
        if (r.url.path == '/api/box/info') return jsonResponse(200, {'boxId': goodId});
        return jsonResponse(403, {'errors': ['kod tidak sah']});
      });
      key = FakeDeviceKey();
      trust = FakeTrust(pinsCa: true);
      store = MemoryEnrolledBoxStore();
      final f = EnrolFlow(clientFor: box.client, key: key, trust: trust, store: store, platform: 'android', now: () => DateTime.utc(2026, 11, 4));
      await expectLater(run(f, payload()), throwsA(isA<BoxError>()));
      expect(trust.routes, isEmpty);
      expect(key.present, isFalse);
      expect(await store.load(), isNull);
    });

    group('the routes table is left as it was by a failed attempt', () {
      test('a route proven earlier survives when every IP fails', () async {
        final (f, _) = flow({'10.1.1.1': 'ffffffffffffffff', '10.1.1.2': 'eeeeeeeeeeeeeeee'});
        trust.routes[name] = '10.9.9.9';
        await run(f, payload());
        expect(trust.routes, {name: '10.9.9.9'});
      });

      test('a route proven earlier survives a refused join', () async {
        final box = FakeBox((r) async {
          if (r.url.path == '/api/box/info') return jsonResponse(200, {'boxId': goodId});
          return jsonResponse(403, {'errors': ['kod tidak sah']});
        });
        key = FakeDeviceKey();
        trust = FakeTrust(pinsCa: true);
        store = MemoryEnrolledBoxStore();
        trust.routes[name] = '10.9.9.9';
        final f = EnrolFlow(clientFor: box.client, key: key, trust: trust, store: store, platform: 'android', now: () => DateTime.utc(2026, 11, 4));
        await expectLater(run(f, payload()), throwsA(isA<BoxError>()));
        expect(trust.routes, {name: '10.9.9.9'});
        expect(key.present, isFalse);
      });

      test('a store.save throw after a good join restores the previous route', () async {
        flow({'10.1.1.1': goodId});
        trust.routes[name] = '10.9.9.9';
        final box = FakeBox((r) async => r.url.path == '/api/box/info' ? jsonResponse(200, {'boxId': goodId}) : happyBox(r));
        final failing = _FailingSaveStore();
        final f3 = EnrolFlow(clientFor: box.client, key: key, trust: trust, store: failing, platform: 'android', now: () => DateTime.utc(2026, 11, 4));
        await expectLater(run(f3, payload()), throwsA(isA<StateError>()));
        expect(trust.routes, {name: '10.9.9.9'});
      });

      test('a store.save throw with no earlier route removes the new one', () async {
        flow({'10.1.1.1': goodId});
        final box = FakeBox((r) async => r.url.path == '/api/box/info' ? jsonResponse(200, {'boxId': goodId}) : happyBox(r));
        final f3 = EnrolFlow(clientFor: box.client, key: key, trust: trust, store: _FailingSaveStore(), platform: 'android', now: () => DateTime.utc(2026, 11, 4));
        await expectLater(run(f3, payload()), throwsA(isA<StateError>()));
        expect(trust.routes, isEmpty);
      });
    });

    group('the real error is not masked', () {
      test('a root that does not match the code is the same trust error an IP payload gives; no route, no key', () async {
        final (f, _) = flow({'10.1.1.1': goodId});
        trust.mismatch = true;
        await expectLater(
          run(f, payload()),
          throwsA(isA<TrustError>().having((e) => e.kind, 'kind', TrustKind.rootMismatch)),
        );
        expect(trust.calls, hasLength(1), reason: 'the same for every IP: no second try');
        expect(trust.routes, isEmpty);
        expect(key.present, isFalse);
        expect(key.generateCalls, 0);
        expect(await store.load(), isNull);
      });

      test('every IP unreachable and the fallback unreachable: an unreachable error as before', () async {
        final box = FakeBox((r) async => throw const BoxUnreachable());
        key = FakeDeviceKey();
        trust = FakeTrust(pinsCa: true);
        store = MemoryEnrolledBoxStore();
        final f = EnrolFlow(clientFor: box.client, key: key, trust: trust, store: store, platform: 'android', now: () => DateTime.utc(2026, 11, 4));
        await expectLater(run(f, payload()), throwsA(isA<BoxUnreachable>()));
        expect(trust.routes, isEmpty);
        expect(key.present, isFalse);
      });

      test('every IP fails with a trust error and the fallback fails too: the trust error wins', () async {
        final (f, _) = flow({'10.1.1.1': goodId});
        trust.failAt.addAll(['10.1.1.1', '10.1.1.2', name]);
        await expectLater(run(f, payload()), throwsA(isA<TrustError>()));
        expect(trust.routes, isEmpty);
      });
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

class _FailingSaveStore extends MemoryEnrolledBoxStore {
  @override
  Future<void> save(EnrolledBox box) async => throw StateError('disk full');
}

/// A store that holds an old record and refuses to save a new one.
class _OldRecordFailingSaveStore extends MemoryEnrolledBoxStore {
  _OldRecordFailingSaveStore(this._old);

  final EnrolledBox _old;

  @override
  Future<EnrolledBox?> load() async => _old;

  @override
  Future<void> save(EnrolledBox box) async => throw StateError('disk full');
}
