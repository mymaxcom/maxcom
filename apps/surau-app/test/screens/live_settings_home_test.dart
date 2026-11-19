// Operator decision 2026-11-18: the live settings (Kamera luaran, Siaran langsung di skrin, Siaran langsung YouTube,
// Rakaman) and the YouTube account have ONE home, the "Tetapan siaran" card of the Siaran langsung page.
// Konfigurasi lists none of them (a search gives one pointer row); their forms open under /live/settings/<feature>
// with the bottom bar on Lagi and Back to /live; the old /settings/<feature> addresses redirect.

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:surau_app/app/app_lang.dart';
import 'package:surau_app/app/router.dart';
import 'package:surau_app/features/live/fake_publisher.dart';
import 'package:surau_app/features/live/live_controller.dart';
import 'package:surau_app/features/shell/menu.dart';
import 'package:surau_app/features/shell/permissions.dart';
import 'package:surau_app/l10n/s_lookup.dart';

import '../features/shell/harness.dart';

Finder k(String key) => find.byKey(ValueKey(key));

const _live = ['liveCamera', 'liveOnKiosk', 'liveYoutube', 'recording'];

Future<ShellHarness> _pump(WidgetTester tester, List<String> roles, {AppLang lang = AppLang.ms}) => pumpShell(
  tester,
  roles: roles,
  overrides: [
    livePublisherProvider.overrideWithValue(FakePublisher()),
    liveBoxProvider.overrideWith(() => LiveBoxNotifier(const LiveBoxStatus())),
    appLangStoreProvider.overrideWithValue(MemoryAppLangStore(lang)),
  ],
);

void main() {
  group('Konfigurasi', () {
    testWidgets('the list shows no live feature row and no live group', (tester) async {
      final h = await _pump(tester, const ['admin']);
      h.router.go('/settings');
      await settle(tester);
      expect(k('settings-group-live'), findsNothing);
      for (final f in _live) {
        expect(k('settings-row-$f'), findsNothing, reason: f);
      }
      // Every other group is still there.
      expect(k('settings-group-solat'), findsOneWidget);
    });

    testWidgets('a search that matches a live feature shows no feature row, only the one pointer', (tester) async {
      final h = await _pump(tester, const ['admin']);
      h.router.go('/settings');
      await settle(tester);
      for (final q in ['kamera', 'camera', 'RTSP', 'onvif', 'youtube', 'rakaman', 'recording', 'siaran', 'live']) {
        await tester.enterText(k('settings-search'), q);
        await settle(tester);
        for (final f in _live) {
          expect(k('settings-row-$f'), findsNothing, reason: '$q $f');
        }
        expect(k('settings-live-moved'), findsOneWidget, reason: q);
        expect(find.text('Tetapan siaran kini di menu Siaran langsung'), findsOneWidget, reason: q);
      }
      // A query that matches none of them has no pointer.
      await tester.enterText(k('settings-search'), 'azan');
      await settle(tester);
      expect(k('settings-live-moved'), findsNothing);
    });

    testWidgets('tapping the pointer opens Siaran langsung with the section open', (tester) async {
      final h = await _pump(tester, const ['admin']);
      // The destinations above Mula siaran push the card below the fold and the list builds lazily: a tall view, as
      // the Live page test below.
      tester.view.physicalSize = const Size(412, 3600) * 2;
      addTearDown(tester.view.resetPhysicalSize);
      h.router.go('/settings');
      await settle(tester);
      await tester.enterText(k('settings-search'), 'kamera');
      await settle(tester);
      await tester.tap(k('settings-live-moved'));
      await settle(tester);
      expect(h.location, '/live');
      expect(k('live-settings-liveCamera'), findsOneWidget, reason: 'the Tetapan siaran card is open');
    });

    test('the pointer says the same in the three languages', () {
      expect(sFor(AppLang.ms).navLive, 'Siaran langsung');
      expect(sFor(AppLang.en).navLive, 'Live broadcast');
    });

    testWidgets('the pointer speaks English and Arabic', (tester) async {
      final h = await _pump(tester, const ['admin'], lang: AppLang.en);
      h.router.go('/settings');
      await settle(tester);
      await tester.enterText(k('settings-search'), 'camera');
      await settle(tester);
      expect(find.text('Live settings are now in the Live broadcast menu'), findsOneWidget);
    });
  });

  group('the Siaran langsung page', () {
    testWidgets('a holder of live:settings sees the Tetapan siaran card with its five entries in order', (tester) async {
      final h = await _pump(tester, const ['live']);
      tester.view.physicalSize = const Size(412, 3600) * 2;
      addTearDown(tester.view.resetPhysicalSize);
      h.router.go('/live');
      await settle(tester);
      expect(k('live-section-set'), findsOneWidget);
      expect(find.descendant(of: k('live-section-set'), matching: find.text('Tetapan siaran')), findsOneWidget);
      // idle: open
      final entries = [
        k('live-settings-liveCamera'),
        k('live-settings-liveOnKiosk'),
        k('live-settings-liveYoutube'),
        k('live-settings-recording'),
        k('live-youtube-account'),
      ];
      for (final e in entries) {
        expect(e, findsOneWidget);
      }
      final tops = [for (final e in entries) tester.getTopLeft(e).dy];
      expect([...tops]..sort(), tops, reason: 'Kamera luaran, skrin, YouTube, Rakaman, Akaun YouTube surau');
      // Folding it hides them all.
      await tester.tap(k('live-section-set-head'));
      await settle(tester);
      for (final e in entries) {
        expect(e, findsNothing);
      }
    });

    testWidgets('the folded or open choice is remembered on the phone', (tester) async {
      final h = await _pump(tester, const ['live']);
      tester.view.physicalSize = const Size(412, 3600) * 2;
      addTearDown(tester.view.resetPhysicalSize);
      h.router.go('/live');
      await settle(tester);
      await tester.tap(k('live-section-set-head'));
      await settle(tester);
      expect(k('live-settings-liveCamera'), findsNothing);
      // Away and back: still folded.
      h.router.go('/');
      await settle(tester);
      h.router.go('/live');
      await settle(tester);
      expect(k('live-section-set'), findsOneWidget);
      expect(k('live-settings-liveCamera'), findsNothing);
    });

    testWidgets('a user without live:settings has no card (and no page)', (tester) async {
      final h = await _pump(tester, const ['media']);
      h.router.go('/live');
      await settle(tester);
      expect(h.location, '/', reason: 'the page is refused');
      expect(k('live-section-set'), findsNothing);
      h.router.go('/live/settings/liveCamera');
      await settle(tester);
      expect(h.location, '/');
    });

    testWidgets('tapping Kamera luaran opens /live/settings/liveCamera; the bar stays on Lagi; Back returns', (
      tester,
    ) async {
      final h = await _pump(tester, const ['admin']);
      tester.view.physicalSize = const Size(412, 3600) * 2;
      addTearDown(tester.view.resetPhysicalSize);
      h.router.go('/live');
      await settle(tester);
      await tester.tap(k('live-settings-liveCamera'));
      await settle(tester);
      expect(h.location, '/live/settings/liveCamera');
      expect(k('feature-liveCamera'), findsOneWidget, reason: 'the same form screen as before');
      expect(find.descendant(of: find.byType(AppBar), matching: find.text('Kamera luaran')), findsOneWidget);
      // the bottom bar: Lagi holds Siaran langsung and is the selected tab
      Finder tab(String label, bool selected) => find.byWidgetPredicate(
        (w) => w is Semantics && w.properties.label == label && w.properties.selected == selected,
      );
      expect(tab('Lagi', true), findsOneWidget);
      expect(tab('Konfigurasi', true), findsNothing);
      // Back
      await tester.tap(k('page-back'));
      await settle(tester);
      expect(h.location, '/live');
    });

    testWidgets('the system Back also returns to /live', (tester) async {
      final h = await _pump(tester, const ['live']);
      h.router.go('/live/settings/recording');
      await settle(tester);
      expect(h.location, '/live/settings/recording');
      await tester.binding.handlePopRoute();
      await settle(tester);
      expect(h.location, '/live');
    });
  });

  group('old addresses and rules', () {
    for (final f in _live) {
      testWidgets('/settings/$f redirects to /live/settings/$f', (tester) async {
        final h = await _pump(tester, const ['admin']);
        h.router.go('/settings/$f');
        await settle(tester);
        expect(h.location, '/live/settings/$f');
      });
    }

    testWidgets('a query on the old address is kept', (tester) async {
      final h = await _pump(tester, const ['admin']);
      h.router.go('/settings/liveYoutube?x=1');
      await settle(tester);
      expect(h.router.state.uri.toString(), '/live/settings/liveYoutube?x=1');
    });

    testWidgets('another feature is not caught by the redirect', (tester) async {
      final h = await _pump(tester, const ['admin']);
      h.router.go('/settings/beeps');
      await settle(tester);
      expect(h.location, '/settings/beeps');
    });

    test('liveSettingsMoved', () {
      expect(liveSettingsMoved(Uri.parse('/settings/recording')), '/live/settings/recording');
      expect(liveSettingsMoved(Uri.parse('/settings/beeps')), isNull);
      expect(liveSettingsMoved(Uri.parse('/live/settings/recording')), isNull);
      expect(liveSettingsMoved(Uri.parse('/settings')), isNull);
    });

    test('routeAllowed: the live forms need live:settings and a live feature', () {
      final on = FeatureFlags.defaults;
      expect(routeAllowed('/live/settings/liveCamera', {'live'}, on), isTrue);
      expect(routeAllowed('/live/settings/recording', {'admin'}, on), isTrue);
      expect(routeAllowed('/live/settings/liveCamera', {'media'}, on), isFalse);
      expect(routeAllowed('/live/settings/beeps', {'admin'}, on), isFalse);
      expect(routeAllowed('/live/settings', {'admin'}, on), isFalse);
    });
  });
}
