// Susunan kad di skrin TV, and the Tetapan list around it: search, groups,
// inline switches, the Lanjutan group, deep links, the enrol expiry choice.

import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:surau_app/app/providers.dart';
import 'package:surau_app/features/registry.g.dart';
import 'package:surau_app/features/validate.dart' show featureByKey;
import 'package:surau_app/screens/settings_list_screen.dart' show settingsOpenGroupsKey;

import '../features/shell/harness.dart';
import '../golden_sizes.dart';

Finder k(String key) => find.byKey(ValueKey(key));

Future<ShellHarness> open(WidgetTester tester, String path, [List<String> roles = const ['admin']]) async {
  final h = await pumpShell(tester, roles: roles);
  h.router.go(path);
  await settle(tester);
  return h;
}

Map<String, Map<String, dynamic>> orderPuts(ShellHarness h) => {
  for (final r in h.box.seen.where((r) => r.method == 'PUT' && r.url.path.startsWith('/api/settings/')))
    r.url.pathSegments.last: jsonDecode(r.body) as Map<String, dynamic>,
};

Future<void> type(WidgetTester tester, String q) async {
  await tester.enterText(k('settings-search'), q);
  await settle(tester);
}

void main() {
  const superadmin = ['admin', 'superadmin'];

  group('card order', () {
    testWidgets('hadis above posters: Simpan writes exactly the moved cards', (tester) async {
      final h = await open(tester, '/settings/order');
      expect(h.location, '/settings/order');
      Text n(String key) => tester.widget<Text>(k('order-number-$key'));
      expect(n('kuliahCard').data, '1');
      expect(n('hadis').data, '6');
      expect(tester.widget<FilledButton>(k('order-save')).enabled, isFalse, reason: 'nothing moved');
      await expectGoldens(tester, h.app, 'settings_order');

      await pumpAtSize(tester, h.app, GoldenSize.ipadMiniLandscape);
      for (var i = 0; i < 3; i++) {
        await tester.tap(k('order-up-hadis'));
        await settle(tester);
      }
      expect(n('hadis').data, '3');
      expect(n('posters').data, '4');
      await reveal(tester, k('order-save'));
      await tester.tap(k('order-save'));
      await settle(tester);
      expect(orderPuts(h), {
        'hadis': {'order': 3},
        'posters': {'order': 4},
        'programKhas': {'order': 5},
        'takwim': {'order': 6},
      });
      expect(find.text('Susunan disimpan'), findsOneWidget);
    });

    test('every card has its own place in the default order', () {
      final orders = [for (final key in orderedFeatures) featureByKey(key)!.defaults['order']];
      expect(orders, [for (var i = 1; i <= orderedFeatures.length; i++) i]);
    });

    testWidgets('moving a card back to its place leaves nothing to save; the ends have no arrow', (tester) async {
      final h = await open(tester, '/settings/order');
      expect(tester.widget<IconButton>(k('order-up-kuliahCard')).onPressed, isNull);
      expect(tester.widget<IconButton>(k('order-down-ayatCard')).onPressed, isNotNull);
      expect(tester.widget<IconButton>(k('order-down-tabungCard')).onPressed, isNull, reason: 'the last card');
      await tester.tap(k('order-down-kuliahCard'));
      await settle(tester);
      await tester.tap(k('order-up-kuliahCard'));
      await settle(tester);
      expect(tester.widget<FilledButton>(k('order-save')).enabled, isFalse);
      expect(orderPuts(h), isEmpty);
    });

    testWidgets('Pulihkan susunan asal writes the registry order for cards that differ', (tester) async {
      final h = await pumpShell(tester, roles: const ['admin']);
      h.settings['hadis'] = {'enabled': true, 'order': 1};
      h.settings['kuliahCard'] = {'enabled': true, 'order': 6};
      h.container.invalidate(settingsProvider);
      await settle(tester);
      h.router.go('/settings/order');
      await settle(tester);
      await reveal(tester, k('order-restore'));
      await tester.tap(k('order-restore'));
      await settle(tester);
      expect(orderPuts(h), {
        'hadis': {'order': 6},
        'kuliahCard': {'order': 1},
      });
    });

    testWidgets('an off card is dimmed and says so; an AJK is kept out', (tester) async {
      final h = await pumpShell(tester, roles: const ['admin']);
      h.settings['posters'] = {'enabled': false};
      h.container.invalidate(settingsProvider);
      await settle(tester);
      h.router.go('/settings/order');
      await settle(tester);
      // Poster here, and Kad tabung, which is off until it is switched on.
      expect(find.textContaining(', dimatikan'), findsNWidgets(2));
      expect(find.descendant(of: k('order-posters'), matching: find.textContaining(', dimatikan')), findsOneWidget);
      expect(find.descendant(of: k('order-tabungCard'), matching: find.text('15 saat, dimatikan')), findsOneWidget);
      expect(find.descendant(of: k('order-tabungCard'), matching: find.text('Kad tabung')), findsOneWidget);
      expect(find.descendant(of: k('order-kuliahCard'), matching: find.textContaining(', dimatikan')), findsNothing);

      final ajk = await open(tester, '/settings/order', const ['ajk']);
      expect(ajk.location, isNot('/settings/order'));
    });
  });

  group('list', () {
    testWidgets('search azan opens the matching groups with reasons; goldens', (tester) async {
      final h = await open(tester, '/settings');
      await type(tester, 'azan');
      expect(k('settings-row-azanCountdown'), findsOneWidget);
      expect(find.text('Kata kunci: azan'), findsWidgets);
      expect(find.textContaining('tetapan sepadan'), findsOneWidget);
      expect(k('settings-row-clock'), findsNothing, reason: 'not a match');
      await reveal(tester, k('settings-row-beeps'));
      expect(k('settings-row-beeps'), findsOneWidget, reason: 'the Audio group opened itself');
      await expectGoldens(tester, h.app, 'settings_search');
    });

    testWidgets('no match: Tiada hasil, and Kosongkan carian brings the list back', (tester) async {
      final h = await open(tester, '/settings');
      await type(tester, 'tempat letak kereta');
      expect(find.text('Tiada hasil'), findsOneWidget);
      expect(find.textContaining('"tempat letak kereta"'), findsOneWidget);
      await expectGoldens(tester, h.app, 'settings_search_empty');
      await pumpAtSize(tester, h.app, GoldenSize.phone);
      await tester.tap(k('settings-search-reset'));
      await settle(tester);
      expect(find.text('Tiada hasil'), findsNothing);
      expect(k('settings-group-solat'), findsOneWidget);
    });

    testWidgets('Lanjutan is absent for an admin; five rows for a superadmin, the deep link scrolls', (tester) async {
      final admin = await open(tester, '/settings');
      await type(tester, 'lanjutan');
      expect(k('settings-group-lanjutan'), findsNothing);
      await type(tester, '');
      await reveal(tester, k('settings-group-keselamatan'));
      expect(k('settings-group-lanjutan'), findsNothing);
      expect(admin.location, '/settings');

      final sup = await open(tester, '/settings', superadmin);
      await reveal(tester, k('settings-group-lanjutan'));
      await tester.tap(k('settings-group-lanjutan'));
      await settle(tester);
      // The bottom of the list at each size: the group is what this golden is for.
      for (final size in GoldenSize.values) {
        await pumpAtSize(tester, sup.app, size);
        await reveal(tester, k('settings-row-lj-tilawah'));
        await expectLater(
          find.byWidget(sup.app),
          matchesGoldenFile('settings_list_superadmin_${size.name}.png'),
        );
      }
      await pumpAtSize(tester, sup.app, GoldenSize.phone);
      for (final key in ['dataSources', 'cloudSync', 'system', 'lj-liveYoutube', 'lj-tilawah']) {
        final row = k('settings-row-$key');
        await reveal(tester, row);
        expect(row, findsOneWidget, reason: key);
      }
      await tester.tap(k('settings-row-lj-liveYoutube'));
      await settle(tester);
      expect(sup.location, '/settings/liveYoutube');
      final card = tester.getRect(k('lanjutan-card'));
      expect(card.top, lessThan(tester.view.physicalSize.height / tester.view.devicePixelRatio));
      expect(card.top, greaterThanOrEqualTo(0), reason: 'scrolled to the card');
    });

    testWidgets('imsakBeep is a switch on its row: one save with enabled, Disimpan', (tester) async {
      final h = await open(tester, '/settings');
      final sw = k('settings-switch-imsakBeep');
      await reveal(tester, sw);
      expect(tester.widget<Switch>(sw).value, isFalse);
      await tester.tap(sw);
      await settle(tester);
      expect(orderPuts(h), {
        'imsakBeep': {'enabled': true},
      });
      expect(h.box.seen.where((r) => r.url.path == '/api/settings/imsakBeep').length, 1);
      expect(find.text('Disimpan'), findsOneWidget);
    });

    testWidgets('prayerSequenceSafety has no chevron and goes nowhere; an AJK cannot flip a switch', (tester) async {
      final h = await open(tester, '/settings');
      final row = k('settings-row-prayerSequenceSafety');
      await reveal(tester, row);
      expect(find.descendant(of: row, matching: find.byIcon(Icons.chevron_right_rounded)), findsNothing);
      await tester.tap(row);
      await settle(tester);
      expect(h.location, '/settings');

      await open(tester, '/settings', const ['ajk']);
      await reveal(tester, k('settings-switch-imsakBeep'));
      expect(tester.widget<Switch>(k('settings-switch-imsakBeep')).onChanged, isNull);
      expect(k('settings-order'), findsNothing, reason: 'the order row is for settings:write');
    });

    testWidgets('open groups are remembered across a rebuild of the screen', (tester) async {
      final h = await open(tester, '/settings');
      expect(k('settings-row-clock'), findsOneWidget, reason: 'Solat is open by default');
      expect(k('settings-row-kuliahCard'), findsNothing);
      await reveal(tester, k('settings-group-kandungan'));
      await tester.tap(k('settings-group-kandungan'));
      await settle(tester);
      final prefs = await SharedPreferences.getInstance();
      expect(jsonDecode(prefs.getString(settingsOpenGroupsKey)!), containsAll(['solat', 'kandungan']));

      h.router.go('/settings/clock');
      await settle(tester);
      h.router.go('/settings');
      await settle(tester);
      await reveal(tester, k('settings-row-kuliahCard'));
      expect(k('settings-row-kuliahCard'), findsOneWidget, reason: 'a fresh screen reads the choice back');
    });

    testWidgets('the order row sits first in Kandungan and opens the screen', (tester) async {
      final h = await open(tester, '/settings');
      await reveal(tester, k('settings-group-kandungan'));
      await tester.tap(k('settings-group-kandungan'));
      await settle(tester);
      await reveal(tester, k('settings-order'));
      expect(find.text('Seret untuk tukar giliran ${orderedFeatures.length} kad.'), findsOneWidget);

      await reveal(tester, k('settings-row-kuliahCard'));
      expect(tester.getRect(k('settings-order')).top, lessThan(tester.getRect(k('settings-row-kuliahCard')).top));
      await reveal(tester, k('settings-order'));
      await tester.tap(k('settings-order'));
      await settle(tester);
      expect(h.location, '/settings/order');
    });
  });

  group('feature page', () {
    testWidgets('Kunci aplikasi: the always-on row for a superadmin only', (tester) async {
      await open(tester, '/settings/appLock');
      expect(k('superadmin-device-lock'), findsNothing);
      final h = await open(tester, '/settings/appLock', superadmin);
      expect(k('superadmin-device-lock'), findsOneWidget);
      expect(find.text('Kunci peranti ini'), findsOneWidget);
      await expectGoldens(tester, h.app, 'settings_applock_superadmin');
    });

    testWidgets('an old stored range of 20 verses is not flagged until a verse field is touched; the steppers then bring it inside the rule', (tester) async {
      final h = await pumpShell(tester, roles: const ['admin']);
      h.settings['ayatCard'] = {'enabled': true, 'surah': 2, 'ayatFrom': 1, 'ayatTo': 20};
      h.container.invalidate(settingsProvider);
      await settle(tester);
      h.router.go('/settings/ayatCard');
      await settle(tester);
      await reveal(tester, k('setting-ayatFrom-plus'));
      // nothing about the verses was touched: no red line, nothing to save
      expect(find.text('Paling banyak 5 ayat sekali paparan'), findsNothing);
      expect(tester.widget<Text>(k('setting-ayatTo-value')).data, '20');
      // touching "Ayat dari" moves "Ayat hingga" with it, so the range is inside the rule again
      await tester.tap(k('setting-ayatFrom-plus'));
      await settle(tester);
      expect(tester.widget<Text>(k('setting-ayatFrom-value')).data, '2');
      expect(tester.widget<Text>(k('setting-ayatTo-value')).data, '6');
      expect(find.text('Paling banyak 5 ayat sekali paparan'), findsNothing);
    });
  });

  group('enrol code expiry', () {
    Future<ShellHarness> openEnrol(WidgetTester tester) async {
      final h = await open(tester, '/users/u2/enrol');
      expect(k('enrol-device-name'), findsOneWidget);
      return h;
    }

    testWidgets('defaults to 10 and sends ttlMinutes 60 after the choice; golden', (tester) async {
      final h = await openEnrol(tester);
      expect(tester.widget<SegmentedButton<int>>(k('enrol-ttl')).selected, {10});
      await expectGoldens(tester, h.app, 'enrol_ttl');
      await pumpAtSize(tester, h.app, GoldenSize.phone);
      await tester.enterText(k('enrol-device-name'), 'iPad Aminah');
      await tester.tap(k('enrol-ttl-60'));
      await settle(tester);
      await tester.tap(find.text('Jana kod QR'));
      await settle(tester);
      expect(jsonDecode(h.box.byPath('/api/enrol/begin')!.body), {
        'userId': 'u2',
        'deviceName': 'iPad Aminah',
        'ttlMinutes': 60,
      });
    });

    testWidgets('untouched, the code is 10 minutes', (tester) async {
      final h = await openEnrol(tester);
      await tester.enterText(k('enrol-device-name'), 'iPad Aminah');
      await tester.tap(find.text('Jana kod QR'));
      await settle(tester);
      expect((jsonDecode(h.box.byPath('/api/enrol/begin')!.body) as Map)['ttlMinutes'], 10);
    });
  });
}
