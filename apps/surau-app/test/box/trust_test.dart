@TestOn('vm')
library;

import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:surau_app/box/box_client.dart';
import 'package:surau_app/box/session_store.dart';
import 'package:surau_app/box/trust.dart';
import 'package:surau_app/features/enrol/enrol_flow.dart' show EnrolledBox;
import 'package:shared_preferences/shared_preferences.dart';

const _dir = 'test/fixtures/tls';

Uint8List _rootDer() => File('$_dir/root-ca.cer').readAsBytesSync();

/// An HTTPS server presenting the fixture box certificate (signed by the
/// fixture root), answering /api/pki/root.cer with [rootBody] and
/// /api/health with a small body.
Future<HttpServer> _boxServer({List<int>? rootBody}) async {
  final ctx = SecurityContext()
    ..useCertificateChainBytes(
      File('$_dir/box.pfx').readAsBytesSync(),
      password: 'test',
    )
    ..usePrivateKeyBytes(
      File('$_dir/box.pfx').readAsBytesSync(),
      password: 'test',
    );
  final s = await HttpServer.bindSecure(InternetAddress.loopbackIPv4, 0, ctx);
  s.listen((req) async {
    if (req.uri.path == '/api/pki/root.cer') {
      req.response
        ..headers.contentType = ContentType('application', 'pkix-cert')
        ..add(rootBody ?? _rootDer());
    } else {
      req.response
        ..headers.contentType = ContentType.json
        ..write(jsonEncode({'ok': true, 'version': 3}));
    }
    await req.response.close();
  });
  return s;
}

Uri _uri(HttpServer s) => Uri.parse('https://127.0.0.1:${s.port}');

void main() {
  test('TrustStore connects with an 8 s budget by default', () {
    expect(TrustStore().connect, const Duration(seconds: 8));
  });

  late Uint8List der;
  late String sha;
  final store = TrustStore();

  // The widget test binding fakes every HttpClient with status 400; these
  // tests need real sockets to a local server.
  setUpAll(() => HttpOverrides.global = null);

  setUp(() {
    der = _rootDer();
    sha = sha256Hex(der);
  });

  test('sha256Hex of the fixture root is lower-case 64 hex', () {
    expect(sha, matches(RegExp(r'^[0-9a-f]{64}$')));
  });

  test('fetchAndCheckRootCa accepts a CA whose sha256 matches', () async {
    final s = await _boxServer();
    addTearDown(() => s.close(force: true));
    final got = await store.fetchAndCheckRootCa(_uri(s), sha);
    expect(got, der);
  });

  test('fetchAndCheckRootCa accepts an upper-case pin', () async {
    final s = await _boxServer();
    addTearDown(() => s.close(force: true));
    expect(await store.fetchAndCheckRootCa(_uri(s), sha.toUpperCase()), der);
  });

  test('a different hash throws TrustError "tidak sepadan"', () async {
    final s = await _boxServer();
    addTearDown(() => s.close(force: true));
    expect(
      store.fetchAndCheckRootCa(_uri(s), '0' * 64),
      throwsA(
        isA<TrustError>().having(
          (e) => e.message,
          'message',
          contains('tidak sepadan'),
        ),
      ),
    );
  });

  test('a swapped CA body fails the pin', () async {
    final other = Uint8List.fromList(der)..[der.length - 1] ^= 1;
    final s = await _boxServer(rootBody: other);
    addTearDown(() => s.close(force: true));
    expect(store.fetchAndCheckRootCa(_uri(s), sha), throwsA(isA<TrustError>()));
  });

  test('an oversized body is refused', () async {
    final s = await _boxServer(rootBody: Uint8List(200000));
    addTearDown(() => s.close(force: true));
    expect(store.fetchAndCheckRootCa(_uri(s), sha), throwsA(isA<TrustError>()));
  });

  test('pinnedClient reaches a server signed by the pinned root', () async {
    final s = await _boxServer();
    addTearDown(() => s.close(force: true));
    final c = await store.pinnedClient(der);
    addTearDown(c.close);
    final r = await c.get(_uri(s).replace(path: '/api/health'));
    expect(r.statusCode, 200);
  });

  test('pinnedClient refuses a self-signed server as BoxUnreachable', () async {
    final other = await _selfSignedServer();
    addTearDown(() => other.close(force: true));
    final c = await store.pinnedClient(der);
    addTearDown(c.close);
    final box = BoxClient(_uri(other), c);
    await expectLater(
      box.getJson('/api/health'),
      throwsA(isA<BoxUnreachable>()),
    );
  });

  test('BoxClient over pinnedClient: health works end to end', () async {
    final s = await _boxServer();
    addTearDown(() => s.close(force: true));
    final c = await store.pinnedClient(der);
    addTearDown(c.close);
    final out = await BoxClient(_uri(s), c).getJson('/api/health');
    expect(out['version'], 3);
  });

  test('a garbage CA is a TrustError, not a crash', () async {
    expect(
      store.pinnedClient(Uint8List.fromList([1, 2, 3])),
      throwsA(isA<TrustError>()),
    );
  });

  test('where the CA is pinned there is no client without one', () async {
    expect(store.pinsCa, isTrue);
    expect(store.pinnedClient(null), throwsA(isA<TrustError>()));
  });

  test('an enrolled box without a recorded CA needs enrolling again, never a plain client', () async {
    SharedPreferences.setMockInitialValues({});
    final session = SessionStore(await SharedPreferences.getInstance());
    final box = EnrolledBox(
      box: Uri.parse('https://10.168.0.154:8443'),
      boxId: '0123456789abcdef',
      deviceId: 'dev-1',
      userId: 'u1',
      userName: 'Ali',
      roles: const ['admin'],
      caSha256: null,
    );
    await expectLater(
      store.boxClient(box, session),
      throwsA(isA<TrustError>()),
    );
  });

  group('PinnedEnrolTrust', () {
    setUp(() => SharedPreferences.setMockInitialValues({}));

    test(
      'a payload without the CA hash is refused, nothing is fetched or kept',
      () async {
        final prefs = await SharedPreferences.getInstance();
        final trust = PinnedEnrolTrust(store, SessionStore(prefs));
        expect(trust.pinsCa, isTrue);
        await expectLater(
          trust.establish(Uri.parse('https://10.168.0.154:8443'), null),
          throwsA(isA<TrustError>()),
        );
        expect(prefs.getKeys(), isEmpty);
      },
    );

    test('holds the checked CA in memory and builds a client pinned to it; nothing is stored yet', () async {
      final s = await _boxServer();
      addTearDown(() => s.close(force: true));
      final prefs = await SharedPreferences.getInstance();
      final session = SessionStore(prefs);
      final trust = PinnedEnrolTrust(store, session);
      await trust.establish(_uri(s), sha);
      expect(await session.loadCaDer(sha), isNull, reason: 'a QR with no successful join leaves nothing behind');
      expect(prefs.getKeys().where((k) => k.contains('ca')), isEmpty);
      final out = await trust.clientFor(_uri(s)).getJson('/api/health');
      expect(out['ok'], true);
    });

    test('commit stores the CA after the join; a different hash stores nothing', () async {
      final s = await _boxServer();
      addTearDown(() => s.close(force: true));
      final prefs = await SharedPreferences.getInstance();
      final session = SessionStore(prefs);
      final trust = PinnedEnrolTrust(store, session);
      await trust.establish(_uri(s), sha);
      await trust.commit('2' * 64);
      expect(await session.loadCaDer(sha), isNull);
      await trust.commit(sha);
      expect(await session.loadCaDer(sha), der);
    });

    test('a mismatch stores nothing', () async {
      final s = await _boxServer();
      addTearDown(() => s.close(force: true));
      final prefs = await SharedPreferences.getInstance();
      final session = SessionStore(prefs);
      final trust = PinnedEnrolTrust(store, session);
      await expectLater(
        trust.establish(_uri(s), '1' * 64),
        throwsA(isA<TrustError>()),
      );
      expect(await session.loadCaDer('1' * 64), isNull);
      expect(prefs.getKeys().where((k) => k.contains('ca')), isEmpty);
    });
  });
}

/// A server whose certificate the fixture root never issued.
Future<HttpServer> _selfSignedServer() async {
  final pfx = File('$_dir/untrusted.pfx').readAsBytesSync();
  final ctx = SecurityContext()
    ..useCertificateChainBytes(pfx, password: 'test')
    ..usePrivateKeyBytes(pfx, password: 'test');
  final s = await HttpServer.bindSecure(InternetAddress.loopbackIPv4, 0, ctx);
  s.listen((req) async {
    req.response.write('{}');
    await req.response.close();
  });
  return s;
}
