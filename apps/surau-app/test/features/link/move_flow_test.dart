// The phone move (lib/features/link/move_flow.dart): the signed message byte for byte as the follower builds it
// (`moveMessage` in apps/box-server/src/follow/moves.ts), the two calls at the old box, every refusal, the pointer's
// checks, and the join at the main box: reached and proven BEFORE the device key is replaced, enrolled with the ticket
// and a new PIN, the stored box replaced only on success.

import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:surau_app/box/box_client.dart';
import 'package:surau_app/box/device_key.dart' show b64url, unB64url;
import 'package:surau_app/box/device_key_software.dart' show SoftwareDeviceKey, verifyP256;
import 'package:surau_app/box/payload.dart';
import 'package:surau_app/features/enrol/enrol_flow.dart';
import 'package:surau_app/features/link/move_flow.dart';

import '../fakes.dart';

const followerId = 'b2b2b2b2b2b2b2b2';
const masterId = 'a1a1a1a1a1a1a1a1';
const masterFp = 'a1a1a1a1a1a1a1a1';
final masterCa64 = 'c' * 64;
const deviceId = 'dev_phone_1';
const nonce = 'XDEmJK-uEm2ZdjkX4kN3l09a-gC3tFkiDDUfgLAlRvg';
const ticket = 'ABCD-EFGH-2345';

EnrolledBox followerBox() => EnrolledBox(
  box: Uri.parse('https://10.168.50.11:8443'),
  boxId: followerId,
  deviceId: deviceId,
  userId: 'u-kamal',
  userName: 'Encik Kamal',
  roles: const ['ajk'],
  caSha256: 'a' * 64,
);

Map<String, Object?> pointerBody({
  String fromBoxId = followerId,
  String ticketCode = ticket,
  String expiresAt = '2099-12-20T09:00:00.000Z',
  List<String> addresses = const ['https://10.168.50.10:8443'],
  String masterBoxId = masterId,
}) => {
  'pointer': {
    'v': 1,
    'linkId': 'l1l1l1l1l1l1l1l1l1l1l1l1l1l1l1l1',
    'fromBoxId': fromBoxId,
    'master': {'name': 'Dewan Utama', 'boxId': masterBoxId, 'keyFp': masterFp, 'caSha256': masterCa64, 'addresses': addresses},
    'ticket': ticketCode,
    'expiresAt': expiresAt,
  },
  'sig': 'x' * 86,
};

http.Response boxInfo({String boxId = masterId, String keyFp = masterFp}) => jsonResponse(200, {
  'boxId': boxId,
  'keyFp': keyFp,
  'name': 'Dewan Utama',
  'state': 'active',
  'reason': '',
  'linked': true,
  'https': true,
  'caSha256': masterCa64,
});

class Rig {
  Rig({
    Future<http.Response> Function(http.Request)? old,
    Future<http.Response> Function(http.Request)? master,
    SoftwareDeviceKey? key,
    DateTime Function()? now,
  }) : key = key ?? SoftwareDeviceKey.random() {
    oldBox = FakeBox(old ?? happyOld);
    masterBox = FakeBox(master ?? happyMaster);
    trust = FakeTrust();
    store = MemoryEnrolledBoxStore();
    flow = MoveFlow(
      box: followerBox(),
      oldClient: oldBox.client(Uri.parse('https://10.168.50.11:8443')),
      key: this.key,
      trust: trust,
      clientFor: masterBox.client,
      store: store,
      platform: 'android',
      now: now,
    );
  }

  final SoftwareDeviceKey key;
  late final FakeBox oldBox;
  late final FakeBox masterBox;
  late final FakeTrust trust;
  late final MemoryEnrolledBoxStore store;
  late final MoveFlow flow;

  /// The old box: checks the signature over the exact message with the phone's own public key.
  Future<http.Response> happyOld(http.Request r) async {
    switch (r.url.path) {
      case '/api/follow/move/challenge':
        return jsonResponse(200, {'nonce': nonce, 'expiresAt': '2099-01-01T00:00:00.000Z'});
      case '/api/follow/move':
        final b = jsonDecode(r.body) as Map<String, dynamic>;
        final ok =
            b['deviceId'] == deviceId &&
            b['nonce'] == nonce &&
            verifyP256(
              await key.publicJwk(),
              moveMessage(followerId, deviceId, nonce),
              unB64url(b['signature'] as String),
            );
        if (!ok) return jsonResponse(401, {'code': 'bad_signature', 'errors': ['bad_signature']});
        return jsonResponse(200, pointerBody());
      case '/api/kiosk/link':
        return jsonResponse(200, {'mode': 'follower', 'master': {'name': 'Dewan Utama'}});
    }
    return jsonResponse(404, {'code': 'not_found'});
  }

  Future<http.Response> happyMaster(http.Request r) async {
    switch (r.url.path) {
      case '/api/box/info':
        return boxInfo();
      case '/api/enrol/complete':
        return jsonResponse(200, {'deviceId': 'dev_new', 'userId': 'u-master-1', 'roles': ['ajk'], 'pinRequired': false, 'appLock': true});
    }
    return jsonResponse(404, {'code': 'not_found'});
  }
}

Future<Object?> failure(Future<Object?> Function() run) async {
  try {
    await run();
  } on Object catch (e) {
    return e;
  }
  return null;
}

void main() {
  group('the signed message', () {
    test('is "maxcom-link-move", the follower\'s box id, the device id and the nonce, joined by newlines', () {
      expect(
        utf8.decode(moveMessage(followerId, deviceId, nonce)),
        'maxcom-link-move\n$followerId\n$deviceId\n$nonce',
      );
    });

    test('has no trailing newline and is not the unlock message', () {
      final bytes = moveMessage(followerId, deviceId, nonce);
      expect(bytes.last, isNot(10));
      expect(utf8.decode(bytes).startsWith('surau-unlock'), isFalse);
      expect(utf8.decode(bytes).split('\n'), hasLength(4));
    });

    test('a refusal of the follower is recognised as 409 follower only', () {
      expect(isFollowerRefusal(const BoxError(409, 'x', code: 'follower')), isTrue);
      expect(isFollowerRefusal(const BoxError(409, 'x', code: 'linking')), isFalse);
      expect(isFollowerRefusal(const BoxError(401, 'x', code: 'follower')), isFalse);
      expect(isFollowerRefusal(StateError('x')), isFalse);
    });
  });

  group('the pointer', () {
    test('challenge, then a signature the follower accepts, then the pointer', () async {
      final rig = Rig();
      final p = await rig.flow.pointer();
      expect(p.masterName, 'Dewan Utama');
      expect(p.masterBoxId, masterId);
      expect(p.masterCaSha256, masterCa64);
      expect(p.addresses, ['https://10.168.50.10:8443']);
      expect(p.ticket, ticket);
      expect(rig.oldBox.seen.map((r) => r.url.path), ['/api/follow/move/challenge', '/api/follow/move']);
      expect(rig.oldBox.bodyOf('/api/follow/move/challenge'), {'deviceId': deviceId});
      final sent = rig.oldBox.bodyOf('/api/follow/move');
      expect(sent.keys.toSet(), {'deviceId', 'nonce', 'signature'});
      // base64url, 64 bytes, no padding
      expect((sent['signature'] as String).length, 86);
      expect(unB64url(sent['signature'] as String), hasLength(64));
      // no token: the phone has no session at the follower, the device key is the proof
      expect(rig.oldBox.seen.every((r) => !r.headers.containsKey('authorization')), isTrue);
      expect(b64url(unB64url(sent['signature'] as String)), sent['signature']);
    });

    test('a signature over another box id is refused by the follower (the id is the follower\'s own)', () async {
      final rig = Rig();
      final jwk = await rig.key.publicJwk();
      final sig = await rig.key.sign(moveMessage(masterId, deviceId, nonce));
      expect(verifyP256(jwk, moveMessage(followerId, deviceId, nonce), sig), isFalse);
      expect(verifyP256(jwk, moveMessage(masterId, deviceId, nonce), sig), isTrue);
    });

    test('401 bad_signature and 404 no_ticket: ask for a join code (an admin phone never has a ticket)', () async {
      final bad = Rig(old: (r) async => jsonResponse(r.url.path.endsWith('challenge') ? 200 : 401, r.url.path.endsWith('challenge') ? {'nonce': nonce} : {'code': 'bad_signature'}));
      expect(await failure(bad.flow.pointer), isA<MoveNeedCode>());
      final none = Rig(old: (r) async => jsonResponse(r.url.path.endsWith('challenge') ? 200 : 404, r.url.path.endsWith('challenge') ? {'nonce': nonce} : {'code': 'no_ticket'}));
      expect(await failure(none.flow.pointer), isA<MoveNeedCode>());
    });

    test('lan_only, no answer and a box that does not know the route: away or nothing to move', () async {
      expect(await failure(Rig(old: (r) async => jsonResponse(403, {'code': 'lan_only'})).flow.pointer), isA<MoveAway>());
      expect(await failure(Rig(old: (r) async => throw http.ClientException('down')).flow.pointer), isA<MoveAway>());
      expect(await failure(Rig(old: (r) async => jsonResponse(404, {'code': 'not_found'})).flow.pointer), isA<MoveNotFollower>());
      expect(await failure(Rig(old: (r) async => jsonResponse(429, {'code': 'too_many'})).flow.pointer), isA<MoveTooMany>());
    });

    test('a pointer from another box id, an expired one, a bad ticket or an HTTP address is refused', () async {
      Future<Object?> with_(Map<String, Object?> body) => failure(
        Rig(
          old: (r) async => r.url.path.endsWith('challenge') ? jsonResponse(200, {'nonce': nonce}) : jsonResponse(200, body),
        ).flow.pointer,
      );
      expect(await with_(pointerBody(fromBoxId: 'f' * 16)), isA<MoveBadPointer>());
      expect(await with_(pointerBody(expiresAt: '2020-01-01T00:00:00.000Z')), isA<MoveNeedCode>());
      expect(await with_(pointerBody(ticketCode: 'not a ticket')), isA<MoveBadPointer>());
      expect(await with_(pointerBody(addresses: ['http://10.168.50.10:8080'])), isA<MoveBadPointer>());
      expect(await with_(pointerBody(addresses: [])), isA<MoveBadPointer>());
      expect(await with_({'pointer': 'x'}), isA<MoveBadPointer>());
    });

    test('a phone without a device key asks for a join code and sends nothing', () async {
      final key = SoftwareDeviceKey.random();
      await key.clear();
      final rig = Rig(key: key);
      expect(await failure(rig.flow.pointer), isA<MoveNeedCode>());
      expect(rig.oldBox.seen, isEmpty);
    });

    test('the main box\'s name comes from the follower\'s own TV answer, best effort', () async {
      expect(await Rig().flow.masterName(), 'Dewan Utama');
      expect(await Rig(old: (r) async => throw http.ClientException('down')).flow.masterName(), isNull);
    });
  });

  group('the follower\'s own web app (a browser cannot call it)', () {
    MovePointer pointerOf({List<String> addresses = const ['https://10.168.50.12:8443']}) =>
        MovePointer.fromJson(pointerBody(addresses: addresses));

    test('the join text is an enrolment code of that box that the enrol page accepts', () {
      final text = joinEnrolText(pointerOf(), user: 'Encik Kamal');
      expect(text, startsWith('surau1:'));
      final payload = EnrolPayload.parse(text, requireCa: true);
      expect(payload.box, 'https://10.168.50.12:8443');
      expect(payload.boxId, masterId);
      expect(payload.caSha256, masterCa64);
      expect(payload.code, ticket);
      expect(payload.user, 'Encik Kamal');
      expect(payload.pinSet, isFalse, reason: 'a new PIN is chosen there');
      expect(payload.exp, DateTime.parse('2099-12-20T09:00:00.000Z').millisecondsSinceEpoch);
    });

    test('the address opens /app/ of the follower with the text in the fragment, never in the query', () {
      final url = followerEnrolUrl(pointerOf(), user: 'Encik Kamal');
      expect(url.scheme, 'https');
      expect(url.host, '10.168.50.12');
      expect(url.port, 8443);
      expect(url.path, '/app/');
      expect(url.query, isEmpty, reason: 'a query would reach the server');
      expect(url.fragment, startsWith('/enrol?join='));
      final inner = Uri.parse(url.fragment).queryParameters['join']!;
      expect(inner, joinEnrolText(pointerOf(), user: 'Encik Kamal'));
      // the first address of the pointer is used
      expect(followerEnrolUrl(pointerOf(addresses: ['https://10.168.50.13:8443', 'https://10.168.50.12:8443']), user: '').host, '10.168.50.13');
    });
  });

  group('joining the main box', () {
    test('reached over the pinned CA, proven by id and key, then enrolled with the ticket and a new PIN', () async {
      final rig = Rig();
      final before = await rig.key.publicJwk();
      final p = await rig.flow.pointer();
      final out = await rig.flow.connect(p, newPin: '280419', deviceName: 'Telefon Encik Kamal');
      expect(rig.trust.calls.single.$1.toString(), 'https://10.168.50.10:8443');
      expect(rig.trust.calls.single.$2, masterCa64);
      expect(rig.masterBox.seen.map((r) => r.url.path), ['/api/box/info', '/api/enrol/complete']);
      final enrol = rig.masterBox.bodyOf('/api/enrol/complete');
      expect(enrol['code'], ticket);
      expect(enrol['pin'], '280419');
      expect(enrol['platform'], 'android');
      // a NEW device key, not the one the old box knew
      expect(enrol['publicJwk'], isNot(before));
      expect(await rig.key.publicJwk(), enrol['publicJwk']);
      // the stored box is the main box now
      final saved = await rig.store.load();
      expect(saved!.boxId, masterId);
      expect(saved.box.toString(), 'https://10.168.50.10:8443');
      expect(saved.deviceId, 'dev_new');
      expect(saved.caSha256, masterCa64);
      expect(saved.userName, 'Encik Kamal');
      expect(out.box.boxId, masterId);
      expect(rig.trust.commits, [masterCa64]);
    });

    test('a box at the address that is not the one named: nothing changes, no enrolment is sent', () async {
      final rig = Rig(master: (r) async => boxInfo(boxId: 'f' * 16));
      final before = await rig.key.publicJwk();
      final p = await rig.flow.pointer();
      expect(await failure(() => rig.flow.connect(p, newPin: '280419', deviceName: 'T')), isA<MoveWrongBox>());
      expect(await rig.key.publicJwk(), before);
      expect(await rig.store.load(), isNull);
      expect(rig.masterBox.seen.where((r) => r.url.path == '/api/enrol/complete'), isEmpty);
      expect(rig.trust.commits, isEmpty);
    });

    test('the same id with another key fingerprint is the wrong box too', () async {
      final rig = Rig(master: (r) async => boxInfo(keyFp: 'e' * 16));
      final p = await rig.flow.pointer();
      expect(await failure(() => rig.flow.connect(p, newPin: '280419', deviceName: 'T')), isA<MoveWrongBox>());
    });

    test('a root CA that does not hash to the pointer is the wrong box; a CA fetch that fails is away', () async {
      Future<Object?> with_(TrustError error) async {
        final rig = Rig();
        final p = await rig.flow.pointer();
        final flow = MoveFlow(
          box: followerBox(),
          oldClient: rig.oldBox.client(Uri.parse('https://10.168.50.11:8443')),
          key: rig.key,
          trust: _RefusingTrust(error),
          clientFor: rig.masterBox.client,
          store: rig.store,
          platform: 'android',
        );
        final e = await failure(() => flow.connect(p, newPin: '280419', deviceName: 'T'));
        expect(await rig.store.load(), isNull);
        expect(rig.masterBox.seen, isEmpty);
        return e;
      }

      expect(await with_(TrustError.of(TrustKind.rootMismatch)), isA<MoveWrongBox>());
      expect(await with_(TrustError.of(TrustKind.rootFetch)), isA<MoveAway>());
    });

    test('the main box does not answer: away, the device key is untouched', () async {
      final rig = Rig(master: (r) async => throw http.ClientException('down'));
      final before = await rig.key.publicJwk();
      final p = await rig.flow.pointer();
      expect(await failure(() => rig.flow.connect(p, newPin: '280419', deviceName: 'T')), isA<MoveAway>());
      expect(await rig.key.publicJwk(), before);
      expect(await rig.store.load(), isNull);
    });

    test('the second address is used when the first does not answer', () async {
      final rig = Rig(
        old: (r) async => r.url.path.endsWith('challenge')
            ? jsonResponse(200, {'nonce': nonce})
            : jsonResponse(200, pointerBody(addresses: ['https://10.168.50.10:8443', 'https://10.168.50.12:8443'])),
        master: (r) async {
          if (r.url.host == '10.168.50.10') throw http.ClientException('down');
          return Rig().happyMaster(r);
        },
      );
      // the fake box client is built per origin but shares one handler: tell the addresses apart by the origin
      final seenHosts = <String>[];
      final flow = MoveFlow(
        box: followerBox(),
        oldClient: rig.oldBox.client(Uri.parse('https://10.168.50.11:8443')),
        key: rig.key,
        trust: rig.trust,
        clientFor: (box) {
          seenHosts.add(box.host);
          return BoxClient(
            box,
            _HostMock(box.host, rig.masterBox),
          );
        },
        store: rig.store,
        platform: 'android',
      );
      final p = await flow.pointer();
      final out = await flow.connect(p, newPin: '280419', deviceName: 'T');
      expect(seenHosts, ['10.168.50.10', '10.168.50.12']);
      expect(out.box.box.toString(), 'https://10.168.50.12:8443');
    });

    test('a ticket that ended while the PIN was typed is not tried: a join code is the way, nothing changes', () async {
      final rig = Rig();
      final before = await rig.key.publicJwk();
      final p = await rig.flow.pointer();
      final ended = MovePointer(
        linkId: p.linkId,
        fromBoxId: p.fromBoxId,
        masterName: p.masterName,
        masterBoxId: p.masterBoxId,
        masterKeyFp: p.masterKeyFp,
        masterCaSha256: p.masterCaSha256,
        addresses: p.addresses,
        ticket: p.ticket,
        expiresAt: DateTime.now().toUtc().subtract(const Duration(minutes: 5)),
        sig: p.sig,
      );
      expect(await failure(() => rig.flow.connect(ended, newPin: '280419', deviceName: 'T')), isA<MoveNeedCode>());
      expect(rig.masterBox.seen, isEmpty, reason: 'the main box was not asked');
      expect(await rig.key.publicJwk(), before, reason: 'the device key is untouched');
    });

    test('the per-person end of the ticket (a linking admin\'s 30 minutes) is the pointer\'s expiry', () async {
      final soon = DateTime.now().toUtc().add(const Duration(minutes: 20)).toIso8601String();
      final rig = Rig(old: (r) async {
        if (r.url.path == '/api/follow/move/challenge') return jsonResponse(200, {'nonce': nonce, 'expiresAt': '2099-01-01T00:00:00.000Z'});
        return jsonResponse(200, pointerBody(expiresAt: soon));
      });
      final p = await rig.flow.pointer();
      expect(p.expiresAt.toIso8601String(), startsWith(soon.substring(0, 16)));
      final out = await rig.flow.connect(p, newPin: '280419', deviceName: 'T');
      expect(out.box.boxId, masterId);
    });

    test('the injected clock decides, with two minutes of skew allowed', () async {
      // the ticket ends at 2099-12-20T09:00Z (the fixture default)
      final end = DateTime.utc(2099, 12, 20, 9);
      // a phone clock 90 seconds ahead of the end: still tried, the box decides
      final skewed = Rig(now: () => end.add(const Duration(seconds: 90)));
      final p1 = await skewed.flow.pointer();
      final out = await skewed.flow.connect(p1, newPin: '280419', deviceName: 'T');
      expect(out.box.boxId, p1.masterBoxId);
      expect(skewed.masterBox.seen, isNotEmpty, reason: 'the main box was asked');
      // a phone clock 3 minutes ahead: refused here, nothing sent, key untouched
      final late = Rig(now: () => end.add(const Duration(minutes: 3)));
      await expectLater(late.flow.pointer(), throwsA(isA<MoveNeedCode>()));
    });

    test('a weak PIN is refused here and nothing is sent', () async {
      final rig = Rig();
      final p = await rig.flow.pointer();
      expect(await failure(() => rig.flow.connect(p, newPin: '123456', deviceName: 'T')), isA<MovePinTooWeak>());
      expect(rig.masterBox.seen, isEmpty);
    });

    test('a ticket the main box refuses reads as "ask for a join code"; the old box stays stored', () async {
      final rig = Rig(master: (r) async => r.url.path == '/api/box/info' ? boxInfo() : jsonResponse(400, {'code': 'bad_code'}));
      final p = await rig.flow.pointer();
      expect(await failure(() => rig.flow.connect(p, newPin: '280419', deviceName: 'T')), isA<MoveNeedCode>());
      expect(await rig.store.load(), isNull);
      expect(await rig.key.exists(), isFalse);
    });
  });
}

/// A client whose requests reach [box]'s handler, or fail when the handler throws.
class _HostMock extends http.BaseClient {
  _HostMock(this.host, this.box);

  final String host;
  final FakeBox box;

  @override
  Future<http.StreamedResponse> send(http.BaseRequest request) async {
    final req = request as http.Request;
    box.seen.add(req);
    final res = await box.handler(req);
    return http.StreamedResponse(Stream.value(res.bodyBytes), res.statusCode, headers: res.headers, request: request);
  }
}

class _RefusingTrust extends FakeTrust {
  _RefusingTrust(this.error);

  final TrustError error;

  @override
  Future<void> establish(Uri box, String? caSha256) async => throw error;
}
