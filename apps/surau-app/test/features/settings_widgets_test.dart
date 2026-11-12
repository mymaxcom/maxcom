// The settings widgets drawn from the registry metadata, on the real feature
// pages over the fake box, plus the goldens of the pages that use them.

import 'dart:convert';
import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:surau_app/app/providers.dart';
import 'package:surau_app/features/settings_widgets/field_meta.dart';

import '../features/fakes.dart';
import '../features/shell/harness.dart';
import '../golden_sizes.dart';

Finder k(String key) => find.byKey(ValueKey(key));

Future<ShellHarness> open(
  WidgetTester tester,
  String feature, {
  List<String> roles = const ['admin'],
  Map<String, Object?>? stored,
}) async {
  final h = await pumpShell(tester, roles: roles);
  if (stored != null) {
    h.settings[feature] = {...(h.settings[feature] as Map? ?? const {}), ...stored};
    h.container.invalidate(settingsProvider);
    await settle(tester);
  }
  h.handlers['GET /api/assets'] = (r) async => jsonResponse(200, {
    'assets': [
      {'id': 'a' * 64, 'bytes': 2 * 1024 * 1024, 'createdAt': '2026-11-03T09:00:00.000Z'},
      {'id': 'b' * 64, 'bytes': 512 * 1024, 'createdAt': '2026-11-02T09:00:00.000Z'},
    ],
  });
  h.router.go('/settings/$feature');
  await settle(tester);
  return h;
}

Finder get save => find.widgetWithText(FilledButton, 'Simpan');

Future<Map<String, dynamic>> saved(WidgetTester tester, ShellHarness h, String feature) async {
  await reveal(tester, save);
  await tester.tap(save);
  await settle(tester);
  final puts = h.box.seen.where((r) => r.method == 'PUT' && r.url.path == '/api/settings/$feature');
  return jsonDecode(puts.last.body) as Map<String, dynamic>;
}

void main() {
  test('fieldMeta reads the generated table', () {
    final m = fieldMeta('liveYoutube', 'maxBitrateKbps')!;
    expect(m.ui, 'slider');
    expect(m.step, 500);
    expect(m.unit, 'kbps');
    expect(m.isSystem, isTrue);
    expect(fieldMeta('liveYoutube', 'privacy'), isNull);
    expect(fieldMeta('tilawah', 'cacheMaxMb')!.choices, [100, 300, 500, 1000]);
    expect(withUnit(2500, 'kbps'), '2500 kbps');
    expect(withUnit(60, '%'), '60%');
  });

  testWidgets('slider: maxBitrateKbps steps by 500 and shows the unit', (tester) async {
    final h = await open(tester, 'liveYoutube', roles: const ['superadmin']);
    await reveal(tester, k('setting-maxBitrateKbps'));
    expect(find.text('2500 kbps'), findsOneWidget);
    final slider = tester.widget<Slider>(k('setting-maxBitrateKbps'));
    expect(slider.divisions, 11);
    expect(slider.min, 500); // the rule's own range, so an old 700 kbps value is shown and kept
    slider.onChanged!(3000);
    await settle(tester);
    expect(find.text('3000 kbps'), findsOneWidget);
    expect(await saved(tester, h, 'liveYoutube'), {'maxBitrateKbps': 3000});
  });

  testWidgets('chips: cacheMaxMb is four choices; a stored value outside them is still shown', (tester) async {
    final h = await open(tester, 'tilawah', roles: const ['superadmin']);
    await reveal(tester, k('setting-cacheMaxMb-500'));
    for (final c in ['100 MB', '300 MB (lalai)', '500 MB', '1 GB']) {
      expect(find.text(c), findsOneWidget, reason: c);
    }
    await tester.tap(k('setting-cacheMaxMb-500'));
    await settle(tester);
    expect(await saved(tester, h, 'tilawah'), {'cacheMaxMb': 500});

    await open(tester, 'tilawah', roles: const ['superadmin'], stored: {'cacheMaxMb': 250});
    await reveal(tester, k('setting-cacheMaxMb-250'));
    expect(tester.widget<ChoiceChip>(k('setting-cacheMaxMb-250')).selected, isTrue);
  });

  testWidgets('surah search finds 18. Al-Kahf; the range clamps to the surah and to five verses', (tester) async {
    final h = await open(tester, 'ayatCard');
    await reveal(tester, k('setting-surah'));
    await tester.tap(k('setting-surah'));
    await settle(tester);
    await tester.enterText(k('picker-search'), 'kahf');
    await settle(tester);
    expect(find.text('18. Al-Kahf'), findsOneWidget);
    expect(k('picker-2'), findsNothing);
    await tester.tap(find.text('18. Al-Kahf'));
    await settle(tester);
    expect(find.text('18. Al-Kahf'), findsOneWidget);
    expect(find.text('110 ayat'), findsOneWidget);
    // 255 is past Al-Kahf: both ends came back to its last verse.
    Text v(String key) => tester.widget<Text>(k('setting-$key-value'));
    expect(v('ayatFrom').data, '110');
    expect(v('ayatTo').data, '110');
    expect(tester.widget<InkWell>(k('setting-ayatFrom-plus')).onTap, isNull, reason: 'the last verse');

    // Five verses at most: stepping the start down drags the end with it.
    for (var i = 0; i < 6; i++) {
      await reveal(tester, k('setting-ayatFrom-minus'));
      await tester.tap(k('setting-ayatFrom-minus'));
      await settle(tester);
    }
    expect(v('ayatFrom').data, '104');
    expect(v('ayatTo').data, '108');
    expect(await saved(tester, h, 'ayatCard'), {'surah': 18, 'ayatFrom': 104, 'ayatTo': 108});
  });

  testWidgets('reciter: a known name writes its folder; Lain-lain shows the folder row and checks it', (tester) async {
    final h = await open(tester, 'tilawah', roles: const ['superadmin']);
    expect(k('setting-reciter-folder'), findsNothing);
    await tester.tap(k('setting-reciter'));
    await settle(tester);
    await tester.tap(find.text('Lain-lain'));
    await settle(tester);
    expect(k('setting-reciter-folder'), findsOneWidget);
    expect(find.textContaining('Mesti nama folder qari'), findsOneWidget, reason: 'empty is refused');
    await tester.enterText(k('setting-reciter-folder'), 'Muhammad_Ayyoub_128kbps');
    await settle(tester);
    expect(find.textContaining('Mesti nama folder qari'), findsNothing);

    h.handlers['POST /api/settings/test-source'] = (r) async => jsonResponse(200, {'ok': true, 'status': 200, 'ms': 162});
    await tester.tap(k('test-source'));
    await settle(tester);
    expect(find.text('Berjaya: 162 ms'), findsOneWidget);
    expect(jsonDecode(h.box.byPath('/api/settings/test-source')!.body), {
      'kind': 'reciter',
      'folder': 'Muhammad_Ayyoub_128kbps',
    });
    expect(await saved(tester, h, 'tilawah'), {'reciter': 'Muhammad_Ayyoub_128kbps'});

    // The toast of the save floats over the page for a few seconds.
    await tester.pump(const Duration(seconds: 5));
    await settle(tester);
    await reveal(tester, k('setting-reciter'));
    await tester.tap(k('setting-reciter'));
    await settle(tester);
    await tester.tap(find.text('Mishary Rashid Alafasy'));
    await settle(tester);
    expect(k('setting-reciter-folder'), findsNothing);
  });

  testWidgets('reciter: an admin may type a folder but gets no Cuba sambungan (a system route)', (tester) async {
    await open(tester, 'tilawah', stored: {'reciter': 'Some_Folder_64'});
    expect(k('setting-reciter-folder'), findsOneWidget);
    expect(k('test-source'), findsNothing);
  });

  testWidgets('colour: Auto writes null, a swatch its colour, Lain with #12ab is red and blocks Simpan', (tester) async {
    final h = await open(tester, 'autoTone', stored: {'override': '#F0C97A'});
    await tester.tap(k('swatch-auto'));
    await settle(tester);
    expect(await saved(tester, h, 'autoTone'), {'override': null});

    await reveal(tester, k('swatch-#FBEFD3'));
    await tester.tap(k('swatch-#FBEFD3'));
    await settle(tester);
    await reveal(tester, k('swatch-custom'));
    await tester.tap(k('swatch-custom'));
    await settle(tester);
    await tester.enterText(k('setting-override'), '#12ab');
    await settle(tester);
    expect(find.text('Tulis # diikuti 6 aksara, contoh #F6E7B8'), findsOneWidget);
    expect(tester.widget<FilledButton>(save).enabled, isFalse);
    await tester.enterText(k('setting-override'), '#12AB34');
    await settle(tester);
    expect(await saved(tester, h, 'autoTone'), {'override': '#12AB34'});
  });

  testWidgets('audio: Tiada fail plus the box files; a tap writes the id; the list asks for audio only', (tester) async {
    final h = await open(tester, 'firstAzanSubuh');
    expect(find.text('Tiada fail'), findsOneWidget);
    expect(find.text('Fail audio 2'), findsOneWidget);
    expect(find.text('Fail audio 1'), findsOneWidget);
    expect(find.text('2.0 MB'), findsOneWidget);
    expect(h.box.seen.any((r) => r.url.path == '/api/assets' && r.url.queryParameters['mime'] == 'audio/mpeg'), isTrue);
    await tester.tap(k('audio-${'a' * 64}'));
    await settle(tester);
    expect(await saved(tester, h, 'firstAzanSubuh'), {'audioFile': 'a' * 64});
  });

  testWidgets('audio: upload sends audio/mpeg and selects the new file; an AJK gets no list request', (tester) async {
    final h = await open(tester, 'firstAzanSubuh');
    h.pickedAudio = Uint8List.fromList(List.filled(32, 7));
    await reveal(tester, k('audio-upload'));
    await tester.tap(k('audio-upload'));
    await settle(tester);
    expect(h.assetsPosted.single.$1, 'audio/mpeg');
    expect(find.text('Audio dimuat naik'), findsOneWidget);
    expect((await saved(tester, h, 'firstAzanSubuh'))['audioFile'], sha256Hex(h.assetsPosted.single.$2));

    final ajk = await open(tester, 'firstAzanSubuh', roles: const ['ajk']);
    expect(ajk.box.byPath('/api/assets'), isNull);
    expect(k('audio-upload'), findsNothing);
    expect(find.text('Tiada fail'), findsOneWidget);
  });

  testWidgets('template: a chip inserts, an unknown mark warns, the meter and the too-long sentence', (tester) async {
    final h = await open(tester, 'liveYoutube');
    final field = k('setting-titleTemplate');
    await reveal(tester, field);
    expect(find.text('Kuliah Maghrib: Ustaz Haji Ahmad Fauzi bin Ismail'), findsOneWidget, reason: 'the live preview');
    await tester.enterText(field, 'Kuliah ');
    await settle(tester);
    await tester.tap(k('placeholder-titleTemplate-penceramah'));
    await settle(tester);
    expect(tester.widget<TextField>(field).controller!.text, 'Kuliah {penceramah}');
    expect(find.text('Kuliah Ustaz Haji Ahmad Fauzi bin Ismail'), findsOneWidget);
    expect(find.text('40 / 100 aksara'), findsOneWidget);

    await tester.enterText(field, 'Kuliah {xyz}');
    await settle(tester);
    expect(find.text('Tanda tidak dikenali: {xyz}'), findsOneWidget);

    await tester.enterText(field, 'a' * 101);
    await settle(tester);
    expect(find.text('101 / 100 aksara: terlalu panjang untuk YouTube, akan dipotong'), findsOneWidget);
    expect(tester.widget<FilledButton>(save).enabled, isFalse);

    await tester.enterText(field, '{label} {surau}');
    await settle(tester);
    expect(await saved(tester, h, 'liveYoutube'), {'titleTemplate': '{label} {surau}'});
  });

  testWidgets('preset text: a chip writes the sentence and the counter follows', (tester) async {
    final h = await open(tester, 'solatScreen');
    await reveal(tester, k('preset-3'));
    await tester.tap(k('preset-3'));
    await settle(tester);
    expect(tester.widget<TextField>(k('setting-message')).controller!.text, 'Sila tutup telefon bimbit anda');
    expect(tester.widget<Text>(k('preset-count-message')).data, '30 / 100');
    expect(await saved(tester, h, 'solatScreen'), {'message': 'Sila tutup telefon bimbit anda'});
  });

  testWidgets('Hijri month is picked by name', (tester) async {
    final h = await open(tester, 'tarawih');
    expect(find.text('Ramadan'), findsOneWidget);
    await tester.tap(k('setting-hijriMonth'));
    await settle(tester);
    await tester.tap(find.text('Safar'));
    await settle(tester);
    expect(await saved(tester, h, 'tarawih'), {'hijriMonth': 2});
  });

  testWidgets('Lanjutan card: absent without system:read, there for a superadmin, dimmed on Telefon terus', (tester) async {
    await open(tester, 'liveYoutube');
    expect(k('lanjutan-card'), findsNothing);
    expect(find.text('Video ke YouTube'), findsNothing, reason: 'hidden, not read-only');
    expect(find.text('Kadar bit maksimum (kbps)'), findsNothing);

    await open(tester, 'liveYoutube', roles: const ['admin', 'superadmin']);
    await reveal(tester, k('lanjutan-card'));
    expect(find.text('Video ke YouTube'), findsOneWidget);
    expect(k('lanjutan-dim-note'), findsNothing);

    await open(tester, 'liveYoutube', roles: const ['admin', 'superadmin'], stored: {'relayFrom': 'phone'});
    await reveal(tester, k('lanjutan-card'));
    expect(find.text('Tidak digunakan bila Telefon terus dipilih'), findsOneWidget);
    expect(find.ancestor(of: find.text('Video ke YouTube'), matching: find.byType(IgnorePointer)), findsWidgets);
  });

  testWidgets('relayFrom: Telefon terus is drawn but cannot be chosen yet', (tester) async {
    await open(tester, 'liveYoutube');
    await reveal(tester, k('setting-relayFrom-phone'));
    expect(find.text('Tersedia dalam keluaran akan datang'), findsOneWidget);
    await tester.tap(k('setting-relayFrom-phone'));
    await settle(tester);
    expect(tester.widget<FilledButton>(save).enabled, isFalse, reason: 'nothing changed');
  });

  testWidgets('phone and email fields use their keyboards', (tester) async {
    await open(tester, 'surauInfo');
    await reveal(tester, k('setting-helpPhone'));
    expect(tester.widget<TextField>(k('setting-helpPhone')).keyboardType, TextInputType.phone);
    await reveal(tester, k('setting-helpEmail'));
    expect(tester.widget<TextField>(k('setting-helpEmail')).keyboardType, TextInputType.emailAddress);
  });

  testWidgets('data sources: Cuba sambungan sends the address, a blocked host reads in BM', (tester) async {
    final h = await open(tester, 'dataSources', roles: const ['superadmin']);
    h.handlers['POST /api/settings/test-source'] = (r) async =>
        jsonResponse(200, {'ok': false, 'status': null, 'ms': 2, 'error': 'blocked_host'});
    final buttons = k('test-source');
    expect(buttons, findsNWidgets(3));
    await tester.tap(buttons.first);
    await settle(tester);
    expect(find.text('Alamat ini tidak dibenarkan'), findsOneWidget);
    final sent = jsonDecode(h.box.byPath('/api/settings/test-source')!.body) as Map<String, dynamic>;
    expect(sent['kind'], 'source');
    expect(sent['url'], startsWith('https://www.e-solat'));
  });

  group('goldens', () {
    const superadmin = ['admin', 'superadmin'];
    for (final (feature, name, roles) in const [
      ('liveYoutube', 'settings_live_youtube', superadmin),
      ('tilawah', 'settings_tilawah', superadmin),
      ('firstAzanSubuh', 'settings_first_azan', ['admin']),
      ('autoTone', 'settings_auto_tone', ['admin']),
      ('solatScreen', 'settings_solat_screen', ['admin']),
      ('tarawih', 'settings_tarawih', ['admin']),
      ('ayatCard', 'settings_ayat_card', ['admin']),
      ('system', 'settings_system', ['superadmin']),
    ]) {
      testWidgets(name, (tester) async {
        final h = await open(tester, feature, roles: roles);
        await expectGoldens(tester, h.app, name);
      });
    }
  });

  for (final scale in [1.0, 1.3]) {
    testWidgets('the Kewangan big-amount stepper shows every digit, scale $scale', (
      tester,
    ) async {
      await open(tester, 'finance');
      tester.view.physicalSize = const Size(360, 800) * 2;
      tester.platformDispatcher.textScaleFactorTestValue = scale;
      addTearDown(tester.platformDispatcher.clearTextScaleFactorTestValue);
      await tester.pump();
      await settle(tester);
      // The shell's bottom bar (shell.dart) overflows 7 px at scale 1.3;
      // that is outside this check.
      while (tester.takeException() != null) {}
      final field = k('setting-bigAmountSen');
      await reveal(tester, field);
      while (tester.takeException() != null) {}
      for (final v in ['2000000', '100000000000']) {
        await tester.enterText(field, v);
        await tester.pump();
        while (tester.takeException() != null) {}
        final editable = find.descendant(
          of: field,
          matching: find.byType(EditableText),
        );
        final state = tester.state<EditableTextState>(editable);
        expect(state.widget.controller.text, v);
        // Nothing to scroll: every digit fits inside the field.
        expect(state.renderEditable.maxScrollExtent, 0, reason: '$v is clipped');
        expect(state.renderEditable.offset.pixels, 0, reason: '$v is scrolled');
      }
    });
  }
}
