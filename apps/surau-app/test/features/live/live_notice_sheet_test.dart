// The live notice sheet (W6): the one big button that suits the device, the
// small ones, the box's shared text, the picture and its fallbacks, the QR,
// and the scenarios of the brief (who started the live, who shares it).

import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/misc.dart' show Override;
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:surau_app/app/app_lang.dart';
import 'package:surau_app/features/finance/share.dart' show ShareFailed, ShareResult;
import 'package:surau_app/features/live/fake_publisher.dart';
import 'package:surau_app/features/live/live_controller.dart' show LiveController, liveBoxProvider;
import 'package:surau_app/features/live/live_notice.dart';
import 'package:surau_app/features/live/live_screen.dart' show livePublisherProvider;
import 'package:surau_app/features/live/live_notice_box.dart';
import 'package:surau_app/features/live/live_notice_card.dart';
import 'package:surau_app/features/live/live_notice_share.dart';
import 'package:surau_app/features/live/live_notice_sheet.dart';

import '../../golden_sizes.dart';
import '../fakes.dart';
import '../shell/harness.dart';

const _id = 'AAAAAAAAAAA';
const _link = 'https://www.youtube.com/live/AAAAAAAAAAA';

// The harness clock is 2026-11-04 22:30 in Malaysia.
final _input = LiveNoticeInput(
  videoId: _id,
  slot: 'maghrib',
  label: 'Kuliah Maghrib',
  start: DateTime(2026, 11, 4, 19, 15),
  speaker: 'Ustaz Ahmad',
  kitab: 'Kitab Contoh',
  surau: 'Surau Perintis Contoh',
);

const _bmText =
    "Assalamu'alaikum warahmatullah.\n"
    'Ikuti *Kuliah Maghrib* di *Surau Perintis Contoh* bersama *Ustaz Ahmad*.\n'
    'Tajuk: *Kitab Contoh*\n'
    '$_link';

final Uint8List _jpeg = Uint8List.fromList([0xFF, 0xD8, 0xFF, 0xE0, 1, 2, 3]);
final Uint8List _frame = Uint8List.fromList([0xFF, 0xD8, 0xAA, 0xAA]);
final Uint8List _photo = Uint8List.fromList([0xFF, 0xD8, 0xCC, 0xCC]);

class _Shared {
  _Shared(this.text, this.picture, this.toWhatsApp);
  final String text;
  final Uint8List? picture;
  final bool toWhatsApp;
}

class FakePlatform implements LiveNoticePlatform {
  FakePlatform({this.isWeb = false, this.whatsApp = true});

  @override
  final bool isWeb;
  final bool whatsApp;
  final shares = <_Shared>[];
  int cleans = 0;
  ShareResult result = const ShareResult('whatsapp');
  Object? failWith;

  @override
  Future<bool> whatsAppInstalled() async => whatsApp;

  @override
  Future<ShareResult> share(String text, {Uint8List? picture, bool toWhatsApp = false}) async {
    if (failWith != null) throw failWith!;
    shares.add(_Shared(text, picture, toWhatsApp));
    return result;
  }

  @override
  Future<void> cleanTemp() async => cleans++;
}

class _Card {
  _Card(this.fields, this.background, this.photo, this.logo);
  final LiveCardFields fields;
  final Uint8List? background;
  final Uint8List? photo;
  final Uint8List? logo;
}

class _T {
  _T(this.h, this.platform, this.cards, this.patches, this.clip);
  final ShellHarness h;
  final FakePlatform platform;
  final List<_Card> cards;
  final List<Object?> patches;
  final List<String> clip;
}

Map<String, Object?> _boxNotice({String? editedText, bool frame = true, Map<String, Object?>? kuliah}) => {
  'active': true,
  'videoId': _id,
  'watchUrl': _link,
  'startedAt': '2026-11-04T14:00:00.000Z',
  'kuliah':
      kuliah ?? {'title': 'Kuliah Maghrib', 'speaker': 'Ustaz Ahmad', 'time': '19:15'},
  'editedText': editedText,
  'editedBy': editedText == null ? null : 'Ustaz Ali',
  'editedAt': editedText == null ? null : '2026-11-04T14:10:00.000Z',
  'frame': frame,
};

List<Map<String, Object?>> _people() => [
  {'id': 'u1', 'ref': 'U-0001', 'name': 'Ustaz Ahmad', 'roles': ['admin'], 'active': true, 'phone': '+60120000001'},
  {'id': 'u2', 'ref': 'U-0002', 'name': 'Kak Siti', 'roles': ['ajk'], 'active': true, 'phone': '+60120000003'},
  {'id': 'u3', 'ref': 'U-0003', 'name': 'Haji Osman', 'roles': ['ajk'], 'active': true},
  {'id': 'u4', 'ref': 'U-0004', 'name': 'Encik Rahman', 'roles': ['ajk'], 'active': false, 'phone': '+60120000004'},
];

/// Opens the sheet over the app. [box] is the box's `GET /api/live/notice` (null: an older box, 404);
/// [input] the notice built on this device (null: the box's alone).
Future<_T> _open(
  WidgetTester tester, {
  List<String> roles = const ['admin'],
  FakePlatform? platform,
  Map<String, Object?>? box,
  bool withInput = true,
  AppLang lang = AppLang.ms,
  String? ownPhone,
  List<Map<String, Object?>>? users,
  Object? cardFails,
  bool frameOk = true,
  bool photoOk = true,
  GoldenSize size = GoldenSize.phone,
}) async {
  final p = platform ?? FakePlatform();
  final cards = <_Card>[];
  final patches = <Object?>[];
  final clip = <String>[];
  tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(SystemChannels.platform, (c) async {
    if (c.method == 'Clipboard.setData') clip.add((c.arguments as Map)['text'] as String);
    return null;
  });
  addTearDown(() => tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(SystemChannels.platform, null));
  final List<Override> overrides = [
    livePublisherProvider.overrideWithValue(FakePublisher()),
    liveNoticePlatformProvider.overrideWithValue(p),
    liveNoticeCardProvider.overrideWithValue(({required fields, background, photo, logo, rtl = false}) async {
      if (cardFails != null) throw cardFails;
      cards.add(_Card(fields, background, photo, logo));
      return _jpeg;
    }),
  ];
  final h = await pumpShell(tester, roles: roles, overrides: overrides, size: size);
  if (users != null) h.users = users;
  if (ownPhone != null) {
    h.me = {
      ...h.me,
      'user': {...(h.me['user'] as Map).cast<String, Object?>(), 'phone': ownPhone},
    };
  }
  h.handlers['GET /api/live/notice'] = (r) async =>
      box == null ? jsonResponse(404, {'errors': ['tiada']}) : jsonResponse(200, box);
  h.handlers['PATCH /api/live/notice'] = (r) async {
    patches.add(jsonDecode(r.body));
    return jsonResponse(200, box ?? {'active': true});
  };
  h.handlers['GET /api/live/notice/frame.jpg'] = (r) async => frameOk
      ? http.Response.bytes(_frame, 200, headers: {'content-type': 'image/jpeg'})
      : jsonResponse(404, {'errors': ['tiada']});
  // The penceramah the kuliah names: one with a photo, one without. (The photo bytes are the harness's own
  // route for `fixtureAssetPhoto`, answered here so the test can tell them.)
  h.content['penceramah'] = [
    {'id': 'p1', 'name': 'Ustaz Ahmad', 'photoAssetId': fixtureAssetPhoto},
    {'id': 'p2', 'name': 'Ustaz Tanpa Gambar'},
  ];
  h.handlers['GET /assets/$fixtureAssetPhoto'] = (r) async => photoOk
      ? http.Response.bytes(_photo, 200, headers: {'content-type': 'image/jpeg'})
      : jsonResponse(404, {'errors': ['tiada']});
  // The dashboard behind the sheet read the notice before these answers were set.
  h.container.invalidate(liveBoxNoticeProvider);
  if (lang != AppLang.ms) await h.container.read(appLangProvider.notifier).set(lang);
  await settle(tester);
  final ctx = tester.element(find.byType(Scaffold).first);
  unawaited(
    showModalBottomSheet<void>(
      context: ctx,
      isScrollControlled: true,
      builder: (_) => LiveNoticeSheet(input: withInput ? _input : null),
    ),
  );
  await settle(tester);
  return _T(h, p, cards, patches, clip);
}

Finder get _field => find.byKey(const ValueKey('live-notice-field'));
Finder get _preview => find.byKey(const ValueKey('live-notice-preview'));
Finder get _primary => find.byKey(const ValueKey('live-notice-primary'));
Finder get _more => find.byKey(const ValueKey('live-notice-more'));
Finder get _toOne => find.byKey(const ValueKey('live-notice-to-one'));
Finder get _toSelf => find.byKey(const ValueKey('live-notice-to-self'));
Finder get _qrGo => find.byKey(const ValueKey('live-notice-qr-go'));
Finder get _copy => find.byKey(const ValueKey('live-notice-copy'));
Finder get _sheet => find.byKey(const ValueKey('live-notice-sheet'));

String _primaryLabel(WidgetTester tester) => tester
    .widget<Text>(find.descendant(of: _primary, matching: find.byType(Text)).first)
    .data!;

Future<void> _tap(WidgetTester tester, Finder f) async {
  await tester.ensureVisible(f);
  await tester.tap(f);
  await settle(tester);
}

Future<void> _edit(WidgetTester tester) async {
  await _tap(tester, find.byKey(const ValueKey('live-notice-edit')));
}

String _qrData(WidgetTester tester) => tester.widget<LiveNoticeQrPage>(find.byType(LiveNoticeQrPage)).data;

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  group('[W6b] the text', () {
    testWidgets('a short preview, "Ubah teks" opens the field, "Kembalikan teks asal" restores it', (tester) async {
      final t = await _open(tester);
      expect(_preview, findsOneWidget);
      expect(tester.widget<Text>(_preview).data, _bmText);
      expect(tester.widget<Text>(_preview).maxLines, 3);
      expect(_field, findsNothing);
      await _edit(tester);
      expect(tester.widget<TextField>(_field).controller!.text, _bmText);
      await tester.enterText(_field, 'Teks saya sendiri');
      await settle(tester);
      await _tap(tester, find.byKey(const ValueKey('live-notice-reset')));
      expect(tester.widget<TextField>(_field).controller!.text, _bmText);
      expect(t.patches, isEmpty, reason: 'back to the original with nothing saved before: nothing to save');
    });

    testWidgets('the language follows the phone (Arabic and English)', (tester) async {
      await _open(tester, lang: AppLang.ar);
      expect(tester.widget<Text>(_preview).data, contains('تابعوا *درس المغرب* في *Surau Perintis Contoh* مع *Ustaz Ahmad*'));
      expect(find.text('إشعار البث المباشر'), findsOneWidget);
    });

    testWidgets('English phone gets the English text', (tester) async {
      await _open(tester, lang: AppLang.en);
      expect(tester.widget<Text>(_preview).data, contains('Join *Maghrib Talk* at *Surau Perintis Contoh* with *Ustaz Ahmad*'));
      expect(find.text('Share to WhatsApp'), findsOneWidget);
    });

    testWidgets('an edit is saved to the box once "Siap" is tapped, and "Kembalikan" saves null', (tester) async {
      final t = await _open(tester, box: _boxNotice());
      await _edit(tester);
      await tester.enterText(_field, 'Ikuti siaran kami.\n$_link');
      await settle(tester);
      await _tap(tester, find.byKey(const ValueKey('live-notice-edit-done')));
      expect(t.patches, [
        {'editedText': 'Ikuti siaran kami.\n$_link'},
      ]);
      expect(tester.widget<Text>(_preview).data, 'Ikuti siaran kami.\n$_link');
      await _edit(tester);
      await _tap(tester, find.byKey(const ValueKey('live-notice-reset')));
      expect(t.patches.last, {'editedText': null});
    });

    testWidgets('the box text edited by another admin is the text shown', (tester) async {
      await _open(tester, box: _boxNotice(editedText: 'Teks Ustaz Ali.\n$_link'), withInput: false);
      expect(tester.widget<Text>(_preview).data, 'Teks Ustaz Ali.\n$_link');
    });

    testWidgets('sharing the box text as it is writes nothing back, and says who edited it and when', (tester) async {
      final t = await _open(tester, box: _boxNotice(editedText: 'Teks Ustaz Ali.\n$_link'), withInput: false);
      expect(find.byKey(const ValueKey('live-notice-edited-by')), findsOneWidget);
      expect(tester.widget<Text>(find.byKey(const ValueKey('live-notice-edited-by'))).data, startsWith('Diubah oleh Ustaz Ali, '));
      await _tap(tester, _primary);
      expect(t.platform.shares.single.text, 'Teks Ustaz Ali.\n$_link');
      expect(t.patches, isEmpty, reason: 'an unchanged text is never written back (Q3)');
    });

    testWidgets('the text changed on the box after the sheet opened: the new text is shared, not the old one', (
      tester,
    ) async {
      final box = _boxNotice(editedText: 'Teks lama.\n$_link');
      final t = await _open(tester, box: box, withInput: false);
      expect(tester.widget<Text>(_preview).data, 'Teks lama.\n$_link');
      box['editedText'] = 'Teks baharu.\n$_link';
      await _tap(tester, _primary);
      expect(t.platform.shares.single.text, 'Teks baharu.\n$_link');
      expect(t.patches, isEmpty);
    });

    testWidgets('my unsaved edit meets a newer box text: the new text is shown, nothing is sent or overwritten', (
      tester,
    ) async {
      final box = _boxNotice(editedText: 'Teks lama.\n$_link');
      final t = await _open(tester, box: box, withInput: false);
      await _edit(tester);
      await tester.enterText(_field, 'Suntingan saya.\n$_link');
      await settle(tester);
      box['editedText'] = 'Teks baharu.\n$_link';
      await _tap(tester, _primary);
      expect(t.platform.shares, isEmpty);
      expect(t.patches, isEmpty, reason: 'the newer text is not overwritten');
      expect(find.text('Teks telah diubah oleh orang lain. Teks terkini ditunjukkan, semak sebelum dikongsi.'), findsOneWidget);
      expect(tester.widget<TextField>(_field).controller!.text, 'Teks baharu.\n$_link');
    });

    testWidgets('the notice is read again when noticeRev of the live status changes', (tester) async {
      final box = _boxNotice(editedText: 'Teks lama.\n$_link');
      final t = await _open(tester, box: box, withInput: false);
      var rev = 1;
      t.h.handlers['GET /api/live/status'] = (r) async => jsonResponse(200, {'noticeRev': rev});
      final ctrl = t.h.container.read(liveBoxProvider.notifier) as LiveController;
      await tester.runAsync(ctrl.pollOnce);
      await settle(tester);
      box['editedText'] = 'Teks Kak Siti.\n$_link';
      box['editedBy'] = 'Kak Siti';
      rev = 2;
      await tester.runAsync(ctrl.pollOnce);
      // the notice read also asks the status whether the box session still runs: one more round trip
      await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 100)));
      await settle(tester);
      expect(tester.widget<Text>(_preview).data, 'Teks Kak Siti.\n$_link');
      expect(tester.widget<Text>(find.byKey(const ValueKey('live-notice-edited-by'))).data, startsWith('Diubah oleh Kak Siti, '));
    });

    testWidgets('an older box (no route): the notice built on this device, nothing saved', (tester) async {
      final t = await _open(tester);
      expect(tester.widget<Text>(_preview).data, _bmText);
      await _edit(tester);
      await tester.enterText(_field, 'Lain.\n$_link');
      await _tap(tester, find.byKey(const ValueKey('live-notice-edit-done')));
      expect(t.patches, isEmpty);
    });

    testWidgets('a removed link is put back on its own line when sharing', (tester) async {
      final t = await _open(tester);
      await _edit(tester);
      await tester.enterText(_field, 'Teks tanpa pautan');
      await settle(tester);
      await _tap(tester, _primary);
      expect(t.platform.shares.single.text, 'Teks tanpa pautan\n$_link');
    });
  });

  group('[W6b] the big button and the small ones', () {
    testWidgets('WhatsApp present: "Kongsi ke WhatsApp" aims at WhatsApp with the picture and copies the text', (
      tester,
    ) async {
      final t = await _open(tester);
      expect(_primaryLabel(tester), 'Kongsi ke WhatsApp');
      await _tap(tester, _primary);
      final s = t.platform.shares.single;
      expect(s.toWhatsApp, isTrue);
      expect(s.text, _bmText);
      expect(s.picture, _jpeg);
      expect(t.clip, [_bmText], reason: 'the text is copied beside a picture');
      expect(find.text('Teks disalin, tampal sebagai kapsyen jika teks tidak muncul'), findsOneWidget);
      expect(find.byKey(const ValueKey('live-notice-share-go')), findsNothing, reason: 'no second share button');
      expect(_qrGo, findsOneWidget);
      expect(_copy, findsOneWidget);
      expect(t.platform.cleans, 1, reason: 'the picture is deleted when the sheet opens, never right after a share (M1)');
    });

    testWidgets('WhatsApp absent: "Kongsi" through the system sheet, no WhatsApp button', (tester) async {
      final t = await _open(tester, platform: FakePlatform(whatsApp: false));
      expect(_primaryLabel(tester), 'Kongsi');
      expect(find.text('Kongsi ke WhatsApp'), findsNothing);
      await _tap(tester, _primary);
      expect(t.platform.shares.single.toWhatsApp, isFalse);
      expect(t.platform.shares.single.picture, _jpeg);
      expect(_qrGo, findsOneWidget);
      expect(_copy, findsOneWidget);
    });

    testWidgets('web (iPad): the big button is "Hantar dari telefon" and opens the QR with the exact address', (
      tester,
    ) async {
      final t = await _open(tester, platform: FakePlatform(isWeb: true, whatsApp: false), size: GoldenSize.ipadMiniPortrait);
      expect(_primaryLabel(tester), 'Hantar dari telefon');
      expect(find.text('Kongsi ke WhatsApp'), findsNothing);
      await _tap(tester, _primary);
      expect(find.byKey(const ValueKey('live-notice-qr-page')), findsOneWidget);
      expect(find.byKey(const ValueKey('live-notice-qr')), findsOneWidget);
      expect(_qrData(tester), 'https://wa.me/?text=${Uri.encodeComponent(_bmText)}');
      expect(Uri.parse(_qrData(tester)).queryParameters['text'], _bmText);
      expect(find.text('Imbas dengan kamera telefon. WhatsApp akan dibuka dengan mesej ini.'), findsOneWidget);
      expect(t.platform.shares, isEmpty);
      await _tap(tester, find.byKey(const ValueKey('live-notice-qr-close')));
      expect(find.byKey(const ValueKey('live-notice-qr-page')), findsNothing);
      expect(_sheet, findsOneWidget);
    });

    testWidgets('web keeps a small "Kongsi" for the browser share sheet', (tester) async {
      final t = await _open(tester, platform: FakePlatform(isWeb: true, whatsApp: false));
      await _tap(tester, find.byKey(const ValueKey('live-notice-share-go')));
      expect(t.platform.shares.single.toWhatsApp, isFalse);
    });

    testWidgets('a browser without a share sheet opens wa.me, and copies when that fails too', (tester) async {
      final p = FakePlatform(isWeb: true, whatsApp: false)..result = const ShareResult('other', completed: false, unavailable: true);
      final t = await _open(tester, platform: p);
      await _tap(tester, find.byKey(const ValueKey('live-notice-share-go')));
      expect(t.h.opener.opened.single.toString(), startsWith('https://wa.me/?text='));
      expect(t.clip, isEmpty);
    });

    testWidgets('the small QR button on a phone shows the same QR', (tester) async {
      await _open(tester);
      await _tap(tester, _qrGo);
      expect(_qrData(tester), 'https://wa.me/?text=${Uri.encodeComponent(_bmText)}');
    });

    testWidgets('a text too long for a scannable QR becomes the title and the link', (tester) async {
      await _open(tester);
      await _edit(tester);
      await tester.enterText(_field, '${'Ikuti siaran kami dengan teliti. ' * 25}\n$_link');
      await tester.pump();
      await _tap(tester, find.byKey(const ValueKey('live-notice-edit-done')));
      await _tap(tester, _qrGo);
      final data = _qrData(tester);
      expect(data.length, lessThanOrEqualTo(liveNoticeQrMaxLength));
      expect(Uri.parse(data).queryParameters['text'], 'Kuliah Maghrib\n$_link');
    });

    testWidgets('"Salin teks" copies the text', (tester) async {
      final t = await _open(tester);
      await _tap(tester, _copy);
      expect(t.clip, [_bmText]);
      expect(find.text('Teks disalin. Tampalkan di WhatsApp.'), findsOneWidget);
    });

    testWidgets('"Hantar kepada diri sendiri" opens wa.me with the own number, only when there is one', (tester) async {
      final t = await _open(tester, ownPhone: '+60120000042');
      expect(_toSelf, findsOneWidget);
      await _tap(tester, _toSelf);
      final u = t.h.opener.opened.single;
      expect(u.toString(), startsWith('https://wa.me/60120000042?text='));
      expect(u.queryParameters['text'], _bmText);
    });

    testWidgets('no own phone number: no self button, no hint to add one', (tester) async {
      await _open(tester);
      expect(_toSelf, findsNothing);
      expect(find.textContaining('Tambah nombor'), findsNothing);
    });

    testWidgets('a share the person cancels leaves the sheet open with no error and no copy', (tester) async {
      final p = FakePlatform()..result = const ShareResult('other', completed: false);
      final t = await _open(tester, platform: p);
      await _tap(tester, _primary);
      expect(_sheet, findsOneWidget);
      expect(find.text('Teks tidak dapat dikongsi.'), findsNothing);
      expect(t.clip, isEmpty);
      expect(tester.widget<FilledButton>(_primary).onPressed, isNotNull, reason: 'can be tried again');
    });

    testWidgets('a share that fails says so and stays open', (tester) async {
      final p = FakePlatform()..failWith = const ShareFailed();
      await _open(tester, platform: p);
      await _tap(tester, _primary);
      expect(find.text('Teks tidak dapat dikongsi.'), findsOneWidget);
      expect(_sheet, findsOneWidget);
    });
  });

  group('[W6b] "Lagi": no picture, and one person for a Pentadbir', () {
    testWidgets('"Tanpa gambar" shares the text alone and copies nothing', (tester) async {
      final t = await _open(tester);
      await _tap(tester, _more);
      await _tap(tester, find.byKey(const ValueKey('live-notice-picture-toggle')));
      await _tap(tester, _primary);
      expect(t.platform.shares.single.picture, isNull);
      expect(t.cards, isEmpty, reason: 'no card is made');
      expect(t.clip, isEmpty);
    });

    testWidgets('the picture is on by default, with no toggle on the main view', (tester) async {
      await _open(tester);
      expect(find.byKey(const ValueKey('live-notice-picture-toggle')), findsNothing);
      expect(find.text('Tanpa gambar'), findsNothing);
    });

    testWidgets('a picture that cannot be made falls back to the text with a small note', (tester) async {
      final t = await _open(tester, cardFails: StateError('no card'));
      await _tap(tester, _primary);
      expect(t.platform.shares.single.picture, isNull);
      expect(t.platform.shares.single.text, _bmText);
      expect(find.text('Gambar tidak dapat disediakan. Teks sahaja dikongsi.'), findsOneWidget);
      expect(t.clip, isEmpty);
    });

    testWidgets('"Hantar kepada seorang" is behind "Lagi", for a Pentadbir only', (tester) async {
      await _open(tester, users: _people());
      expect(_toOne, findsNothing, reason: 'not a main button');
      await _tap(tester, _more);
      expect(_toOne, findsOneWidget);
    });

    testWidgets('absent for the Siaran Langsung role and when nobody has a number', (tester) async {
      await _open(tester, roles: const ['live'], users: _people());
      await _tap(tester, _more);
      expect(_toOne, findsNothing);
    });

    testWidgets('absent when no user has a phone number', (tester) async {
      await _open(tester, users: [for (final u in _people()) {...u}..remove('phone')]);
      await _tap(tester, _more);
      expect(_toOne, findsNothing);
    });

    testWidgets('the list holds active users with a number, filters, shows no digits; the confirm names the number', (
      tester,
    ) async {
      final t = await _open(tester, users: _people());
      await _tap(tester, _more);
      await _tap(tester, _toOne);
      expect(find.text('Hantar kepada siapa?'), findsOneWidget);
      expect(find.text('Kak Siti'), findsOneWidget);
      expect(find.text('Haji Osman'), findsNothing, reason: 'no phone');
      expect(find.text('Encik Rahman'), findsNothing, reason: 'deactivated');
      expect(find.textContaining('6012'), findsNothing);
      await tester.enterText(find.byKey(const ValueKey('live-notice-pick-search')), 'siti');
      await settle(tester);
      expect(find.text('Ustaz Ahmad'), findsNothing);
      await tester.tap(find.byKey(const ValueKey('live-notice-pick-u2')));
      await settle(tester);
      expect(find.textContaining('+60 12-000 0003'), findsOneWidget);
      expect(t.h.opener.opened, isEmpty, reason: 'nothing opens before the confirm');
      await tester.tap(find.text('Buka WhatsApp'));
      await settle(tester);
      final u = t.h.opener.opened.single;
      expect(u.toString(), startsWith('https://wa.me/60120000003?text='));
      expect(u.queryParameters['text'], _bmText);
      expect(t.platform.shares, isEmpty);
    });

    testWidgets('cancelling the confirm opens nothing', (tester) async {
      final t = await _open(tester, users: _people());
      await _tap(tester, _more);
      await _tap(tester, _toOne);
      await tester.tap(find.byKey(const ValueKey('live-notice-pick-u1')));
      await settle(tester);
      await tester.tap(find.text('Batal'));
      await settle(tester);
      expect(t.h.opener.opened, isEmpty);
    });
  });

  group('[W22-4] the picture card: the box frame, else today\'s kuliah card, never a thumbnail', () {
    testWidgets('CCTV through the box: the card is made from the box frame', (tester) async {
      final t = await _open(tester, box: _boxNotice(), withInput: false);
      await _tap(tester, _primary);
      expect(t.cards.single.background, _frame);
      expect(t.cards.single.photo, isNull, reason: 'the frame is the picture');
      expect(
        t.cards.single.fields,
        const LiveCardFields(
          badge: 'SIARAN LANGSUNG',
          surau: 'Surau Contoh',
          slot: 'Kuliah Maghrib',
          speaker: 'Ustaz Ahmad',
          time: '19:15',
        ),
      );
    });

    testWidgets('frame 404: the kuliah card with the penceramah photo, no background, no outside request', (tester) async {
      final t = await _open(tester, box: _boxNotice(), frameOk: false);
      await _tap(tester, _primary);
      final c = t.cards.single;
      expect(c.background, isNull, reason: 'never a YouTube thumbnail');
      expect(c.photo, _photo);
      expect(c.fields.slot, 'Kuliah Maghrib');
      expect(c.fields.speaker, 'Ustaz Ahmad');
      expect(c.fields.surau, 'Surau Contoh');
      expect(c.fields.time, '19:15');
      expect(t.platform.shares.single.picture, _jpeg);
      expect(t.h.box.byPath('/api/live/notice/frame.jpg'), isNotNull);
    });

    testWidgets('the card carries the phone\'s own kuliah: slot name, title, time', (tester) async {
      final t = await _open(tester, frameOk: false);
      await _tap(tester, _primary);
      final c = t.cards.single;
      expect(c.background, isNull);
      expect(c.fields.slot, 'Kuliah Maghrib');
      expect(c.fields.title, 'Kitab Contoh', reason: 'the kitab stands in when there is no topic');
      expect(c.fields.speaker, 'Ustaz Ahmad');
      expect(c.fields.time, '19:15');
      expect(c.photo, _photo);
    });

    testWidgets('a penceramah without a photo: the card is made without one', (tester) async {
      final t = await _open(
        tester,
        box: _boxNotice(kuliah: {'title': 'Kuliah Maghrib', 'speaker': 'Ustaz Tanpa Gambar', 'time': '19:15'}),
        frameOk: false,
        withInput: false,
      );
      await _tap(tester, _primary);
      expect(t.cards.single.photo, isNull);
      expect(t.cards.single.background, isNull);
      expect(t.platform.shares.single.picture, _jpeg);
    });

    testWidgets('a photo the box cannot give: the card is made without one', (tester) async {
      final t = await _open(tester, box: _boxNotice(), frameOk: false, photoOk: false, withInput: false);
      await _tap(tester, _primary);
      expect(t.cards.single.photo, isNull);
      expect(t.platform.shares.single.picture, _jpeg);
    });

    testWidgets('no kuliah for the live: a plain card with the surau name, no photo, no thumbnail', (tester) async {
      final t = await _open(tester, box: _boxNotice(kuliah: {}), frameOk: false, withInput: false);
      await _tap(tester, _primary);
      final c = t.cards.single;
      expect(c.background, isNull);
      expect(c.photo, isNull);
      expect(c.fields, const LiveCardFields(badge: 'SIARAN LANGSUNG', surau: 'Surau Contoh'));
      expect(c.fields.hasKuliah, isFalse);
      expect(t.platform.shares.single.picture, _jpeg);
    });

    testWidgets('the card fields follow the phone language (slot name)', (tester) async {
      final t = await _open(tester, frameOk: false, lang: AppLang.en);
      await _tap(tester, _primary);
      expect(t.cards.single.fields.slot, 'Maghrib Talk');
      expect(t.cards.single.fields.badge, 'LIVE NOW');
    });

    testWidgets('an older box (no frame route): the kuliah card', (tester) async {
      final t = await _open(tester, frameOk: false);
      await _tap(tester, _primary);
      expect(t.cards.single.background, isNull);
      expect(t.cards.single.fields.hasKuliah, isTrue);
    });

    test('the fields carry nothing but the notice words: no number, no address; a missing one keeps its role', () {
      final f = liveCardFields(
        badge: 'SIARAN LANGSUNG',
        surau: 'Surau Contoh',
        title: 'Kuliah Maghrib',
        speaker: 'Ustaz Ahmad +60 12-000 0042',
      );
      expect(f, const LiveCardFields(badge: 'SIARAN LANGSUNG', surau: 'Surau Contoh', title: 'Kuliah Maghrib'));
      expect(f.speaker, isNull);
      final bad = liveCardFields(surau: 'https://10.168.0.154:8443', title: 'Kuliah 0123456789', speaker: 'www.contoh.my');
      expect(bad.isEmpty, isTrue);
      // no surau name: the title stays the title (it used to move up into the surau slot)
      final noSurau = liveCardFields(badge: 'B', title: 'Kuliah', speaker: 'Ustaz');
      expect(noSurau.surau, isNull);
      expect(noSurau.title, 'Kuliah');
      expect(noSurau.speaker, 'Ustaz');
    });
  });

  group('[W6b] the card is a real 1200 x 630 JPEG', () {
    testWidgets('renders from lines with no background and from a still', (tester) async {
      await tester.runAsync(() async {
        final out = await renderLiveCard(
          fields: const LiveCardFields(badge: 'SIARAN LANGSUNG', surau: 'Surau Contoh', title: 'Kuliah Maghrib', speaker: 'Ustaz Ahmad'),
        );
        expect(out.sublist(0, 2), [0xFF, 0xD8]);
        expect(out.length, greaterThan(2000));
        expect(out.length, lessThan(600 * 1024));
        final ui = await decodeImageFromList(out);
        expect(ui.width, liveCardWidth);
        expect(ui.height, liveCardHeight);
        // the same from a still of another shape
        final out2 = await renderLiveCard(
          fields: const LiveCardFields(badge: 'SIARAN LANGSUNG', title: 'Kuliah'),
          background: out,
          rtl: true,
        );
        expect(out2.sublist(0, 2), [0xFF, 0xD8]);
      });
    });
  });

  group('[W6b] who sees what, on which device', () {
    testWidgets('Android phone, phone camera (no box notice): local text, kuliah card, WhatsApp button', (tester) async {
      final t = await _open(tester, frameOk: false);
      expect(_primaryLabel(tester), 'Kongsi ke WhatsApp');
      await _tap(tester, _primary);
      expect(t.platform.shares.single.text, _bmText);
      expect(t.cards.single.background, isNull);
    });

    testWidgets('Android phone, CCTV through the box: the box text and the box frame', (tester) async {
      final t = await _open(tester, box: _boxNotice(), withInput: false);
      expect(tester.widget<Text>(_preview).data, contains('Ikuti *Kuliah Maghrib*'));
      expect(tester.widget<Text>(_preview).data, contains(_link));
      await _tap(tester, _primary);
      expect(t.cards.single.background, _frame);
      expect(t.platform.shares.single.toWhatsApp, isTrue);
    });

    testWidgets('iPad web without WhatsApp, live from another device: the QR holds the box text exactly', (tester) async {
      await _open(
        tester,
        platform: FakePlatform(isWeb: true, whatsApp: false),
        box: _boxNotice(editedText: 'Mari ikuti.\n$_link'),
        withInput: false,
        size: GoldenSize.ipadMiniPortrait,
      );
      await _tap(tester, _primary);
      expect(_qrData(tester), 'https://wa.me/?text=${Uri.encodeComponent('Mari ikuti.\n$_link')}');
    });

    testWidgets('a device without WhatsApp: no WhatsApp wording anywhere, share sheet and QR offered', (tester) async {
      await _open(tester, platform: FakePlatform(whatsApp: false));
      expect(find.textContaining('WhatsApp'), findsNothing);
      expect(_primaryLabel(tester), 'Kongsi');
      expect(_qrGo, findsOneWidget);
    });

    testWidgets('no live: the box answers inactive and there is no notice', (tester) async {
      final h = await pumpShell(tester, roles: const ['admin']);
      h.handlers['GET /api/live/notice'] = (r) async => jsonResponse(200, {'active': false});
      h.container.invalidate(liveBoxNoticeProvider);
      expect(await tester.runAsync(() => h.container.read(liveBoxNoticeProvider.future)), isNull);
    });
  });

  group('[W6b] the box notice parser', () {
    test('only an active notice with a public watch link counts', () {
      expect(BoxLiveNotice.fromJson({'active': false}), isNull);
      expect(BoxLiveNotice.fromJson(null), isNull);
      expect(BoxLiveNotice.fromJson({'active': true, 'videoId': 'short'}), isNull);
      expect(BoxLiveNotice.fromJson({'active': true, 'watchUrl': 'https://evil.example/live/$_id'}), isNull);
      final n = BoxLiveNotice.fromJson({'active': true, 'watchUrl': _link, 'frame': true, 'kuliah': {'title': 7}});
      expect(n!.videoId, _id);
      expect(n.frame, isTrue);
      expect(n.kuliah!.title, isNull);
    });
  });

  group('[W6b] goldens of the sheet', () {
    Future<void> shot(WidgetTester tester, String name, FakePlatform p, GoldenSize size, {String? own}) async {
      await _open(tester, platform: p, size: size, ownPhone: own, users: _people());
      await expectLater(find.byType(MaterialApp).first, matchesGoldenFile('live_notice_sheet_${name}_${size.name}.png'));
    }

    testWidgets('WhatsApp present, phone', (tester) async {
      await shot(tester, 'present', FakePlatform(), GoldenSize.phone, own: '+60120000042');
    });
    testWidgets('WhatsApp present, iPad', (tester) async {
      await shot(tester, 'present', FakePlatform(), GoldenSize.ipadMiniPortrait, own: '+60120000042');
    });
    testWidgets('WhatsApp absent, phone', (tester) async {
      await shot(tester, 'absent', FakePlatform(whatsApp: false), GoldenSize.phone);
    });
    testWidgets('web, iPad', (tester) async {
      await shot(tester, 'absent', FakePlatform(isWeb: true, whatsApp: false), GoldenSize.ipadMiniPortrait);
    });
    testWidgets('the QR page, iPad', (tester) async {
      await _open(tester, platform: FakePlatform(isWeb: true, whatsApp: false), size: GoldenSize.ipadMiniPortrait);
      await _tap(tester, _primary);
      await expectLater(find.byType(MaterialApp).first, matchesGoldenFile('live_notice_qr_ipadMiniPortrait.png'));
    });
  });
}
