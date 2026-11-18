// The live notice sheet (Task L1): editable text, the reset, the share, the
// language of the phone, and "Hantar kepada seorang" for a Pentadbir only,
// from the users who have a phone number, with no number drawn.

import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:surau_app/app/app_lang.dart';
import 'package:surau_app/features/live/live_notice.dart';
import 'package:surau_app/features/live/live_notice_sheet.dart';

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
    'Ikuti Kuliah Maghrib malam ini disampaikan oleh Ustaz Ahmad membicarakan Kitab Contoh '
    'secara langsung dalam talian menerusi pautan berikut:\n'
    '$_link';

List<Map<String, Object?>> _people() => [
  {
    'id': 'u1',
    'ref': 'U-0001',
    'name': 'Ustaz Ahmad',
    'roles': ['admin'],
    'active': true,
    'phone': '+60120000001',
  },
  {
    'id': 'u2',
    'ref': 'U-0002',
    'name': 'Kak Siti',
    'roles': ['ajk'],
    'active': true,
    'phone': '+60120000003',
  },
  // no number: never listed
  {'id': 'u3', 'ref': 'U-0003', 'name': 'Haji Osman', 'roles': ['ajk'], 'active': true},
  // deactivated and deleted: never listed
  {'id': 'u4', 'ref': 'U-0004', 'name': 'Encik Rahman', 'roles': ['ajk'], 'active': false, 'phone': '+60120000004'},
  {
    'id': 'u5',
    'ref': 'U-0005',
    'name': 'Puan Aminah',
    'roles': ['ajk'],
    'active': true,
    'deleted': true,
    'phone': '+60120000005',
  },
];

Future<ShellHarness> _openSheet(
  WidgetTester tester, {
  List<String> roles = const ['admin'],
  AppLang lang = AppLang.ms,
  List<Map<String, Object?>>? users,
}) async {
  final h = await pumpShell(tester, roles: roles);
  if (users != null) h.users = users;
  if (lang != AppLang.ms) await h.container.read(appLangProvider.notifier).set(lang);
  await settle(tester);
  final ctx = tester.element(find.byType(Scaffold).first);
  unawaited(
    showModalBottomSheet<void>(
      context: ctx,
      isScrollControlled: true,
      builder: (_) => LiveNoticeSheet(input: _input),
    ),
  );
  await settle(tester);
  return h;
}

Finder get _field => find.byKey(const ValueKey('live-notice-field'));
Finder get _reset => find.byKey(const ValueKey('live-notice-reset'));
Finder get _share => find.byKey(const ValueKey('live-notice-share-go'));
Finder get _toOne => find.byKey(const ValueKey('live-notice-to-one'));

String _fieldText(WidgetTester tester) => tester.widget<TextField>(_field).controller!.text;

Future<void> _tap(WidgetTester tester, Finder f) async {
  await tester.ensureVisible(f);
  await tester.tap(f);
  await settle(tester);
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  const channel = MethodChannel('my.maxcom/share');
  final shared = <MethodCall>[];

  setUp(() {
    shared.clear();
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger.setMockMethodCallHandler(channel, (c) async {
      shared.add(c);
      return {'via': 'whatsapp', 'completed': true};
    });
  });
  tearDown(() {
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger.setMockMethodCallHandler(channel, null);
  });

  testWidgets('[PP-L1b] the field holds the BM text, is editable, and "Kembalikan teks asal" restores it', (tester) async {
    await _openSheet(tester);
    expect(find.text('Makluman siaran langsung'), findsOneWidget);
    expect(_fieldText(tester), _bmText);
    await tester.enterText(_field, 'Teks saya sendiri');
    await settle(tester);
    expect(_fieldText(tester), 'Teks saya sendiri');
    expect(find.text('Kembalikan teks asal'), findsOneWidget);
    await _tap(tester, _reset);
    expect(_fieldText(tester), _bmText);
  });

  testWidgets('[PP-L1b] the language follows the phone: Arabic text and Arabic sheet', (tester) async {
    await _openSheet(tester, lang: AppLang.ar);
    expect(_fieldText(tester), contains('تابعوا درس المغرب الليلة يلقيه Ustaz Ahmad'));
    expect(find.text('إشعار البث المباشر'), findsOneWidget);
    expect(tester.widget<TextField>(_field).textDirection, TextDirection.rtl);
  });

  testWidgets('[PP-L1b] the English phone gets the English text', (tester) async {
    await _openSheet(tester, lang: AppLang.en);
    expect(_fieldText(tester), contains('Join the Maghrib talk tonight, delivered by Ustaz Ahmad'));
    expect(find.text('Restore original text'), findsOneWidget);
  });

  testWidgets('[PP-L1b] Kongsi sends the edited text once through the share helper', (tester) async {
    await _openSheet(tester);
    await tester.enterText(_field, 'Ikuti siaran kami.\n$_link');
    await settle(tester);
    await _tap(tester, _share);
    expect(shared, hasLength(1));
    expect(shared.single.method, 'shareText');
    expect((shared.single.arguments as Map)['text'], 'Ikuti siaran kami.\n$_link');
  });

  testWidgets('[PP-L1b] a removed link is put back on its own line when sharing', (tester) async {
    await _openSheet(tester);
    await tester.enterText(_field, 'Teks tanpa pautan');
    await settle(tester);
    await _tap(tester, _share);
    expect(shared, hasLength(1));
    expect((shared.single.arguments as Map)['text'], 'Teks tanpa pautan\n$_link');
    expect(_fieldText(tester), 'Teks tanpa pautan\n$_link');
  });

  testWidgets('[PP-L1b] a text over 4,096 characters is not shared and says so', (tester) async {
    await _openSheet(tester);
    // the field limits typing, so paste past it through the controller
    tester.widget<TextField>(_field).controller!.text = '${'x' * 4100}\n$_link';
    await settle(tester);
    await _tap(tester, _share);
    expect(shared, isEmpty);
    expect(find.text('Teks tidak dapat dikongsi.'), findsOneWidget);
  });

  testWidgets('[PP-L1b] "Hantar kepada seorang" is absent for the Siaran Langsung role', (tester) async {
    await _openSheet(tester, roles: const ['live'], users: _people());
    expect(_share, findsOneWidget);
    expect(_toOne, findsNothing);
  });

  testWidgets('[PP-L1b] the button is hidden when no user has a phone number', (tester) async {
    final none = [
      for (final u in _people()) {...u}..remove('phone'),
    ];
    await _openSheet(tester, users: none);
    expect(_share, findsOneWidget);
    expect(_toOne, findsNothing);
  });

  testWidgets('[PP-L1b] the list holds only active users with a number, filters as typed, shows no digits', (tester) async {
    final h = await _openSheet(tester, users: _people());
    expect(_toOne, findsOneWidget);
    await _tap(tester, _toOne);
    expect(find.text('Hantar kepada siapa?'), findsOneWidget);
    expect(find.text('Ustaz Ahmad'), findsOneWidget);
    expect(find.text('Kak Siti'), findsOneWidget);
    expect(find.text('Haji Osman'), findsNothing, reason: 'no phone');
    expect(find.text('Encik Rahman'), findsNothing, reason: 'deactivated');
    expect(find.text('Puan Aminah'), findsNothing, reason: 'deleted');
    // the ID shows, the number never
    expect(find.textContaining('U-0002'), findsOneWidget);
    expect(find.textContaining('6012'), findsNothing);
    expect(find.textContaining('012-'), findsNothing);
    await tester.enterText(find.byKey(const ValueKey('live-notice-pick-search')), 'siti');
    await settle(tester);
    expect(find.text('Kak Siti'), findsOneWidget);
    expect(find.text('Ustaz Ahmad'), findsNothing);
    // an ID typed loosely finds the person
    await tester.enterText(find.byKey(const ValueKey('live-notice-pick-search')), 'u1');
    await settle(tester);
    expect(find.text('Ustaz Ahmad'), findsOneWidget);
    expect(find.text('Kak Siti'), findsNothing);
    await tester.enterText(find.byKey(const ValueKey('live-notice-pick-search')), 'zzz');
    await settle(tester);
    expect(find.text('Tiada pengguna dijumpai.'), findsOneWidget);
    expect(h.opener.opened, isEmpty);
  });

  testWidgets('[PP-L1b] choosing a person opens https://wa.me/<their number> with the text, after a confirm', (tester) async {
    final h = await _openSheet(tester, users: _people());
    await _tap(tester, _toOne);
    await tester.tap(find.byKey(const ValueKey('live-notice-pick-u2')));
    await settle(tester);
    expect(find.textContaining('WhatsApp dibuka terus ke'), findsOneWidget);
    expect(find.textContaining('+60 12-000 0003'), findsOneWidget, reason: 'the confirm names the number');
    expect(h.opener.opened, isEmpty, reason: 'nothing opens before the confirm');
    await tester.tap(find.text('Buka WhatsApp'));
    await settle(tester);
    expect(h.opener.opened, hasLength(1));
    final u = h.opener.opened.single;
    expect(u.toString(), startsWith('https://wa.me/60120000003?text='));
    expect(u.queryParameters['text'], _bmText);
    expect(shared, isEmpty, reason: 'no share sheet for one person');
  });

  testWidgets('[PP-L1b] cancelling the confirm opens nothing', (tester) async {
    final h = await _openSheet(tester, users: _people());
    await _tap(tester, _toOne);
    await tester.tap(find.byKey(const ValueKey('live-notice-pick-u1')));
    await settle(tester);
    await tester.tap(find.text('Batal'));
    await settle(tester);
    expect(h.opener.opened, isEmpty);
  });
}
