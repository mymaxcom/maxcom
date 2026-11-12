@TestOn('vm')
library;

import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:surau_app/box/box_client.dart';
import 'package:surau_app/box/locator.dart';
import 'package:surau_app/features/enrol/enrol_flow.dart';
import 'package:surau_app/sync/sync_engine.dart';
import 'package:surau_app/sync/transport.dart';

import '../features/fakes.dart';

final Uri _boxUri = Uri.parse('https://10.168.0.154:8443');
final Uri _cloudUri = Uri.parse('https://203.0.113.10');

EnrolledBox _enrolled({Uri? cloud}) => EnrolledBox(
  box: _boxUri,
  boxId: 'a1b2c3d4e5f60718',
  deviceId: 'dev1',
  userId: 'u1',
  userName: 'Ali',
  roles: const ['admin'],
  caSha256: null,
  cloud: cloud,
);

http.Response _health() => jsonResponse(200, {'ok': true, 'version': 7});

/// Records which hosts were asked what.
class _Net {
  final List<String> asked = [];
  bool boxUp = true;
  int cloudStatus = 200;
  Map<String, String> cloudHeaders = const {};

  BoxClient clientFor(Uri base) => BoxClient(
    base,
    MockClient((r) async {
      asked.add('${r.url.host} ${r.method} ${r.url.path}');
      final isBox = r.url.host == _boxUri.host;
      if (isBox) {
        if (!boxUp) throw http.ClientException('box down');
        return _handle(r);
      }
      if (cloudStatus != 200) {
        return jsonResponse(cloudStatus, {
          'state': 'waking',
        }, headers: cloudHeaders);
      }
      return _handle(r);
    }),
  );

  http.Response _handle(http.Request r) {
    switch (r.url.path) {
      case '/api/health':
        return _health();
      case '/api/auth/challenge':
        return jsonResponse(200, {'nonce': 'n-1', 'expiresAt': 'x'});
      case '/api/auth/unlock':
        return jsonResponse(200, sessionJson);
    }
    return jsonResponse(404, {
      'errors': ['tiada'],
    });
  }
}

BoxLocator _locators(_Net n) => CompositeLocator([
  TimeoutLocator(
    DirectBoxLocator(clientFor: (b) async => n.clientFor(b.box)),
    const Duration(seconds: 2),
  ),
  CloudLocator(clientFor: (cloud) async => n.clientFor(cloud)),
]);

void main() {
  test('the box answers: via box, the cloud is not asked', () async {
    final n = _Net();
    final at = await _locators(n).locate(_enrolled(cloud: _cloudUri));
    expect(at.via, 'box');
    expect(at.base, _boxUri);
    expect(n.asked.any((a) => a.startsWith(_cloudUri.host)), isFalse);
  });

  test('box down, cloud up: via cloud, base is the cloud', () async {
    final n = _Net()..boxUp = false;
    final at = await _locators(n).locate(_enrolled(cloud: _cloudUri));
    expect(at.via, 'cloud');
    expect(at.base, _cloudUri);
    expect(n.asked.first, startsWith(_boxUri.host), reason: 'box first');
    expect(n.asked.last, '${_cloudUri.host} GET /api/health');
  });

  test('both down: BoxUnreachable', () async {
    final n = _Net()
      ..boxUp = false
      ..cloudStatus = 500;
    await expectLater(
      _locators(n).locate(_enrolled(cloud: _cloudUri)),
      throwsA(isA<BoxUnreachable>()),
    );
  });

  test('no cloud linked and box down: the default cloud is asked', () async {
    final n = _Net()..boxUp = false;
    final at = await _locators(n).locate(_enrolled());
    expect(at.via, 'cloud');
    expect(at.base, Uri.parse('https://api.mymaxcom.my'));
    expect(n.asked.last, 'api.mymaxcom.my GET /api/health');
  });

  test(
    'cloud 503 waking is CloudWaking with Retry-After, not unreachable',
    () async {
      final n = _Net()
        ..boxUp = false
        ..cloudStatus = 503
        ..cloudHeaders = {'retry-after': '60'};
      await expectLater(
        _locators(n).locate(_enrolled(cloud: _cloudUri)),
        throwsA(
          isA<CloudWaking>()
              .having((e) => e.retryAfterSec, 'retry', 60)
              .having((e) => e.status, 'status', 503),
        ),
      );
    },
  );

  test(
    'a slow box does not hold the app: the timeout moves on to the cloud',
    () async {
      final slow = TimeoutLocator(_Never(), const Duration(milliseconds: 30));
      await expectLater(
        slow.locate(_enrolled()),
        throwsA(isA<BoxUnreachable>()),
      );
    },
  );

  test('CloudLocator has a 12 s budget of its own, so the Worker can say '
      'down or waking', () {
    final l = CloudLocator(clientFor: (c) async => throw StateError('x'));
    expect(l.timeout, const Duration(seconds: 12));
  });

  group('unlock goes to the located base', () {
    test('box up: the challenge is posted to the box', () async {
      final n = _Net();
      final tokens = SessionTokens();
      final out = await unlockAtLocated(
        locator: _locators(n),
        box: _enrolled(cloud: _cloudUri),
        clientFor: (b) async => n.clientFor(b),
        key: FakeDeviceKey(present: true),
        biometric: FakeBiometricPin(),
        tokens: tokens,
        noPin: true,
      );
      expect(out.at.via, 'box');
      expect(n.asked.where((a) => a.contains('/api/auth/challenge')), [
        '${_boxUri.host} POST /api/auth/challenge',
      ]);
      expect(tokens.get(_boxUri), 'tok-1');
      expect(tokens.get(_cloudUri), isNull, reason: 'tokens are per host');
    });

    test(
      'box down: the challenge and unlock are posted to the cloud',
      () async {
        final n = _Net()..boxUp = false;
        final tokens = SessionTokens();
        final out = await unlockAtLocated(
          locator: _locators(n),
          box: _enrolled(cloud: _cloudUri),
          clientFor: (b) async => n.clientFor(b),
          key: FakeDeviceKey(present: true),
          biometric: FakeBiometricPin(),
          tokens: tokens,
          noPin: true,
        );
        expect(out.at.via, 'cloud');
        final posts = n.asked.where((a) => a.contains('POST')).toList();
        expect(posts, [
          '${_cloudUri.host} POST /api/auth/challenge',
          '${_cloudUri.host} POST /api/auth/unlock',
        ]);
        expect(tokens.get(_cloudUri), 'tok-1');
        expect(tokens.get(_boxUri), isNull);
      },
    );

    test('the unlock screen\'s flow (LocatedUnlockFlow) goes through it: '
        'box down, a PIN unlock lands on the cloud', () async {
      final n = _Net()..boxUp = false;
      final tokens = SessionTokens();
      final seen = <String>[];
      final flow = LocatedUnlockFlow(
        client: n.clientFor(_boxUri),
        key: FakeDeviceKey(present: true),
        box: _enrolled(cloud: _cloudUri),
        biometric: FakeBiometricPin(),
        locator: _locators(n),
        clientFor: (b) async => n.clientFor(b),
        tokens: tokens,
        onLocated: (at) => seen.add(at.via),
      );
      final session = await flow.run(pin: '482913');
      expect(session.token, 'tok-1');
      expect(seen, ['cloud']);
      expect(tokens.get(_cloudUri), 'tok-1');
      expect(
        n.asked.where((a) => a.contains('POST')),
        everyElement(startsWith(_cloudUri.host)),
      );
    });
  });

  group('LocatorTransport', () {
    test('a located base with no session token is NeedsUnlock', () async {
      final n = _Net()..boxUp = false;
      final t = LocatorTransport(
        locator: _locators(n),
        box: () => _enrolled(cloud: _cloudUri),
        clientFor: (b) async => n.clientFor(b),
        tokenFor: (b) => b.host == _boxUri.host ? 'box-token' : null,
      );
      await expectLater(t.connect(), throwsA(isA<NeedsUnlock>()));
    });

    test(
      'the token of the located base is used, never the other base\'s',
      () async {
        final n = _Net()..boxUp = false;
        final t = LocatorTransport(
          locator: _locators(n),
          box: () => _enrolled(cloud: _cloudUri),
          clientFor: (b) async => n.clientFor(b),
          tokenFor: (b) => b.host == _boxUri.host ? 'box-token' : 'cloud-token',
        );
        final link = await t.connect();
        expect(link.via, 'cloud');
        expect(link.token, 'cloud-token');
      },
    );

    test('cloud waking becomes the engine signal', () async {
      final n = _Net()
        ..boxUp = false
        ..cloudStatus = 503
        ..cloudHeaders = {'retry-after': '45'};
      final t = LocatorTransport(
        locator: _locators(n),
        box: () => _enrolled(cloud: _cloudUri),
        clientFor: (b) async => n.clientFor(b),
        tokenFor: (_) => 'x',
      );
      await expectLater(
        t.connect(),
        throwsA(
          isA<CloudWakingSignal>().having((e) => e.retryAfterSec, 'retry', 45),
        ),
      );
    });

    test('nothing answers: BoxUnreachable', () async {
      final n = _Net()
        ..boxUp = false
        ..cloudStatus = 500;
      final t = LocatorTransport(
        locator: _locators(n),
        box: () => _enrolled(cloud: _cloudUri),
        clientFor: (b) async => n.clientFor(b),
        tokenFor: (_) => 'x',
      );
      await expectLater(t.connect(), throwsA(isA<BoxUnreachable>()));
    });
  });

  test('the enrolled box keeps its cloud origin through JSON', () {
    final b = _enrolled(cloud: _cloudUri);
    final back = EnrolledBox.fromJson(
      jsonDecode(jsonEncode(b.toJson())) as Map<String, dynamic>,
    );
    expect(back.cloud, _cloudUri);
    expect(_enrolled().toJson().containsKey('cloud'), isFalse);
    expect(b.withAppLock(false).cloud, _cloudUri);
  });
}

class _Never implements BoxLocator {
  @override
  Future<Located> locate(EnrolledBox b) => Future<Located>.delayed(
    const Duration(seconds: 5),
    () => throw StateError('too late'),
  );
}
