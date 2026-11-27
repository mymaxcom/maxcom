// The cloud access of an upload run, and the box client the app uses, follow
// the IP the locator last proved for the box.

import 'dart:typed_data';

import 'package:flutter/widgets.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:surau_app/app/deps.dart';
import 'package:surau_app/app/providers.dart';
import 'package:surau_app/box/routes.dart';
import 'package:surau_app/box/trust.dart' show CaDerSource;
import 'package:surau_app/features/enrol/enrol_flow.dart';
import 'package:surau_app/features/shell/read_cache.dart';
import 'package:surau_app/features/common/surau_info.dart';
import 'package:surau_app/sync/sync_providers.dart';
import 'package:surau_app/sync/transport.dart';
import 'package:surau_app/upload/upload_providers.dart';

import '../features/fakes.dart';

const _name = 'box1-surau.local';

/// A box store that also holds the root CA (as the real session store does).
class _CaStore extends MemoryEnrolledBoxStore implements CaDerSource {
  _CaStore(this.der);
  final Uint8List? der;

  @override
  Future<Uint8List?> loadCaDer(String sha256) async => der;
}

ProviderContainer _container(EnrolledBox box, List<Uri> clientOrigins, {BoxRoutes? routes, SessionTokens? tokens, Uint8List? ca, bool pins = true}) {
  final fake = FakeBox((r) async => jsonResponse(200, <String, Object?>{}));
  final deps = AppDeps(
    boxStore: _CaStore(ca ?? Uint8List.fromList([1, 2, 3])),
    surauInfoStore: MemorySurauInfoStore(null),
    key: FakeDeviceKey(present: true),
    trust: FakeTrust(pinsCa: pins),
    biometric: FakeBiometricPin(),
    clientFor: fake.client,
    enrolledClient: (b) async {
      clientOrigins.add(b.box);
      return fake.client(b.box);
    },
    platform: 'android',
    cameraAvailable: false,
    scannerBuilder: (_, _, _) => const SizedBox.shrink(),
    healthPollInterval: null,
    initialBox: box,
    cacheStore: MemoryReadCacheStore(),
    routes: routes,
  );
  final c = ProviderContainer(overrides: [
    appDepsProvider.overrideWithValue(deps),
    if (tokens != null) sessionTokensProvider.overrideWithValue(tokens),
  ]);
  addTearDown(c.dispose);
  return c;
}

/// A container whose store holds no root CA at all.
ProviderContainer _noCaContainer(EnrolledBox box, SessionTokens tokens, {bool pins = true}) {
  final fake = FakeBox((r) async => jsonResponse(200, <String, Object?>{}));
  final deps = AppDeps(
    boxStore: _CaStore(null),
    surauInfoStore: MemorySurauInfoStore(null),
    key: FakeDeviceKey(present: true),
    trust: FakeTrust(pinsCa: pins),
    biometric: FakeBiometricPin(),
    clientFor: fake.client,
    enrolledClient: (b) async => fake.client(b.box),
    platform: 'android',
    cameraAvailable: false,
    scannerBuilder: (_, _, _) => const SizedBox.shrink(),
    healthPollInterval: null,
    initialBox: box,
    cacheStore: MemoryReadCacheStore(),
  );
  final c = ProviderContainer(overrides: [
    appDepsProvider.overrideWithValue(deps),
    sessionTokensProvider.overrideWithValue(tokens),
  ]);
  addTearDown(c.dispose);
  return c;
}

void main() {
  group('uploadAuthProvider', () {
    test('base and the session lookup follow lastIp, not the enrolment IP', () async {
      final tokens = SessionTokens()..set(Uri.parse('https://10.0.0.9:8443'), 'tok-new');
      final origins = <Uri>[];
      final c = _container(fixtureBox(lastIp: '10.0.0.9'), origins, tokens: tokens);
      final auth = await c.read(uploadAuthProvider)();
      expect(auth, isNotNull);
      expect(auth!.base, Uri.parse('https://10.0.0.9:8443'));
      expect(auth.token, 'tok-new');
      expect(origins.single, Uri.parse('https://10.0.0.9:8443'));
    });

    test('the token kept under the enrolment origin is still found', () async {
      final tokens = SessionTokens()..set(Uri.parse('https://127.0.0.1:8443'), 'tok-old');
      final c = _container(fixtureBox(lastIp: '10.0.0.9'), <Uri>[], tokens: tokens);
      expect((await c.read(uploadAuthProvider)())!.token, 'tok-old');
    });

    test('a name-origin box: base is the IP origin from lastIp, the token kept under the name is found', () async {
      final tokens = SessionTokens()..set(Uri.parse('https://$_name:8443'), 'tok-name');
      final c = _container(fixtureBox(box: 'https://$_name:8443', name: _name, lastIp: '10.0.0.9'), <Uri>[], tokens: tokens);
      final auth = (await c.read(uploadAuthProvider)())!;
      expect(auth.base, Uri.parse('https://10.0.0.9:8443'));
      expect(auth.token, 'tok-name');
    });

    test('a name-origin box with no known IP gives no auth (the native uploader cannot open .local)', () async {
      final tokens = SessionTokens()..set(Uri.parse('https://$_name:8443'), 'tok-name');
      final c = _container(fixtureBox(box: 'https://$_name:8443', name: _name), <Uri>[], tokens: tokens);
      expect(await c.read(uploadAuthProvider)(), isNull);
    });
  });

  group('uploadAuthProvider, root CA', () {
    final tokens = SessionTokens()..set(Uri.parse('https://127.0.0.1:8443'), 'tok');

    test('a private box with no stored root CA gives no auth (never system trust)', () async {
      final c = _noCaContainer(fixtureBox(lastIp: '127.0.0.1'), tokens);
      expect(await c.read(uploadAuthProvider)(), isNull);
    });

    test('a private box with its root CA gets it', () async {
      final c = _container(fixtureBox(lastIp: '127.0.0.1'), <Uri>[], tokens: tokens);
      final auth = await c.read(uploadAuthProvider)();
      expect(auth!.caDer, Uint8List.fromList([1, 2, 3]));
    });

    test('web (the app does not pin): a name-origin box with no stored CA still gets auth at the name origin', () async {
      final t = SessionTokens()..set(Uri.parse('https://$_name:8443'), 'tok-name');
      final c = _noCaContainer(fixtureBox(box: 'https://$_name:8443', name: _name), t, pins: false);
      final auth = await c.read(uploadAuthProvider)();
      expect(auth, isNotNull);
      expect(auth!.base, Uri.parse('https://$_name:8443'));
      expect(auth.caDer, isNull);
    });

    test('web: an IP-origin box with no stored CA gets auth', () async {
      final c = _noCaContainer(fixtureBox(lastIp: '127.0.0.1'), tokens, pins: false);
      final auth = await c.read(uploadAuthProvider)();
      expect(auth, isNotNull);
      expect(auth!.caDer, isNull);
    });

    test('the public cloud with no stored CA is unchanged: auth with no CA', () async {
      final cloud = Uri.parse('https://app.mymaxcom.my');
      final box = EnrolledBox(
        box: cloud,
        boxId: '0123456789abcdef',
        deviceId: 'd',
        userId: 'u',
        userName: 'U',
        roles: const ['admin'],
        caSha256: 'abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789',
        cloud: cloud,
      );
      final t = SessionTokens()..set(cloud, 'tok-cloud');
      final c = _noCaContainer(box, t);
      final auth = await c.read(uploadAuthProvider)();
      expect(auth, isNotNull);
      expect(auth!.caDer, isNull);
      expect(auth.base, cloud);
    });
  });

  group('enrolledClientProvider', () {
    test('without a route, the client goes to the IP last proved', () async {
      final origins = <Uri>[];
      final c = _container(fixtureBox(name: _name, lastIp: '10.0.0.9'), origins, routes: BoxRoutes());
      await c.read(enrolledClientProvider.future);
      expect(origins.single, Uri.parse('https://10.0.0.9:8443'));
    });

    test('with a route for the name, the client goes to the name (as before)', () async {
      final origins = <Uri>[];
      final routes = BoxRoutes()..set(_name, '10.0.0.9');
      final c = _container(fixtureBox(name: _name, lastIp: '10.0.0.9'), origins, routes: routes);
      await c.read(enrolledClientProvider.future);
      expect(origins.single, Uri.parse('https://$_name:8443'));
    });

    test('a box never re-located keeps its enrolled origin', () async {
      final origins = <Uri>[];
      final c = _container(fixtureBox(), origins, routes: BoxRoutes());
      await c.read(enrolledClientProvider.future);
      expect(origins.single, Uri.parse('https://127.0.0.1:8443'));
    });
  });
}
