// Offline honesty: reads from the cache with the banner when the box is
// away, writes refused before any request, a 401 anywhere back to the
// unlock screen with every cache kept.

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:surau_app/app/providers.dart';
import 'package:surau_app/box/box_client.dart';
import 'package:surau_app/features/shell/box_gateway.dart';
import 'package:surau_app/features/shell/read_cache.dart';
import 'package:surau_app/features/unlock/pin_pad.dart';
import 'package:surau_app/l10n/generated/s_ms.dart';

import '../features/fakes.dart';
import '../features/shell/harness.dart';
import '../golden_sizes.dart';

class _Reach implements ReachSink {
  BoxReach _r = BoxReach.unknown;
  @override
  BoxReach get reach => _r;
  @override
  void markUp(DateTime at) => _r = _r.up(at);
  @override
  void markDown(DateTime at) => _r = _r.failed(at);
}

void main() {
  group('BoxGateway', () {
    late bool away;
    late FakeBox box;
    late _Reach reach;
    late ReadCache cache;
    late int expired;
    late BoxGateway gw;

    setUp(() {
      away = false;
      expired = 0;
      box = FakeBox((r) async {
        if (away) throw http.ClientException('away');
        if (r.url.path == '/api/settings') {
          return jsonResponse(200, {
            'clock': {'enabled': true},
          });
        }
        if (r.url.path == '/api/health') {
          return jsonResponse(401, {
            'errors': ['Sesi tamat'],
          });
        }
        return jsonResponse(200, {'ok': true});
      });
      reach = _Reach();
      cache = ReadCache();
      gw = BoxGateway(
        client: box.client(Uri.parse('https://127.0.0.1:8443')),
        token: 'tok-1',
        cache: cache,
        reach: reach,
        now: fixedNow,
        onSessionExpired: () => expired++,
      );
    });

    test('a good GET is fresh and cached; the next one, away, is stale', () async {
      final fresh = await gw.get('/api/settings');
      expect(fresh.stale, isFalse);
      expect(fresh.value['clock'], {'enabled': true});
      expect(reach.reach.down, isFalse);
      expect(reach.reach.lastContact, fixedNow());

      away = true;
      final stale = await gw.get('/api/settings');
      expect(stale.stale, isTrue);
      expect(stale.value, fresh.value);
      expect(stale.at, fixedNow());
      expect(reach.reach.down, isTrue);
      expect(reach.reach.lastContact, fixedNow(), reason: 'kept');
    });

    test('nothing cached and away: BoxUnreachable', () async {
      away = true;
      await expectLater(gw.get('/api/settings'), throwsA(isA<BoxUnreachable>()));
    });

    test('a PUT while the box is known to be away sends nothing', () async {
      reach.markDown(fixedNow());
      await expectLater(
        gw.put('/api/settings/clock', {'showSeconds': true}),
        throwsA(
          isA<OfflineWriteRefused>().having(
            (e) => OfflineWriteRefused.message,
            'message',
            contains('Cuba lagi di surau'),
          ),
        ),
      );
      expect(box.seen, isEmpty);
    });

    test('a PUT that fails to reach the box is refused the same way', () async {
      away = true;
      await expectLater(
        gw.put('/api/settings/clock', {'showSeconds': true}),
        throwsA(isA<OfflineWriteRefused>()),
      );
      expect(reach.reach.down, isTrue);
    });

    test('the refusal wording is the ARB string', () {
      expect(SMs().offlineWriteRefused, OfflineWriteRefused.message);
    });

    test('a 401 reports the expired session once and rethrows', () async {
      await expectLater(gw.get('/api/health'), throwsA(isA<SessionExpired>()));
      expect(expired, 1);
    });
  });

  group('in the app', () {
    testWidgets('settings come from the cache with the banner when the box goes away', (
      tester,
    ) async {
      final h = await pumpShell(tester, roles: const ['admin']);
      final first = h.container.read(settingsProvider).value!;
      expect(first.stale, isFalse);
      expect(h.box.byPath('/api/settings'), isNotNull);
      expect(find.byIcon(Icons.cloud_off_rounded), findsNothing);

      h.boxAway = true;
      h.container.invalidate(settingsProvider);
      await h.container.read(settingsProvider.future);
      await h.container.read(healthProvider.notifier).refresh();
      await settle(tester);

      final again = h.container.read(settingsProvider).value!;
      expect(again.stale, isTrue);
      expect(again.value, first.value);

      h.router.go('/settings');
      await settle(tester);
      expect(
        find.text(
          'MAXCOM tidak dapat dihubungi. Menunjukkan data terakhir (10:30 malam).',
        ),
        findsOneWidget,
      );
      expect(find.text('Cuba lagi'), findsOneWidget);
    });

    testWidgets('a write while away is refused before any request', (tester) async {
      final h = await pumpShell(tester, roles: const ['admin']);
      h.boxAway = true;
      await h.container.read(healthProvider.notifier).refresh();
      await settle(tester);
      final before = h.box.seen.length;

      final gw = h.container.read(gatewayProvider)!;
      await expectLater(
        gw.put('/api/settings/clock', {'showSeconds': true}),
        throwsA(isA<OfflineWriteRefused>()),
      );
      expect(h.box.seen.length, before);
      expect(h.box.seen.where((r) => r.method == 'PUT'), isEmpty);
    });

    testWidgets('Cuba lagi on the banner clears it when the box is back', (tester) async {
      final h = await pumpShell(tester, roles: const ['admin']);
      h.boxAway = true;
      await h.container.read(healthProvider.notifier).refresh();
      await settle(tester);
      expect(find.byIcon(Icons.cloud_off_rounded), findsOneWidget);

      h.boxAway = false;
      await tester.tap(find.text('Cuba lagi'));
      await settle(tester);
      expect(find.byIcon(Icons.cloud_off_rounded), findsNothing);
    });

    testWidgets(
      'a 401 from GET /api/health lands on /unlock; the cached dashboard is back after the next unlock',
      (tester) async {
        final h = await pumpShell(tester, roles: const ['admin']);
        expect(h.location, '/');
        expect(find.text('212 hari lagi'), findsOneWidget);

        h.healthStatus = 401;
        await h.container.read(healthProvider.notifier).refresh();
        await settle(tester);
        expect(h.location, '/unlock');
        expect(find.text('Masukkan PIN untuk teruskan'), findsOneWidget);
        expect(h.container.read(sessionProvider), isNull);
        expect(
          h.container.read(readCacheProvider).get('/api/health'),
          isNotNull,
          reason: 'cache kept across the 401',
        );

        // The box is now away for data routes; unlock still works (public
        // routes) and the dashboard shows the last data with the banner.
        h.healthStatus = 200;
        h.boxAway = true;
        for (final d in '280419'.split('')) {
          await tester.tap(find.widgetWithText(PinKey, d));
          await tester.pump();
        }
        await settle(tester);
        expect(h.location, '/');
        expect(find.text('212 hari lagi'), findsOneWidget);
        expect(find.byIcon(Icons.cloud_off_rounded), findsOneWidget);
      },
    );

    testWidgets('Log keluar locks the app and keeps the cache', (tester) async {
      final h = await pumpShell(tester, roles: const ['ajk']);
      await tester.tap(find.byIcon(Icons.person_outline_rounded));
      await settle(tester);
      await tester.tap(find.text('Log keluar'));
      await settle(tester);
      expect(h.location, '/unlock');
      expect(h.container.read(readCacheProvider).get('/api/health'), isNotNull);
    });

    testWidgets('settings refetch when the health version changes', (tester) async {
      final h = await pumpShell(tester, roles: const ['admin']);
      final fetches = h.box.seen.where((r) => r.url.path == '/api/settings').length;
      h.health = {...healthyJson, 'version': 18};
      await h.container.read(healthProvider.notifier).refresh();
      await settle(tester);
      expect(
        h.box.seen.where((r) => r.url.path == '/api/settings').length,
        fetches + 1,
      );
      await h.container.read(healthProvider.notifier).refresh();
      await settle(tester);
      expect(
        h.box.seen.where((r) => r.url.path == '/api/settings').length,
        fetches + 1,
        reason: 'same version: no refetch',
      );
    });

    testWidgets('the shell never sends a token in a URL', (tester) async {
      final h = await pumpShell(tester, roles: const ['admin'], size: GoldenSize.phone);
      for (final r in h.box.seen) {
        expect(r.url.toString(), isNot(contains('tok-1')));
        if (r.url.path.startsWith('/api/health') || r.url.path.startsWith('/api/settings')) {
          expect(r.headers['authorization'], 'Bearer tok-1');
        }
      }
    });
  });
}
