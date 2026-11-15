import 'package:flutter/widgets.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:surau_app/app/deps.dart';
import 'package:surau_app/app/providers.dart';
import 'package:surau_app/features/common/surau_info.dart';
import 'package:surau_app/features/shell/read_cache.dart';

import '../features/fakes.dart';
import 'package:surau_app/features/enrol/enrol_flow.dart';

/// A store whose save yields, so overlapping learns really interleave.
class _SlowStore extends MemoryEnrolledBoxStore {
  @override
  Future<void> save(box) async {
    await Future<void>.delayed(const Duration(milliseconds: 20));
    await super.save(box);
  }
}

void main() {
  test('two concurrent learns keep both fields', () async {
    final box = FakeBox((r) async => jsonResponse(200, <String, Object?>{}));
    final store = _SlowStore();
    final deps = AppDeps(
      boxStore: store,
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
      initialBox: fixtureBox(),
      cacheStore: MemoryReadCacheStore(),
    );
    final c = ProviderContainer(
      overrides: [appDepsProvider.overrideWithValue(deps)],
    );
    addTearDown(c.dispose);
    final n = c.read(enrolledBoxProvider.notifier);
    await Future.wait([
      n.learnLastIp('10.0.0.42'),
      n.learnName('box1-surau.local'),
    ]);
    final s = c.read(enrolledBoxProvider)!;
    expect(s.lastIp, '10.0.0.42');
    expect(s.name, 'box1-surau.local');
  });
}
