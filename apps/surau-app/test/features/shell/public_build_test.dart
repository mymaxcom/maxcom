// Plan 14 Task 25: the public MAX Admin Client carries none of the Pentadbir
// MAXCOM screens. A fake server answer may still hand the app the role
// `superadmin` (the real server no longer does); the app must draw nothing
// for it. These tests run in the default build and are skipped in the ops
// build (superadmin_test.dart and the Lanjutan tests cover that side).

import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:surau_app/app/providers.dart';
import 'package:surau_app/ops/ops_build.dart';

import '../../golden_sizes.dart';
import 'harness.dart';

Finder k(String key) => find.byKey(ValueKey(key));

Future<ShellHarness> open(
  WidgetTester tester,
  List<String> roles,
  String path, {
  GoldenSize size = GoldenSize.phone,
  Map<String, Object?>? stored,
  String? feature,
}) async {
  final h = await pumpShell(tester, roles: roles, size: size);
  if (stored != null && feature != null) {
    h.settings[feature] = {...(h.settings[feature] as Map? ?? const {}), ...stored};
    h.container.invalidate(settingsProvider);
    await settle(tester);
  }
  h.router.go(path);
  await settle(tester);
  return h;
}

void main() {
  const both = ['admin', 'superadmin'];

  testWidgets('no shield badge, on the phone bar or the iPad rail, even for a superadmin session', (tester) async {
    await open(tester, both, '/settings');
    expect(k('superadmin-badge'), findsNothing);
    await open(tester, const ['superadmin'], '/', size: GoldenSize.ipadMiniLandscape);
    expect(k('superadmin-badge'), findsNothing);
    await open(tester, const ['superadmin'], '/', size: GoldenSize.ipadMiniPortrait);
    expect(k('superadmin-badge'), findsNothing);
  }, skip: kOpsBuild);

  testWidgets('the settings list has no Lanjutan group and search finds none of it', (tester) async {
    await open(tester, both, '/settings');
    expect(k('settings-group-lanjutan'), findsNothing);
    expect(k('settings-row-dataSources'), findsNothing);
    expect(k('settings-row-lj-liveYoutube'), findsNothing);
    await tester.enterText(find.byType(TextField).first, 'lanjutan');
    await settle(tester);
    expect(k('settings-group-lanjutan'), findsNothing);
    await tester.enterText(find.byType(TextField).first, 'kadar bit');
    await settle(tester);
    expect(k('settings-row-liveYoutube'), findsNothing);
    expect(k('settings-row-lj-liveYoutube'), findsNothing);
  }, skip: kOpsBuild);

  testWidgets('a feature page shows no Lanjutan card and no system field, with or without ?lj=1', (tester) async {
    for (final path in ['/settings/liveYoutube', '/settings/liveYoutube?lj=1', '/settings/tilawah?lj=1']) {
      await open(tester, both, path);
      expect(k('lanjutan-card'), findsNothing, reason: path);
      expect(find.text('Video ke YouTube'), findsNothing, reason: path);
      expect(find.text('Ruang simpanan (MB)'), findsNothing, reason: path);
    }
  }, skip: kOpsBuild);

  testWidgets('a MAXCOM system page is not found in the public app', (tester) async {
    for (final key in ['dataSources', 'cloudSync', 'system']) {
      final h = await open(tester, both, '/settings/$key');
      // The route guard sends the person home, or the page answers "not found": either way no form.
      expect(k('feature-$key'), findsNothing, reason: key);
      expect(k('lanjutan-card'), findsNothing, reason: key);
      expect(h.location, isNot('/settings/$key'), reason: 'guard refused $key');
    }
  }, skip: kOpsBuild);

  testWidgets('Kunci aplikasi has no Pentadbir MAXCOM device-lock card', (tester) async {
    await open(tester, both, '/settings/appLock');
    expect(k('superadmin-device-lock'), findsNothing);
  }, skip: kOpsBuild);

  testWidgets('This device has no always-on lock row for a superadmin session', (tester) async {
    await open(tester, const ['superadmin'], '/this-device');
    expect(k('this-device-lock-always'), findsNothing);
  }, skip: kOpsBuild);

  testWidgets('saving a feature sends only what the person changed: a system field is never in the patch', (tester) async {
    final h = await open(
      tester,
      const ['admin'],
      '/settings/liveYoutube',
      feature: 'liveYoutube',
      stored: {'relayVideo': 'reencode', 'maxBitrateKbps': 1500, 'titleTemplate': 'Kuliah'},
    );
    final field = find.byKey(const ValueKey('setting-titleTemplate'));
    await reveal(tester, field);
    await tester.enterText(field, 'Kuliah Maghrib');
    await settle(tester);
    final save = find.widgetWithText(FilledButton, 'Simpan');
    await reveal(tester, save);
    await tester.tap(save);
    await settle(tester);
    final puts = h.box.seen.where((r) => r.method == 'PUT' && r.url.path == '/api/settings/liveYoutube');
    expect(puts, isNotEmpty);
    final body = jsonDecode(puts.last.body) as Map<String, dynamic>;
    expect(body.keys, isNot(contains('relayVideo')));
    // the bitrate is no longer a system field; it is absent only because the person did not change it
    expect(body.keys, isNot(contains('maxBitrateKbps')));
    expect(body['titleTemplate'], 'Kuliah Maghrib');
  }, skip: kOpsBuild);

  testWidgets('a new user form never offers the Pentadbir MAXCOM role, on the cloud gateway either', (tester) async {
    final h = await pumpShell(
      tester,
      roles: const ['superadmin', 'admin'],
      overrides: [isCloudGatewayProvider.overrideWithValue(true)],
    );
    h.router.go('/users/new');
    await settle(tester);
    expect(find.text('Pentadbir MAXCOM'), findsNothing);
    expect(find.byType(CheckboxListTile), findsWidgets);
    expect(find.text('Pentadbir'), findsWidgets);
  }, skip: kOpsBuild);

  testWidgets('a person who holds the role shows it as read-only text, never a tick', (tester) async {
    final h = await pumpShell(tester, roles: const ['admin']);
    h.users = [
      ...h.users,
      {
        'id': 'u9',
        'name': 'Cik MAXCOM',
        'roles': ['superadmin', 'admin'],
        'active': true,
        'pinRequired': false,
        'pinLockedUntil': null,
      },
    ];
    h.router.go('/users/u9');
    await settle(tester);
    expect(k('user-role-superadmin-readonly'), findsOneWidget);
    expect(find.text('Pentadbir MAXCOM'), findsOneWidget);
    final ticks = tester.widgetList<CheckboxListTile>(find.byType(CheckboxListTile));
    for (final t in ticks) {
      expect((t.title as Text).data, isNot('Pentadbir MAXCOM'));
    }
  });
}
