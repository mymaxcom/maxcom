// A box that became a follower answers 409 `follower`: that is the move, not a PIN matter.

import 'package:flutter_test/flutter_test.dart';
import 'package:surau_app/features/unlock/unlock_flow.dart';

import '../fakes.dart';

void main() {
  UnlockFlow flowFor(FakeBox box) {
    final enrolled = fixtureBox();
    return UnlockFlow(
      client: box.client(enrolled.box),
      key: FakeDeviceKey(present: true),
      box: enrolled,
      biometric: FakeBiometricPin(),
    );
  }

  test('409 follower on the challenge becomes UnlockFollower', () async {
    final box = FakeBox((r) async => jsonResponse(409, {
      'code': 'follower',
      'errors': ['follower'],
      'master': {'name': 'Dewan Utama'},
    }));
    await expectLater(flowFor(box).run(pin: '280419'), throwsA(isA<UnlockFollower>()));
  });

  test('409 follower on the unlock becomes UnlockFollower, not PIN required', () async {
    final box = FakeBox((r) async {
      if (r.url.path == '/api/auth/challenge') return happyBox(r);
      return jsonResponse(409, {'code': 'follower', 'errors': ['follower']});
    });
    await expectLater(
      flowFor(box).run(pin: '280419'),
      throwsA(isA<UnlockFollower>()),
    );
  });

  test('409 with another code stays PIN required', () async {
    final box = FakeBox((r) async {
      if (r.url.path == '/api/auth/challenge') return happyBox(r);
      return jsonResponse(409, {'code': 'pin_required', 'errors': ['pin_required']});
    });
    await expectLater(
      flowFor(box).run(pin: '280419'),
      throwsA(isA<UnlockPinRequired>()),
    );
  });
}
