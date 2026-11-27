// The link flow's screens through the whole app over a fake box (real link API, real routes): the entry and its
// checks, the PIN sheet, the scan and its confirmation, the version stop, the wait, the matching code on both
// sides, the ONE questions screen, the progress, the results and a box that now follows another. Goldens: the
// matching code (the approving side and the other side), the questions (phone and iPad) and the progress, each in
// BM, English and Arabic.

import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart' show ProviderScope;
import 'package:flutter_riverpod/misc.dart' show Override;
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:surau_app/app/app_lang.dart';
import 'package:surau_app/app/providers.dart';
import 'package:surau_app/features/link/link_controller.dart';
import 'package:surau_app/features/link/link_models.dart';
import 'package:surau_app/features/link/link_widgets.dart' show LinkBoxCard;
import 'package:surau_app/features/live/fake_publisher.dart';
import 'package:surau_app/features/live/live_screen.dart' show livePublisherProvider;

import '../../golden_sizes.dart';
import '../fakes.dart';
import '../shell/harness.dart';
import 'link_fixtures.dart';

/// The status the fake box answers now; a test changes it between polls.
class Box {
  Box(this.status);

  Map<String, Object?> status;
  int statusCode = 200;
  Map<String, Object?>? statusBody;
  final Map<String, http.Response Function(http.Request)> writes = {};
}

Future<(ShellHarness, Box)> openLink(
  WidgetTester tester,
  Map<String, Object?> status, {
  AppLang lang = AppLang.ms,
  bool lock = false,
  GoldenSize size = GoldenSize.phone,
}) async {
  final overrides = <Override>[
    appLangStoreProvider.overrideWithValue(MemoryAppLangStore(lang)),
    livePublisherProvider.overrideWithValue(FakePublisher()),
    appLockProvider.overrideWithValue(lock),
    linkPollEveryProvider.overrideWithValue(const Duration(hours: 1)),
  ];
  final h = await pumpShell(tester, roles: const ['admin'], overrides: overrides, size: size);
  final box = Box(status);
  h.handlers['GET /api/link/status'] = (r) async => box.statusCode == 200 ? jsonResponse(200, box.status) : jsonResponse(box.statusCode, box.statusBody ?? {});
  h.handlers['GET /api/boxes'] = (r) async => jsonResponse(200, {
    'self': {'boxId': 'b2b2b2b2b2b2b2b2', 'name': 'Ruang Muslimat', 'keyFp': 'b2b2b2b2b2b2b2b2', 'version': '2026.11.13', 'mode': 'main', 'master': null},
    'boxes': <Object?>[],
  });
  for (final route in ['POST /api/link/pin', 'POST /api/link/show', 'POST /api/link/scan', 'POST /api/link/approve', 'PUT /api/link/answers', 'POST /api/link/agree', 'POST /api/link/cancel']) {
    h.handlers[route] = (r) async {
      final w = box.writes[route];
      return w != null ? w(r) : jsonResponse(200, box.status);
    };
  }
  h.router.go('/screens/link');
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

/// A golden of the whole of a long page: the window is [logical] tall at the usual pixel ratio.
Future<void> expectTall(WidgetTester tester, Widget app, String name, Size logical) async {
  tester.view.physicalSize = logical * goldenPixelRatio;
  tester.view.devicePixelRatio = goldenPixelRatio;
  addTearDown(tester.view.resetPhysicalSize);
  addTearDown(tester.view.resetDevicePixelRatio);
  await tester.pumpWidget(app);
  await tester.pumpAndSettle();
  await expectLater(find.byWidget(app), matchesGoldenFile('$name.png'), reason: 'golden $name');
}

Map<String, Object?> questionsStatus({
  int rev = 1,
  String keep = 'scan',
  String master = 'scan',
  bool ownAgreed = false,
  bool peerAgreed = false,
  bool tick = false,
  bool caseX = true,
  Map<String, String> fixed = const {},
  Map<String, Object?>? show,
  Map<String, Object?>? scan,
  Map<String, int>? replaced,
  bool pinFresh = true,
  String phones = 'direct',
}) => statusJson(
  caseX: caseX,
  session: linkSession(
    role: 'show',
    step: 'questions',
    show: show,
    scan: scan,
    answers: answersJson(rev: rev, keep: keep, master: master, financeTick: tick, replaced: replaced, phones: phones),
    fixed: fixed,
    ownAgreed: ownAgreed,
    peerAgreed: peerAgreed,
    pinFresh: pinFresh,
  ),
);

void main() {
  group('entry', () {
    testWidgets('the intro, the two choices, no check failing', (tester) async {
      final (h, _) = await openLink(tester, statusJson());
      expect(find.text('Pautkan MAXCOM Kiosk Box'), findsOneWidget);
      expect(find.byKey(const ValueKey('link-entry')), findsOneWidget);
      expect(find.text('Papar kod di TV ini'), findsOneWidget);
      expect(find.text('Imbas kod MAXCOM Kiosk Box lain'), findsOneWidget);
      expect(find.byKey(const ValueKey('link-block-notLan')), findsNothing);
      expect(h.location, '/screens/link');
      await close(tester);
    });

    testWidgets('not on the surau Wi-Fi: the sentence, and neither choice opens', (tester) async {
      await openLink(tester, statusJson(lan: false));
      expect(find.text('Pautan MAXCOM Kiosk Box hanya boleh dibuat di Wi-Fi surau.'), findsOneWidget);
      await tester.tap(find.byKey(const ValueKey('link-choice-show')));
      await settle(tester);
      expect(find.byKey(const ValueKey('link-pin-sheet')), findsNothing);
      expect(find.byKey(const ValueKey('link-scan')), findsNothing);
      await close(tester);
    });

    testWidgets('a live broadcast: the sentence from the plan', (tester) async {
      await openLink(tester, statusJson(live: true));
      expect(find.text('Hentikan siaran langsung dahulu, kemudian cuba lagi.'), findsOneWidget);
      await close(tester);
    });

    testWidgets('a box that already follows another: the pointer, nothing to start', (tester) async {
      final (_, box) = await openLink(tester, statusJson());
      box.statusCode = 409;
      box.statusBody = {
        'code': 'follower',
        'errors': ['follower'],
        'master': {'name': 'Dewan Utama', 'boxId': 'a1a1a1a1a1a1a1a1', 'addresses': ['https://10.168.50.10:8443'], 'caSha256': 'c' * 64},
      };
      await tester.pump(const Duration(hours: 1));
      await settle(tester);
      expect(find.text('Surau anda kini diurus dari MAXCOM Kiosk Box utama Dewan Utama.'), findsOneWidget);
      expect(find.byKey(const ValueKey('link-choice-show')), findsNothing);
      await close(tester);
    });
  });

  group('show the code', () {
    testWidgets('with the app lock on: the PIN sheet, a wrong PIN says so and stays, the right one shows the wait', (tester) async {
      final (h, box) = await openLink(tester, statusJson(), lock: true);
      await tapKey(tester, 'link-choice-show');
      expect(find.byKey(const ValueKey('link-pin-sheet')), findsOneWidget);
      expect(find.text('Ruang Muslimat akan memaparkan kod pautan di TV selama 5 minit.'), findsOneWidget);
      expect(tester.widget<FilledButton>(find.byKey(const ValueKey('link-pin-go'))).onPressed, isNull, reason: 'six digits first');

      box.writes['POST /api/link/show'] = (r) => jsonResponse(401, {'code': 'wrong_pin', 'errors': ['wrong_pin']});
      await tester.enterText(find.byKey(const ValueKey('link-pin-field')), '482913');
      await tester.pump();
      await tester.tap(find.byKey(const ValueKey('link-pin-go')));
      await settle(tester);
      expect(sent(h, '/api/link/show'), {'pin': '482913'});
      expect(find.text('PIN salah. Cuba lagi.'), findsOneWidget);
      expect(find.byKey(const ValueKey('link-pin-sheet')), findsOneWidget);
      expect(h.location, '/screens/link', reason: 'a wrong PIN is not an ended session');

      box.writes['POST /api/link/show'] = (r) => jsonResponse(200, box.status);
      box.status = statusJson(session: linkSession(step: 'qr', expiresAt: '2026-11-21T09:55:00.000Z'));
      await tester.enterText(find.byKey(const ValueKey('link-pin-field')), '739204');
      await tester.pump();
      await tester.tap(find.byKey(const ValueKey('link-pin-go')));
      await settle(tester);
      expect(find.byKey(const ValueKey('link-pin-sheet')), findsNothing);
      expect(find.byKey(const ValueKey('link-waiting')), findsOneWidget);
      expect(find.text('Kod pautan di TV Dewan Utama'), findsOneWidget);
      await close(tester);
    });

    testWidgets('with the app lock off there is no PIN sheet and no PIN in the request', (tester) async {
      final (h, box) = await openLink(tester, statusJson());
      box.status = statusJson(session: linkSession(step: 'qr'));
      await tapKey(tester, 'link-choice-show');
      expect(find.byKey(const ValueKey('link-pin-sheet')), findsNothing);
      expect(sent(h, '/api/link/show'), <String, dynamic>{});
      expect(find.byKey(const ValueKey('link-waiting')), findsOneWidget);
      await close(tester);
    });

    testWidgets('"Tutup kod sekarang" cancels the session', (tester) async {
      final (h, box) = await openLink(tester, statusJson(session: linkSession(step: 'qr', expiresAt: '2026-11-21T09:55:00.000Z')));
      expect(find.byKey(const ValueKey('link-countdown')), findsOneWidget);
      box.status = statusJson();
      await tapKey(tester, 'link-wait-close');
      expect(count(h, '/api/link/cancel'), 1);
      expect(find.byKey(const ValueKey('link-entry')), findsOneWidget);
      await close(tester);
    });

    testWidgets('a refusal of "show" is worded in the language, never as the box sent it', (tester) async {
      final (_, box) = await openLink(tester, statusJson());
      box.writes['POST /api/link/show'] = (r) => jsonResponse(409, {'code': 'session_open', 'errors': ['English words of the box']});
      await tapKey(tester, 'link-choice-show');
      expect(find.text('Satu pautan sedang berjalan di MAXCOM Kiosk Box ini. Batalkan dahulu atau tunggu ia tamat.'), findsOneWidget);
      expect(find.text('English words of the box'), findsNothing);
      await close(tester);
    });

    testWidgets('a code the app does not know gets the generic sentence', (tester) async {
      final (_, box) = await openLink(tester, statusJson());
      box.writes['POST /api/link/show'] = (r) => jsonResponse(409, {'code': 'a_newer_code', 'errors': ['x']});
      await tapKey(tester, 'link-choice-show');
      expect(find.text('Pautan tidak dapat diteruskan. Cuba lagi.'), findsOneWidget);
      await close(tester);
    });
  });

  group('scan', () {
    testWidgets('a QR is checked on the phone; the box is named with its key fingerprint; Teruskan sends the raw text', (tester) async {
      final (h, box) = await openLink(tester, statusJson());
      await tapKey(tester, 'link-choice-scan');
      expect(find.byKey(const ValueKey('link-scan')), findsOneWidget);
      final qr = await signedLinkQr();
      await tester.enterText(find.byKey(const ValueKey('link-scan-paste')), qr);
      await tapKey(tester, 'link-scan-paste-go');
      expect(find.text('Pautkan dengan MAXCOM Dewan Utama?'), findsOneWidget);
      expect(find.byKey(const ValueKey('link-confirm-fp')), findsOneWidget);
      expect(count(h, '/api/link/scan'), 0, reason: 'nothing leaves before Teruskan');

      box.status = statusJson(session: linkSession(role: 'scan', step: 'code'));
      await tapKey(tester, 'link-confirm-go');
      expect(sent(h, '/api/link/scan')['qr'], qr);
      expect(find.byKey(const ValueKey('link-code-title')), findsOneWidget);
      await close(tester);
    });

    testWidgets('a QR that is not a link code is refused on the phone', (tester) async {
      final (h, _) = await openLink(tester, statusJson());
      await tapKey(tester, 'link-choice-scan');
      await tester.enterText(find.byKey(const ValueKey('link-scan-paste')), await signedLinkQr(type: 'setup'));
      await tapKey(tester, 'link-scan-paste-go');
      expect(find.text('Kod ini bukan kod pautan MAXCOM Kiosk Box yang sah.'), findsOneWidget);
      expect(count(h, '/api/link/scan'), 0);
      await close(tester);
    });

    testWidgets('the version stop names the box that is behind and its release (this phone box is behind)', (tester) async {
      final (_, box) = await openLink(tester, statusJson());
      await tapKey(tester, 'link-choice-scan');
      await tester.enterText(find.byKey(const ValueKey('link-scan-paste')), await signedLinkQr());
      await tapKey(tester, 'link-scan-paste-go');
      box.writes['POST /api/link/scan'] = (r) => jsonResponse(409, {'code': 'version', 'behind': 'scan', 'errors': ['version']});
      await tapKey(tester, 'link-confirm-go');
      expect(find.byKey(const ValueKey('link-stop')), findsOneWidget);
      expect(find.text('MAXCOM Kiosk Box Ruang Muslimat menggunakan versi 2026.11.13. Kemas kini Box itu, kemudian cuba lagi.'), findsOneWidget);
      await tapKey(tester, 'link-stop-close');
      expect(find.byKey(const ValueKey('link-entry')), findsOneWidget);
      await close(tester);
    });

    testWidgets('the version stop when the other box is behind names it from the QR, without a release', (tester) async {
      final (_, box) = await openLink(tester, statusJson());
      await tapKey(tester, 'link-choice-scan');
      await tester.enterText(find.byKey(const ValueKey('link-scan-paste')), await signedLinkQr());
      await tapKey(tester, 'link-scan-paste-go');
      box.writes['POST /api/link/scan'] = (r) => jsonResponse(409, {'code': 'db_level', 'behind': 'show', 'errors': ['db_level']});
      await tapKey(tester, 'link-confirm-go');
      expect(find.text('MAXCOM Kiosk Box MAXCOM Dewan Utama menggunakan versi yang lebih lama. Kemas kini Box itu, kemudian cuba lagi.'), findsOneWidget);
      await close(tester);
    });

    testWidgets('with the lock on, the PIN is asked at Teruskan and sent with the QR', (tester) async {
      final (h, box) = await openLink(tester, statusJson(), lock: true);
      await tapKey(tester, 'link-choice-scan');
      final qr = await signedLinkQr();
      await tester.enterText(find.byKey(const ValueKey('link-scan-paste')), qr);
      await tapKey(tester, 'link-scan-paste-go');
      await tapKey(tester, 'link-confirm-go');
      expect(find.byKey(const ValueKey('link-pin-sheet')), findsOneWidget);
      box.status = statusJson(session: linkSession(role: 'scan', step: 'code'));
      await tester.enterText(find.byKey(const ValueKey('link-pin-field')), '739204');
      await tester.pump();
      await tester.tap(find.byKey(const ValueKey('link-pin-go')));
      await settle(tester);
      expect(sent(h, '/api/link/scan'), {'pin': '739204', 'qr': qr});
      await close(tester);
    });
  });

  group('the matching code', () {
    testWidgets('the approving side: the code, the other box\'s numbers, Setuju and Tolak', (tester) async {
      final (h, box) = await openLink(tester, statusJson(session: linkSession(step: 'code')));
      expect(find.byKey(const ValueKey('link-code')), findsOneWidget);
      expect(tester.widget<Text>(find.byKey(const ValueKey('link-code'))).data, '482 193');
      expect(find.byKey(const ValueKey('link-code-ltr')), findsOneWidget);
      expect(find.text('5 pengguna, 14 kandungan'), findsOneWidget);
      box.status = statusJson(session: linkSession(step: 'questions', answers: answersJson()));
      await tapKey(tester, 'link-code-approve');
      expect(sent(h, '/api/link/approve'), {'ok': true});
      await close(tester);
    });

    testWidgets('Tolak sends ok false and the screen shows the result', (tester) async {
      final (h, box) = await openLink(tester, statusJson(session: linkSession(step: 'code')));
      box.writes['POST /api/link/approve'] = (r) => jsonResponse(409, {'code': 'rejected', 'errors': ['rejected']});
      box.status = statusJson(last: {'id': 'r1', 'outcome': 'rejected', 'finishedAt': '2026-11-21T09:40:00.000Z', 'role': 'show'});
      await tapKey(tester, 'link-code-reject');
      expect(sent(h, '/api/link/approve'), {'ok': false});
      expect(find.text('Pautan dibatalkan'), findsOneWidget);
      expect(find.text('Pautan ditolak.'), findsOneWidget);
      await close(tester);
    });

    testWidgets('the other side only shows the code and waits; it can cancel', (tester) async {
      final (h, box) = await openLink(tester, statusJson(session: linkSession(role: 'scan', step: 'code')));
      expect(find.text('Tunjukkan kod ini kepada pentadbir MAXCOM Kiosk Box yang satu lagi'), findsOneWidget);
      expect(find.byKey(const ValueKey('link-code')), findsOneWidget);
      expect(find.byKey(const ValueKey('link-code-approve')), findsNothing);
      expect(find.byKey(const ValueKey('link-code-reject')), findsNothing);
      box.status = statusJson();
      await tapKey(tester, 'link-code-cancel');
      expect(count(h, '/api/link/cancel'), 1);
      await close(tester);
    });

    testWidgets('a new box that shows the QR: one button, "Kod sama"', (tester) async {
      final (h, _) = await openLink(
        tester,
        statusJson(session: linkSession(role: 'scan', step: 'code', show: ruangMuslimat(setUp: false), scan: dewanUtama())),
      );
      expect(find.byKey(const ValueKey('link-code-same')), findsOneWidget);
      expect(find.byKey(const ValueKey('link-code-approve')), findsNothing);
      expect(find.byKey(const ValueKey('link-code-reject')), findsNothing);
      await tapKey(tester, 'link-code-same');
      expect(sent(h, '/api/link/approve'), {'ok': true});
      await close(tester);
    });

    for (final lang in AppLang.values) {
      testWidgets('golden: the approving side in ${lang.name}', (tester) async {
        final (h, _) = await openLink(tester, statusJson(session: linkSession(step: 'code')), lang: lang);
        expect(tester.takeException(), isNull);
        await expectGoldens(tester, h.app, 'link_code_approve_${lang.name}', sizes: const [GoldenSize.phone]);
        await close(tester);
      });
      testWidgets('golden: the other side in ${lang.name}', (tester) async {
        final (h, _) = await openLink(tester, statusJson(session: linkSession(role: 'scan', step: 'code')), lang: lang);
        expect(tester.takeException(), isNull);
        await expectGoldens(tester, h.app, 'link_code_show_${lang.name}', sizes: const [GoldenSize.phone]);
        await close(tester);
      });
    }
  });

  group('the questions', () {
    testWidgets('both questions, the facts, the advice, what is replaced, the backup line and the worded button', (tester) async {
      final (_, _) = await openLink(tester, questionsStatus());
      expect(find.text('Data MAXCOM Kiosk Box mana yang dikekalkan?'), findsOneWidget);
      expect(find.text('MAXCOM Kiosk Box mana menjadi Box utama?'), findsOneWidget);
      for (final k in ['link-q1-show', 'link-q1-scan', 'link-q2-show', 'link-q2-scan']) {
        expect(find.byKey(ValueKey(k)), findsOneWidget, reason: k);
      }
      expect(find.text('Disyorkan: Dewan Utama (PC Windows, kabel)'), findsOneWidget);
      final replaced = find.byKey(const ValueKey('link-replaced'));
      await reveal(tester, replaced);
      expect(find.textContaining('Data Dewan Utama akan diganti: 9 kandungan, 3 poster, 1 video, 148 rekod kewangan. Data Ruang Muslimat dikekalkan.'), findsOneWidget);
      expect(find.byKey(const ValueKey('link-backup')), findsOneWidget);
      expect(find.textContaining('Sandaran kedua-dua MAXCOM Kiosk Box diambil dahulu:'), findsOneWidget);
      await reveal(tester, find.byKey(const ValueKey('link-agree')));
      expect(find.text('Setuju: kekalkan data Ruang Muslimat, Ruang Muslimat menjadi Box utama'), findsOneWidget);
      expect(find.text('Dewan Utama: belum setuju'), findsOneWidget);
      await close(tester);
    });

    testWidgets('the third question: "Sambung terus" is the default and fills the choice; the other asks for a join code', (tester) async {
      await openLink(tester, questionsStatus());
      await reveal(tester, find.byKey(const ValueKey('link-q3-direct')));
      expect(find.text('Telefon pengguna Box ini'), findsOneWidget);
      expect(find.text('Sambung terus ke Box utama'), findsOneWidget);
      expect(find.text('Minta kod sertai untuk pentadbir'), findsOneWidget);
      expect(tester.widget<LinkBoxCard>(find.byKey(const ValueKey('link-q3-direct'))).selected, isTrue);
      expect(tester.widget<LinkBoxCard>(find.byKey(const ValueKey('link-q3-code'))).selected, isFalse);
      await close(tester);
    });

    testWidgets('the third question shows the strict choice when the box says "code"', (tester) async {
      await openLink(tester, questionsStatus(phones: 'code'));
      await reveal(tester, find.byKey(const ValueKey('link-q3-code')));
      expect(tester.widget<LinkBoxCard>(find.byKey(const ValueKey('link-q3-code'))).selected, isTrue);
      expect(tester.widget<LinkBoxCard>(find.byKey(const ValueKey('link-q3-direct'))).selected, isFalse);
      await close(tester);
    });

    testWidgets('choosing "Minta kod sertai" is one PUT with the whole answer and phones code', (tester) async {
      final (h, box) = await openLink(tester, questionsStatus());
      box.status = questionsStatus(rev: 2, phones: 'code');
      await tapKey(tester, 'link-q3-code');
      expect(sent(h, '/api/link/answers', method: 'PUT'), {'keep': 'scan', 'master': 'scan', 'roles': <String, dynamic>{}, 'same': <dynamic>[], 'phones': 'code', 'financeTick': false});
      await close(tester);
    });

    testWidgets('a change of the kept data keeps the phones choice', (tester) async {
      final (h, box) = await openLink(tester, questionsStatus(phones: 'code'));
      box.status = questionsStatus(rev: 2, keep: 'show', master: 'show', phones: 'code');
      await tapKey(tester, 'link-q1-show');
      expect(sent(h, '/api/link/answers', method: 'PUT')['phones'], 'code');
      await close(tester);
    });

    test('an answer from an older box without the phones choice reads as the strict "code"', () {
      final j = answersJson()..remove('phones');
      expect(LinkAnswers.fromJson(j).phones, LinkPhones.code);
      expect(LinkAnswers.fromJson(answersJson()).phones, LinkPhones.direct);
    });

    testWidgets('a new box that only receives: no third question', (tester) async {
      await openLink(
        tester,
        questionsStatus(
          show: dewanUtama(finance: 0),
          scan: ruangMuslimat(setUp: false),
          keep: 'show',
          master: 'show',
          fixed: {'keep': 'show'},
          replaced: {'content': 0, 'posters': 0, 'videos': 0, 'finance': 0},
        ),
      );
      expect(find.byKey(const ValueKey('link-q3-direct')), findsNothing);
      await close(tester);
    });

    testWidgets('a tap on a card is one PUT with the whole answer', (tester) async {
      final (h, box) = await openLink(tester, questionsStatus());
      box.status = questionsStatus(rev: 2, keep: 'show', master: 'show');
      await tapKey(tester, 'link-q1-show');
      expect(sent(h, '/api/link/answers', method: 'PUT'), {'keep': 'show', 'master': 'show', 'roles': <String, dynamic>{}, 'same': <dynamic>[], 'phones': 'direct', 'financeTick': false});
      expect(find.byKey(const ValueKey('link-stale')), findsNothing);
      await close(tester);
    });

    testWidgets('Setuju stays off until the finance tick is on, then agrees to this revision', (tester) async {
      final (h, box) = await openLink(tester, questionsStatus(rev: 3));
      final agree = find.byKey(const ValueKey('link-agree'));
      await reveal(tester, agree);
      expect(tester.widget<FilledButton>(agree).onPressed, isNull);
      expect(find.text('Tandakan pengesahan rekod kewangan dahulu.'), findsOneWidget);
      box.status = questionsStatus(rev: 4, tick: true);
      await tapKey(tester, 'link-tick');
      expect(sent(h, '/api/link/answers', method: 'PUT')['financeTick'], isTrue);
      await reveal(tester, agree);
      expect(tester.widget<FilledButton>(agree).onPressed, isNotNull);
      box.status = questionsStatus(rev: 4, tick: true, ownAgreed: true);
      await tester.tap(agree);
      await settle(tester);
      expect(sent(h, '/api/link/agree'), {'rev': 4});
      expect(find.text('Dewan Utama: setuju'), findsOneWidget);
      expect(find.text('Ruang Muslimat: belum setuju'), findsOneWidget);
      expect(find.text('Menunggu Ruang Muslimat'), findsOneWidget);
      expect(tester.widget<FilledButton>(find.byKey(const ValueKey('link-agree'))).onPressed, isNull);
      await close(tester);
    });

    testWidgets('no finance records to replace: no tick, Setuju works at once', (tester) async {
      await openLink(tester, questionsStatus(replaced: {'content': 9, 'posters': 3, 'videos': 1, 'finance': 0}));
      expect(find.byKey(const ValueKey('link-tick')), findsNothing);
      final agree = find.byKey(const ValueKey('link-agree'));
      await reveal(tester, agree);
      expect(tester.widget<FilledButton>(agree).onPressed, isNotNull);
      await close(tester);
    });

    testWidgets('a box that wants the PIN again: the sheet, the PIN, then Setuju once more', (tester) async {
      final (h, box) = await openLink(tester, questionsStatus(tick: true, pinFresh: false), lock: true);
      var agrees = 0;
      box.writes['POST /api/link/agree'] = (r) {
        agrees++;
        return agrees == 1 ? jsonResponse(401, {'code': 'pin_required', 'errors': ['pin_required']}) : jsonResponse(200, box.status);
      };
      await tapKey(tester, 'link-agree');
      expect(find.byKey(const ValueKey('link-pin-sheet')), findsOneWidget);
      expect(h.location, '/screens/link', reason: 'pin_required is not an ended session');
      await tester.enterText(find.byKey(const ValueKey('link-pin-field')), '739204');
      await tester.pump();
      await tester.tap(find.byKey(const ValueKey('link-pin-go')));
      await settle(tester);
      expect(sent(h, '/api/link/pin'), {'pin': '739204'});
      expect(agrees, 2);
      expect(find.byKey(const ValueKey('link-pin-sheet')), findsNothing);
      await close(tester);
    });

    testWidgets('the other admin changes the answers: the notice, from the next poll', (tester) async {
      final (h, box) = await openLink(tester, questionsStatus());
      expect(find.byKey(const ValueKey('link-stale')), findsNothing);
      box.status = questionsStatus(rev: 2, keep: 'show', master: 'show');
      await h.container.read(linkControllerProvider.notifier).refresh();
      await settle(tester);
      expect(find.text('Pentadbir lain menukar pilihan. Semak dan setuju sekali lagi.'), findsOneWidget);
      await close(tester);
    });

    testWidgets('a stale revision on Setuju shows the same notice', (tester) async {
      final (_, box) = await openLink(tester, questionsStatus(tick: true));
      box.writes['POST /api/link/agree'] = (r) => jsonResponse(409, {'code': 'stale_revision', 'rev': 2, 'errors': ['stale_revision']});
      box.status = questionsStatus(rev: 2, keep: 'show', master: 'show', tick: true);
      await tapKey(tester, 'link-agree');
      expect(find.text('Pentadbir lain menukar pilihan. Semak dan setuju sekali lagi.'), findsOneWidget);
      await close(tester);
    });

    testWidgets('case X off: the other box is not a choice for the master, and the line says why', (tester) async {
      final (h, _) = await openLink(tester, questionsStatus(caseX: false));
      expect(find.text('Dalam keluaran ini MAXCOM Kiosk Box utama mestilah Box yang datanya dikekalkan.'), findsOneWidget);
      final other = find.byKey(const ValueKey('link-q2-show'));
      await reveal(tester, other);
      await tester.tap(other, warnIfMissed: false);
      await settle(tester);
      expect(count(h, '/api/link/answers', method: 'PUT'), 0);
      await close(tester);
    });

    testWidgets('a box with followers is fixed as the master and as the kept data, with the reason', (tester) async {
      final (h, _) = await openLink(
        tester,
        questionsStatus(show: dewanUtama(followers: 1), keep: 'show', master: 'show', fixed: {'keep': 'show', 'master': 'show'}),
      );
      expect(find.byKey(const ValueKey('link-q1-fixed')), findsOneWidget);
      expect(find.byKey(const ValueKey('link-q2-fixed')), findsOneWidget);
      expect(find.text('Dewan Utama sudah mempunyai MAXCOM Kiosk Box pengikut, jadi ia kekal sebagai Box utama dan datanya dikekalkan.'), findsNWidgets(2));
      await tester.tap(find.byKey(const ValueKey('link-q1-scan')), warnIfMissed: false);
      await settle(tester);
      expect(count(h, '/api/link/answers', method: 'PUT'), 0);
      await close(tester);
    });

    testWidgets('a new box: its card says it has no data, nothing is replaced, no backup line, no tick', (tester) async {
      await openLink(
        tester,
        questionsStatus(
          show: dewanUtama(finance: 0),
          scan: ruangMuslimat(setUp: false),
          keep: 'show',
          master: 'show',
          fixed: {'keep': 'show'},
          replaced: {'content': 0, 'posters': 0, 'videos': 0, 'finance': 0},
        ),
      );
      expect(find.text('MAXCOM Kiosk Box baharu tiada data'), findsWidgets);
      await reveal(tester, find.byKey(const ValueKey('link-replaced')));
      expect(find.text('Tiada data diganti. Semua data Dewan Utama dikekalkan.'), findsOneWidget);
      expect(find.byKey(const ValueKey('link-backup')), findsNothing);
      expect(find.byKey(const ValueKey('link-tick')), findsNothing);
      await close(tester);
    });

    testWidgets('data and master on different boxes: the note says what happens', (tester) async {
      await openLink(tester, questionsStatus(keep: 'scan', master: 'show'));
      await reveal(tester, find.byKey(const ValueKey('link-cross')));
      expect(find.text('Data dan MAXCOM Kiosk Box utama berbeza'), findsOneWidget);
      await close(tester);
    });

    testWidgets('"Butiran lain" is folded and opens with one tap', (tester) async {
      await openLink(tester, questionsStatus());
      final more = find.byKey(const ValueKey('link-more'));
      await reveal(tester, more);
      expect(find.text('Skrin pelayar perlu dipadankan semula selepas pautan.'), findsNothing);
      await tester.tap(more);
      await settle(tester);
      await reveal(tester, find.text('Skrin pelayar perlu dipadankan semula selepas pautan.'));
      expect(find.text('Skrin pelayar perlu dipadankan semula selepas pautan.'), findsOneWidget);
      expect(find.text('Pengguna kedua-dua MAXCOM Kiosk Box digabungkan: 3 di Dewan Utama, 5 di Ruang Muslimat.'), findsOneWidget);
      await close(tester);
    });

    for (final lang in AppLang.values) {
      testWidgets('golden: the questions in ${lang.name}', (tester) async {
        final (h, _) = await openLink(tester, questionsStatus(), lang: lang);
        expect(tester.takeException(), isNull);
        // The screen is long: the window is made tall enough to hold all of it.
        await expectTall(tester, h.app, 'link_questions_${lang.name}_phone', const Size(412, 3000));
        await expectTall(tester, h.app, 'link_questions_${lang.name}_ipadMiniPortrait', const Size(744, 2300));
        await close(tester);
      });
    }
  });

  group('progress and the result', () {
    testWidgets('the step in words with the percent; both boxes the same', (tester) async {
      await openLink(tester, statusJson(session: linkSession(step: 'working'), progress: {'linkId': 'l' * 32, 'step': 'people', 'stepNo': 2, 'steps': 4, 'percent': 62}));
      expect(find.text('Langkah 2 daripada 4: menggabungkan pengguna, 62%'), findsOneWidget);
      await close(tester);
    });

    testWidgets('the store move of a case X link (step commit) shows its percent as a bar with the number', (tester) async {
      await openLink(tester, statusJson(session: linkSession(step: 'working'), progress: {'linkId': 'l' * 32, 'step': 'commit', 'stepNo': 3, 'steps': 4, 'percent': 55}));
      expect(find.text('Langkah 3 daripada 4: memuktamadkan pautan, 55%'), findsOneWidget);
      expect(tester.widget<LinearProgressIndicator>(find.byKey(const ValueKey('link-progress-bar'))).value, closeTo(0.55, 0.001));
      await close(tester);
    });

    testWidgets('a percent outside 0 to 100 is held inside the bar', (tester) async {
      await openLink(tester, statusJson(session: linkSession(step: 'working'), progress: {'linkId': 'l' * 32, 'step': 'commit', 'stepNo': 3, 'steps': 4, 'percent': 180}));
      expect(find.text('Langkah 3 daripada 4: memuktamadkan pautan, 100%'), findsOneWidget);
      await close(tester);
    });

    testWidgets('agreed and no progress yet: the link is starting', (tester) async {
      await openLink(tester, statusJson(session: linkSession(step: 'agreed')));
      expect(find.text('Pautan sedang bermula'), findsOneWidget);
      await close(tester);
    });

    for (final lang in AppLang.values) {
      testWidgets('golden: the progress in ${lang.name}', (tester) async {
        final (h, _) = await openLink(
          tester,
          statusJson(session: linkSession(step: 'working'), progress: {'linkId': 'l' * 32, 'step': 'commit', 'stepNo': 3, 'steps': 4, 'percent': null}),
          lang: lang,
        );
        expect(tester.takeException(), isNull);
        await expectGoldens(tester, h.app, 'link_progress_${lang.name}', sizes: const [GoldenSize.phone]);
        await close(tester);
      });
    }

    testWidgets('after a case X link the new recovery code is shown once, then "Pautan siap"; a reload does not bring it back', (tester) async {
      const code = 'ABCD-EFGH-JKLM-NPQR';
      final linked = {'id': 'r6', 'outcome': 'linked', 'finishedAt': '2026-11-21T09:45:00.000Z', 'role': 'show'};
      final (_, box) = await openLink(tester, statusJson(last: linked, recoveryCode: code));
      expect(find.byKey(const ValueKey('link-recovery')), findsOneWidget);
      expect(find.text('Simpan kod ini'), findsOneWidget);
      expect(find.text(code), findsOneWidget);
      expect(find.text('Pautan siap'), findsNothing, reason: 'the code comes before the result');
      // the box gave it once: the next poll has none, and the screen still shows what it was given
      box.status = statusJson(last: linked);
      final container = ProviderScope.containerOf(tester.element(find.byKey(const ValueKey('link-recovery'))));
      await container.read(linkControllerProvider.notifier).refresh();
      await settle(tester);
      expect(find.text(code), findsOneWidget);
      expect(container.read(linkControllerProvider).status!.recoveryCode, isNull, reason: 'the status read again never holds the code');
      // "Teruskan" waits for the tick that it was written down
      FilledButton go() => tester.widget<FilledButton>(find.byKey(const ValueKey('recovery-code-continue')));
      expect(go().onPressed, isNull);
      await tapKey(tester, 'recovery-code-written');
      await tapKey(tester, 'recovery-code-continue');
      expect(find.text(code), findsNothing);
      expect(container.read(linkControllerProvider).recoveryCode, isNull);
      expect(find.text('Pautan siap'), findsOneWidget);
      await close(tester);

      // a reload: a fresh run of the app reads the status again and the code is not there
      await openLink(tester, statusJson(last: linked));
      expect(find.byKey(const ValueKey('link-recovery')), findsNothing);
      expect(find.text('Pautan siap'), findsOneWidget);
      await close(tester);
    });

    testWidgets('a link of two set up boxes brings no recovery code: the result is as before', (tester) async {
      await openLink(tester, statusJson(last: {'id': 'r7', 'outcome': 'linked', 'finishedAt': '2026-11-21T09:45:00.000Z', 'role': 'show'}));
      expect(find.byKey(const ValueKey('link-recovery')), findsNothing);
      expect(find.text('Pautan siap'), findsOneWidget);
      await close(tester);
    });

    testWidgets('done: Pautan siap with what to do next', (tester) async {
      final (h, _) = await openLink(tester, statusJson(last: {'id': 'r5', 'outcome': 'linked', 'finishedAt': '2026-11-21T09:45:00.000Z', 'role': 'show'}));
      expect(find.text('Pautan siap'), findsOneWidget);
      expect(find.text('Kedua-dua MAXCOM Kiosk Box kini dipautkan. Tetapan dan kandungan diurus dari Box utama.'), findsOneWidget);
      expect(find.textContaining('sertai Box utama dengan kod sertai'), findsOneWidget);
      await tapKey(tester, 'link-done-close');
      expect(find.byKey(const ValueKey('link-entry')), findsOneWidget);
      expect(h.location, '/screens/link');
      await close(tester);
    });

    testWidgets('every other outcome is "Pautan dibatalkan" with its reason', (tester) async {
      final reasons = {
        'cancelled': 'Anda membatalkan pautan. Tiada data diubah.',
        'cancelled_by_peer': 'Pentadbir MAXCOM Kiosk Box yang satu lagi membatalkan pautan. Tiada data diubah.',
        'rejected_by_peer': 'Pentadbir MAXCOM Kiosk Box yang satu lagi menolak pautan. Tiada data diubah.',
        'expired': 'Masa tamat sebelum pautan selesai. Tiada data diubah.',
        'approve_timeout': 'Kod tidak disetujui dalam masa 2 minit. Tiada data diubah.',
        'restart': 'MAXCOM Kiosk Box dimulakan semula semasa pautan. Tiada data diubah; mulakan pautan sekali lagi.',
        'failed': 'Pautan tidak dapat disiapkan. Semak keadaan kedua-dua MAXCOM Kiosk Box, kemudian cuba lagi.',
        'peer_unreachable': 'MAXCOM Kiosk Box yang satu lagi tidak dapat dihubungi. Pastikan kedua-dua Box berada di Wi-Fi surau yang sama.',
        'case_x_unavailable': 'Dalam keluaran ini MAXCOM Kiosk Box utama mestilah Box yang datanya dikekalkan.',
        'version': 'Kedua-dua MAXCOM Kiosk Box mesti menjalankan versi yang sama. Kemas kini Box yang lebih lama, kemudian cuba lagi.',
      };
      for (final e in reasons.entries) {
        await openLink(tester, statusJson(last: {'id': 'r-${e.key}', 'outcome': e.key, 'finishedAt': '2026-11-21T09:45:00.000Z', 'role': 'show'}));
        expect(find.text('Pautan dibatalkan'), findsOneWidget, reason: e.key);
        expect(find.text(e.value), findsOneWidget, reason: e.key);
        await close(tester);
      }
    });
  });

  group('English and Arabic', () {
    testWidgets('the entry in English', (tester) async {
      await openLink(tester, statusJson(lan: false), lang: AppLang.en);
      expect(find.text('Link MAXCOM Kiosk Boxes'), findsOneWidget);
      expect(find.text('MAXCOM Kiosk Boxes can only be linked on the surau Wi-Fi.'), findsOneWidget);
      await close(tester);
    });

    testWidgets('the code in Arabic is read left to right inside a mirrored page', (tester) async {
      await openLink(tester, statusJson(session: linkSession(step: 'code')), lang: AppLang.ar);
      final d = tester.widget<Directionality>(find.byKey(const ValueKey('link-code-ltr')));
      expect(d.textDirection, TextDirection.ltr);
      expect(tester.widget<Text>(find.byKey(const ValueKey('link-code'))).data, '482 193');
      await close(tester);
    });
  });
}
