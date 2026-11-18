// Plan 14 Task 14: the public MAX Admin Client has no ops route, no ops menu row and never sends the acting-surau
// header, whatever the roles or the session say. Runs in both builds; each build checks its own side.

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:surau_app/box/box_client.dart';
import 'package:surau_app/features/shell/box_gateway.dart';
import 'package:surau_app/features/shell/menu.dart';
import 'package:surau_app/features/shell/permissions.dart';
import 'package:surau_app/features/shell/read_cache.dart';
import 'package:surau_app/ops/ops_build.dart';

import '../features/fakes.dart';
import '../features/shell/harness.dart';
import 'fleet_support.dart';

class _Reach implements ReachSink {
  @override
  BoxReach reach = BoxReach.unknown;
  @override
  void markUp(DateTime at) {}
  @override
  void markDown(DateTime at) {}
}

void main() {
  const ops = kOpsBuild;

  group('the public build', skip: ops, () {
    test('no ops path is allowed for any role', () {
      for (final path in ['/ops/suraus', '/ops/suraus/abc', '/ops/pending', '/ops/switch', '/ops']) {
        for (final roles in [
          {'superadmin'},
          {'superadmin', 'admin'},
          {'support'},
          {'admin'},
        ]) {
          expect(routeAllowed(path, roles, FeatureFlags.defaults), isFalse, reason: '$path $roles');
        }
      }
    });

    test('the menu has no ops row, even asked for one', () {
      final items = menuFor({'superadmin', 'admin'}, FeatureFlags.defaults, ops: true);
      expect(items.where((i) => i.entry == MenuEntry.fleet), isEmpty);
      expect(items.where((i) => i.route.startsWith('/ops')), isEmpty);
    });

    testWidgets('a deep link to the list finds nothing, a cloud session or not', (tester) async {
      final h = await openCloud(tester, roles: const ['superadmin', 'admin']);
      h.router.go('/ops/suraus');
      await settle(tester);
      expect(h.location, '/');
      expect(find.byKey(const ValueKey('surau-switcher')), findsNothing);
      expect(find.byKey(const ValueKey('acting-banner')), findsNothing);
    });

    testWidgets('the shell never asks the cloud who the session is for, or for the fleet', (tester) async {
      final h = await openCloud(tester, roles: const ['superadmin', 'admin']);
      h.router.go('/users');
      await settle(tester);
      expect(seenAt(h, '/api/suraus'), isEmpty);
      expect(h.box.seen.where((r) => r.headers.containsKey('X-Maxcom-Surau')), isEmpty);
    });
  });

  group('the gateway', () {
    Future<Map<String, String>> sentHeaders({String? acting}) async {
      late Map<String, String> headers;
      final client = BoxClient(
        Uri.parse('https://api.mymaxcom.my'),
        MockClient((r) async {
          headers = r.headers;
          return http.Response('{}', 200, headers: {'content-type': 'application/json'});
        }),
      );
      final gateway = BoxGateway(
        client: client,
        token: 'tok',
        cache: ReadCache(),
        reach: _Reach(),
        now: fixedNow,
        onSessionExpired: () {},
        actingSurau: acting,
      );
      await gateway.getFresh('/api/users');
      return headers;
    }

    test('sends the acting-surau header only in the ops build, and only when a surau is chosen', () async {
      final chosen = await sentHeaders(acting: 'bukit-contoh');
      if (ops) {
        expect(chosen['X-Maxcom-Surau'], 'bukit-contoh');
      } else {
        expect(chosen.containsKey('X-Maxcom-Surau'), isFalse);
      }
      expect((await sentHeaders()).containsKey('X-Maxcom-Surau'), isFalse);
    });
  });
}
