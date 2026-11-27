// The backup lines of the main box's row on "Skrin TV dan MAXCOM Kiosk Box": the backup before the link with "Buang
// sandaran" (PIN sheet, typed word, the sentence about the date) and "Kembali ke data sebelum dipautkan" (only with no
// follower), the data kept after an unlink with "Buang data lama", and every refusal code worded in the language.
// Goldens: the list with the lines in BM, English and Arabic, and the sheet of the drop.

import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:surau_app/app/app_lang.dart';
import 'package:surau_app/app/providers.dart';
import 'package:surau_app/features/link/link_controller.dart';
import 'package:surau_app/features/live/fake_publisher.dart';
import 'package:surau_app/features/live/live_screen.dart' show livePublisherProvider;

import '../../golden_sizes.dart';
import '../fakes.dart';
import '../shell/harness.dart';

Map<String, Object?> backupJson() => {
  'linkId': 'l' * 32,
  'kind': 'set-aside',
  'at': '2026-11-02T01:45:00.000Z',
  'bytes': 1932735283,
  'files': 412,
};

Map<String, Object?> keptJson() => {
  'linkId': 'k' * 32,
  'at': '2026-11-03T02:00:00.000Z',
  'bytes': 734003200,
  'until': '2026-11-10T02:00:00.000Z',
};

Map<String, Object?> boxesBody({Object? backup, Object? kept, bool follower = false}) => {
  'self': {
    'boxId': 'a1a1a1a1a1a1a1a1',
    'name': 'Dewan Utama',
    'keyFp': 'a1a1a1a1a1a1a1a1',
    'version': '2026.11.14',
    'mode': 'main',
    'master': null,
    'backup': backup,
    'kept': kept,
    'freeBytes': 9000000000,
  },
  'boxes': [
    if (follower)
      {
        'id': 'dev-b2',
        'boxId': 'b2b2b2b2b2b2b2b2',
        'keyFp': 'b2b2b2b2b2b2b2b2',
        'name': 'Ruang Muslimat',
        'version': '2026.11.14',
        'linkedAt': '2026-11-02T01:45:00.000Z',
        'linkId': 'l' * 32,
        'lastSeenAt': '2026-11-04T14:29:20.000Z',
        'removedAt': null,
      },
  ],
};

Future<ShellHarness> open(
  WidgetTester tester, {
  AppLang lang = AppLang.ms,
  Map<String, Object?>? body,
  bool lock = false,
}) async {
  final h = await pumpShell(
    tester,
    roles: const ['admin'],
    overrides: [
      appLangStoreProvider.overrideWithValue(MemoryAppLangStore(lang)),
      livePublisherProvider.overrideWithValue(FakePublisher()),
      appLockProvider.overrideWithValue(lock),
      linkPollEveryProvider.overrideWithValue(const Duration(hours: 1)),
    ],
  );
  h.devices = [];
  final b = body ?? boxesBody(backup: backupJson());
  h.handlers['GET /api/boxes'] = (r) async => jsonResponse(200, b);
  h.router.go('/screens');
  await settle(tester);
  return h;
}

Future<void> close(WidgetTester tester) async {
  await tester.pumpWidget(const SizedBox());
  await tester.pump(const Duration(milliseconds: 10));
}

Future<void> tapKey(WidgetTester tester, String key) async {
  await tester.ensureVisible(find.byKey(ValueKey(key)));
  await tester.tap(find.byKey(ValueKey(key)));
  await settle(tester);
}

Map<String, dynamic> sent(ShellHarness h, String path) =>
    jsonDecode(h.box.seen.lastWhere((x) => x.url.path == path && x.method == 'POST').body) as Map<String, dynamic>;

void main() {
  testWidgets('the entry: a tab of the people pages leads to the list', (tester) async {
    await open(tester);
    expect(find.text('Skrin TV dan MAXCOM Kiosk Box'), findsWidgets);
    expect(find.text('Skrin TV'), findsOneWidget, reason: 'the pairing tab is still there');
    await close(tester);
  });

  testWidgets('no backup and nothing kept: no backup line at all', (tester) async {
    await open(tester, body: boxesBody());
    expect(find.byKey(const ValueKey('backup-line')), findsNothing);
    expect(find.byKey(const ValueKey('backup-drop')), findsNothing);
    expect(find.byKey(const ValueKey('backup-kept-line')), findsNothing);
    await close(tester);
  });

  testWidgets('the backup line, "Buang sandaran" and "Kembali ke data sebelum dipautkan" with no follower', (tester) async {
    await open(tester);
    expect(find.textContaining('Sandaran sebelum pautan:'), findsOneWidget);
    expect(find.textContaining('2 Nov 2026'), findsOneWidget);
    expect(find.textContaining('1.8 GB'), findsOneWidget);
    expect(find.byKey(const ValueKey('backup-drop')), findsOneWidget);
    expect(find.byKey(const ValueKey('backup-restore')), findsOneWidget);
    await close(tester);
  });

  testWidgets('a linked follower hides "Kembali ke data sebelum dipautkan"', (tester) async {
    await open(tester, body: boxesBody(backup: backupJson(), follower: true));
    expect(find.byKey(const ValueKey('backup-drop')), findsOneWidget);
    expect(find.byKey(const ValueKey('backup-restore')), findsNothing);
    await close(tester);
  });

  testWidgets('the drop: the sentence, the typed word and the PIN gate the button, then the request', (tester) async {
    final h = await open(tester, lock: true);
    h.handlers['POST /api/link/backup/drop'] = (r) async => jsonResponse(200, {'ok': true});
    await tapKey(tester, 'backup-drop');
    expect(find.text('Buang sandaran?'), findsOneWidget);
    expect(find.textContaining('tidak boleh kembali ke data'), findsOneWidget);
    expect(find.textContaining('Selepas ini Box ini'), findsOneWidget);
    FilledButton go() => tester.widget<FilledButton>(find.byKey(const ValueKey('backup-go')));
    expect(go().onPressed, isNull);
    await tester.enterText(find.byKey(const ValueKey('backup-confirm-field')), 'salah');
    await tester.enterText(find.byKey(const ValueKey('backup-pin-field')), '123456');
    await tester.pump();
    expect(go().onPressed, isNull, reason: 'the word is wrong');
    await tester.enterText(find.byKey(const ValueKey('backup-confirm-field')), 'buang');
    await tester.pump();
    expect(go().onPressed, isNotNull);
    await tester.tap(find.byKey(const ValueKey('backup-go')));
    await settle(tester);
    final b = sent(h, '/api/link/backup/drop');
    expect(b['pin'], '123456');
    expect(b['linkId'], 'l' * 32);
    expect(b['confirm'], isTrue);
    expect(b.containsKey('which'), isFalse);
    expect(find.byKey(const ValueKey('backup-sheet')), findsNothing);
    expect(find.text('Sandaran dibuang.'), findsOneWidget);
    await close(tester);
  });

  testWidgets('with the app lock off the sheet asks no PIN and sends none', (tester) async {
    final h = await open(tester);
    h.handlers['POST /api/link/backup/drop'] = (r) async => jsonResponse(200, {'ok': true});
    await tapKey(tester, 'backup-drop');
    expect(find.byKey(const ValueKey('backup-pin-field')), findsNothing);
    await tester.enterText(find.byKey(const ValueKey('backup-confirm-field')), 'BUANG');
    await tester.pump();
    await tester.tap(find.byKey(const ValueKey('backup-go')));
    await settle(tester);
    expect(sent(h, '/api/link/backup/drop').containsKey('pin'), isFalse);
    await close(tester);
  });

  testWidgets('the restore: the notice of the restart, the typed word, then the request', (tester) async {
    final h = await open(tester, lock: true);
    h.handlers['POST /api/link/backup/restore'] = (r) async => jsonResponse(200, {'ok': true});
    await tapKey(tester, 'backup-restore');
    expect(find.text('Kembali ke data sebelum dipautkan?'), findsOneWidget);
    expect(find.textContaining('dimulakan semula'), findsOneWidget);
    expect(find.textContaining('Telefon Pentadbir terus berfungsi'), findsOneWidget);
    await tester.enterText(find.byKey(const ValueKey('backup-confirm-field')), 'kembali');
    await tester.enterText(find.byKey(const ValueKey('backup-pin-field')), '123456');
    await tester.pump();
    await tester.tap(find.byKey(const ValueKey('backup-go')));
    await settle(tester);
    final b = sent(h, '/api/link/backup/restore');
    expect([b['pin'], b['linkId'], b['confirm']], ['123456', 'l' * 32, true]);
    await close(tester);
  });

  testWidgets('the kept data: the line with its date and "Buang data lama" (which: kept)', (tester) async {
    final h = await open(tester, body: boxesBody(kept: keptJson()));
    expect(find.textContaining('Pilihan ini boleh ditukar hingga'), findsOneWidget);
    expect(find.textContaining('10 Nov 2026'), findsOneWidget);
    h.handlers['POST /api/link/backup/drop'] = (r) async => jsonResponse(200, {'ok': true});
    await tapKey(tester, 'backup-kept-drop');
    await tester.enterText(find.byKey(const ValueKey('backup-confirm-field')), 'BUANG');
    await tester.pump();
    await tester.tap(find.byKey(const ValueKey('backup-go')));
    await settle(tester);
    final b = sent(h, '/api/link/backup/drop');
    expect([b['linkId'], b['which'], b['confirm']], ['k' * 32, 'kept', true]);
    expect(find.text('Data lama dibuang.'), findsOneWidget);
    await close(tester);
  });

  group('every refusal is worded, never the box sentence', () {
    final cases = <(String, int, String)>[
      ('lan_only', 403, 'Pautan MAXCOM Kiosk Box hanya boleh dibuat di Wi-Fi surau.'),
      ('pin_required', 400, 'Masukkan PIN anda untuk meneruskan.'),
      ('wrong_pin', 401, 'PIN salah. Cuba lagi.'),
      ('locked', 423, 'PIN dikunci buat sementara. Cuba lagi sebentar lagi.'),
      ('linking', 409, 'Pautan sedang dibuat. Cuba sebentar lagi.'),
      ('live_on', 409, 'Hentikan siaran langsung dahulu, kemudian cuba lagi.'),
      ('has_followers', 409, 'Box ini masih mempunyai Box pengikut. Tanggalkan mereka dahulu.'),
      ('kept_exists', 409, 'Data lama masih ada. Buang data lama dahulu.'),
      ('other_volume', 409, 'Sandaran berada di storan lain dan tidak boleh dipulihkan di sini.'),
      ('confirm_required', 400, 'Taip perkataan pengesahan dahulu.'),
      ('no_backup', 404, 'Tiada sandaran lagi.'),
    ];
    for (final (code, status, words) in cases) {
      testWidgets(code, (tester) async {
        final h = await open(tester);
        h.handlers['POST /api/link/backup/drop'] = (r) async => jsonResponse(status, {'code': code, 'errors': ['English words of the box']});
        await tapKey(tester, 'backup-drop');
        await tester.enterText(find.byKey(const ValueKey('backup-confirm-field')), 'BUANG');
        await tester.pump();
        await tester.tap(find.byKey(const ValueKey('backup-go')));
        await settle(tester);
        expect(find.byKey(const ValueKey('backup-error')), findsOneWidget, reason: 'the sheet stays open');
        expect(find.text(words), findsOneWidget);
        expect(find.textContaining('English words'), findsNothing);
        await close(tester);
      });
    }
  });

  Future<ShellHarness> openRefusedLink(WidgetTester tester, {required Object? kept, AppLang lang = AppLang.ms}) async {
    final h = await open(tester, body: boxesBody(), lang: lang);
    h.handlers['GET /api/link/status'] = (r) async => jsonResponse(200, {
      'mode': 'main',
      'session': null,
      'last': null,
      'progress': null,
      'checks': {'lan': true, 'live': false, 'caseX': false, 'setUp': true},
    });
    h.handlers['GET /api/link/backup'] = (r) async => jsonResponse(200, {'backup': null, 'kept': kept, 'freeBytes': 9000000000, 'followers': 0});
    h.handlers['POST /api/link/show'] = (r) async => jsonResponse(409, {'code': 'kept_data', 'errors': ['kept_data'], 'until': '2026-11-10T02:00:00.000Z'});
    h.router.go('/screens/link');
    await settle(tester);
    await tapKey(tester, 'link-choice-show');
    return h;
  }

  testWidgets('a refused link start for kept data on THIS box: the date, and "Buang data lama" right there', (tester) async {
    final h = await openRefusedLink(tester, kept: keptJson());
    expect(find.text('Data lama disimpan hingga 10 Nov 2026. Buang data lama untuk memaut sekarang.'), findsOneWidget);
    expect(find.byKey(const ValueKey('link-kept-other')), findsNothing);
    h.handlers['POST /api/link/backup/drop'] = (r) async => jsonResponse(200, {'ok': true});
    await tapKey(tester, 'link-kept-drop');
    await tester.enterText(find.byKey(const ValueKey('backup-confirm-field')), 'BUANG');
    await tester.pump();
    await tester.tap(find.byKey(const ValueKey('backup-go')));
    await settle(tester);
    final b = sent(h, '/api/link/backup/drop');
    expect([b['linkId'], b['which'], b['confirm']], ['k' * 32, 'kept', true]);
    expect(find.text('Data lama dibuang.'), findsOneWidget);
    expect(find.byKey(const ValueKey('link-kept-notice')), findsNothing, reason: 'the refusal is cleared once the data is gone');
    await close(tester);
  });

  testWidgets('a refused link start for kept data on the OTHER box: this box has none, so the line says where to remove it', (tester) async {
    await openRefusedLink(tester, kept: null);
    expect(find.text('Data lama disimpan hingga 10 Nov 2026. Buang data lama untuk memaut sekarang.'), findsOneWidget);
    expect(find.byKey(const ValueKey('link-kept-drop')), findsNothing);
    expect(
      find.text('Data lama itu disimpan pada MAXCOM yang satu lagi. Buang data lama di sana, dengan telefon Pentadbirnya, untuk memaut sekarang.'),
      findsOneWidget,
    );
    await close(tester);
  });

  testWidgets('the kept-data refusal in English', (tester) async {
    await openRefusedLink(tester, kept: keptJson(), lang: AppLang.en);
    expect(find.text('The old data is kept until 10 Nov 2026. Remove the old data to link now.'), findsOneWidget);
    expect(find.text('Remove the old data'), findsWidgets);
    await close(tester);
  });

  testWidgets('English and Arabic words of the lines', (tester) async {
    await open(tester, lang: AppLang.en, body: boxesBody(backup: backupJson(), kept: keptJson()));
    expect(find.textContaining('Backup before the link:'), findsOneWidget);
    expect(find.textContaining('2 Nov 2026'), findsWidgets);
    expect(find.text('Remove the backup'), findsOneWidget);
    expect(find.text('Go back to the data from before the link'), findsOneWidget);
    expect(find.text('Remove the old data'), findsOneWidget);
    expect(find.textContaining('This choice can be changed until'), findsOneWidget);
    expect(find.textContaining('10 Nov 2026'), findsOneWidget);
    await close(tester);
    await open(tester, lang: AppLang.ar, body: boxesBody(backup: backupJson(), kept: keptJson()));
    expect(find.text('حذف النسخة الاحتياطية'), findsOneWidget);
    expect(find.text('حذف البيانات القديمة'), findsOneWidget);
    await close(tester);
  });

  for (final lang in AppLang.values) {
    testWidgets('golden: the lines in ${lang.name}', (tester) async {
      final h = await open(tester, lang: lang, body: boxesBody(backup: backupJson(), kept: keptJson()));
      expect(tester.takeException(), isNull);
      expect(h.box.seen, isNotEmpty);
      await expectGoldens(tester, h.app, 'screens_backup_${lang.name}', sizes: const [GoldenSize.phone]);
      await close(tester);
    });
    testWidgets('golden: the sheet of the drop in ${lang.name}', (tester) async {
      final h = await open(tester, lang: lang, lock: true);
      await tapKey(tester, 'backup-drop');
      await tester.enterText(find.byKey(const ValueKey('backup-confirm-field')), lang == AppLang.ms ? 'BUANG' : lang == AppLang.en ? 'REMOVE' : 'حذف');
      await tester.pump();
      await expectGoldens(tester, h.app, 'screens_backup_sheet_${lang.name}', sizes: const [GoldenSize.phone]);
      await close(tester);
    });
  }
}
