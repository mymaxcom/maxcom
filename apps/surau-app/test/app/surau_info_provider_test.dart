// The header's surau name: from the box when it answers, else from the
// MAXCOM cloud for this enrolment, else the kept copy.

import 'dart:async';

import 'package:flutter/widgets.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:surau_app/app/deps.dart';
import 'package:surau_app/app/providers.dart';
import 'package:surau_app/box/box_client.dart';
import 'package:surau_app/features/common/surau_info.dart';
import 'package:surau_app/features/enrol/enrol_flow.dart';
import 'package:surau_app/features/shell/read_cache.dart';

import '../features/fakes.dart';

AppDeps _deps({
  required FakeBox box,
  required FakeBox cloud,
  required SurauInfoStore store,
  SurauInfo? initial,
}) => AppDeps(
  boxStore: MemoryEnrolledBoxStore(),
  surauInfoStore: store,
  key: FakeDeviceKey(present: true),
  trust: FakeTrust(),
  biometric: FakeBiometricPin(),
  clientFor: (uri) => box.client(uri),
  // The cloud is the one on a public domain; anything else is the box.
  enrolledClient: (b) async =>
      b.box.host.endsWith('mymaxcom.my') ? cloud.client(b.box) : box.client(b.box),
  platform: 'android',
  cameraAvailable: false,
  scannerBuilder: (_, _, _) => const SizedBox.shrink(),
  healthPollInterval: null,
  initialBox: fixtureBox(),
  initialSurau: initial,
  cacheStore: MemoryReadCacheStore(),
);

// A store that keeps nothing: what the old enrolment saved must not stand
// in for the new one in these tests (enrolment replaces the saved copy).
class _NoStore implements SurauInfoStore {
  @override
  Future<SurauInfo?> load() async => null;
  @override
  Future<void> save(SurauInfo info) async {}
  @override
  Future<void> clear() async {}
}

EnrolledBox _boxWithId(String id) => EnrolledBox(
  box: Uri.parse('https://127.0.0.2:8443'),
  boxId: id,
  deviceId: 'dev-1',
  userId: 'u1',
  userName: 'Ustaz Ali',
  roles: const ['admin'],
  caSha256: 'abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789',
);

// Routes by the enrolled box id: [byId] answers for that box; the cloud
// route (public domain) is always away.
AppDeps _depsById(Map<String, FakeBox> byId) {
  final base = _deps(box: FakeBox((r) async => throw const BoxUnreachable()), cloud: FakeBox((r) async => throw const BoxUnreachable()), store: _NoStore());
  return AppDeps(
    boxStore: MemoryEnrolledBoxStore(),
    surauInfoStore: _NoStore(),
    key: FakeDeviceKey(present: true),
    trust: FakeTrust(),
    biometric: FakeBiometricPin(),
    clientFor: base.clientFor,
    enrolledClient: (b) async => b.box.host.endsWith('mymaxcom.my')
        ? FakeBox((r) async => throw const BoxUnreachable()).client(b.box)
        : (byId[b.boxId] ?? FakeBox((r) async => throw const BoxUnreachable())).client(b.box),
    platform: 'android',
    cameraAvailable: false,
    scannerBuilder: (_, _, _) => const SizedBox.shrink(),
    healthPollInterval: null,
    initialBox: fixtureBox(),
    initialSurau: null,
    cacheStore: MemoryReadCacheStore(),
  );
}

Future<void> _settle() => Future<void>.delayed(const Duration(milliseconds: 50));

void main() {
  final away = FakeBox((r) async => throw const BoxUnreachable());

  test('the box away and the cloud answering: the header gets the cloud name',
      () async {
    final cloud = FakeBox((r) async => jsonResponse(200, {'name': 'Surau Awan'}));
    final c = ProviderContainer(
      overrides: [
        appDepsProvider.overrideWithValue(
          _deps(box: away, cloud: cloud, store: MemorySurauInfoStore()),
        ),
      ],
    );
    addTearDown(c.dispose);
    c.listen(surauInfoProvider, (_, _) {});
    await _settle();
    expect(c.read(surauInfoProvider)?.name, 'Surau Awan');
    expect(cloud.byPath('/api/surau/info'), isNotNull);
  });

  test('the box answers: its name wins and the cloud is not asked', () async {
    final box = FakeBox((r) async => jsonResponse(200, {'name': 'Surau Kotak'}));
    final cloud = FakeBox((r) async => jsonResponse(200, {'name': 'Surau Awan'}));
    final c = ProviderContainer(
      overrides: [
        appDepsProvider.overrideWithValue(
          _deps(box: box, cloud: cloud, store: MemorySurauInfoStore()),
        ),
      ],
    );
    addTearDown(c.dispose);
    c.listen(surauInfoProvider, (_, _) {});
    await _settle();
    expect(c.read(surauInfoProvider)?.name, 'Surau Kotak');
    expect(cloud.seen, isEmpty);
  });

  test('neither answers: the kept copy stays', () async {
    final cloud = FakeBox((r) async => throw const BoxUnreachable());
    const kept = SurauInfo(name: 'Surau Lama');
    final c = ProviderContainer(
      overrides: [
        appDepsProvider.overrideWithValue(
          _deps(box: away, cloud: cloud, store: MemorySurauInfoStore(kept), initial: kept),
        ),
      ],
    );
    addTearDown(c.dispose);
    c.listen(surauInfoProvider, (_, _) {});
    await _settle();
    expect(c.read(surauInfoProvider)?.name, 'Surau Lama');
  });

  group('the name never leaks across enrolments', () {
    FakeBox answers(String name) => FakeBox((r) async => jsonResponse(200, {'name': name}));

    test('enrolled to another box that does not answer: the old name is gone', () async {
      final c = ProviderContainer(overrides: [
        appDepsProvider.overrideWithValue(_depsById({'0123456789abcdef': answers('Surau A')})),
      ]);
      addTearDown(c.dispose);
      c.listen(surauInfoProvider, (_, _) {});
      await _settle();
      expect(c.read(surauInfoProvider)?.name, 'Surau A');
      c.read(enrolledBoxProvider.notifier).adopt(_boxWithId('fedcba9876543210'));
      await _settle();
      expect(c.read(surauInfoProvider), isNull);
    });

    test('enrolled to another box that does not answer, with the old surau still in the store: nothing shows', () async {
      final store = MemorySurauInfoStore(const SurauInfo(name: 'Surau A'));
      final c = ProviderContainer(overrides: [
        appDepsProvider.overrideWithValue(
          _deps(
            box: FakeBox((r) async => throw const BoxUnreachable()),
            cloud: FakeBox((r) async => throw const BoxUnreachable()),
            store: store,
          ),
        ),
      ]);
      addTearDown(c.dispose);
      c.listen(surauInfoProvider, (_, _) {});
      await _settle();
      // leaving the surau clears the kept copy
      await c.read(enrolledBoxProvider.notifier).forget();
      expect(await store.load(), isNull);
      c.read(enrolledBoxProvider.notifier).adopt(_boxWithId('fedcba9876543210'));
      await _settle();
      expect(c.read(surauInfoProvider), isNull);
    });

    test('a late answer from the old enrolment is ignored', () async {
      final gate = Completer<void>();
      final oldBox = FakeBox((r) async {
        await gate.future;
        return jsonResponse(200, {'name': 'Surau A'});
      });
      final c = ProviderContainer(overrides: [
        appDepsProvider.overrideWithValue(_depsById({
          '0123456789abcdef': oldBox,
          'fedcba9876543210': answers('Surau B'),
        })),
      ]);
      addTearDown(c.dispose);
      c.listen(surauInfoProvider, (_, _) {});
      await _settle();
      c.read(enrolledBoxProvider.notifier).adopt(_boxWithId('fedcba9876543210'));
      await _settle();
      expect(c.read(surauInfoProvider)?.name, 'Surau B');
      gate.complete();
      await _settle();
      expect(c.read(surauInfoProvider)?.name, 'Surau B');
    });

    test('un-enrolled: nothing is shown', () async {
      final c = ProviderContainer(overrides: [
        appDepsProvider.overrideWithValue(_depsById({'0123456789abcdef': answers('Surau A')})),
      ]);
      addTearDown(c.dispose);
      c.listen(surauInfoProvider, (_, _) {});
      await _settle();
      expect(c.read(surauInfoProvider)?.name, 'Surau A');
      await c.read(enrolledBoxProvider.notifier).forget();
      await _settle();
      expect(c.read(surauInfoProvider), isNull);
    });
  });
}
