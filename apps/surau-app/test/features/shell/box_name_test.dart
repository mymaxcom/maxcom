// The box name in "Butiran sistem" (2026.11.14, W25 item 2): shown, editable by whoever may change the settings,
// straight to the box (PUT /api/box/name, 1..60), the hint that it follows the surau name unless changed, and
// goldens of the dialog in BM, EN and AR.

import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:surau_app/app/app_lang.dart';
import 'package:surau_app/app/providers.dart' show isCloudGatewayProvider;
import 'package:surau_app/features/live/fake_publisher.dart';
import 'package:surau_app/features/live/live_screen.dart' show livePublisherProvider;
import 'package:surau_app/features/shell/box_name_dialog.dart' show validBoxName;

import '../../golden_sizes.dart';
import '../fakes.dart' show jsonResponse;
import 'harness.dart';

const _name = 'box1-Surau Contoh';
Finder get _row => find.byKey(const ValueKey('status-box-name'));

Future<ShellHarness> _open(
  WidgetTester tester, {
  List<String> roles = const ['admin'],
  bool cloud = false,
  AppLang lang = AppLang.ms,
  String? name = _name,
}) async {
  final h = await pumpShell(
    tester,
    roles: roles,
    health: {...healthyJson, 'name': ?name},
    overrides: [livePublisherProvider.overrideWithValue(FakePublisher()), if (cloud) isCloudGatewayProvider.overrideWithValue(true)],
  );
  if (lang != AppLang.ms) await h.container.read(appLangProvider.notifier).set(lang);
  await pumpAtSize(tester, h.app, GoldenSize.phone);
  await tester.tap(find.byKey(const ValueKey('dash-system-toggle')));
  await settle(tester);
  return h;
}

void main() {
  test('a name of 1 to 60 characters is accepted, an empty or a longer one is not', () {
    expect(validBoxName('a'), isTrue);
    expect(validBoxName('  Surau  '), isTrue);
    expect(validBoxName('x' * 60), isTrue);
    expect(validBoxName('x' * 61), isFalse);
    expect(validBoxName('   '), isFalse);
  });

  testWidgets('the name is shown under Butiran sistem; the admin renames it and the box is told', (tester) async {
    final h = await _open(tester);
    h.handlers['PUT /api/box/name'] = (r) async => jsonResponse(200, {'name': 'box1-Surau Baru'});
    expect(find.text('Nama MAXCOM'), findsOneWidget);
    expect(find.text(_name), findsOneWidget);
    await tester.tap(_row);
    await settle(tester);
    expect(find.text('Nama ini mengikut nama surau melainkan anda menukarnya sendiri.'), findsOneWidget);
    await tester.enterText(find.byKey(const ValueKey('box-name-field')), 'box1-Surau Baru');
    await tester.tap(find.byKey(const ValueKey('box-name-save')));
    await settle(tester);
    final put = h.box.seen.singleWhere((r) => r.method == 'PUT' && r.url.path == '/api/box/name');
    expect(jsonDecode(put.body), {'name': 'box1-Surau Baru'});
    expect(find.byKey(const ValueKey('box-name-field')), findsNothing, reason: 'the dialog closed');
  });

  testWidgets('an empty name is refused before anything is sent', (tester) async {
    final h = await _open(tester);
    await tester.tap(_row);
    await settle(tester);
    await tester.enterText(find.byKey(const ValueKey('box-name-field')), '   ');
    await tester.tap(find.byKey(const ValueKey('box-name-save')));
    await settle(tester);
    expect(find.text('Nama MAXCOM mestilah 1 hingga 60 aksara'), findsOneWidget);
    expect(h.box.seen.any((r) => r.method == 'PUT' && r.url.path == '/api/box/name'), isFalse);
  });

  testWidgets('a refusal from the box is shown in the dialog', (tester) async {
    final h = await _open(tester);
    h.handlers['PUT /api/box/name'] = (r) async => jsonResponse(400, {'errors': ['x'], 'code': 'bad_box_name'});
    await tester.tap(_row);
    await settle(tester);
    await tester.tap(find.byKey(const ValueKey('box-name-save')));
    await settle(tester);
    expect(find.text('Nama MAXCOM mestilah 1 hingga 60 aksara'), findsOneWidget);
    expect(find.byKey(const ValueKey('box-name-field')), findsOneWidget, reason: 'still open to correct it');
  });

  testWidgets('someone who may not change the settings, or the cloud, only reads the name', (tester) async {
    await _open(tester, roles: const ['ajk']);
    expect(find.text(_name), findsOneWidget);
    await tester.tap(_row);
    await settle(tester);
    expect(find.byKey(const ValueKey('box-name-field')), findsNothing);
  });

  testWidgets('through the cloud the name is read only', (tester) async {
    await _open(tester, cloud: true);
    await tester.tap(_row);
    await settle(tester);
    expect(find.byKey(const ValueKey('box-name-field')), findsNothing);
  });

  testWidgets('an older box that sends no name has no row', (tester) async {
    await _open(tester, name: null);
    expect(_row, findsNothing);
  });

  group('goldens', () {
    for (final (name, lang, hint) in [
      ('bm', AppLang.ms, 'Nama ini mengikut nama surau melainkan anda menukarnya sendiri.'),
      ('en', AppLang.en, 'This name follows the surau name unless you change it yourself.'),
      ('ar', AppLang.ar, 'يتبع هذا الاسم اسم المصلى ما لم تغيّره بنفسك.'),
    ]) {
      testWidgets('the rename dialog, $name', (tester) async {
        final h = await _open(tester, lang: lang);
        await tester.tap(_row);
        await settle(tester);
        expect(find.text(hint), findsOneWidget);
        await expectLater(find.byWidget(h.app), matchesGoldenFile('box_name_dialog_$name.png'));
      });
    }

    testWidgets('Butiran sistem with the name row', (tester) async {
      final h = await _open(tester);
      await expectLater(find.byWidget(h.app), matchesGoldenFile('box_name_row_bm.png'));
    });
  });
}
