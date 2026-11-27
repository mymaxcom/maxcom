// The end of "join instead" (a phone that left a follower enrols at the main box): it must leave a consistent state
// whatever fails on the way, and the join ticket in a web address must not stay there.

import 'package:flutter/widgets.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:surau_app/app/deps.dart';
import 'package:surau_app/app/providers.dart';
import 'package:surau_app/app/router.dart' show finishJoining;
import 'package:surau_app/box/join_address.dart';
import 'package:surau_app/features/common/surau_info.dart';
import 'package:surau_app/features/enrol/enrol_flow.dart';
import 'package:surau_app/features/shell/read_cache.dart';

import '../features/fakes.dart';

class _ThrowingBiometric extends FakeBiometricPin {
  @override
  Future<void> clear() async => throw StateError('keystore gone');
}

ProviderContainer _container(FakeBiometricPin bio, EnrolledBoxStore store) {
  final c = ProviderContainer(
    overrides: [
      appDepsProvider.overrideWithValue(
        AppDeps(
          boxStore: store,
          surauInfoStore: MemorySurauInfoStore(),
          key: FakeDeviceKey(present: true),
          trust: FakeTrust(),
          biometric: bio,
          clientFor: FakeBox(happyBox).client,
          enrolledClient: (b) async => FakeBox(happyBox).client(b.box),
          platform: 'android',
          cameraAvailable: false,
          scannerBuilder: (_, _, _) => const SizedBox.shrink(),
          healthPollInterval: null,
          initialBox: fixtureBox(),
          cacheStore: MemoryReadCacheStore(),
        ),
      ),
    ],
  );
  addTearDown(c.dispose);
  return c;
}

EnrolledBox _newBox() => EnrolledBox(
  box: Uri.parse('https://10.168.50.10:8443'),
  boxId: 'c3c3c3c3c3c3c3c3',
  deviceId: 'dev-new',
  userId: 'u-new',
  userName: 'Encik Kamal',
  roles: const ['admin'],
  caSha256: 'b' * 64,
);

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  group('finishJoining', () {
    test('success: the new box is taken and the joining flag is cleared', () async {
      final c = _container(FakeBiometricPin(), MemoryEnrolledBoxStore());
      c.read(enrolledBoxProvider);
      c.read(joiningInsteadProvider.notifier).set(true);
      final box = _newBox();
      await finishJoining(c.read, EnrolOutcome(box: box, pinPending: false));
      expect(c.read(enrolledBoxProvider)?.deviceId, 'dev-new');
      expect(c.read(joiningInsteadProvider), isFalse);
    });

    test('a failing biometric clear does not stop it: new box taken, flag cleared', () async {
      final c = _container(_ThrowingBiometric(), MemoryEnrolledBoxStore());
      c.read(enrolledBoxProvider);
      c.read(joiningInsteadProvider.notifier).set(true);
      await finishJoining(c.read, EnrolOutcome(box: _newBox(), pinPending: false));
      expect(c.read(enrolledBoxProvider)?.deviceId, 'dev-new');
      expect(c.read(joiningInsteadProvider), isFalse);
    });
  });

  group('join ticket in the web address', () {
    tearDown(clearHeldJoin);

    test('joinFromFragment reads the join value of an enrol address and nothing else', () {
      expect(joinFromFragment('/enrol?join=surau1%3Aabc'), 'surau1:abc');
      expect(joinFromFragment('/dashboard'), isNull);
      expect(joinFromFragment('/enrol?join='), isNull);
      expect(joinFromFragment(''), isNull);
    });

    test('captured from any route: held in memory and the address is scrubbed', () {
      var scrubs = 0;
      captureJoinFrom('/dashboard?join=surau1%3Aabc', () => scrubs++);
      expect(heldJoinText, 'surau1:abc');
      expect(scrubs, 1);
      clearHeldJoin();
      expect(heldJoinText, isNull);
    });

    test('an address without a ticket is left alone', () {
      var scrubs = 0;
      captureJoinFrom('/dashboard', () => scrubs++);
      expect(heldJoinText, isNull);
      expect(scrubs, 0);
    });
  });
}
