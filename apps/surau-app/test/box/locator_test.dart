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

EnrolledBox _enrolled(Uri box) => EnrolledBox(
  box: box,
  boxId: 'a1b2c3d4e5f60718',
  deviceId: 'dev1',
  userId: 'u1',
  userName: 'Ali',
  roles: const ['admin'],
  caSha256: null,
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
