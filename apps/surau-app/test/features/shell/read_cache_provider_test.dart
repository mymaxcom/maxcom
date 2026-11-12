import 'package:flutter/widgets.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:surau_app/app/deps.dart';
import 'package:surau_app/app/providers.dart';
import 'package:surau_app/features/enrol/enrol_flow.dart';
import 'package:surau_app/features/shell/read_cache.dart';

import 'package:surau_app/features/common/surau_info.dart';

import '../fakes.dart';

void main() {
  final at = DateTime.utc(2026, 11, 4, 9);

  ({ProviderContainer c, ReadCacheStore store}) build(EnrolledBox? first) {
    final store = MemoryReadCacheStore();
    final box = FakeBox((r) async => jsonResponse(200, <String, Object?>{}));
    final deps = AppDeps(
      boxStore: MemoryEnrolledBoxStore(),
      surauInfoStore: MemorySurauInfoStore(null),
      key: FakeDeviceKey(present: true),
      trust: FakeTrust(),
      biometric: FakeBiometricPin(),
      clientFor: (uri) => box.client(uri),
      enrolledClient: (b) async => box.client(b.box),
      platform: 'android',
      cameraAvailable: false,
      scannerBuilder: (_, _, _) => const SizedBox.shrink(),
      healthPollInterval: null,
      initialBox: first,
      cacheStore: store,
    );
    final c = ProviderContainer(
      overrides: [appDepsProvider.overrideWithValue(deps)],
    );
    addTearDown(c.dispose);
    return (c: c, store: store);
  }

  test('forgetting the box empties the read cache and its store', () async {
    final t = build(fixtureBox());
    final cache = t.c.read(readCacheProvider);
    cache.put('/api/health', {'v': 1}, at);
    await t.store.load(fixtureBox().boxId);
    await t.c.read(enrolledBoxProvider.notifier).forget();
    expect(t.c.read(readCacheProvider).isEmpty, isTrue);
    expect(await t.store.load(fixtureBox().boxId), isEmpty);
    expect(cache.isEmpty, isTrue);
  });

  test('enrolling again starts with an empty cache', () async {
    final t = build(fixtureBox());
    t.c.read(readCacheProvider).put('/api/health', {'v': 1}, at);
    t.c.read(enrolledBoxProvider.notifier).adopt(fixtureBox());
    expect(t.c.read(readCacheProvider).isEmpty, isTrue);
    expect(await t.store.load(fixtureBox().boxId), isEmpty);
  });

  test('a different box id gets its own cache', () async {
    final t = build(fixtureBox());
    t.c.read(readCacheProvider).put('/api/health', {'v': 1}, at);
    final other = EnrolledBox(
      box: fixtureBox().box,
      boxId: 'ffffffffffffffff',
      deviceId: 'dev-9',
      userId: 'u1',
      userName: 'Ustaz Ali',
      roles: const ['admin'],
      caSha256: fixtureBox().caSha256,
    );
    t.c.read(enrolledBoxProvider.notifier).adopt(other);
    expect(t.c.read(readCacheProvider).get('/api/health'), isNull);
  });
}
