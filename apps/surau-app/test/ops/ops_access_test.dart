// Plan 14 Task 26 (wiring): after an ops device is unlocked, `/api/auth/me` decides. `ops: true` leads to the Armada
// (Task 14's needsSurau guard); `ops: false` shows `Peranti ini bukan lagi peranti MAXCOM` and no ops screen. Ops build
// tests run with --dart-define=MAXCOM_OPS=true; the public build has none of it.

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:surau_app/app/guards.dart';
import 'package:surau_app/ops/fleet/fleet_providers.dart';
import 'package:surau_app/features/shell/permissions.dart';
import 'package:surau_app/ops/fleet/fleet_routes.dart';
import 'package:surau_app/ops/ops_build.dart';

import '../features/fakes.dart';
import '../features/shell/harness.dart';
import 'fleet_support.dart';

ValueKey<String> _key(String k) => ValueKey<String>(k);

/// A cloud session whose first `/api/auth/me` fails (the cloud is away for a moment).
Future<ShellHarness> pumpShellForMe(WidgetTester tester) async {
  return openCloud(tester, beforeSession: (h) {
    h.handlers['GET /api/auth/me'] = (r) async => jsonResponse(503, {'errors': ['tiada']});
  });
}

GuardResult _run(String location, {required bool opsRevoked, bool needsSurau = false}) => guard(
  GuardInput(
    location: location,
    enrolled: true,
    unlocked: true,
    roles: const {'superadmin'},
    features: FeatureFlags.defaults,
    needsSurau: needsSurau,
    opsRevoked: opsRevoked,
  ),
);

void main() {
  group('the guard', skip: !kOpsBuild, () {
    test('a withdrawn ops mark sends every page to the notice, except the notice and the device page', () {
      for (final p in ['/', '/users', '/ops/suraus', '/ops/pending', '/settings', '/finance']) {
        expect(_run(p, opsRevoked: true).redirect, OpsRoutes.unmarked, reason: p);
      }
      expect(_run(OpsRoutes.unmarked, opsRevoked: true).redirect, isNull);
      expect(_run('/this-device', opsRevoked: true).redirect, isNull);
    });

    test('with the mark in place the notice is not the answer (the needsSurau rule is unchanged)', () {
      expect(_run('/users', opsRevoked: false).redirect, isNull);
      expect(_run('/users', opsRevoked: false, needsSurau: true).redirect, OpsRoutes.armada);
    });
  });

  group('after the unlock', skip: !kOpsBuild, () {
    testWidgets('ops true: the Armada, no notice', (tester) async {
      final h = await openCloud(tester);
      expect(h.location, OpsRoutes.armada);
      expect(find.byKey(_key('ops-unmarked')), findsNothing);
    });

    testWidgets('ops false: the notice, no ops screen, no further fleet call, every path leads back to it', (tester) async {
      final h = await openCloud(tester, me: meOps(ops: false));
      expect(h.location, OpsRoutes.unmarked);
      expect(find.text('Peranti ini bukan lagi peranti MAXCOM'), findsOneWidget);
      expect(find.byKey(_key('surau-switcher')), findsNothing);
      expect(find.byKey(_key('fleet-choose-hint')), findsNothing);
      // (before the answer of /api/auth/me the roles alone lead to the Armada, as in Task 14; the server refuses its
      // reads for a phone that is not an ops device. From the notice on, nothing more is asked.)
      final fleetCalls = seenAt(h, '/api/suraus').length;
      for (final path in ['/', '/ops/suraus', '/ops/pending', '/users']) {
        h.router.go(path);
        await settle(tester);
        expect(h.location, OpsRoutes.unmarked, reason: path);
        expect(find.byKey(_key('ops-unmarked')), findsOneWidget, reason: path);
      }
      expect(seenAt(h, '/api/suraus'), hasLength(fleetCalls));
      expect(seenAt(h, '/api/fleet/pending'), isEmpty);
      expect(find.byKey(_key('ops-unmarked-device')), findsOneWidget);
    });
  });

  group('retry and unknown answers', skip: !kOpsBuild, () {
    testWidgets('the notice has a Cuba lagi that asks again; marked once more, the person leaves the notice', (tester) async {
      final h = await openCloud(tester, me: meOps(ops: false));
      expect(h.location, OpsRoutes.unmarked);
      h.me = meOps();
      await tester.tap(find.byKey(_key('ops-unmarked-retry')));
      await settle(tester);
      expect(h.location, OpsRoutes.armada);
      expect(find.byKey(_key('ops-unmarked')), findsNothing);
    });

    testWidgets('a failed /api/auth/me keeps the switcher (roles decide), is not "withdrawn", and a retry asks again', (tester) async {
      final h = await pumpShellForMe(tester);
      expect(find.byKey(_key('surau-switcher')), findsOneWidget);
      expect(h.container.read(opsRevokedProvider), isFalse);
      expect(h.container.read(opsContextProvider).hasError, isTrue);
      h.handlers.remove('GET /api/auth/me');
      await tester.tap(find.byKey(_key('surau-switcher')));
      await settle(tester);
      expect(h.container.read(opsContextProvider).value?.mayAct, isTrue);
    });
  });

  group('the public build', skip: kOpsBuild, () {
    testWidgets('has no notice, whatever /api/auth/me says', (tester) async {
      final h = await openCloud(tester, me: meOps(ops: false));
      expect(h.location, '/');
      h.router.go('/ops/unmarked');
      await settle(tester);
      expect(h.location, '/');
      expect(find.byKey(_key('ops-unmarked')), findsNothing);
      expect(find.text('Peranti ini bukan lagi peranti MAXCOM'), findsNothing);
    });

    test('the guard ignores the flag', () {
      expect(_run('/users', opsRevoked: true).redirect, isNull);
    });
  });
}
