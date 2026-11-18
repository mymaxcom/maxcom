// Plan 14 Task 14: the surau switcher, the acting banner and the Senarai surau list in the ops build. Run with
// --dart-define=MAXCOM_OPS=true; skipped in the public build (fleet_public_test.dart covers that side).

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:surau_app/app/providers.dart';
import 'package:surau_app/ops/ops_build.dart';

import '../features/shell/harness.dart';
import '../golden_sizes.dart';
import 'fleet_support.dart';

ValueKey<String> _key(String k) => ValueKey<String>(k);

/// Taps the widget with [key], scrolling it into view first (a long list leaves the last card under the bar).
Future<void> tapKey(WidgetTester tester, String key) async {
  final f = find.byKey(_key(key));
  await tester.ensureVisible(f);
  await tester.pumpAndSettle();
  await tester.tap(f);
  await settle(tester);
}

void main() {
  const skip = !kOpsBuild;
  group('switcher', skip: skip, () {
    testWidgets('absent on the box gateway', (tester) async {
      final h = await openCloud(tester, viaCloud: false);
      h.router.go('/users');
      await settle(tester);
      expect(find.byKey(_key('surau-switcher')), findsNothing);
    });

    testWidgets('absent for a surau user on the cloud (scope surau, not an ops session)', (tester) async {
      final h = await openCloud(tester, roles: const ['admin'], me: meOps(scope: 'surau', ops: false));
      h.router.go('/users');
      await settle(tester);
      expect(find.byKey(_key('surau-switcher')), findsNothing);
    });

    testWidgets('present on the cloud for scope all with ops true', (tester) async {
      final h = await openCloud(tester);
      expect(h.location, '/ops/suraus');
      expect(find.byKey(_key('surau-switcher')), findsOneWidget);
    });

    testWidgets('absent for a Pentadbir MAXCOM whose answer says ops false', (tester) async {
      await openCloud(tester, me: meOps(ops: false));
      expect(find.byKey(_key('surau-switcher')), findsNothing);
    });
  });

  group('landing', skip: skip, () {
    testWidgets('a Pentadbir MAXCOM with no surau chosen lands on Senarai surau, tenant screens ask to choose', (tester) async {
      final h = await openCloud(tester);
      expect(h.location, '/ops/suraus');
      expect(find.byKey(_key('fleet-choose-hint')), findsOneWidget);
      for (final path in ['/', '/users', '/settings', '/finance']) {
        h.router.go(path);
        await settle(tester);
        expect(h.location, '/ops/suraus', reason: path);
      }
      expect(find.byKey(_key('acting-banner')), findsNothing);
    });

    testWidgets('a surau user on the cloud is not sent to the list (the ops build shows the ops_access notice: ops false)', (tester) async {
      final h = await openCloud(tester, roles: const ['admin'], me: meOps(scope: 'surau', ops: false));
      expect(h.location, '/ops/unmarked');
    });

    testWidgets('the list is refused to someone who is not a Pentadbir or Sokongan MAXCOM', (tester) async {
      final h = await openCloud(tester, roles: const ['admin'], me: meOps(scope: 'surau', ops: false));
      h.router.go('/ops/suraus');
      await settle(tester);
      expect(h.location, '/ops/unmarked');
      expect(find.byKey(_key('surau-switcher')), findsNothing);
    });

    testWidgets('Sokongan MAXCOM opens the list', (tester) async {
      final h = await openCloud(tester, roles: const ['support']);
      expect(h.location, '/ops/suraus');
      expect(find.byKey(_key('fleet-card-bukit-contoh')), findsOneWidget);
    });
  });

  group('Senarai surau', skip: skip, () {
    testWidgets('sorts Menunggu MAXCOM and Luar talian first, then Digantung, then OK', (tester) async {
      await openCloud(tester);
      final ids = ['dwaqaf', 'taman-contoh', 'masjid-contoh', 'al-hidayah', 'bukit-contoh'];
      double top(String id) => tester.getTopLeft(find.byKey(_key('fleet-card-$id'))).dy;
      for (var i = 0; i + 1 < ids.length; i++) {
        expect(top(ids[i]), lessThan(top(ids[i + 1])), reason: '${ids[i]} before ${ids[i + 1]}');
      }
      expect(find.text('Luar talian'), findsWidgets);
      expect(find.text('Menunggu MAXCOM'), findsWidgets);
      expect(find.text('Digantung'), findsWidgets);
    });

    testWidgets('a card shows the boxes, the last seen and the storage', (tester) async {
      await openCloud(tester);
      final card = find.byKey(_key('fleet-card-dwaqaf'));
      expect(find.descendant(of: card, matching: find.textContaining('1 kotak')), findsOneWidget);
      expect(find.descendant(of: card, matching: find.textContaining('2 hari lalu')), findsOneWidget);
      expect(find.descendant(of: card, matching: find.text('1.71 GB / 2 GB')), findsOneWidget);
    });

    testWidgets('a filter and a search narrow the list', (tester) async {
      await openCloud(tester);
      await tapKey(tester, 'fleet-filter-suspended');
      expect(find.byKey(_key('fleet-card-masjid-contoh')), findsOneWidget);
      expect(find.byKey(_key('fleet-card-bukit-contoh')), findsNothing);
      await tapKey(tester, 'fleet-filter-all');
      await tester.enterText(find.byKey(_key('fleet-search')), '9f02-b7aa');
      await settle(tester);
      expect(find.byKey(_key('fleet-card-bukit-contoh')), findsOneWidget);
      expect(find.byKey(_key('fleet-card-dwaqaf')), findsNothing);
    });

    testWidgets('golden: the list on a phone', (tester) async {
      final h = await openCloud(tester);
      await expectLater(find.byWidget(h.app), matchesGoldenFile('ops_fleet_phone.png'));
    });

    testWidgets('golden: the list on the iPad', (tester) async {
      final h = await openCloud(tester, size: GoldenSize.ipadMiniLandscape);
      await expectLater(find.byWidget(h.app), matchesGoldenFile('ops_fleet_ipadMiniLandscape.png'));
    });
  });

  group('acting for a surau', skip: skip, () {
    testWidgets('choosing a surau adds the header to the next request and the banner to every screen', (tester) async {
      final h = await openCloud(tester);
      await tapKey(tester, 'fleet-card-bukit-contoh');
      expect(h.location, '/ops/suraus/bukit-contoh');
      expect(find.byKey(_key('detail-surau-id')), findsOneWidget);
      await tapKey(tester, 'view-as-maxcom');
      expect(h.location, '/');
      expect(find.byKey(_key('acting-banner')), findsOneWidget);
      expect(find.text('Anda melihat sebagai MAXCOM: Surau Bukit Contoh'), findsOneWidget);

      h.box.seen.clear();
      for (final path in ['/users', '/settings', '/audit']) {
        h.router.go(path);
        await settle(tester);
        expect(h.location, path);
        expect(find.byKey(_key('acting-banner')), findsOneWidget, reason: path);
      }
      final tenant = h.box.seen.where((r) => r.url.path.startsWith('/api/users') || r.url.path.startsWith('/api/audit'));
      expect(tenant, isNotEmpty);
      for (final r in tenant) {
        expect(r.headers['X-Maxcom-Surau'], 'bukit-contoh', reason: r.url.path);
      }
      await expectLater(find.byWidget(h.app), matchesGoldenFile('ops_acting_banner_phone.png'));
    });

    testWidgets('the fleet routes themselves never carry the header', (tester) async {
      final h = await openCloud(tester);
      await tapKey(tester, 'fleet-card-bukit-contoh');
      await tapKey(tester, 'view-as-maxcom');
      h.router.go('/ops/switch'); // the list is read again now that a surau is chosen
      await settle(tester);
      final fleet = seenAt(h, '/api/suraus');
      expect(fleet.length, greaterThanOrEqualTo(2));
      expect(fleet.every((r) => !r.headers.containsKey('X-Maxcom-Surau')), isTrue);
    });

    testWidgets('Keluar ends the work in that surau: no banner, no header, back on the list', (tester) async {
      final h = await openCloud(tester);
      await tapKey(tester, 'fleet-card-bukit-contoh');
      await tapKey(tester, 'view-as-maxcom');
      await tapKey(tester, 'acting-exit');
      expect(h.location, '/ops/suraus');
      expect(find.byKey(_key('acting-banner')), findsNothing);
      h.box.seen.clear();
      h.router.go('/users');
      await settle(tester);
      expect(h.location, '/ops/suraus');
      expect(h.box.seen.where((r) => r.headers.containsKey('X-Maxcom-Surau')), isEmpty);
    });

    testWidgets('the switcher changes the surau and the next request names the new one', (tester) async {
      final h = await openCloud(tester);
      await tapKey(tester, 'surau-switcher');
      expect(h.location, '/ops/switch');
      await tapKey(tester, 'switcher-al-hidayah');
      expect(find.text('Anda melihat sebagai MAXCOM: Surau Al-Hidayah Contoh'), findsOneWidget);
      h.box.seen.clear();
      h.router.go('/users');
      await settle(tester);
      expect(seenAt(h, '/api/users').first.headers['X-Maxcom-Surau'], 'al-hidayah');
      // change again: the old surau's cached answers are gone and the new header is used
      await tapKey(tester, 'acting-change');
      await tapKey(tester, 'switcher-bukit-contoh');
      h.box.seen.clear();
      h.router.go('/users');
      await settle(tester);
      expect(seenAt(h, '/api/users').first.headers['X-Maxcom-Surau'], 'bukit-contoh');
    });

    testWidgets('the switcher lists every surau, remembers nothing and has a search', (tester) async {
      final h = await openCloud(tester);
      h.router.go('/ops/switch');
      await settle(tester);
      expect(find.byKey(_key('switcher-none')), findsOneWidget);
      await tester.enterText(find.byKey(_key('switcher-search')), 'waqaf');
      await settle(tester);
      expect(find.byKey(_key('switcher-dwaqaf')), findsOneWidget);
      expect(find.byKey(_key('switcher-bukit-contoh')), findsNothing);
      await expectLater(find.byWidget(h.app), matchesGoldenFile('ops_switcher_phone.png'));
    });

    testWidgets('a lock (session cleared) forgets the chosen surau', (tester) async {
      final h = await openCloud(tester);
      await tapKey(tester, 'fleet-card-bukit-contoh');
      await tapKey(tester, 'view-as-maxcom');
      expect(find.byKey(_key('acting-banner')), findsOneWidget);
      h.container.read(sessionProvider.notifier).clear();
      await settle(tester);
      expect(find.byKey(_key('acting-banner')), findsNothing);
    });
  });
}
