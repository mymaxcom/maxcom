// The phone-move page is a door like the unlock: reachable while enrolled and locked, never without a box.

import 'package:flutter_test/flutter_test.dart';
import 'package:surau_app/app/guards.dart';
import 'package:surau_app/app/router.dart';
import 'package:surau_app/features/shell/permissions.dart';

GuardResult run(String location, {bool enrolled = true, bool unlocked = true, bool joining = false}) => guard(
  GuardInput(
    location: location,
    enrolled: enrolled,
    unlocked: unlocked,
    roles: const {'ajk'},
    features: FeatureFlags.defaults,
    joining: joining,
  ),
);

void main() {
  test('the move path is /move', () {
    expect(AppRoutes.move, '/move');
  });

  test('enrolled and locked: /move is open', () {
    expect(run(AppRoutes.move, unlocked: false).redirect, isNull);
  });

  test('not enrolled: /move goes to the enrol page', () {
    expect(run(AppRoutes.move, enrolled: false).redirect, AppRoutes.enrol);
    expect(run(AppRoutes.move, enrolled: false, unlocked: false).redirect, AppRoutes.enrol);
  });

  test('an unlocked session does not stay on the door', () {
    expect(run(AppRoutes.move).redirect, AppRoutes.dashboard);
  });

  test('an enrolled phone is sent away from the enrol page, unless it is leaving its follower with a join code', () {
    expect(run(AppRoutes.enrol, unlocked: false).redirect, AppRoutes.unlock);
    expect(run(AppRoutes.enrol, unlocked: false, joining: true).redirect, isNull);
    // only the enrol page is opened that way
    expect(run(AppRoutes.setup, unlocked: false, joining: true).redirect, AppRoutes.unlock);
  });

  test('the move page is never a return page of the unlock', () {
    expect(returnPathOf('/unlock?from=%2Fmove'), isNull);
  });
}
