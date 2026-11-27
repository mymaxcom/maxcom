// The unlink screens through the whole app over a fake box (real unlink API, real routes): the way in from a follower's
// row, the intro and the PIN, the sheet of each side with its numbers, the typed word, "Menunggu pentadbir yang satu
// lagi", the progress, the join of the follower, the result and the kept data with "Tukar pilihan" and "Buang data
// lama". Goldens: the sheet (phone in BM, English and Arabic, iPad in BM) and the progress in the three languages.

import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart' show ProviderScope;
import 'package:flutter_riverpod/misc.dart' show Override;
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:surau_app/app/app_lang.dart';
import 'package:surau_app/app/providers.dart';
import 'package:surau_app/app/theme.dart';
import 'package:surau_app/features/enrol/enrol_flow.dart' show EnrolledBox;
import 'package:surau_app/features/link/link_controller.dart';
import 'package:surau_app/features/live/fake_publisher.dart';
import 'package:surau_app/box/payload.dart' show EnrolPayload;
import 'package:surau_app/features/link/move_flow.dart' show MoveAway, joinEnrolText;
import 'package:surau_app/features/live/live_screen.dart' show livePublisherProvider;
import 'package:surau_app/features/unlink/unlink_controller.dart';
import 'package:surau_app/features/unlink/unlink_models.dart';
import 'package:surau_app/features/unlink/unlink_screen.dart';
import 'package:surau_app/features/unlink/unlink_sheet.dart';
import 'package:surau_app/l10n/generated/s.dart';

import '../../golden_sizes.dart';
import '../fakes.dart' show jsonResponse;
import '../shell/harness.dart';
import 'unlink_fixtures.dart';

/// The status the fake box answers now; a test changes it between polls.
class Box {
  Box(this.status);

  Map<String, Object?> status;
  final Map<String, http.Response Function(http.Request)> writes = {};
}

const String unlinkRoute = '/screens/unlink?device=dev-b2&name=Ruang%20Muslimat';

Map<String, Object?> boxes() => {
  'self': {'boxId': 'a1a1a1a1a1a1a1a1', 'name': 'Dewan Utama', 'keyFp': 'a1a1a1a1a1a1a1a1', 'version': '2026.11.14', 'mode': 'main', 'master': null},
  'boxes': [
    {
      'id': 'dev-b2',
      'boxId': 'b2b2b2b2b2b2b2b2',
      'keyFp': 'b2b2b2b2b2b2b2b2',
      'name': 'Ruang Muslimat',
      'version': '2026.11.14',
      'linkedAt': '2026-11-02T01:45:00.000Z',
      'linkId': 'l' * 32,
      'lastSeenAt': '2026-11-23T09:59:20.000Z',
      'removedAt': null,
    },
  ],
};

Future<(ShellHarness, Box)> openUnlink(
  WidgetTester tester,
  Map<String, Object?> status, {
  AppLang lang = AppLang.ms,
  bool lock = false,
  String route = unlinkRoute,
  List<Override> extra = const [],
}) async {
  final overrides = <Override>[
    appLangStoreProvider.overrideWithValue(MemoryAppLangStore(lang)),
    livePublisherProvider.overrideWithValue(FakePublisher()),
    appLockProvider.overrideWithValue(lock),
    linkPollEveryProvider.overrideWithValue(const Duration(hours: 1)),
    unlinkPollEveryProvider.overrideWithValue(const Duration(hours: 1)),
    ...extra,
  ];
  final h = await pumpShell(tester, roles: const ['admin'], overrides: overrides);
  final box = Box(status);
  h.handlers['GET /api/boxes'] = (r) async => jsonResponse(200, boxes());
  h.handlers['GET /api/unlink/status'] = (r) async => jsonResponse(200, box.status);
  for (final route in [
    'POST /api/unlink/start',
    'PUT /api/unlink/answer',
    'POST /api/unlink/agree',
    'POST /api/unlink/cancel',
    'POST /api/unlink/switch',
    'POST /api/unlink/drop-kept',
  ]) {
    h.handlers[route] = (r) async {
      final w = box.writes[route];
      return w != null ? w(r) : jsonResponse(200, box.status);
    };
  }
  h.router.go(route);
  await settle(tester);
  return (h, box);
}

Map<String, dynamic> sent(ShellHarness h, String path, {String method = 'POST'}) {
  final r = h.box.seen.lastWhere((x) => x.url.path == path && x.method == method);
  return jsonDecode(r.body) as Map<String, dynamic>;
}

int count(ShellHarness h, String path, {String method = 'POST'}) => h.box.seen.where((x) => x.url.path == path && x.method == method).length;

Future<void> tapKey(WidgetTester tester, String key) async {
  final f = find.byKey(ValueKey(key));
  await reveal(tester, f);
  await tester.tap(f);
  await settle(tester);
}

Future<void> close(WidgetTester tester) async {
  await tester.pumpWidget(const SizedBox());
  await tester.pump(const Duration(milliseconds: 10));
  await tester.pump(const Duration(milliseconds: 10));
}

/// A text widget whose text contains [part] (dates come wrapped in direction marks).
Finder textHas(String part) => find.byWidgetPredicate((w) => w is Text && (w.data ?? '').replaceAll('\u2066', '').replaceAll('\u2069', '').contains(part));

Future<void> typeInto(WidgetTester tester, String key, String text) async {
  await tester.enterText(find.byKey(ValueKey(key)), text);
  await tester.pump();
}

/// A golden of a page taller than the phone: the window is [logical] tall at the usual pixel ratio.
Future<void> tallGolden(WidgetTester tester, Widget app, String name, Size logical) async {
  tester.view.physicalSize = logical * goldenPixelRatio;
  tester.view.devicePixelRatio = goldenPixelRatio;
  addTearDown(tester.view.resetPhysicalSize);
  addTearDown(tester.view.resetDevicePixelRatio);
  await tester.pumpWidget(app);
  await tester.pumpAndSettle();
  await expectLater(find.byWidget(app), matchesGoldenFile('$name.png'), reason: 'golden $name');
}

/// The sheet or the progress alone, on a plain page, in [lang].
Widget plain(AppLang lang, Widget child) => MaterialApp(
  debugShowCheckedModeBanner: false,
  theme: SurauTheme.light(),
  locale: Locale(lang.name),
  localizationsDelegates: S.localizationsDelegates,
  supportedLocales: S.supportedLocales,
  home: Scaffold(
    body: Center(
      child: ConstrainedBox(
        constraints: const BoxConstraints(maxWidth: 560),
        child: SingleChildScrollView(padding: const EdgeInsets.all(16), child: child),
      ),
    ),
  ),
);

UnlinkView sessionOf(Map<String, Object?> session) => statusOf(unlinkStatusJson(session: session)).session!;

Widget sheetOf(
  AppLang lang,
  UnlinkView session, {
  UnlinkSide side = UnlinkSide.follower,
  bool tick = false,
  bool busy = false,
  String? error,
  bool stale = false,
}) => plain(
  lang,
  UnlinkSheetView(
    session: session,
    side: side,
    lang: lang,
    tick: tick,
    busy: busy,
    staleNotice: stale,
    error: error,
    toLocal: (d) => d.toUtc(),
    onChoose: (_) {},
    onRemovePeople: (_) {},
    onTick: (_) {},
    onAgree: () {},
    onCancel: () {},
  ),
);

void main() {
  group('the way in', () {
    testWidgets('a follower row has "Putuskan pautan"; it opens the intro for that box', (tester) async {
      final (h, _) = await openUnlink(tester, unlinkStatusJson(), route: '/screens');
      expect(find.byKey(const ValueKey('tv-unlink-dev-b2')), findsOneWidget);
      expect(find.byKey(const ValueKey('tv-unlink-self')), findsNothing, reason: 'the main box has nobody to unlink');
      await tapKey(tester, 'tv-unlink-dev-b2');
      expect(h.location, '/screens/unlink');
      expect(find.byKey(const ValueKey('unlink-start')), findsOneWidget);
      expect(find.text('Putuskan pautan: Ruang Muslimat'), findsOneWidget);
      await close(tester);
    });

    testWidgets('Mula opens the unlink of that box; with the app lock off no PIN is sent', (tester) async {
      final (h, box) = await openUnlink(tester, unlinkStatusJson());
      box.writes['POST /api/unlink/start'] = (r) {
        box.status = unlinkStatusJson(session: sessionJson());
        return jsonResponse(200, box.status);
      };
      await tapKey(tester, 'unlink-start-go');
      expect(sent(h, '/api/unlink/start'), {'deviceId': 'dev-b2'});
      expect(find.byKey(const ValueKey('unlink-sheet-follower')), findsOneWidget);
      await close(tester);
    });

    testWidgets('with the app lock on, Mula asks for the PIN first and a wrong one is worded under the field', (tester) async {
      final (h, box) = await openUnlink(tester, unlinkStatusJson(), lock: true);
      box.writes['POST /api/unlink/start'] = (r) => jsonResponse(401, {'code': 'wrong_pin', 'errors': ['wrong_pin']});
      await tapKey(tester, 'unlink-start-go');
      expect(count(h, '/api/unlink/start'), 0, reason: 'nothing is sent before the PIN');
      expect(find.byKey(const ValueKey('unlink-confirm-sheet')), findsOneWidget);
      await typeInto(tester, 'unlink-confirm-pin', '246813');
      await tester.tap(find.byKey(const ValueKey('unlink-confirm-go')));
      await settle(tester);
      expect(sent(h, '/api/unlink/start'), {'deviceId': 'dev-b2', 'pin': '246813'});
      expect(find.text('PIN salah. Cuba lagi.'), findsOneWidget);
      expect(find.byKey(const ValueKey('unlink-confirm-sheet')), findsOneWidget, reason: 'the sheet stays open');
      await close(tester);
    });

    testWidgets('a refusal of the start is a sentence, not a code', (tester) async {
      final (_, box) = await openUnlink(tester, unlinkStatusJson());
      box.writes['POST /api/unlink/start'] = (r) => jsonResponse(409, {'code': 'live_on', 'errors': ['live_on']});
      await tapKey(tester, 'unlink-start-go');
      expect(find.text('Hentikan siaran langsung dahulu, kemudian cuba lagi.'), findsOneWidget);
      expect(find.textContaining('live_on'), findsNothing);
      await close(tester);
    });
  });

  group('the sheet', () {
    testWidgets('the follower: backup and carry on, no empty option; the chosen one shows its numbers', (tester) async {
      final (h, box) = await openUnlink(tester, unlinkStatusJson(session: sessionJson(follower: followerBack())));
      expect(find.text('Putuskan pautan: Ruang Muslimat'), findsOneWidget);
      expect(find.byKey(const ValueKey('unlink-choice-back')), findsOneWidget);
      expect(find.byKey(const ValueKey('unlink-choice-carry-on')), findsOneWidget);
      expect(find.byKey(const ValueKey('unlink-choice-empty')), findsNothing);
      expect(textHas('Kembali ke data sebelum dipautkan (sandaran 20 Nov 2026)'), findsOneWidget);
      expect(textHas('312 perubahan sejak 20 Nov 2026'), findsOneWidget);
      expect(textHas('2 orang yang dibuang selepas itu akan kembali: Zainab, Hasan.'), findsOneWidget);
      expect(textHas('3 orang yang ditambah selepas itu tiada: Khalid, Mariam, Yusuf.'), findsOneWidget);
      expect(find.text('Data sekarang disimpan 7 hari lagi sebelum dibuang.'), findsOneWidget);
      // the phone leaves the main box: said on the sheet
      expect(find.byKey(const ValueKey('unlink-phone-note')), findsOneWidget);
      expect(find.byKey(const ValueKey('unlink-eligible-any')), findsNothing);
      // another choice is one answer
      box.writes['PUT /api/unlink/answer'] = (r) {
        box.status = unlinkStatusJson(session: sessionJson(rev: 2, follower: followerCarry()));
        return jsonResponse(200, box.status);
      };
      await tapKey(tester, 'unlink-choice-carry-on');
      expect(sent(h, '/api/unlink/answer', method: 'PUT'), {'side': 'follower', 'choice': 'carry-on', 'financeTick': false});
      await close(tester);
    });

    testWidgets('the follower carries on: the finance tick gates "Setuju", the videos that do not fit are listed', (tester) async {
      final (h, box) = await openUnlink(tester, unlinkStatusJson(session: sessionJson(follower: followerCarry())));
      expect(textHas('42 rekod kewangan kekal di Box utama.'), findsOneWidget);
      expect(textHas('Video ini tidak muat di Box itu dan tidak disalin:'), findsOneWidget);
      expect(textHas('Kuliah Maghrib'), findsOneWidget);
      expect(textHas('700 MB'), findsOneWidget);
      expect(find.text('YouTube: tiada log masuk. Log masuk sendiri di Box ini (kira-kira seminit).'), findsOneWidget);
      FilledButton agree() => tester.widget<FilledButton>(find.byKey(const ValueKey('unlink-agree')));
      expect(agree().onPressed, isNull, reason: 'the tick is required');
      // the box holds the tick and answers it back: the checkbox and "Setuju" follow what it says
      box.writes['PUT /api/unlink/answer'] = (r) {
        box.status = unlinkStatusJson(session: sessionJson(follower: followerCarry(financeTick: true)));
        return jsonResponse(200, box.status);
      };
      await tapKey(tester, 'unlink-finance-tick');
      expect(sent(h, '/api/unlink/answer', method: 'PUT'), {'side': 'follower', 'choice': 'carry-on', 'financeTick': true});
      expect(agree().onPressed, isNotNull);
      await close(tester);
    });

    testWidgets('the master side, back: Pentadbir phones keep working, others join again with a QR code, the recovery code only if no Pentadbir phone is left', (tester) async {
      final session = sessionJson(
        master: sideJson(eligible: null, choice: 'back', numbers: numbersJson(changes: 4)),
        follower: sideJson(mayAnswer: false),
      );
      await openUnlink(tester, unlinkStatusJson(session: session));
      expect(find.byKey(const ValueKey('unlink-sheet-master')), findsOneWidget);
      expect(find.byKey(const ValueKey('unlink-num-recovery')), findsOneWidget);
      expect(
        find.text('Telefon Pentadbir terus berfungsi. Telefon lain menyertai semula dengan kod QR daripada Pentadbir. Kod pemulihan hanya diperlukan jika tiada lagi telefon Pentadbir.'),
        findsOneWidget,
      );
      await close(tester);
    });

    testWidgets('the follower side, back: the recovery line is not shown (its phones are not revoked)', (tester) async {
      await openUnlink(tester, unlinkStatusJson(session: sessionJson(follower: followerBack())));
      expect(find.byKey(const ValueKey('unlink-num-kept')), findsOneWidget);
      expect(find.byKey(const ValueKey('unlink-num-recovery')), findsNothing);
      await close(tester);
    });

    testWidgets('a follower that was a new box: carry on or empty, nothing to go back to', (tester) async {
      await openUnlink(tester, unlinkStatusJson(session: sessionJson(follower: sideJson(eligible: 'before', back: false, empty: true))));
      expect(find.byKey(const ValueKey('unlink-choice-back')), findsNothing);
      expect(find.byKey(const ValueKey('unlink-choice-carry-on')), findsOneWidget);
      expect(find.text('Kosongkan Box ini (kembali ke skrin persediaan)'), findsOneWidget);
      await close(tester);
    });

    testWidgets('a backup that was dropped: only carry on', (tester) async {
      await openUnlink(tester, unlinkStatusJson(session: sessionJson(follower: sideJson(eligible: 'before', back: false))));
      expect(find.byKey(const ValueKey('unlink-choice-back')), findsNothing);
      expect(find.byKey(const ValueKey('unlink-choice-empty')), findsNothing);
      expect(find.byKey(const ValueKey('unlink-choice-carry-on')), findsOneWidget);
      await close(tester);
    });

    testWidgets('any admin may answer when none of the earlier admins is left: the sheet says so', (tester) async {
      await openUnlink(tester, unlinkStatusJson(session: sessionJson(follower: sideJson(eligible: 'any'))));
      expect(find.byKey(const ValueKey('unlink-eligible-any')), findsOneWidget);
      expect(textHas('Anda dijadikan Pentadbir Ruang Muslimat.'), findsOneWidget);
      await close(tester);
    });

    testWidgets('the master side: the people switch of carry on is one answer; the master is not asked when others stay', (tester) async {
      final session = sessionJson(
        master: sideJson(eligible: null, choice: 'carry-on', numbers: numbersJson(peopleFromFollower: 5)),
        follower: sideJson(mayAnswer: false),
      );
      final (h, box) = await openUnlink(tester, unlinkStatusJson(session: session));
      expect(find.byKey(const ValueKey('unlink-sheet-master')), findsOneWidget);
      expect(find.byKey(const ValueKey('unlink-sheet-follower')), findsNothing);
      expect(find.text('Ruang Muslimat akan berjalan sendiri. Pilih data yang digunakan oleh Box ini selepas ini.'), findsOneWidget);
      expect(find.byKey(const ValueKey('unlink-phone-note')), findsNothing);
      expect(textHas('Buang pengguna yang datang dari Ruang Muslimat (5 orang)'), findsOneWidget);
      box.writes['PUT /api/unlink/answer'] = (r) => jsonResponse(200, box.status);
      await tapKey(tester, 'unlink-remove-people');
      expect(sent(h, '/api/unlink/answer', method: 'PUT'), {'side': 'master', 'choice': 'carry-on', 'removePeople': true});
      await close(tester);
    });

    testWidgets('the master that is not asked, and a phone with no side: waiting, with no sheet', (tester) async {
      await openUnlink(tester, unlinkStatusJson(session: sessionJson(follower: sideJson(mayAnswer: false))));
      expect(find.byKey(const ValueKey('unlink-waiting')), findsOneWidget);
      expect(find.byKey(const ValueKey('unlink-sheet-follower')), findsNothing);
      expect(find.byKey(const ValueKey('unlink-edit')), findsNothing);
      await close(tester);
    });

    testWidgets('a choice that leaves changes behind asks the typed word before "Setuju" is sent', (tester) async {
      final (h, box) = await openUnlink(tester, unlinkStatusJson(session: sessionJson(rev: 3, follower: followerBack())));
      box.writes['POST /api/unlink/agree'] = (r) {
        box.status = unlinkStatusJson(session: sessionJson(rev: 3, follower: followerBack(agreed: true)));
        return jsonResponse(200, box.status);
      };
      await tapKey(tester, 'unlink-agree');
      expect(count(h, '/api/unlink/agree'), 0);
      expect(find.byKey(const ValueKey('unlink-confirm-sheet')), findsOneWidget);
      FilledButton go() => tester.widget<FilledButton>(find.byKey(const ValueKey('unlink-confirm-go')));
      expect(go().onPressed, isNull);
      await typeInto(tester, 'unlink-confirm-field', 'salah');
      expect(go().onPressed, isNull, reason: 'a wrong word does nothing');
      await typeInto(tester, 'unlink-confirm-field', 'putus');
      expect(go().onPressed, isNotNull, reason: 'the word is checked without regard to case');
      await tester.tap(find.byKey(const ValueKey('unlink-confirm-go')));
      await settle(tester);
      expect(sent(h, '/api/unlink/agree'), {'side': 'follower', 'rev': 3, 'confirm': true});
      expect(find.byKey(const ValueKey('unlink-waiting')), findsOneWidget);
      expect(find.text('Menunggu pentadbir yang satu lagi'), findsOneWidget);
      await close(tester);
    });

    testWidgets('a choice that leaves nothing behind needs no word and, with the lock off, no sheet', (tester) async {
      final (h, box) = await openUnlink(tester, unlinkStatusJson(session: sessionJson(follower: followerBack(needsTyped: false))));
            await tapKey(tester, 'unlink-agree');
      expect(find.byKey(const ValueKey('unlink-confirm-sheet')), findsNothing);
      expect(sent(h, '/api/unlink/agree'), {'side': 'follower', 'rev': 1});
      await close(tester);
    });

    testWidgets('with the app lock on the PIN rides in the same request as the word', (tester) async {
      final (h, box) = await openUnlink(tester, unlinkStatusJson(session: sessionJson(follower: followerBack())), lock: true);
            await tapKey(tester, 'unlink-agree');
      await typeInto(tester, 'unlink-confirm-field', 'PUTUS');
      FilledButton go() => tester.widget<FilledButton>(find.byKey(const ValueKey('unlink-confirm-go')));
      expect(go().onPressed, isNull, reason: 'the PIN is missing');
      await typeInto(tester, 'unlink-confirm-pin', '246813');
      await tester.tap(find.byKey(const ValueKey('unlink-confirm-go')));
      await settle(tester);
      expect(sent(h, '/api/unlink/agree'), {'side': 'follower', 'rev': 1, 'confirm': true, 'pin': '246813'});
      await close(tester);
    });

    testWidgets('a refusal of "Setuju" is worded in the sheet, which stays open', (tester) async {
      final (_, box) = await openUnlink(tester, unlinkStatusJson(session: sessionJson(follower: followerBack())));
      box.writes['POST /api/unlink/agree'] = (r) => jsonResponse(409, {'code': 'same_phone', 'errors': ['same_phone']});
      await tapKey(tester, 'unlink-agree');
      await typeInto(tester, 'unlink-confirm-field', 'PUTUS');
      await tester.tap(find.byKey(const ValueKey('unlink-confirm-go')));
      await settle(tester);
      expect(find.byKey(const ValueKey('unlink-confirm-error')), findsOneWidget);
      expect(find.text('Satu telefon tidak boleh menjawab untuk kedua-dua Box.'), findsOneWidget);
      await close(tester);
    });

    testWidgets('"Batal" ends the session', (tester) async {
      final (h, box) = await openUnlink(tester, unlinkStatusJson(session: sessionJson(follower: followerBack())));
      box.writes['POST /api/unlink/cancel'] = (r) {
        box.status = unlinkStatusJson(last: lastJson(outcome: 'cancelled'));
        return jsonResponse(200, <String, Object?>{'ok': true});
      };
      await tapKey(tester, 'unlink-cancel');
      expect(count(h, '/api/unlink/cancel'), 1);
      expect(find.byKey(const ValueKey('unlink-failed')), findsOneWidget);
      expect(find.text('Pautan tidak diputuskan'), findsOneWidget);
      await close(tester);
    });

    testWidgets('another admin changed the answers: the notice, and agreeing again answers it', (tester) async {
      final (_, box) = await openUnlink(tester, unlinkStatusJson(session: sessionJson(follower: followerBack())));
      expect(find.byKey(const ValueKey('unlink-stale')), findsNothing);
      box.status = unlinkStatusJson(session: sessionJson(rev: 2, follower: followerCarry()));
      await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 5)));
      final container = ProviderScope.containerOf(tester.element(find.byKey(const ValueKey('unlink-sheet-follower'))));
      await container.read(unlinkControllerProvider.notifier).refresh();
      await settle(tester);
      expect(find.byKey(const ValueKey('unlink-stale')), findsOneWidget);
      expect(find.text('Pentadbir lain menukar pilihan. Semak dan setuju sekali lagi.'), findsOneWidget);
      await close(tester);
    });
  });

  group('waiting, progress and join', () {
    testWidgets('after this phone agreed: waiting, and "Ubah jawapan" brings the sheet back', (tester) async {
      final session = sessionJson(master: sideJson(eligible: null, mayAnswer: false), follower: followerBack(agreed: true));
      await openUnlink(tester, unlinkStatusJson(session: session));
      expect(find.byKey(const ValueKey('unlink-waiting')), findsOneWidget);
      expect(find.text('Menunggu pentadbir yang satu lagi'), findsOneWidget);
      await tapKey(tester, 'unlink-edit');
      expect(find.byKey(const ValueKey('unlink-sheet-follower')), findsOneWidget);
      await close(tester);
    });

    testWidgets('the work: the step, its number and its percent', (tester) async {
      await openUnlink(
        tester,
        unlinkStatusJson(session: sessionJson(stage: 'working', progress: {'step': 'carry-on', 'stepNo': 2, 'steps': 3, 'percent': 40})),
      );
      expect(find.text('Pautan sedang diputuskan'), findsOneWidget);
      expect(find.text('Langkah 2 daripada 3: menyimpan data sekarang, 40%'), findsOneWidget);
      expect(tester.widget<LinearProgressIndicator>(find.byKey(const ValueKey('unlink-progress-bar'))).value, closeTo(0.4, 0.001));
      expect(find.text('Jangan matikan kuasa kedua-dua MAXCOM Kiosk Box sehingga selesai.'), findsOneWidget);
      await close(tester);
    });

    testWidgets('the work without a progress yet, and every step has its words', (tester) async {
      await openUnlink(tester, unlinkStatusJson(session: sessionJson(stage: 'working')));
      expect(find.text('Kerja sedang bermula'), findsOneWidget);
      await close(tester);
    });

    testWidgets('join: the follower\'s phone sets a new PIN and the 2C move flow runs with the pointer', (tester) async {
      final calls = <(String, String, String)>[];
      final enrolled = EnrolledBox(
        box: Uri.parse('https://10.168.50.12:8443'),
        boxId: 'b2b2b2b2b2b2b2b2',
        deviceId: 'dev-new',
        userId: 'u-aminah',
        userName: 'Aminah',
        roles: const ['admin'],
        caSha256: 'ab' * 32,
      );
      final (_, _) = await openUnlink(
        tester,
        unlinkStatusJson(session: sessionJson(stage: 'join', join: joinJson())),
        extra: [
          unlinkJoinProvider.overrideWithValue((pointer, pin, name) async {
            calls.add((pointer.ticket, pin, pointer.masterBoxId));
            return enrolled;
          }),
        ],
      );
      expect(find.byKey(const ValueKey('unlink-join')), findsOneWidget);
      expect(find.text('Sambung ke Ruang Muslimat'), findsOneWidget);
      // a weak PIN and a PIN that does not match are told before anything is sent
      await typeInto(tester, 'unlink-join-pin', '123456');
      await typeInto(tester, 'unlink-join-pin-again', '123456');
      await tester.tap(find.byKey(const ValueKey('unlink-join-submit')));
      await tester.pump();
      expect(calls, isEmpty, reason: 'a PIN the box would refuse is not sent');
      await typeInto(tester, 'unlink-join-pin', '246813');
      await tester.tap(find.byKey(const ValueKey('unlink-join-submit')));
      await tester.pump();
      expect(calls, isEmpty, reason: 'the two PINs differ');
      await typeInto(tester, 'unlink-join-pin-again', '246813');
      await tester.tap(find.byKey(const ValueKey('unlink-join-submit')));
      await settle(tester);
      expect(calls.single, ('ABCD-EFGH-2345', '246813', 'b2b2b2b2b2b2b2b2'));
      expect(find.byKey(const ValueKey('unlink-join-done')), findsOneWidget);
      expect(find.text('Anda kini disambungkan ke Ruang Muslimat.'), findsOneWidget);
      await close(tester);
    });

    testWidgets('join: a move that cannot reach the follower is worded and can be tried again', (tester) async {
      final (_, _) = await openUnlink(
        tester,
        unlinkStatusJson(session: sessionJson(stage: 'join', join: joinJson())),
        extra: [unlinkJoinProvider.overrideWithValue((pointer, pin, name) async => throw StateError('no route'))],
      );
      await typeInto(tester, 'unlink-join-pin', '246813');
      await typeInto(tester, 'unlink-join-pin-again', '246813');
      await tapKey(tester, 'unlink-join-submit');
      expect(find.byKey(const ValueKey('unlink-join')), findsOneWidget, reason: 'back on the PIN form');
      expect(find.byKey(const ValueKey('unlink-join-submit')), findsOneWidget);
      await close(tester);
    });

    testWidgets('join on a native app that cannot reach the follower says so plainly, never the Wi-Fi sentence', (tester) async {
      await openUnlink(
        tester,
        unlinkStatusJson(session: sessionJson(stage: 'join', join: joinJson())),
        extra: [unlinkJoinProvider.overrideWithValue((pointer, pin, name) async => throw const MoveAway())],
      );
      await typeInto(tester, 'unlink-join-pin', '246813');
      await typeInto(tester, 'unlink-join-pin-again', '246813');
      await tapKey(tester, 'unlink-join-submit');
      expect(find.text('Telefon ini tidak dapat menghubungi Ruang Muslimat. Semak sambungan rangkaian dan cuba lagi.'), findsOneWidget);
      expect(find.textContaining('Wi-Fi surau'), findsNothing);
      expect(find.byKey(const ValueKey('unlink-join-submit')), findsOneWidget, reason: 'it can be tried again');
      await close(tester);
    });

    testWidgets('join in the web app: no PIN here; the button opens the follower\'s own web app with the ticket in the fragment', (tester) async {
      final calls = <String>[];
      final (h, _) = await openUnlink(
        tester,
        unlinkStatusJson(session: sessionJson(stage: 'join', join: joinJson())),
        extra: [
          unlinkIsWebProvider.overrideWithValue(true),
          unlinkJoinProvider.overrideWithValue((pointer, pin, name) async {
            calls.add('direct');
            throw StateError('the web app never joins directly');
          }),
        ],
      );
      expect(find.byKey(const ValueKey('unlink-join-web')), findsOneWidget);
      expect(find.byKey(const ValueKey('unlink-join')), findsNothing);
      expect(find.byKey(const ValueKey('unlink-join-pin')), findsNothing);
      expect(find.text('Sambung ke Ruang Muslimat'), findsOneWidget);
      expect(find.text('Buka aplikasi Ruang Muslimat'), findsOneWidget);
      expect(find.textContaining('Wi-Fi surau'), findsNothing);
      expect(find.text('Pelayar mungkin meminta anda mempercayai MAXCOM itu sekali sahaja. Terima, kemudian teruskan.'), findsOneWidget);
      await tapKey(tester, 'unlink-join-open');
      final url = h.opener.opened.single;
      expect(url.toString(), startsWith('https://10.168.50.12:8443/app/#/enrol?join=surau1'));
      expect(url.query, isEmpty);
      final join = joinJson();
      final pointer = statusOf(unlinkStatusJson(session: sessionJson(stage: 'join', join: join))).session!.join!.pointer;
      expect(Uri.parse(url.fragment).queryParameters['join'], joinEnrolText(pointer, user: 'Ustaz Ali'));
      expect(calls, isEmpty);
      // "Kekal di sini" still leaves
      await tapKey(tester, 'unlink-join-stay');
      expect(h.location, '/screens');
      await close(tester);
    });

    testWidgets('join in the web app: the box, user and exp the status carries make the enrolment text', (tester) async {
      final (h, _) = await openUnlink(
        tester,
        unlinkStatusJson(
          session: sessionJson(
            stage: 'join',
            join: {...joinJson(), 'box': 'https://10.168.50.12:8443', 'mode': 'ip', 'user': 'Puan Aminah', 'exp': 4102444800000},
          ),
        ),
        extra: [unlinkIsWebProvider.overrideWithValue(true)],
      );
      await tapKey(tester, 'unlink-join-open');
      final text = Uri.parse(h.opener.opened.single.fragment).queryParameters['join']!;
      final payload = EnrolPayload.parse(text, requireCa: true);
      expect(payload.user, 'Puan Aminah');
      expect(payload.exp, 4102444800000);
      expect(payload.box, 'https://10.168.50.12:8443');
      await close(tester);
    });

    testWidgets('join in the web app: a browser that cannot open the address says so', (tester) async {
      final (h, _) = await openUnlink(
        tester,
        unlinkStatusJson(session: sessionJson(stage: 'join', join: joinJson())),
        extra: [unlinkIsWebProvider.overrideWithValue(true)],
      );
      h.opener.result = false;
      await tapKey(tester, 'unlink-join-open');
      expect(find.text('Pelayar tidak dapat membuka aplikasi itu. Cuba lagi.'), findsOneWidget);
      await close(tester);
    });

    testWidgets('join: "Kekal di sini" says plainly that this phone is signed out of the main box, and leaves', (tester) async {
      final (h, _) = await openUnlink(tester, unlinkStatusJson(session: sessionJson(stage: 'join', join: joinJson())));
      expect(find.byKey(const ValueKey('unlink-join-submit')), findsOneWidget);
      await reveal(tester, find.byKey(const ValueKey('unlink-join-stay-note')));
      expect(
        find.text('Jika anda kekal di sini, telefon ini dilog keluar daripada Dewan Utama apabila Ruang Muslimat sudah disertai. Pilih Sambung sekarang untuk terus mengurus Ruang Muslimat dengan telefon ini.'),
        findsOneWidget,
      );
      await tapKey(tester, 'unlink-join-stay');
      expect(h.location, '/screens');
      await close(tester);
    });

    testWidgets('a phone that did not answer for the follower waits for the one that did', (tester) async {
      await openUnlink(tester, unlinkStatusJson(session: sessionJson(stage: 'join')));
      expect(find.byKey(const ValueKey('unlink-join-wait')), findsOneWidget);
      expect(find.text('Menunggu telefon Pentadbir Ruang Muslimat'), findsOneWidget);
      await close(tester);
    });
  });

  group('the result and the kept data', () {
    testWidgets('a kept row that cannot be switched shows no "Tukar pilihan"; an empty name is not printed as a gap', (tester) async {
      await openUnlink(
        tester,
        unlinkStatusJson(
          last: lastJson(),
          kept: [
            {...keptJson(), 'switchable': false},
            {...keptJson(side: 'master', chosen: 'carry-on'), 'followerName': '', 'masterName': ''},
          ],
        ),
      );
      expect(find.byKey(const ValueKey('unlink-switch-follower')), findsNothing);
      expect(find.byKey(const ValueKey('unlink-drop-follower')), findsOneWidget, reason: '"Buang data lama" stays');
      expect(find.byKey(const ValueKey('unlink-switch-master')), findsOneWidget, reason: 'switchable is on unless the box says false');
      expect(find.byKey(const ValueKey('unlink-kept')), findsOneWidget);
      await close(tester);
    });

    testWidgets('done: the result and the kept rows with their date, "Tukar pilihan" and "Buang data lama"', (tester) async {
      await openUnlink(tester, unlinkStatusJson(last: lastJson(), kept: [keptJson(), keptJson(side: 'master', chosen: 'carry-on')]));
      expect(find.byKey(const ValueKey('unlink-done')), findsOneWidget);
      expect(find.text('Pautan diputuskan'), findsOneWidget);
      expect(find.text('Ruang Muslimat kini berjalan sendiri.'), findsOneWidget);
      expect(find.text('Ruang Muslimat'), findsOneWidget);
      expect(find.text('Dewan Utama, selepas Ruang Muslimat keluar'), findsOneWidget);
      expect(find.text('Pilihan: kembali ke data sebelum dipautkan'), findsOneWidget);
      expect(find.text('Pilihan: teruskan dengan data sekarang'), findsOneWidget);
      expect(textHas('Pilihan ini boleh ditukar hingga 27 Nov 2026'), findsNWidgets(2));
      expect(find.byKey(const ValueKey('unlink-switch-follower')), findsOneWidget);
      expect(find.byKey(const ValueKey('unlink-drop-master')), findsOneWidget);
      await close(tester);
    });

    testWidgets('"Tukar pilihan" asks the word, then switches that side and shows the new work', (tester) async {
      final (h, box) = await openUnlink(tester, unlinkStatusJson(last: lastJson(), kept: [keptJson()]));
      box.writes['POST /api/unlink/switch'] = (r) {
        box.status = unlinkStatusJson(session: sessionJson(stage: 'working', progress: {'step': 'carry-on', 'stepNo': 1, 'steps': 1, 'percent': 10}));
        return jsonResponse(200, box.status);
      };
      await tapKey(tester, 'unlink-switch-follower');
      expect(find.text('Tukar pilihan?'), findsOneWidget);
      expect(textHas('Box ini meneruskan dengan data sekarang. Sandaran disimpan sehingga 27 Nov 2026.'), findsOneWidget);
      await typeInto(tester, 'unlink-confirm-field', 'PUTUS');
      await tester.tap(find.byKey(const ValueKey('unlink-confirm-go')));
      await settle(tester);
      expect(sent(h, '/api/unlink/switch'), {'side': 'follower', 'confirm': true});
      expect(find.byKey(const ValueKey('unlink-progress')), findsOneWidget);
      await close(tester);
    });

    testWidgets('"Buang data lama" asks the word and drops that side', (tester) async {
      final (h, box) = await openUnlink(tester, unlinkStatusJson(last: lastJson(), kept: [keptJson()]));
      box.writes['POST /api/unlink/drop-kept'] = (r) {
        box.status = unlinkStatusJson(last: lastJson());
        return jsonResponse(200, <String, Object?>{'ok': true});
      };
      await tapKey(tester, 'unlink-drop-follower');
      await typeInto(tester, 'unlink-confirm-field', 'BUANG');
      await tester.tap(find.byKey(const ValueKey('unlink-confirm-go')));
      await settle(tester);
      expect(sent(h, '/api/unlink/drop-kept'), {'side': 'follower', 'confirm': true});
      expect(find.byKey(const ValueKey('unlink-kept')), findsNothing, reason: 'the row is gone');
      await close(tester);
    });

    testWidgets('a switch after the window: the refusal is worded in the sheet', (tester) async {
      final (_, box) = await openUnlink(tester, unlinkStatusJson(last: lastJson(), kept: [keptJson()]));
      box.writes['POST /api/unlink/switch'] = (r) => jsonResponse(409, {'code': 'kept_window_over', 'errors': ['kept_window_over']});
      await tapKey(tester, 'unlink-switch-follower');
      await typeInto(tester, 'unlink-confirm-field', 'PUTUS');
      await tester.tap(find.byKey(const ValueKey('unlink-confirm-go')));
      await settle(tester);
      expect(find.text('Masa untuk menukar pilihan sudah tamat.'), findsOneWidget);
      await close(tester);
    });

    testWidgets('failed and expired results say why; nothing changed', (tester) async {
      for (final (outcome, text) in [('failed', 'Pautan tidak dapat disiapkan.'), ('expired', 'Masa tamat sebelum pautan selesai. Tiada data diubah.')]) {
        final (_, _) = await openUnlink(tester, unlinkStatusJson(last: lastJson(outcome: outcome)));
        expect(find.byKey(const ValueKey('unlink-failed')), findsOneWidget, reason: outcome);
        expect(textHas(text), findsOneWidget, reason: outcome);
        await close(tester);
      }
    });

    testWidgets('no session and no row: the kept data alone, or a line saying there is none', (tester) async {
      await openUnlink(tester, unlinkStatusJson(), route: '/screens/unlink');
      expect(find.byKey(const ValueKey('unlink-idle-none')), findsOneWidget);
      await close(tester);
      await openUnlink(tester, unlinkStatusJson(kept: [keptJson()]), route: '/screens/unlink');
      expect(find.byKey(const ValueKey('unlink-kept')), findsOneWidget);
      await close(tester);
    });
  });

  group('the kept data on the screens list', () {
    testWidgets('a line with the date while data is kept; it opens the kept rows', (tester) async {
      final (h, _) = await openUnlink(tester, unlinkStatusJson(kept: [keptJson(), keptJson(side: 'master', chosen: 'carry-on', until: '2026-11-25T12:00:00.000Z')]), route: '/screens');
      expect(find.byKey(const ValueKey('tvs-kept-line')), findsOneWidget);
      expect(textHas('Data lama disimpan hingga 25 Nov 2026'), findsOneWidget, reason: 'the soonest date');
      await tapKey(tester, 'tvs-kept-line');
      expect(h.location, '/screens/unlink');
      expect(find.byKey(const ValueKey('unlink-kept')), findsOneWidget);
      expect(find.byKey(const ValueKey('unlink-switch-follower')), findsOneWidget);
      expect(find.byKey(const ValueKey('unlink-drop-master')), findsOneWidget);
      expect(find.text('Dewan Utama, selepas Ruang Muslimat keluar'), findsOneWidget);
      await close(tester);
    });

    testWidgets('nothing kept: no line', (tester) async {
      await openUnlink(tester, unlinkStatusJson(), route: '/screens');
      expect(find.byKey(const ValueKey('tvs-kept-line')), findsNothing);
      await close(tester);
    });

    testWidgets('a box that cannot answer the unlink status leaves the list as it was', (tester) async {
      final (h, _) = await openUnlink(tester, unlinkStatusJson(kept: [keptJson()]), route: '/screens');
      h.handlers['GET /api/unlink/status'] = (r) async => jsonResponse(404, <String, Object?>{});
      final container = ProviderScope.containerOf(tester.element(find.byKey(const ValueKey('tv-row-dev-b2'))));
      container.invalidate(unlinkKeptProvider);
      await settle(tester);
      expect(find.byKey(const ValueKey('tvs-kept-line')), findsNothing);
      expect(find.byKey(const ValueKey('tv-row-dev-b2')), findsOneWidget);
      await close(tester);
    });

    testWidgets('English: the line says the date in English', (tester) async {
      await openUnlink(tester, unlinkStatusJson(kept: [keptJson()]), route: '/screens', lang: AppLang.en);
      expect(textHas('Old data kept until 27 Nov 2026'), findsOneWidget);
      await close(tester);
    });
  });

  group('the copy of "Teruskan dengan data sekarang"', () {
    final copy = {'step': 'copy', 'stepNo': 1, 'steps': 3, 'percent': 41};
    final fit = [
      {'title': 'Kuliah Maghrib', 'bytes': 734003200},
    ];

    testWidgets('the copy step shows its percent as a bar with the number, then the follower step', (tester) async {
      final (_, box) = await openUnlink(tester, unlinkStatusJson(session: sessionJson(stage: 'working', progress: copy)));
      expect(find.text('Langkah 1 daripada 3: menyalin data untuk Box pengikut, 41%'), findsOneWidget);
      expect(tester.widget<LinearProgressIndicator>(find.byKey(const ValueKey('unlink-progress-bar'))).value, closeTo(0.41, 0.001));
      box.status = unlinkStatusJson(session: sessionJson(stage: 'working', progress: {'step': 'carry-on', 'stepNo': 2, 'steps': 3, 'percent': 10}));
      final container = ProviderScope.containerOf(tester.element(find.byKey(const ValueKey('unlink-progress'))));
      await container.read(unlinkControllerProvider.notifier).refresh();
      await settle(tester);
      expect(find.text('Langkah 2 daripada 3: menyimpan data sekarang, 10%'), findsOneWidget);
      await close(tester);
    });

    testWidgets('the videos that do not fit show on the progress once the copy started, and on the result', (tester) async {
      final follower = followerCarry(agreed: true, financeTick: true, videos: fit);
      final (_, box) = await openUnlink(tester, unlinkStatusJson(session: sessionJson(stage: 'working', progress: copy, follower: follower)));
      expect(textHas('Video ini tidak muat di Box itu dan tidak disalin:'), findsOneWidget);
      expect(textHas('Kuliah Maghrib'), findsOneWidget);
      expect(textHas('700 MB'), findsOneWidget);
      box.status = unlinkStatusJson(session: sessionJson(stage: 'done', follower: follower), last: lastJson());
      final container = ProviderScope.containerOf(tester.element(find.byKey(const ValueKey('unlink-progress'))));
      await container.read(unlinkControllerProvider.notifier).refresh();
      await settle(tester);
      expect(find.byKey(const ValueKey('unlink-done')), findsOneWidget);
      expect(textHas('Kuliah Maghrib'), findsOneWidget);
      await close(tester);
    });

    testWidgets('no video left out: no line on the progress', (tester) async {
      await openUnlink(tester, unlinkStatusJson(session: sessionJson(stage: 'working', progress: copy, follower: followerCarry(agreed: true, financeTick: true, videos: []))));
      expect(textHas('Video ini tidak muat'), findsNothing);
      await close(tester);
    });
  });

  group('three languages', () {
    for (final lang in AppLang.values) {
      testWidgets('${lang.name}: the sheet draws, with no overflow, in the language\'s direction', (tester) async {
        final session = sessionOf(sessionJson(follower: followerBack()));
        await pumpAtSize(tester, sheetOf(lang, session), GoldenSize.phone);
        expect(tester.takeException(), isNull);
        final s = S.of(tester.element(find.byType(UnlinkSheetView)));
        expect(find.text(s.unlinkSheetTitle('Ruang Muslimat')), findsOneWidget);
        expect(find.text(s.unlinkAgree), findsOneWidget);
        expect(Directionality.of(tester.element(find.byType(UnlinkSheetView))), lang == AppLang.ar ? TextDirection.rtl : TextDirection.ltr);
        await close(tester);
      });
    }

    testWidgets('ar: the title starts at the right edge and the cards fill the width', (tester) async {
      final session = sessionOf(sessionJson(follower: followerBack()));
      await pumpAtSize(tester, sheetOf(AppLang.ar, session), GoldenSize.phone);
      final title = tester.getTopRight(find.byKey(const ValueKey('unlink-sheet-title')));
      final card = tester.getTopRight(find.byKey(const ValueKey('unlink-choice-back')));
      expect(title.dx, closeTo(card.dx, 1), reason: 'the title and the cards share the right edge');
      expect(tester.getSize(find.byKey(const ValueKey('unlink-choice-back'))).width, greaterThan(300));
      await close(tester);
    });

    testWidgets('en: a refusal in the sheet and the stale notice', (tester) async {
      final session = sessionOf(sessionJson(follower: followerCarry()));
      await pumpAtSize(tester, sheetOf(AppLang.en, session, error: 'finance_tick', stale: true), GoldenSize.phone);
      expect(find.text('The other admin changed the choices. Check them and agree again.'), findsOneWidget);
      expect(find.text('Tick the finance line first.'), findsNothing, reason: 'the sentence is the link flow\'s, not a made up one');
      expect(find.byKey(const ValueKey('unlink-error')), findsOneWidget);
      await close(tester);
    });
  });

  group('goldens', () {
    final back = sessionOf(sessionJson(follower: followerBack()));
    final carry = sessionOf(sessionJson(follower: followerCarry()));
    final working = statusOf(unlinkStatusJson(session: sessionJson(stage: 'working', progress: {'step': 'carry-on', 'stepNo': 2, 'steps': 3, 'percent': 40}))).session!;

    for (final lang in AppLang.values) {
      testWidgets('the sheet, backup chosen, ${lang.name}, phone', (tester) async {
        await tallGolden(tester, sheetOf(lang, back), 'unlink_sheet_${lang.name}_phone', const Size(412, 1500));
      });
      testWidgets('the sheet, carry on, ${lang.name}, phone', (tester) async {
        await tallGolden(tester, sheetOf(lang, carry, tick: true), 'unlink_sheet_carry_${lang.name}_phone', const Size(412, 1300));
      });
      testWidgets('the progress, ${lang.name}, phone', (tester) async {
        await tallGolden(tester, plain(lang, UnlinkProgressView(progress: working.progress)), 'unlink_progress_${lang.name}_phone', const Size(412, 520));
      });
    }

    final copying = statusOf(unlinkStatusJson(session: sessionJson(stage: 'working', progress: {'step': 'copy', 'stepNo': 1, 'steps': 3, 'percent': 41}, follower: followerCarry(agreed: true, financeTick: true)))).session!;
    for (final lang in AppLang.values) {
      testWidgets('the copy with a video left out, ${lang.name}, phone', (tester) async {
        await tallGolden(
          tester,
          plain(lang, UnlinkProgressView(progress: copying.progress, videosNotFit: copying.follower.numbers.videosNotFit)),
          'unlink_copy_${lang.name}_phone',
          const Size(412, 640),
        );
      });
      testWidgets('the join with "Kekal di sini", ${lang.name}, phone', (tester) async {
        final join = statusOf(unlinkStatusJson(session: sessionJson(stage: 'join', join: joinJson()))).session!.join!;
        await tallGolden(
          tester,
          plain(lang, UnlinkJoinView(join: join, masterName: 'Dewan Utama', deviceName: 'Telefon', run: (p, n, d) async => throw StateError('no'), onContinue: (_) {}, onStay: () {})),
          'unlink_join_${lang.name}_phone',
          const Size(412, 860),
        );
      });
    }

    testWidgets('the sheet, backup chosen, ms, iPad', (tester) async {
      await tallGolden(tester, sheetOf(AppLang.ms, back), 'unlink_sheet_ms_ipadMiniPortrait', const Size(744, 1500));
    });
  });
}
