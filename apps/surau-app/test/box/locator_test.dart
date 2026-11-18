@TestOn('vm')
library;

import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:surau_app/box/box_client.dart';
import 'package:surau_app/box/locator.dart';
import 'package:surau_app/features/enrol/enrol_flow.dart';
import 'package:surau_app/ops/ops_build.dart' show kOpsBuild;
import 'package:surau_app/sync/transport.dart';

import '../features/fakes.dart';

EnrolledBox _enrolled(Uri box, {Uri? cloud}) => EnrolledBox(
  box: box,
  boxId: 'a1b2c3d4e5f60718',
  deviceId: 'dev1',
  userId: 'u1',
  userName: 'Ali',
  roles: const ['admin'],
  caSha256: null,
  cloud: cloud,
);

http.Response _health() => http.Response(
  jsonEncode({'ok': true, 'version': 7, 'daysAhead': 90}),
  200,
  headers: {'content-type': 'application/json'},
);

class _Fixed implements BoxLocator {
  _Fixed(this.via, [this.fail = false]);
  final String via;
  final bool fail;
  int calls = 0;

  @override
  Future<Located> locate(EnrolledBox b) async {
    calls++;
    if (fail) throw const BoxUnreachable('down');
    return Located(
      base: b.box,
      via: via,
      health: const HealthDto(ok: true, version: 1),
    );
  }
}

void main() {
  // The widget test binding fakes every HttpClient with status 400; these
  // tests need real sockets to a local server.
  setUpAll(() => HttpOverrides.global = null);

  final box = Uri.parse('https://10.168.0.154:8443');

  test('DirectBoxLocator reads /api/health and says via box', () async {
    late Uri seen;
    final loc = DirectBoxLocator(
      clientFor: (b) async => BoxClient(
        b.box,
        MockClient((r) async {
          seen = r.url;
          return _health();
        }),
      ),
    );
    final out = await loc.locate(_enrolled(box));
    expect(seen.path, '/api/health');
    expect(out.via, 'box');
    expect(out.base, box);
    expect(out.health.version, 7);
  });

  test('the enrolled address is the cloud origin: via cloud', () async {
    final cloud = Uri.parse('https://api.mymaxcom.my');
    final loc = DirectBoxLocator(
      clientFor: (b) async =>
          BoxClient(b.box, MockClient((r) async => _health())),
    );
    final out = await loc.locate(_enrolled(cloud, cloud: cloud));
    expect(out.base, cloud);
    expect(out.via, 'cloud');
  }, skip: !kOpsBuild);

  test('same host in another case, an explicit default port and a '
      'trailing slash are still the cloud origin', () async {
    final cloud = Uri.parse('https://api.mymaxcom.my');
    final loc = DirectBoxLocator(
      clientFor: (b) async =>
          BoxClient(b.box, MockClient((r) async => _health())),
    );
    final out = await loc.locate(
      _enrolled(Uri.parse('https://API.MyMaxcom.My:443/'), cloud: cloud),
    );
    expect(out.via, 'cloud');
  }, skip: !kOpsBuild);

  // The public build must never infer `cloud` from the origin: a real box on
  // a public TLS origin can share the cloud's origin without being the cloud.
  test('the public build: the same origin is still via box', () async {
    final cloud = Uri.parse('https://api.mymaxcom.my');
    final loc = DirectBoxLocator(
      clientFor: (b) async =>
          BoxClient(b.box, MockClient((r) async => _health())),
    );
    final out = await loc.locate(_enrolled(cloud, cloud: cloud));
    expect(out.base, cloud);
    expect(out.via, 'box');
  }, skip: kOpsBuild);

  test('a LAN box with a different cloud is still via box', () async {
    final loc = DirectBoxLocator(
      clientFor: (b) async =>
          BoxClient(b.box, MockClient((r) async => _health())),
    );
    final out = await loc.locate(
      _enrolled(box, cloud: Uri.parse('https://api.mymaxcom.my')),
    );
    expect(out.via, 'box');
  });

  test('no cloud recorded: via box', () async {
    final loc = DirectBoxLocator(
      clientFor: (b) async =>
          BoxClient(b.box, MockClient((r) async => _health())),
    );
    final out = await loc.locate(_enrolled(box));
    expect(out.via, 'box');
  });

  test('an Ops enrolment (the cloud saved as the box) unlocks as a '
      'cloud session', () async {
    // The EnrolledBox exactly as OpsEnrolFlow.run keeps it: the cloud in
    // both fields, no CA, no user name.
    final cloud = Uri.parse('https://api.mymaxcom.my');
    final enrolled = EnrolledBox(
      box: cloud,
      boxId: 'b1c2d3e4f5a60718',
      deviceId: 'dev-ops',
      userId: 'u-maxcom',
      userName: '',
      roles: const ['superadmin'],
      caSha256: null,
      appLock: true,
      cloud: cloud,
    );
    final asked = <String>[];
    final loc = DirectBoxLocator(
      clientFor: (b) async => BoxClient(
        b.box,
        MockClient((r) async {
          asked.add('${r.method} ${r.url.path}');
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
        }),
      ),
    );
    final tokens = SessionTokens();
    final out = await unlockAtLocated(
      locator: loc,
      box: enrolled,
      clientFor: (b) async => BoxClient(
        b,
        MockClient((r) async {
          switch (r.url.path) {
            case '/api/auth/challenge':
              return jsonResponse(200, {'nonce': 'n-1', 'expiresAt': 'x'});
            case '/api/auth/unlock':
              return jsonResponse(200, sessionJson);
          }
          return jsonResponse(404, {
            'errors': ['tiada'],
          });
        }),
      ),
      key: FakeDeviceKey(present: true),
      biometric: FakeBiometricPin(),
      tokens: tokens,
      noPin: true,
    );
    expect(asked, ['GET /api/health'], reason: 'the locator asks only health');
    expect(out.at.base, cloud);
    expect(out.session.via, 'cloud');
    expect(out.session.base, cloud);
    expect(tokens.get(cloud), 'tok-1');
  }, skip: !kOpsBuild);

  test('CompositeLocator falls through to the second locator', () async {
    final a = _Fixed('box', true);
    final b = _Fixed('cloud');
    final out = await CompositeLocator([a, b]).locate(_enrolled(box));
    expect(out.via, 'cloud');
    expect(a.calls, 1);
  });

  test('CompositeLocator stops at the first success', () async {
    final a = _Fixed('box');
    final b = _Fixed('cloud');
    final out = await CompositeLocator([a, b]).locate(_enrolled(box));
    expect(out.via, 'box');
    expect(b.calls, 0);
  });

  test('all failing rethrows BoxUnreachable; empty list too', () async {
    await expectLater(
      CompositeLocator([_Fixed('a', true), _Fixed('b', true)])
          .locate(_enrolled(box)),
      throwsA(isA<BoxUnreachable>()),
    );
    await expectLater(
      CompositeLocator(const []).locate(_enrolled(box)),
      throwsA(isA<BoxUnreachable>()),
    );
  });

  test('a port nobody listens on throws BoxUnreachable after the one retry, within 6 s', () async {
    final s = await ServerSocket.bind(InternetAddress.loopbackIPv4, 0);
    final port = s.port;
    await s.close();
    final target = Uri.parse('http://127.0.0.1:$port');
    final loc = DirectBoxLocator(
      clientFor: (b) async =>
          BoxClient(b.box, http.Client(), connect: const Duration(seconds: 2)),
    );
    final sw = Stopwatch()..start();
    await expectLater(
      loc.locate(_enrolled(target)),
      throwsA(isA<BoxUnreachable>()),
    );
    expect(sw.elapsed, lessThan(const Duration(seconds: 6)));
  });
}
