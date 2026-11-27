@TestOn('vm')
library;

import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:surau_app/box/routes.dart';
import 'package:surau_app/box/session_store.dart' show SessionStore;
import 'package:surau_app/box/trust.dart';
import 'package:surau_app/features/enrol/enrol_flow.dart';

import '../features/fakes.dart';

// Real TLS: the V2 fixture root and a leaf for box2-surau.local at
// 127.0.0.1. A payload whose box is the NAME enrols through the real
// PinnedEnrolTrust (the OS would not resolve `.local`): the flow seeds the
// route from the payload's IPs, proves the boxId and enrols at the name.
const _dir = 'test/fixtures/tls-nc-v2';
const _name = 'box2-surau.local';
const _boxId = '0123456789abcdef';

Future<HttpServer> _serve(String boxId, List<String> log) async {
  final bytes = File('$_dir/box2.pfx').readAsBytesSync();
  final password = File('$_dir/pfx.pass').readAsStringSync().trim();
  final ctx = SecurityContext()
    ..useCertificateChainBytes(bytes, password: password)
    ..usePrivateKeyBytes(bytes, password: password);
  final s = await HttpServer.bindSecure(InternetAddress.loopbackIPv4, 0, ctx);
  s.listen((req) async {
    log.add('${req.method} ${req.uri.path} host=${req.headers.host}');
    final res = req.response;
    switch (req.uri.path) {
      case '/api/pki/root.cer':
        res.add(File('$_dir/root-ca.cer').readAsBytesSync());
      case '/api/box/info':
        res.headers.contentType = ContentType.json;
        res.write(jsonEncode({'boxId': boxId}));
      case '/api/enrol/complete':
        res.headers.contentType = ContentType.json;
        res.write(jsonEncode({'deviceId': 'dev-1', 'userId': 'u1', 'roles': ['admin'], 'pinRequired': false}));
      default:
        res.statusCode = 404;
    }
    await res.close();
  });
  addTearDown(() => s.close(force: true));
  return s;
}

String _payload(int port, String caSha, List<String> ips) {
  final m = <String, Object?>{
    'v': 1,
    'mode': 'ip',
    'box': 'https://$_name:$port',
    'name': _name,
    'ips': ips,
    'boxId': _boxId,
    'caSha256': caSha,
    'code': 'ABCD-EFGH-2345',
    'user': 'Ustaz Ali',
    'exp': 1893456000000,
  };
  return 'surau1:${base64Url.encode(utf8.encode(jsonEncode(m))).replaceAll('=', '')}';
}

void main() {
  setUpAll(() => HttpOverrides.global = null);

  final root = File('$_dir/root-ca.cer').readAsBytesSync();
  final caSha = sha256Hex(root);

  Future<(EnrolFlow, BoxRoutes, MemoryEnrolledBoxStore)> build() async {
    SharedPreferences.setMockInitialValues({});
    final routes = BoxRoutes();
    final trustStore = TrustStore(routes: routes, connect: const Duration(seconds: 3));
    final trust = PinnedEnrolTrust(trustStore, SessionStore(await SharedPreferences.getInstance()));
    final store = MemoryEnrolledBoxStore();
    final flow = EnrolFlow(
      clientFor: trust.clientFor,
      key: FakeDeviceKey(),
      trust: trust,
      store: store,
      platform: 'android',
      now: () => DateTime.utc(2026, 11, 4),
    );
    return (flow, routes, store);
  }

  test('name payload: first IP refused, second proven; enrolled at the name over the pinned CA', () async {
    final log = <String>[];
    final s = await _serve(_boxId, log);
    final (flow, routes, store) = await build();
    // 127.0.0.3 is not bound: connection refused, so the next IP is tried.
    final out = await flow.run(_payload(s.port, caSha, ['127.0.0.3', '127.0.0.1']), deviceName: 'T', hasPinAlready: false, newPin: '280419');
    expect(out.box.box.toString(), 'https://$_name:${s.port}');
    expect(out.box.name, _name);
    expect(out.box.lastIp, '127.0.0.1');
    expect(routes.addressOf(_name), '127.0.0.1');
    expect((await store.load())!.box.host, _name);
    expect(log.any((l) => l.startsWith('GET /api/box/info host=$_name')), isTrue);
    expect(log.any((l) => l.startsWith('POST /api/enrol/complete host=$_name')), isTrue);
  });

  test('name payload: a box with another boxId is refused at every IP and the route is gone', () async {
    final s = await _serve('ffffffffffffffff', <String>[]);
    final (flow, routes, store) = await build();
    // no IP passes: the old path (name, no route) cannot connect on a phone
    await expectLater(
      flow.run(_payload(s.port, caSha, ['127.0.0.1']), deviceName: 'T', hasPinAlready: false, newPin: '280419'),
      throwsA(anything),
    );
    expect(routes.addressOf(_name), isNull);
    expect(await store.load(), isNull);
  });
}
