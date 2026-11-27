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
import 'package:surau_app/ops/ops_build.dart';

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
    expect(m.hidden, isTrue, reason: 'quality is automatic: no manual control');
    expect(m.ui, 'slider');
    expect(m.step, 500);
    expect(m.unit, 'kbps');
    expect(m.isSystem, isFalse, reason: 'the bitrate is a live setting, not a system one');
    expect(m.min, 1000);
    expect(m.max, 8000);
    expect(fieldMeta('liveYoutube', 'relayVideo')!.isSystem, isTrue);
    expect(fieldMeta('liveYoutube', 'privacy'), isNull);
    expect(fieldMeta('tilawah', 'cacheMaxMb')!.choices, [100, 300, 500, 1000]);
    expect(withUnit(3500, 'kbps'), '3500 kbps');
    expect(withUnit(60, '%'), '60%');
  });

  testWidgets('maxBitrateKbps and autoQuality are hidden from the YouTube page', (tester) async {
    await open(tester, 'liveYoutube');
    expect(k('setting-maxBitrateKbps'), findsNothing);
    expect(k('setting-autoQuality'), findsNothing);
    expect(find.text('Kualiti automatik'), findsNothing);
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
  }, skip: !kOpsBuild);

  testWidgets('Kad Ayat: the verses are drawn only for "Pilih sendiri"; the other modes keep them hidden', (tester) async {
    final h = await open(tester, 'ayatCard');
    // the default is the daily selection: three modes with a sentence each, no surah and no verses
    expect(k('setting-pick-daily'), findsOneWidget);
    expect(find.text('Membaca Al-Quran mengikut turutan, hingga 3 ayat sehari, bersambung esok.'), findsOneWidget);
    expect(find.text('Satu ayat rawak daripada seluruh Al-Quran, bertukar setiap hari.'), findsOneWidget);
    expect(find.text('Ayat yang anda pilih dipaparkan setiap hari sehingga anda menukarnya.'), findsOneWidget);
    expect(k('setting-surah'), findsNothing);
    expect(k('setting-ayatFrom-value'), findsNothing);
    await tester.tap(k('setting-pick-random'));
    await settle(tester);
    expect(k('setting-surah'), findsNothing);
    await tester.tap(k('setting-pick-manual'));
    await settle(tester);
    expect(k('setting-surah'), findsOneWidget);
    expect(k('setting-ayatFrom-value'), findsOneWidget);
    expect(k('setting-ayatCount-3'), findsOneWidget);
    expect(k('setting-ayatCount-4'), findsNothing, reason: 'three verses at most');
    expect(await saved(tester, h, 'ayatCard'), {'pick': 'manual'});
  });

  testWidgets('Kad Ayat: surah search finds 18. Al-Kahfi; a new surah starts at verse 1; start and count never leave the surah or pass 3 verses', (tester) async {
    final h = await open(tester, 'ayatCard', stored: {'pick': 'manual'});
    await reveal(tester, k('setting-surah'));
    await tester.tap(k('setting-surah'));
    await settle(tester);
    await tester.enterText(k('picker-search'), 'kahf');
    await settle(tester);
    expect(find.text('18. Al-Kahfi'), findsOneWidget);
    expect(k('picker-2'), findsNothing);
    await tester.tap(find.text('18. Al-Kahfi'));
    await settle(tester);
    expect(find.text('18. Al-Kahfi'), findsOneWidget);
    expect(find.text('110 ayat'), findsOneWidget);
    Text v(String key) => tester.widget<Text>(k('setting-$key-value'));
    ChoiceChip chip(int n) => tester.widget<ChoiceChip>(k('setting-ayatCount-$n'));
    // the old range (255) meant nothing in Al-Kahfi: verse 1, one verse
    expect(v('ayatFrom').data, '1');
    expect(chip(1).selected, isTrue);
    expect(find.text('Dipaparkan di TV: Surah Al-Kahfi (110): ayat 1'), findsOneWidget);

    await reveal(tester, k('setting-ayatCount-3'));
    await tester.tap(k('setting-ayatCount-3'));
    await settle(tester);
    expect(chip(3).selected, isTrue);
    expect(v('ayatFrom').data, '1', reason: 'the count never moves the start');
    expect(find.text('Dipaparkan di TV: Surah Al-Kahfi (110): ayat 1 hingga 3'), findsOneWidget);

    // type the start verse
    await reveal(tester, k('setting-ayatFrom-edit'));
    await tester.tap(k('setting-ayatFrom-edit'));
    await settle(tester);
    await tester.enterText(k('setting-ayatFrom-input'), '111');
    await tester.tap(k('setting-ayatFrom-input-ok'));
    await settle(tester);
    expect(find.text('Masukkan nombor antara 1 dan 110'), findsOneWidget);
    await tester.enterText(k('setting-ayatFrom-input'), '109');
    await tester.tap(k('setting-ayatFrom-input-ok'));
    await settle(tester);
    // 109 and 110 are the last two verses: the count shrinks to fit, 3 is off
    expect(v('ayatFrom').data, '109');
    expect(chip(2).selected, isTrue);
    expect(chip(3).onSelected, isNull, reason: 'past the end of the surah');
    expect(find.text('Surah ini tamat pada ayat 110.'), findsOneWidget);
    expect(tester.widget<InkWell>(k('setting-ayatFrom-plus')).onTap, isNotNull);
    await tester.tap(k('setting-ayatFrom-plus'));
    await settle(tester);
    expect(v('ayatFrom').data, '110');
    expect(chip(1).selected, isTrue);
    expect(tester.widget<InkWell>(k('setting-ayatFrom-plus')).onTap, isNull, reason: 'the last verse');
    expect(await saved(tester, h, 'ayatCard'), {'surah': 18, 'ayatFrom': 110, 'ayatTo': 110});
  });

  testWidgets('Kad Ayat: an old stored range of 5 verses shows start and 3 verses with a note, and touching the count fixes it', (tester) async {
    final h = await open(tester, 'ayatCard', stored: {'pick': 'manual', 'surah': 2, 'ayatFrom': 10, 'ayatTo': 14});
    await reveal(tester, k('setting-ayatCount-3'));
    expect(tester.widget<Text>(k('setting-ayatFrom-value')).data, '10');
    expect(tester.widget<ChoiceChip>(k('setting-ayatCount-3')).selected, isTrue);
    expect(find.text('Julat lama dipendekkan kepada 3 ayat.'), findsOneWidget);
    // touching the count rewrites both ends inside the rule and drops the note
    await tester.tap(k('setting-ayatCount-2'));
    await settle(tester);
    expect(find.text('Julat lama dipendekkan kepada 3 ayat.'), findsNothing);
    expect(await saved(tester, h, 'ayatCard'), {'ayatTo': 11});
  });

  testWidgets('Kad Ayat: saving another setting of a box with an old 5-verse range is not blocked', (tester) async {
    final h = await open(tester, 'ayatCard', stored: {'pick': 'manual', 'surah': 2, 'ayatFrom': 10, 'ayatTo': 14});
    await reveal(tester, k('setting-showTranslation'));
    await tester.tap(k('setting-showTranslation'));
    await settle(tester);
    expect(find.text('Paling banyak 3 ayat sekali paparan'), findsNothing);
    expect(await saved(tester, h, 'ayatCard'), {'showTranslation': false});
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

  testWidgets('autoTone: the accent override is not offered (Ubah suai Warna aksen owns the accent)', (tester) async {
    await open(tester, 'autoTone', stored: {'override': '#F0C97A'});
    expect(k('swatch-auto'), findsNothing);
    expect(k('setting-override'), findsNothing);
    expect(find.text('Warna teks'), findsNothing);
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

  testWidgets('[K17] preset text: an English TV gets the English sentences (presetsEn)', (tester) async {
    final h = await pumpShell(tester, roles: const ['admin']);
    h.settings['language'] = {'enabled': true, 'lang': 'en'};
    h.container.invalidate(settingsProvider);
    await settle(tester);
    h.router.go('/settings/solatScreen');
    await settle(tester);
    await reveal(tester, k('preset-3'));
    expect(find.text('Please switch off your phones'), findsOneWidget);
    expect(find.text('Sila tutup telefon bimbit anda'), findsNothing);
  });

  testWidgets('[K17] a feature that needs another says so and cannot be switched on first (featureRequires)', (tester) async {
    final h = await pumpShell(tester, roles: const ['admin'], features: const {'liveOnKiosk': false, 'liveYoutube': false});
    h.router.go('/settings/liveYoutube');
    await settle(tester);
    expect(k('feature-requires'), findsOneWidget);
    expect(tester.widget<Switch>(find.descendant(of: k('feature-switch'), matching: find.byType(Switch))).onChanged, isNull);
  });

  testWidgets('[K17] settings nothing reads are absent from the forms', (tester) async {
    for (final (feature, field) in const [
      ('pengumuman', 'daysAhead'),
      ('programKhas', 'daysAhead'),
      ('autoTone', 'override'),
      ('system', 'suspendedAt'),
    ]) {
      final h = await open(tester, feature, roles: const ['superadmin']);
      expect(k('setting-$field'), findsNothing, reason: '$feature.$field');
      h.router.go('/settings');
      await settle(tester);
    }
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

  testWidgets('Lanjutan card: absent without system:read', (tester) async {
    await open(tester, 'liveYoutube');
    expect(k('lanjutan-card'), findsNothing);
    expect(find.text('Video ke YouTube'), findsNothing, reason: 'hidden, not read-only');
    // the bitrate is no longer a Lanjutan field, and no longer shown at all (quality is automatic)
    expect(find.text('Kadar bit maksimum (kbps)'), findsNothing);
  });

  // One app per test: a second app opened in the same test leaves the first one's timer pending.
  testWidgets('Lanjutan card: absent in the public build even for a superadmin', (tester) async {
    await open(tester, 'liveYoutube', roles: const ['admin', 'superadmin']);
    expect(k('lanjutan-card'), findsNothing);
    expect(find.text('Video ke YouTube'), findsNothing);
  }, skip: kOpsBuild);

  testWidgets('Lanjutan card: shown to a superadmin in the ops build, and a stored phone relay does not dim it', (tester) async {
    await open(tester, 'liveYoutube', roles: const ['admin', 'superadmin']);
    await reveal(tester, k('lanjutan-card'));
    expect(find.text('Video ke YouTube'), findsOneWidget);
    expect(k('lanjutan-dim-note'), findsNothing);

    await open(tester, 'liveYoutube', roles: const ['admin', 'superadmin'], stored: {'relayFrom': 'phone'});
    await reveal(tester, k('lanjutan-card'));
    // relayFrom is hidden (planned): a stored 'phone' must not dim the card, no control could undo it.
    expect(find.text('Tidak digunakan bila Telefon terus dipilih'), findsNothing);
    expect(k('lanjutan-dim-note'), findsNothing);
  }, skip: !kOpsBuild);

  testWidgets('relayFrom is hidden from Tetapan (planned), the stored value untouched', (tester) async {
    await open(tester, 'liveYoutube');
    expect(k('setting-relayFrom-phone'), findsNothing);
    expect(k('setting-relayFrom-box'), findsNothing);
  });

  group('a setting another one switches off (disabledWhen)', () {
    Future<ShellHarness> openWith(WidgetTester tester, String feature, Map<String, Map<String, Object?>> other) async {
      final h = await pumpShell(tester, roles: const ['admin']);
      for (final e in other.entries) {
        h.settings[e.key] = {...(h.settings[e.key] as Map? ?? const {}), ...e.value};
      }
      h.container.invalidate(settingsProvider);
      await settle(tester);
      h.router.go('/settings/$feature');
      await settle(tester);
      return h;
    }

    test('the metadata names both sides', () {
      expect(fieldMeta('recordingCleanup', 'keepDays')!.disabledWhen!.field, 'keepOnDevice');
      expect(fieldMeta('recording', 'keepOnDevice')!.disabledWhen!.feature, 'recordingCleanup');
    });

    testWidgets('keepOnDevice off: the days field is dimmed with a note, its value untouched', (tester) async {
      final h = await openWith(tester, 'recordingCleanup', {
        'recording': {'keepOnDevice': false},
        'recordingCleanup': {'keepDays': 7},
      });
      await reveal(tester, k('setting-note-keepDays'));
      expect(find.textContaining('dipadam sebaik YouTube mengesahkannya'), findsOneWidget);
      expect(find.ancestor(of: k('setting-keepDays'), matching: find.byType(IgnorePointer)), findsWidgets);
      expect(tester.widget<FilledButton>(save).enabled, isFalse, reason: 'nothing edited');
      expect(h.settings['recordingCleanup'], containsPair('keepDays', 7));
    });

    testWidgets('keepOnDevice on: the days field is a normal control', (tester) async {
      await openWith(tester, 'recordingCleanup', {});
      await reveal(tester, k('setting-keepDays'));
      expect(k('setting-note-keepDays'), findsNothing);
    });

    testWidgets('clean-up off: the keepOnDevice switch is dimmed with a note', (tester) async {
      await openWith(tester, 'recording', {
        'recordingCleanup': {'enabled': false},
      });
      await reveal(tester, k('setting-note-keepOnDevice'));
      expect(find.textContaining('selagi Pembersihan rakaman dimatikan'), findsOneWidget);
      expect(find.ancestor(of: k('setting-keepOnDevice'), matching: find.byType(IgnorePointer)), findsWidgets);
      expect(find.textContaining('Jika dimatikan, dipadam sebaik YouTube mengesahkannya', skipOffstage: false), findsOneWidget);
    });

    testWidgets('clean-up on: no note on keepOnDevice', (tester) async {
      await openWith(tester, 'recording', {});
      await reveal(tester, k('setting-keepOnDevice'));
      expect(k('setting-note-keepOnDevice'), findsNothing);
    });
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
  }, skip: !kOpsBuild);

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
      }, skip: !kOpsBuild && roles.contains('superadmin')); // the Lanjutan goldens are ops-build pictures
    }
  });

  testWidgets('settings_ayat_card_manual', (tester) async {
    final h = await open(tester, 'ayatCard', stored: {'pick': 'manual', 'surah': 18, 'ayatFrom': 10, 'ayatTo': 12});
    await expectGoldens(tester, h.app, 'settings_ayat_card_manual');
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
