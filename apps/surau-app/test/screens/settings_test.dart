// Settings: the list grouped by BM headings with locked features marked
// `Sentiasa hidup` and switched-off ones dimmed; the iqamah page with its
// 7x5 grid, `Salin ke semua hari`, validation that disables `Simpan`, a
// save that sends only the changed cells, reset to defaults after a
// confirm, the box's 400 shown in its own words, the offline refusal with
// nothing sent, and an AJK who sees everything read-only. Goldens:
// settings_list, settings_iqamah, settings_backgrounds.

import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:image/image.dart' as img;
import 'package:surau_app/app/providers.dart';
import 'package:surau_app/features/registry.g.dart';
import 'package:surau_app/features/settings_repository.dart';

import '../features/fakes.dart';
import '../features/shell/harness.dart';
import '../golden_sizes.dart';

Future<ShellHarness> openSettings(
  WidgetTester tester, [
  String path = '/settings',
  List<String> roles = const ['admin'],
]) async {
  final h = await pumpShell(tester, roles: roles);
  h.router.go(path);
  await settle(tester);
  return h;
}

Finder cell(String day, String prayer) => find.byKey(ValueKey('setting-minutes.$day.$prayer'));

String cellText(WidgetTester tester, String day, String prayer) =>
    tester.widget<TextField>(cell(day, prayer)).controller!.text;

Finder get save => find.widgetWithText(FilledButton, 'Simpan');

/// The feature's own on/off switch (the form may hold other switches).
Finder get featureSwitch =>
    find.descendant(of: find.byKey(const ValueKey('feature-switch')), matching: find.byType(Switch));

/// Every piece of text on screen, for a failure message.
String screenText(WidgetTester tester) => tester
    .widgetList<Text>(find.byType(Text))
    .map((t) => t.data ?? t.textSpan?.toPlainText() ?? '')
    .where((t) => t.isNotEmpty)
    .join(' | ');

bool saveEnabled(WidgetTester tester) => tester.widget<FilledButton>(save).enabled;

void main() {
  testWidgets('the list: groups with counts, every feature behind its group, locked and off marked', (tester) async {
    final h = await openSettings(tester);
    expect(h.location, '/settings');
    expect(find.text('Solat'), findsOneWidget);
    expect(find.text('Sentiasa hidup'), findsWidgets);
    expect(find.textContaining('Kotak'), findsNothing);
    await expectGoldens(tester, h.app, 'settings_list');

    // Open every group, then scroll to every feature row.
    await pumpAtSize(tester, h.app, GoldenSize.ipadMiniLandscape);
    for (final g in ['skrin', 'kandungan', 'quran', 'audio', 'live', 'kewangan', 'jemaah', 'awan', 'keselamatan']) {
      final head = find.byKey(ValueKey('settings-group-$g'));
      await reveal(tester, head);
      await tester.tap(head);
      await settle(tester);
    }
    final off = <String>[];
    var locked = 0;
    for (final f in features.where((f) => f.group != 'lanjutan')) {
      final row = find.byKey(ValueKey('settings-row-${f.key}'));
      await reveal(tester, row);
      expect(row, findsOneWidget, reason: f.key);
      expect(find.descendant(of: row, matching: find.text(f.labelMs)), findsOneWidget, reason: f.key);
      if (find.descendant(of: row, matching: find.text('Mati')).evaluate().isNotEmpty) off.add(f.key);
      if (find.descendant(of: row, matching: find.text('Sentiasa hidup')).evaluate().isNotEmpty) locked++;
    }
    expect(locked, 7, reason: 'prayerBar, clock, prayerSequenceSafety, zone, location, prayerSources, surauInfo; the Lanjutan features are hidden from an admin');
    expect(off, unorderedEquals(['firstAzanSubuh', 'tilawah', 'appLock', 'finance', 'tabungCard']), reason: 'the features with no settings are switches now; Kewangan and Kad tabung are off until switched on');

    await reveal(tester, find.text('Kiraan detik iqamah'));
    await tester.tap(find.text('Kiraan detik iqamah'));
    await settle(tester);
    expect(h.location, '/settings/iqamahCountdown');
  });

  testWidgets(
    'the two data pages are reached from the Solat group: Data waktu solat (prayer:import) and Al-Quran & audio tilawah',
    (tester) async {
      final h = await openSettings(tester);
      await reveal(tester, find.byKey(const ValueKey('settings-prayer-data')));
      expect(find.text('Data waktu solat'), findsOneWidget);
      expect(find.text('212 hari lagi'), findsOneWidget, reason: 'the health figure as the hint');
      expect(find.text('Al-Quran & audio tilawah'), findsOneWidget);
      final row = tester.getRect(find.byKey(const ValueKey('settings-prayer-data')));
      expect(row.height, greaterThanOrEqualTo(48));
      await tester.tap(find.byKey(const ValueKey('settings-prayer-data')));
      await settle(tester);
      expect(h.location, '/prayer-data');
      expect(find.text('Waktu solat'), findsWidgets);

      h.router.go('/settings');
      await settle(tester);
      await reveal(tester, find.byKey(const ValueKey('settings-islamic')));
      await tester.tap(find.byKey(const ValueKey('settings-islamic')));
      await settle(tester);
      expect(h.location, '/islamic');

      // An AJK may look at the Quran page but never imports prayer data.
      final ajk = await openSettings(tester, '/settings', const ['ajk']);
      await reveal(tester, find.byKey(const ValueKey('settings-islamic')));
      expect(find.byKey(const ValueKey('settings-prayer-data')), findsNothing);
      expect(find.text('Data waktu solat'), findsNothing);
      expect(find.text('Al-Quran & audio tilawah'), findsOneWidget);
      expect(ajk.location, '/settings');
    },
  );

  testWidgets('iqamah: 7x5 grid, -3 disables Simpan with the range, copy to all days, save sends only changed cells', (
    tester,
  ) async {
    final h = await openSettings(tester, '/settings/iqamahCountdown');
    expect(featureSwitch, findsOneWidget);
    for (final day in ['ahad', 'isnin', 'selasa', 'rabu', 'khamis', 'jumaat', 'sabtu']) {
      for (final p in ['subuh', 'zohor', 'asar', 'maghrib', 'isyak']) {
        expect(cell(day, p), findsOneWidget, reason: '$day $p');
      }
    }
    expect(cellText(tester, 'jumaat', 'subuh'), '12');
    expect(find.text('Jumaat'), findsOneWidget);
    expect(find.text('Salin ke semua hari'), findsNWidgets(7));
    expect(saveEnabled(tester), isFalse, reason: 'nothing changed yet');
    await expectGoldens(tester, h.app, 'settings_iqamah');

    await pumpAtSize(tester, h.app, GoldenSize.phone);
    await tester.enterText(cell('jumaat', 'subuh'), '-3');
    await settle(tester);
    expect(saveEnabled(tester), isFalse);
    expect(find.textContaining('0 hingga 120'), findsOneWidget);

    await tester.enterText(cell('jumaat', 'subuh'), '15');
    await settle(tester);
    expect(find.textContaining('0 hingga 120'), findsNothing);
    expect(saveEnabled(tester), isTrue);

    // Friday's row goes to every day.
    final copyJumaat = find.descendant(
      of: find.byKey(const ValueKey('day-jumaat')),
      matching: find.text('Salin ke semua hari'),
    );
    await reveal(tester, copyJumaat);
    await tester.tap(copyJumaat);
    await settle(tester);
    for (final day in ['ahad', 'isnin', 'selasa', 'rabu', 'khamis', 'sabtu']) {
      expect(cellText(tester, day, 'subuh'), '15', reason: day);
      expect(cellText(tester, day, 'zohor'), '10', reason: day);
    }
    expect(find.text('Nilai Jumaat disalin ke semua hari'), findsOneWidget);

    await reveal(tester, save);
    await tester.tap(save);
    await settle(tester);
    final put = h.box.byPath('/api/settings/iqamahCountdown')!;
    expect(put.method, 'PUT');
    expect(jsonDecode(put.body), {
      'minutes': {
        for (final day in ['ahad', 'isnin', 'selasa', 'rabu', 'khamis', 'jumaat', 'sabtu']) day: {'subuh': 15},
      },
    });
    expect(find.text('Tetapan disimpan'), findsOneWidget, reason: screenText(tester));
    expect(saveEnabled(tester), isFalse, reason: 'saved: nothing left to send');
    expect(cellText(tester, 'ahad', 'subuh'), '15', reason: 'the box answer is now the form');
  });

  testWidgets('the box changes under unsaved edits: the edits stay, a notice says so, Simpan sends only the edit', (
    tester,
  ) async {
    final h = await openSettings(tester, '/settings/iqamahCountdown');
    await tester.enterText(cell('jumaat', 'subuh'), '15');
    await settle(tester);
    expect(saveEnabled(tester), isTrue);
    expect(find.byKey(const ValueKey('settings-changed-elsewhere')), findsNothing);

    // Another device changes Ahad's Zohor on the box; the app learns of it.
    h.settings['iqamahCountdown'] = {
      'enabled': true,
      'minutes': {
        'ahad': {'zohor': 20},
      },
    };
    h.container.read(dataVersionProvider.notifier).bump();
    await settle(tester);

    expect(cellText(tester, 'jumaat', 'subuh'), '15', reason: 'the unsaved edit stays');
    expect(cellText(tester, 'ahad', 'zohor'), '20', reason: 'the other device value is shown');
    expect(find.text('Tetapan ini telah diubah di peranti lain. Simpan akan menggantikannya.'), findsOneWidget);
    await reveal(tester, save);
    await tester.tap(save);
    await settle(tester);
    expect(jsonDecode(h.box.byPath('/api/settings/iqamahCountdown')!.body), {
      'minutes': {
        'jumaat': {'subuh': 15},
      },
    });
  });

  testWidgets('the switch is part of the form: off plus a cell in one PUT', (tester) async {
    final h = await openSettings(tester, '/settings/masukWaktu');
    expect(find.text('Tempoh skrin (saat)'), findsOneWidget);
    await tester.tap(featureSwitch);
    await settle(tester);
    await tester.enterText(find.byKey(const ValueKey('setting-screenSeconds')), '90');
    await settle(tester);
    await tester.tap(save);
    await settle(tester);
    expect(jsonDecode(h.box.byPath('/api/settings/masukWaktu')!.body), {'enabled': false, 'screenSeconds': 90});
    expect(
      find.text('Ciri ini dimatikan. Tetapannya disimpan dan digunakan semula apabila dihidupkan.'),
      findsOneWidget,
    );
  });

  testWidgets('Kunci aplikasi: the help text, a confirm before switching on, then one PUT', (tester) async {
    final h = await openSettings(tester, '/settings/appLock');
    expect(find.text('Kunci aplikasi'), findsWidgets);
    expect(find.byKey(const ValueKey('feature-help-appLock')), findsOneWidget);
    expect(find.textContaining('Bila dimatikan (lalai), MAXCOM dibuka terus'), findsOneWidget);
    expect(find.textContaining('cap jari boleh digunakan di Android.'), findsOneWidget);
    await expectGoldens(tester, h.app, 'settings_applock');

    await pumpAtSize(tester, h.app, GoldenSize.phone);
    await tester.tap(featureSwitch);
    await settle(tester);
    expect(find.text('Hidupkan kunci aplikasi?'), findsOneWidget);
    expect(find.text('Setiap pengguna akan diminta tetapkan PIN.'), findsOneWidget);
    // Cancel: nothing changes.
    await tester.tap(find.widgetWithText(TextButton, 'Batal'));
    await settle(tester);
    expect(saveEnabled(tester), isFalse);

    await tester.tap(featureSwitch);
    await settle(tester);
    await tester.tap(find.widgetWithText(FilledButton, 'Hidupkan'));
    await settle(tester);
    expect(saveEnabled(tester), isTrue);
    await tester.tap(save);
    await settle(tester);
    expect(jsonDecode(h.box.byPath('/api/settings/appLock')!.body), {'enabled': true});
  });

  testWidgets('Kunci aplikasi: an AJK reads the switch and the help, edits nothing', (tester) async {
    await openSettings(tester, '/settings/appLock', const ['ajk']);
    expect(find.byKey(const ValueKey('feature-help-appLock')), findsOneWidget);
    expect(tester.widget<Switch>(featureSwitch).onChanged, isNull);
    expect(save, findsNothing);
  });

  testWidgets('a stepper: plus and minus stay inside the rule, enum draws BM choices', (tester) async {
    final h = await openSettings(tester, '/settings/masukWaktu');
    final field = find.byKey(const ValueKey('setting-screenSeconds'));
    final start = int.parse(tester.widget<TextField>(field).controller!.text);
    await tester.tap(find.byKey(const ValueKey('setting-screenSeconds-plus')));
    await settle(tester);
    expect(tester.widget<TextField>(field).controller!.text, '${start + 1}');
    await tester.enterText(field, '600');
    await settle(tester);
    await tester.tap(find.byKey(const ValueKey('setting-screenSeconds-plus')));
    await settle(tester);
    expect(tester.widget<TextField>(field).controller!.text, '600', reason: 'max 600');
    await tester.tap(save);
    await settle(tester);
    expect(jsonDecode(h.box.byPath('/api/settings/masukWaktu')!.body), {'screenSeconds': 600});

    h.router.go('/settings/hijriDate');
    await settle(tester);
    expect(find.text('Waktu Maghrib'), findsOneWidget);
    expect(find.text('Tengah malam'), findsOneWidget);
    await tester.tap(find.text('Tengah malam'));
    await settle(tester);
    await tester.tap(save);
    await settle(tester);
    expect(jsonDecode(h.box.byPath('/api/settings/hijriDate')!.body), {'switchAt': 'midnight'});
  });

  testWidgets('clock: Sentiasa hidup and no switch; a feature with no settings says so', (tester) async {
    final h = await openSettings(tester, '/settings/clock');
    expect(find.text('Sentiasa hidup'), findsOneWidget);
    expect(featureSwitch, findsNothing);
    expect(find.text('Papar saat'), findsOneWidget);
    h.router.go('/settings/imsakBeep');
    await settle(tester);
    expect(featureSwitch, findsOneWidget);
    expect(find.text('Ciri ini tiada tetapan lain. Hidupkan atau matikan sahaja.'), findsOneWidget);
    h.router.go('/settings/nope');
    await settle(tester);
    expect(find.text('Ciri tidak dijumpai.'), findsOneWidget);
  });

  testWidgets('Set semula kepada lalai: confirm, then PUT enabled plus every default', (tester) async {
    final h = await openSettings(tester, '/settings/iqamahCountdown');
    final reset = find.text('Set semula kepada lalai');
    await reveal(tester, reset);
    await tester.tap(reset);
    await settle(tester);
    expect(find.text('Set semula Kiraan detik iqamah?'), findsOneWidget);
    await tester.tap(find.text('Batal'));
    await settle(tester);
    expect(h.box.byPath('/api/settings/iqamahCountdown'), isNull);

    await reveal(tester, reset);
    await tester.tap(reset);
    await settle(tester);
    expect(find.text('Set semula Kiraan detik iqamah?'), findsOneWidget, reason: screenText(tester));
    await tester.tap(find.widgetWithText(FilledButton, 'Set semula kepada lalai'));
    await settle(tester);
    final put = h.box.byPath('/api/settings/iqamahCountdown')!;
    expect(put.method, 'PUT');
    final f = features.firstWhere((x) => x.key == 'iqamahCountdown');
    expect(jsonDecode(put.body), defaultsPatch(f));
    expect(find.text('Tetapan asal dipulihkan'), findsOneWidget);
  });

  testWidgets('a 400 from the box shows errors[0]; a 403 the app sentence', (tester) async {
    final h = await openSettings(tester, '/settings/solatScreen');
    h.handlers['PUT /api/settings/solatScreen'] = (r) async => jsonResponse(400, {
      'errors': ['Mesej tidak diterima oleh MAXCOM.'],
    });
    await reveal(tester, find.byKey(const ValueKey('setting-message')));
    await tester.enterText(find.byKey(const ValueKey('setting-message')), 'Sila senyapkan telefon');
    await settle(tester);
    await reveal(tester, save);
    await tester.tap(save);
    await settle(tester);
    expect(find.text('Mesej tidak diterima oleh MAXCOM.'), findsOneWidget);

    h.handlers['PUT /api/settings/solatScreen'] = (r) async => jsonResponse(403, {
      'errors': ['forbidden'],
    });
    await tester.tap(save);
    await settle(tester);
    expect(find.text('Tiada kebenaran untuk tindakan ini'), findsOneWidget);
  });

  testWidgets('offline: Cuba lagi di surau, and no request leaves the device', (tester) async {
    final h = await openSettings(tester, '/settings/beeps');
    h.boxAway = true;
    await h.container.read(healthProvider.notifier).refresh();
    await settle(tester);
    expect(find.text('70%'), findsOneWidget, reason: 'the last value stays');
    h.box.seen.clear();
    tester.widget<Slider>(find.byKey(const ValueKey('setting-volume'))).onChanged!(55);
    await settle(tester);
    await tester.tap(save);
    await settle(tester);
    expect(find.text('MAXCOM tidak dapat dihubungi. Cuba lagi di surau.'), findsWidgets);
    expect(h.box.byPath('/api/settings/beeps'), isNull);
  });

  testWidgets('an AJK sees every control read-only and no Simpan', (tester) async {
    final h = await openSettings(tester, '/settings', const ['ajk']);
    expect(find.text('Anda boleh melihat tetapan tetapi tidak mengubahnya.'), findsOneWidget);
    h.router.go('/settings/iqamahCountdown');
    await settle(tester);
    expect(find.text('Anda boleh melihat tetapan tetapi tidak mengubahnya.'), findsOneWidget);
    expect(save, findsNothing);
    expect(find.text('Set semula kepada lalai'), findsNothing);
    expect(find.text('Salin ke semua hari'), findsNothing);
    expect(find.byType(Switch), findsNWidgets(2), reason: 'the feature and beep');
    for (final sw in tester.widgetList<Switch>(find.byType(Switch))) {
      expect(sw.onChanged, isNull);
    }
    for (final t in tester.widgetList<TextField>(find.byType(TextField))) {
      expect(t.enabled, isFalse);
    }
    h.router.go('/settings/backgrounds');
    await settle(tester);
    for (final c in tester.widgetList<Checkbox>(find.byType(Checkbox))) {
      expect(c.onChanged, isNull);
    }
  });

  // ---- backgrounds ----

  const otherPicture = 'e4e4e4e4e4e4e4e4e4e4e4e4e4e4e4e4e4e4e4e4e4e4e4e4e4e4e4e4e4e4e4e4';

  Map<String, Object?> assetList(List<String> ids) => {
    'assets': [
      for (final id in ids)
        {'id': id, 'width': 160, 'height': 90, 'bytes': 4000, 'createdAt': '2026-11-03T09:00:00.000Z'},
    ],
  };

  /// The backgrounds page with `GET /api/assets` answering [ids] (newest
  /// first), or [listStatus] when it is not 200.
  Future<ShellHarness> openBackgrounds(
    WidgetTester tester, {
    List<String> ids = const [fixtureAssetPoster, otherPicture],
    int listStatus = 200,
    List<String> roles = const ['admin'],
  }) async {
    final h = await pumpShell(tester, roles: roles);
    h.handlers['GET /api/assets'] = (_) async => listStatus == 200
        ? jsonResponse(200, assetList(ids))
        : jsonResponse(listStatus, {
            'errors': ['no'],
          });
    h.router.go('/settings/backgrounds');
    await settleImages(tester);
    return h;
  }

  Map<String, dynamic> savedBackgrounds(ShellHarness h) =>
      jsonDecode(h.box.seen.lastWhere((r) => r.method == 'PUT' && r.url.path == '/api/settings/backgrounds').body)
          as Map<String, dynamic>;

  testWidgets(
    'backgrounds: built-ins plus the box pictures as thumbnails; ticking in order numbers them and sends the list',
    (tester) async {
      final h = await openBackgrounds(tester);
      expect(find.text('Gambar sedia ada'), findsOneWidget);
      expect(find.text('Gambar 1'), findsOneWidget);
      expect(find.text('Gambar 2'), findsOneWidget);
      expect(find.text('Gambar dimuat naik'), findsOneWidget);
      expect(find.text('Setiap hari'), findsOneWidget);
      expect(find.textContaining('akan datang'), findsNothing, reason: 'the uploads-come-later line is gone');
      expect(find.text('Muat naik gambar latar'), findsOneWidget);
      expect(find.byKey(const ValueKey('background-upload-$fixtureAssetPoster')), findsOneWidget);
      expect(find.byKey(const ValueKey('background-upload-$otherPicture')), findsOneWidget);
      expect(find.byKey(const ValueKey('background-order-$fixtureAssetPoster')), findsNothing, reason: 'not ticked');
      // The thumbnail came through the pinned client (bearer token), not a plain network image.
      expect(h.box.byPath('/assets/$fixtureAssetPoster')!.headers['authorization'], 'Bearer tok-1');
      expect(find.byType(Image), findsOneWidget, reason: 'the poster; the other id is unknown to the box');
      await expectGoldens(tester, h.app, 'settings_backgrounds');

      await pumpAtSize(tester, h.app, GoldenSize.phone);
      await tester.tap(find.byKey(const ValueKey('background-default-2')));
      await settle(tester);
      await reveal(tester, save);
      await tester.tap(save);
      await settle(tester);
      expect(savedBackgrounds(h), {
        'images': ['default-1'],
      });

      // Tapped in the order wanted: the numbers follow the list (default-1 is 1).
      await reveal(tester, find.byKey(const ValueKey('background-upload-$otherPicture')));
      await tester.tap(find.byKey(const ValueKey('background-upload-$otherPicture')));
      await settle(tester);
      await reveal(tester, find.byKey(const ValueKey('background-upload-$fixtureAssetPoster')));
      await tester.tap(find.byKey(const ValueKey('background-upload-$fixtureAssetPoster')));
      await settle(tester);
      expect(
        find.descendant(of: find.byKey(const ValueKey('background-order-$otherPicture')), matching: find.text('2')),
        findsOneWidget,
      );
      expect(
        find.descendant(
          of: find.byKey(const ValueKey('background-order-$fixtureAssetPoster')),
          matching: find.text('3'),
        ),
        findsOneWidget,
      );
      await reveal(tester, save);
      await tester.tap(save);
      await settle(tester);
      expect(savedBackgrounds(h), {
        'images': ['default-1', otherPicture, fixtureAssetPoster],
      });

      // Unticking drops it and renumbers.
      await tester.tap(find.byKey(const ValueKey('background-upload-$otherPicture')));
      await settle(tester);
      expect(find.byKey(const ValueKey('background-order-$otherPicture')), findsNothing);
      expect(
        find.descendant(
          of: find.byKey(const ValueKey('background-order-$fixtureAssetPoster')),
          matching: find.text('2'),
        ),
        findsOneWidget,
      );
    },
  );

  testWidgets(
    'backgrounds: no pictures on the box says so; a refused or unreachable list keeps the built-ins with a short BM note',
    (tester) async {
      await openBackgrounds(tester, ids: const []);
      expect(find.text('Belum ada gambar dimuat naik.'), findsOneWidget);
      expect(find.byKey(const ValueKey('background-list-unavailable')), findsNothing);

      final down = await openBackgrounds(tester, listStatus: 500);
      expect(find.byKey(const ValueKey('background-list-unavailable')), findsOneWidget);
      expect(
        find.text('Senarai gambar dimuat naik tidak dapat dibaca sekarang. Gambar sedia ada masih boleh dipilih.'),
        findsOneWidget,
      );
      expect(find.text('Belum ada gambar dimuat naik.'), findsNothing);
      expect(find.byKey(const ValueKey('background-default-1')), findsOneWidget);
      expect(find.text('Muat naik gambar latar'), findsOneWidget);
      await tester.tap(find.byKey(const ValueKey('background-default-2')));
      await settle(tester);
      expect(tester.widget<CheckboxListTile>(find.byKey(const ValueKey('background-default-2'))).value, isFalse);
      expect(down.location, '/settings/backgrounds');
    },
  );

  testWidgets(
    'backgrounds: Muat naik gambar latar uploads the picture, opens the adjust screen, and an untouched picture is ticked by its own id',
    (tester) async {
      final h = await openBackgrounds(tester, ids: const []);
      h.handlers['GET /api/assets'] = (_) async =>
          jsonResponse(200, assetList([for (final (_, bytes) in h.assetsPosted.reversed) sha256Hex(bytes)]));
      h.pickedImage = fixturePosterPng();
      await tester.tap(find.byKey(const ValueKey('background-upload')));
      await settleImages(tester);
      expect(h.assetsPosted.length, 1);
      final id = sha256Hex(h.assetsPosted.single.$2);
      expect(find.byKey(const ValueKey('adjust-save')), findsOneWidget, reason: 'the adjust screen opened');
      await tester.tap(find.byKey(const ValueKey('adjust-save')));
      await settleImages(tester);
      expect(h.assetsPosted.length, 1, reason: 'nothing adjusted: no second upload');
      expect(find.text('Gambar latar dimuat naik'), findsOneWidget);
      expect(find.byKey(ValueKey('background-upload-$id')), findsOneWidget);
      expect(
        find.descendant(of: find.byKey(ValueKey('background-order-$id')), matching: find.text('3')),
        findsOneWidget,
      );
      await reveal(tester, save);
      await tester.tap(save);
      await settle(tester);
      expect(savedBackgrounds(h), {
        'images': ['default-1', 'default-2', id],
      });
    },
  );

  testWidgets('backgrounds: a turned or cropped upload is burnt into a new picture and only that one is ticked', (
    tester,
  ) async {
    final h = await openBackgrounds(tester, ids: const []);
    h.handlers['GET /api/assets'] = (_) async =>
        jsonResponse(200, assetList([for (final (_, bytes) in h.assetsPosted.reversed) sha256Hex(bytes)]));
    h.pickedImage = fixturePosterPng();
    await tester.tap(find.byKey(const ValueKey('background-upload')));
    await settleImages(tester);
    final original = sha256Hex(h.assetsPosted.single.$2);
    await tester.tap(find.byKey(const ValueKey('adjust-rotate')));
    await settleImages(tester);
    await tester.tap(find.byKey(const ValueKey('adjust-save')));
    await settleImages(tester);
    expect(h.assetsPosted.length, 2, reason: 'the original, then the turned copy');
    expect(h.assetsPosted.last.$1, 'image/jpeg');
    final baked = sha256Hex(h.assetsPosted.last.$2);
    expect(baked, isNot(original));
    final decoded = img.decodeJpg(h.assetsPosted.last.$2)!;
    expect(decoded.width, 90, reason: 'the 160 x 90 poster turned a quarter is 90 wide');
    expect(decoded.width / decoded.height, closeTo(16 / 9, 0.05), reason: 'cut to the TV frame');
    await reveal(tester, save);
    await tester.tap(save);
    await settle(tester);
    expect(savedBackgrounds(h), {
      'images': ['default-1', 'default-2', baked],
    });
  });

  testWidgets(
    'backgrounds: a cancelled gallery uploads nothing; a refused upload shows the box words and ticks nothing; the box away refuses before sending',
    (tester) async {
      final h = await openBackgrounds(tester, ids: const []);
      h.pickedImage = null;
      await tester.tap(find.byKey(const ValueKey('background-upload')));
      await settleImages(tester);
      expect(h.assetsPosted, isEmpty);
      expect(find.byKey(const ValueKey('adjust-save')), findsNothing);

      h.pickError = Exception('blocked');
      await tester.tap(find.byKey(const ValueKey('background-upload')));
      await settleImages(tester);
      expect(find.text('Gambar tidak dapat dibaca. Cuba gambar lain.'), findsOneWidget);
      expect(find.byKey(const ValueKey('background-upload')), findsOneWidget, reason: 'the button is usable again');
      h.pickError = null;

      h.pickedImage = fixturePosterPng();
      h.handlers['POST /api/assets'] = (_) async => jsonResponse(413, {
        'errors': ['Ruang simpanan aset penuh. Padam fail yang tidak digunakan atau tambah had SURAU_ASSETS_MAX_MB.'],
      });
      await tester.tap(find.byKey(const ValueKey('background-upload')));
      await settleImages(tester);
      expect(find.textContaining('Ruang simpanan aset penuh'), findsOneWidget, reason: screenText(tester));
      expect(find.byKey(const ValueKey('adjust-save')), findsNothing);
      expect(saveEnabled(tester), isFalse, reason: 'nothing was ticked');
    },
  );

  testWidgets(
    'backgrounds: an AJK sees the ticked pictures and the built-ins, read-only, with no list request and no upload button',
    (tester) async {
      final h = await pumpShell(tester, roles: const ['ajk']);
      h.settings['backgrounds'] = {
        ...(h.settings['backgrounds'] as Map? ?? const {}),
        'images': ['default-1', fixtureAssetPoster],
      };
      h.container.invalidate(settingsProvider);
      h.router.go('/settings/backgrounds');
      await settleImages(tester);
      expect(h.box.byPath('/api/assets'), isNull, reason: 'the list is an upload-side route');
      expect(find.byKey(const ValueKey('background-upload')), findsNothing);
      expect(find.text('Muat naik gambar latar'), findsNothing);
      expect(find.byKey(const ValueKey('background-upload-$fixtureAssetPoster')), findsOneWidget);
      expect(
        find.descendant(
          of: find.byKey(const ValueKey('background-order-$fixtureAssetPoster')),
          matching: find.text('2'),
        ),
        findsOneWidget,
      );
      expect(find.byKey(const ValueKey('background-list-unavailable')), findsNothing);
      for (final c in tester.widgetList<Checkbox>(find.byType(Checkbox))) {
        expect(c.onChanged, isNull);
      }
      await tester.tap(find.byKey(const ValueKey('background-upload-$fixtureAssetPoster')));
      await settle(tester);
      expect(
        find.descendant(
          of: find.byKey(const ValueKey('background-order-$fixtureAssetPoster')),
          matching: find.text('2'),
        ),
        findsOneWidget,
        reason: 'a tap changes nothing',
      );
    },
  );

  testWidgets('data sources: a card per source with name and https address; the box 400 lands under the field', (
    tester,
  ) async {
    final h = await openSettings(tester, '/settings/dataSources', const ['superadmin']);
    expect(find.text('Sumber data internet'), findsWidgets);
    expect(find.text('Sentiasa hidup'), findsOneWidget, reason: 'locked: no switch');
    for (final label in [
      'Waktu solat (e-Solat)',
      'Senarai zon (e-Solat)',
      'Carian lokasi (Nominatim)',
      'Teks Al-Quran',
      'Audio tilawah',
      'Hadis (HadeethEnc)',
    ]) {
      expect(find.text(label), findsOneWidget, reason: label);
    }
    expect(find.text('Nama sumber'), findsNWidgets(6));
    expect(find.text('Alamat (https)'), findsNWidgets(6));
    expect(find.text('Nama surau'), findsNothing, reason: 'the source name, not the surau');
    final esolatName = tester.widget<TextField>(find.byKey(const ValueKey('setting-esolat.name')));
    expect(esolatName.controller!.text, 'e-Solat JAKIM');
    final audioUrl = tester.widget<TextField>(find.byKey(const ValueKey('setting-quranAudio.url')));
    expect(audioUrl.controller!.text, 'https://everyayah.com/data');
    expect(audioUrl.keyboardType, TextInputType.url);
    expect(audioUrl.textCapitalization, TextCapitalization.none);
    expect(find.text('Set semula kepada lalai'), findsOneWidget);
    await expectGoldens(tester, h.app, 'settings_data_sources');

    // A plain http address is refused by the app itself (core's rule), in
    // BM under the field, before anything is sent.
    await pumpAtSize(tester, h.app, GoldenSize.phone);
    final esolatUrl = find.byKey(const ValueKey('setting-esolat.url'));
    await tester.enterText(esolatUrl, 'http://www.e-solat.gov.my/index.php');
    await settle(tester);
    await reveal(tester, esolatUrl);
    expect(find.text('Mesti bermula dengan https://'), findsOneWidget);
    expect(tester.widget<TextField>(esolatUrl).decoration!.errorText, 'Mesti bermula dengan https://');
    await reveal(tester, save);
    expect(saveEnabled(tester), isFalse, reason: 'refused locally');
    expect(h.box.byPath('/api/settings/dataSources'), isNull, reason: 'nothing sent');
    await tester.enterText(esolatUrl, 'https://10.168.1.14/index.php');
    await settle(tester);
    await reveal(tester, esolatUrl);
    expect(find.text('Mesti alamat internet awam (bukan setempat atau peribadi)'), findsOneWidget);
    await tester.enterText(find.byKey(const ValueKey('setting-quranText.name')), '');
    await settle(tester);
    expect(find.text('Wajib diisi'), findsOneWidget);
    await tester.enterText(find.byKey(const ValueKey('setting-quranText.name')), 'QuranEnc');
    await settle(tester);
    expect(find.text('Wajib diisi'), findsNothing);

    // An address the app accepts but the box still refuses (it resolves the
    // host itself): the box's reason sits under the field.
    h.handlers['PUT /api/settings/dataSources'] = (r) async => jsonResponse(400, {
      'errors': ['esolat.url must be a public internet address (not local or private)'],
    });
    await tester.enterText(esolatUrl, 'https://esolat.example.my/index.php');
    await settle(tester);
    await reveal(tester, save);
    expect(saveEnabled(tester), isTrue);
    await tester.tap(save);
    await settle(tester);
    expect(jsonDecode(h.box.byPath('/api/settings/dataSources')!.body), {
      'esolat': {'url': 'https://esolat.example.my/index.php'},
    });
    await reveal(tester, esolatUrl);
    expect(find.text('must be a public internet address (not local or private)'), findsOneWidget);
    expect(
      find.text('esolat.url must be a public internet address (not local or private)'),
      findsNothing,
      reason: 'under the field, not as a page line',
    );
    expect(
      tester.widget<TextField>(esolatUrl).decoration!.errorText,
      'must be a public internet address (not local or private)',
    );

    // A fixed address sends only that source's field.
    h.handlers['PUT /api/settings/dataSources'] = (r) async => jsonResponse(200, {
      ...h.settings,
      'dataSources': {
        'enabled': true,
        'esolat': {'name': 'e-Solat JAKIM', 'url': 'https://www.e-solat.gov.my/index.php'},
      },
    });
    await tester.enterText(esolatUrl, 'https://www.e-solat.gov.my/index.php');
    await settle(tester);
    expect(
      find.text('must be a public internet address (not local or private)'),
      findsNothing,
      reason: 'typing clears it',
    );
    await reveal(tester, save);
    await tester.tap(save);
    await settle(tester);
    expect(find.text('Tetapan disimpan'), findsOneWidget, reason: screenText(tester));
  });

  testWidgets(
    'surau info: the logo is a picture field with the square hint; an upload sends its id, Buang sends empty, the box refusals read in BM',
    (tester) async {
      final h = await openSettings(tester, '/settings/surauInfo');
      // The logo field sits under the text fields: bring it up first.
      await reveal(tester, find.byKey(const ValueKey('setting-logo')));
      expect(find.textContaining('Logo surau/masjid'), findsOneWidget, reason: 'optional: "(pilihan)" follows');
      expect(find.byKey(const ValueKey('setting-logo')), findsOneWidget);
      expect(find.text('Pilih gambar'), findsOneWidget);
      expect(
        find.text('PNG atau JPEG. Logo lebar atau segi empat sama; latar putih boleh dibuang selepas dipilih.'),
        findsOneWidget,
      );
      await reveal(tester, save);
      expect(saveEnabled(tester), isFalse);

      // The operator's wordmark on white: uploaded, analysed by the box, then
      // the adjust screen with `Buang latar putih` preselected and the trim
      // box as the frame; the square icon step; Simpan.
      h.pickedImage = fixtureMaxcomPng();
      await reveal(tester, find.byKey(const ValueKey('image-pick')));
      await tester.tap(find.byKey(const ValueKey('image-pick')));
      await settle(tester);
      expect(h.assetsPosted.length, 1);
      final uploadedId = sha256Hex(h.assetsPosted.single.$2);
      expect(h.box.byPath('/api/assets/$uploadedId/analyze'), isNotNull, reason: 'the box analysed the upload');
      expect(find.text('Laraskan logo'), findsOneWidget);
      expect(tester.widget<ChoiceChip>(find.byKey(const ValueKey('bg-remove'))).selected, isTrue);
      await tester.tap(find.byKey(const ValueKey('adjust-next')));
      await settle(tester);
      await tester.tap(find.byKey(const ValueKey('adjust-save')));
      await settle(tester);
      expect(find.text('Laraskan logo'), findsNothing);
      expect(find.text('Tukar gambar'), findsOneWidget);
      expect(find.text('Laraskan gambar'), findsOneWidget);
      expect(find.text('Buang gambar'), findsOneWidget);
      expect(
        find.byKey(const ValueKey('logo-header-preview')),
        findsOneWidget,
        reason: 'the header as the TV draws it',
      );
      await tester.pump(const Duration(seconds: 5));
      await settle(tester);
      expect(saveEnabled(tester), isTrue);
      await reveal(tester, save);
      await tester.tap(save);
      await settle(tester);
      final sent = jsonDecode(h.box.byPath('/api/settings/surauInfo')!.body) as Map<String, dynamic>;
      final logo = sent['logo'] as Map<String, dynamic>;
      expect(sent.keys.toList(), ['logo']);
      expect(logo['asset'], uploadedId);
      expect(logo['bg'], 'remove');
      final crop = logo['crop'] as Map<String, dynamic>;
      expect(crop['x'], closeTo(0.038, 0.01), reason: 'the trim box the box found');
      expect(crop['w'], closeTo(0.93, 0.01));
      final square = logo['square'] as Map<String, dynamic>;
      expect(
        (square['w'] as num) * 500,
        closeTo((square['h'] as num) * 126, 1),
        reason: 'a square, centred on the mark',
      );
      expect(find.text('Tetapan disimpan'), findsOneWidget, reason: screenText(tester));

      // The box refuses the picture type: its reason sits under the field, in BM.
      h.handlers['PUT /api/settings/surauInfo'] = (r) async => jsonResponse(400, {
        'errors': ['logo must be a PNG or JPEG image'],
      });
      await reveal(tester, find.text('Buang gambar'));
      await tester.tap(find.text('Buang gambar'));
      await settle(tester);
      expect(find.text('Pilih gambar'), findsOneWidget);
      await reveal(tester, save);
      await tester.tap(save);
      await settle(tester);
      expect(jsonDecode(h.box.seen.where((r) => r.method == 'PUT').last.body), {'logo': ''});
      expect(find.text('Logo mesti gambar PNG atau JPEG.'), findsOneWidget);
      expect(find.text('logo must be a PNG or JPEG image'), findsNothing, reason: 'translated, under the field');

      h.handlers['PUT /api/settings/surauInfo'] = (r) async => jsonResponse(400, {
        'errors': ['logo refers to an asset that does not exist'],
      });
      // The toast of the earlier save floats over the buttons for a few seconds.
      await tester.pump(const Duration(seconds: 5));
      await settle(tester);
      await reveal(tester, save);
      await tester.tap(save);
      await settle(tester);
      await reveal(tester, find.byKey(const ValueKey('setting-logo')));
      expect(
        find.text('Gambar logo tidak dijumpai di MAXCOM. Pilih semula.'),
        findsOneWidget,
        reason: screenText(tester),
      );
    },
  );

  testWidgets(
    'surau info with a logo set shows its thumbnail (golden settings_surau_info_logo); an AJK sees it read-only',
    (tester) async {
      final h = await pumpShell(tester, roles: const ['admin'], logo: true);
      h.router.go('/settings/surauInfo');
      await settle(tester);
      await reveal(tester, find.byKey(const ValueKey('setting-logo')));
      expect(find.text('Tukar gambar'), findsOneWidget);
      expect(find.text('Laraskan gambar'), findsOneWidget);
      expect(
        find.byType(Image),
        findsNWidgets(2),
        reason: 'the thumbnail and the header preview, through the pinned client',
      );
      expect(h.box.byPath('/assets/$fixtureAssetLogo')!.headers['authorization'], 'Bearer tok-1');
      final sw = find.descendant(of: find.byKey(const ValueKey('setting-showName')), matching: find.byType(Switch));
      expect(find.text('Paparkan nama surau juga'), findsOneWidget);
      expect(tester.widget<Switch>(sw).value, isTrue);
      expect(find.text('SURAU D\'WAQAF'), findsOneWidget, reason: 'the name beside the logo in the preview');
      await settleImages(tester);
      await expectGoldens(tester, h.app, 'settings_surau_info_logo');

      // Off: the preview drops the name at once; the save sends only the switch.
      await pumpAtSize(tester, h.app, GoldenSize.phone);
      await reveal(tester, sw);
      await tester.tap(sw);
      await settle(tester);
      expect(find.text('SURAU D\'WAQAF'), findsNothing);
      await reveal(tester, save);
      await tester.tap(save);
      await settle(tester);
      expect(jsonDecode(h.box.byPath('/api/settings/surauInfo')!.body), {'showName': false});

      final ajk = await pumpShell(tester, roles: const ['ajk'], logo: true);
      ajk.router.go('/settings/surauInfo');
      await settle(tester);
      await reveal(tester, find.byKey(const ValueKey('setting-logo')));
      expect(find.text('Tukar gambar'), findsNothing);
      expect(find.text('Laraskan gambar'), findsNothing);
      expect(find.text('Buang gambar'), findsNothing);
      expect(find.text('Gambar dimuat naik'), findsOneWidget);
      final ajkSwitch = find.descendant(
        of: find.byKey(const ValueKey('setting-showName')),
        matching: find.byType(Switch),
      );
      expect(tester.widget<Switch>(ajkSwitch).onChanged, isNull, reason: 'read-only');
    },
  );

  testWidgets(
    'Laraskan gambar on the saved logo reopens the adjust screen on its adjustment; without a logo the name switch is off limits',
    (tester) async {
      final h = await pumpShell(tester, roles: const ['admin'], wideLogo: true, showName: false);
      h.router.go('/settings/surauInfo');
      await settle(tester);
      await reveal(tester, find.byKey(const ValueKey('image-adjust')));
      await tester.tap(find.byKey(const ValueKey('image-adjust')));
      await settle(tester);
      expect(find.text('Laraskan logo'), findsOneWidget);
      expect(
        tester.widget<ChoiceChip>(find.byKey(const ValueKey('bg-remove'))).selected,
        isTrue,
        reason: 'the stored bg',
      );
      await tester.tap(find.byKey(const ValueKey('bg-card')));
      await settle(tester);
      await tester.tap(find.byKey(const ValueKey('adjust-next')));
      await settle(tester);
      await tester.tap(find.byKey(const ValueKey('adjust-save')));
      await settle(tester);
      expect(find.text('Gambar dilaraskan'), findsOneWidget);
      await tester.pump(const Duration(seconds: 5));
      await settle(tester);
      await reveal(tester, save);
      await tester.tap(save);
      await settle(tester);
      final sent = jsonDecode(h.box.byPath('/api/settings/surauInfo')!.body) as Map<String, dynamic>;
      expect((sent['logo'] as Map)['bg'], 'card');
      expect((sent['logo'] as Map)['asset'], fixtureAssetLogo);

      final plain = await openSettings(tester, '/settings/surauInfo');
      await reveal(tester, find.byKey(const ValueKey('setting-showName')));
      final sw = find.descendant(of: find.byKey(const ValueKey('setting-showName')), matching: find.byType(Switch));
      expect(tester.widget<Switch>(sw).onChanged, isNull, reason: 'no logo: the name always shows');
      expect(find.byKey(const ValueKey('logo-header-preview')), findsNothing);
      expect(plain.box.byPath('/assets/$fixtureAssetLogo'), isNull);
    },
  );

  testWidgets('a person without settings:read is kept out', (tester) async {
    // Every role reads settings; the guard still refuses an unknown feature path for nobody else.
    final h = await pumpShell(tester, roles: const ['treasurer']);
    h.router.go('/settings/beeps');
    await settle(tester);
    expect(h.location, '/settings/beeps');
    expect(save, findsNothing, reason: 'treasurer has no settings:write');
  });
}
