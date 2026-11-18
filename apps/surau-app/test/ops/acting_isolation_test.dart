// Plan 14 Phase 2 gate (N1, Q6, S3, Q15): while a MAXCOM phone acts for a surau, nothing works from the phone's own
// local copy, and no answer of one surau is ever shown as another's. Ops build only (--dart-define=MAXCOM_OPS=true).

import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:surau_app/app/guards.dart';
import 'package:surau_app/app/providers.dart';
import 'package:surau_app/features/shell/menu.dart';
import 'package:surau_app/features/shell/permissions.dart';
import 'package:surau_app/ops/fleet/fleet_models.dart';
import 'package:surau_app/ops/fleet/fleet_providers.dart';
import 'package:surau_app/ops/fleet/fleet_routes.dart';
import 'package:surau_app/ops/ops_build.dart';
import 'package:surau_app/sync/sync_providers.dart';

import '../features/fakes.dart';
import '../features/shell/harness.dart';
import 'fleet_support.dart';

GuardResult _run(String location, {required bool closed}) => guard(
  GuardInput(
    location: location,
    enrolled: true,
    unlocked: true,
    roles: const {'superadmin'},
    features: FeatureFlags.defaults,
    localDataClosed: closed,
  ),
);

void main() {
  const skip = !kOpsBuild;

  group('local data pages (guard and menu)', skip: skip, () {
    test('Kewangan, the upload queue and the sync pages lead to the notice', () {
      for (final p in ['/finance', '/finance/kutipan', '/upload', '/sync/conflicts', '/settings/sync']) {
        expect(_run(p, closed: true).redirect, OpsRoutes.localOnly, reason: p);
      }
    });

    test('other pages and the notice itself are not affected; nothing changes when not closed', () {
      for (final p in ['/users', '/audit', OpsRoutes.localOnly, OpsRoutes.armada]) {
        expect(_run(p, closed: true).redirect, isNull, reason: p);
      }
      expect(_run('/users', closed: false).redirect, isNull);
    });

    test('the menu of a MAXCOM cloud session has no Kewangan or Muat naik row', () {
      final features = FeatureFlags(const {'finance': true, 'youtubeCatchUp': true});
      const roles = {'superadmin'};
      final ops = menuFor(roles, features, ops: true).map((m) => m.entry).toSet();
      expect(ops, isNot(contains(MenuEntry.finance)));
      expect(ops, isNot(contains(MenuEntry.upload)));
      final box = menuFor(roles, features).map((m) => m.entry).toSet();
      expect(box, contains(MenuEntry.finance));
    });
  });

  group('acting', skip: skip, () {
    testWidgets('/finance while acting shows the notice and the sync engine stays idle', (tester) async {
      final h = await openCloud(tester);
      h.container
          .read(actingSurauProvider.notifier)
          .choose(const ActingSurau(id: 'bukit-contoh', name: 'Surau Bukit Contoh'));
      await settle(tester);
      expect(h.container.read(syncEngineProvider), isNull);
      h.router.go('/finance');
      await settle(tester);
      expect(h.location, OpsRoutes.localOnly);
      expect(find.byKey(const ValueKey('ops-local-only')), findsOneWidget);
      expect(find.text('Tidak tersedia semasa bertindak sebagai MAXCOM. Gunakan telefon pentadbir surau itu.'), findsOneWidget);
    });

    testWidgets('a late answer of surau A is never kept as the offline data of surau B', (tester) async {
      final h = await openCloud(tester);
      final late = Completer<http.Response>();
      h.handlers['GET /api/probe'] = (_) => late.future;
      final notifier = h.container.read(actingSurauProvider.notifier);
      notifier.choose(const ActingSurau(id: 'al-hidayah', name: 'A'));
      await settle(tester);
      final gatewayA = h.container.read(gatewayProvider)!;
      final pending = gatewayA.get('/api/probe');
      await tester.pump();
      notifier.choose(const ActingSurau(id: 'bukit-contoh', name: 'B'));
      await settle(tester);
      late.complete(jsonResponse(200, {'surau': 'A'}));
      await pending;
      await settle(tester);
      expect(h.container.read(readCacheProvider).get('/api/probe'), isNull);
      // the gateway of B still caches its own answers
      h.handlers['GET /api/probe'] = (_) async => jsonResponse(200, {'surau': 'B'});
      await h.container.read(gatewayProvider)!.get('/api/probe');
      expect(h.container.read(readCacheProvider).get('/api/probe')?.body['surau'], 'B');
    });

    testWidgets('the cache is empty after the cloud session ends', (tester) async {
      final h = await openCloud(tester);
      h.container.read(readCacheProvider).put('/api/users', {'users': <Object>[]}, DateTime.utc(2026, 11, 13));
      expect(h.container.read(readCacheProvider).isEmpty, isFalse);
      h.container.read(sessionProvider.notifier).clear();
      await settle(tester);
      expect(h.container.read(readCacheProvider).isEmpty, isTrue);
    });
  });
}
