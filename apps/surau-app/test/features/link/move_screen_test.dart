// The phone move screen: the question, the new PIN, the join, and each refusal in words (BM, English, Arabic).
// Goldens: the question and the join-code line in three languages.

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:surau_app/app/app_lang.dart';
import 'package:surau_app/app/theme.dart';
import 'package:surau_app/features/enrol/enrol_flow.dart';
import 'package:surau_app/features/link/move_screen.dart';
import 'package:surau_app/l10n/generated/s.dart';

import '../../golden_sizes.dart';
import '../fakes.dart';
import 'move_flow_test.dart' show Rig, boxInfo;

Widget host(AppLang lang, Rig rig, {void Function(EnrolledBox)? onAdopt, VoidCallback? onLater, VoidCallback? onJoinScan, void Function(String)? onJoinCode}) {
  final app = MaterialApp(
    key: UniqueKey(),
    debugShowCheckedModeBanner: false,
    theme: SurauTheme.light(),
    locale: Locale(lang.name),
    localizationsDelegates: S.localizationsDelegates,
    supportedLocales: S.supportedLocales,
    home: MoveScreen(flow: rig.flow, deviceName: 'Telefon', onAdopt: onAdopt ?? (_) {}, onLater: onLater ?? () {}, onJoinScan: onJoinScan ?? () {}, onJoinCode: onJoinCode ?? (_) {}),
  );
  return app;
}

Future<void> open(WidgetTester tester, Widget w) async {
  tester.view.physicalSize = const Size(412, 915) * goldenPixelRatio;
  tester.view.devicePixelRatio = goldenPixelRatio;
  addTearDown(tester.view.resetPhysicalSize);
  addTearDown(tester.view.resetDevicePixelRatio);
  await tester.pumpWidget(w);
  await tester.pumpAndSettle();
}

Rig refusing(int status, String code) => Rig(
  old: (r) async => r.url.path.endsWith('challenge')
      ? jsonResponse(200, {'nonce': 'n'})
      : r.url.path == '/api/kiosk/link'
      ? jsonResponse(200, {'master': {'name': 'Dewan Utama'}})
      : jsonResponse(status, {'code': code}),
);

void main() {
  testWidgets('the question names the main box; "Sambung sekarang" asks for a new PIN; done adopts the new box', (tester) async {
    final rig = Rig();
    EnrolledBox? adopted;
    await open(tester, host(AppLang.ms, rig, onAdopt: (b) => adopted = b));
    expect(find.text('Surau anda kini diurus dari MAXCOM Kiosk Box utama Dewan Utama. Sambung sekarang?'), findsOneWidget);
    await tester.tap(find.byKey(const ValueKey('move-connect')));
    await tester.pumpAndSettle();
    expect(find.text('Tetapkan PIN baharu'), findsOneWidget);
    // weak PIN: refused here
    final fields = find.byType(TextField);
    await tester.enterText(fields.at(0), '123456');
    await tester.enterText(fields.at(1), '123456');
    await tester.tap(find.byKey(const ValueKey('move-submit')));
    await tester.pumpAndSettle();
    expect(find.text('PIN terlalu mudah. Pilih 6 digit yang bukan sama dan bukan turutan.'), findsOneWidget);
    expect(rig.masterBox.seen, isEmpty);
    // two different PINs
    await tester.enterText(fields.at(0), '280419');
    await tester.enterText(fields.at(1), '280418');
    await tester.tap(find.byKey(const ValueKey('move-submit')));
    await tester.pumpAndSettle();
    expect(find.text('PIN tidak sepadan'), findsOneWidget);
    expect(rig.masterBox.seen, isEmpty);
    await tester.enterText(fields.at(1), '280419');
    await tester.tap(find.byKey(const ValueKey('move-submit')));
    await tester.pumpAndSettle();
    expect(find.text('Anda kini disambungkan ke Dewan Utama.'), findsOneWidget);
    expect(adopted, isNull);
    await tester.tap(find.byKey(const ValueKey('move-continue')));
    expect(adopted!.boxId, 'a1a1a1a1a1a1a1a1');
  });

  testWidgets('a ticket the main box refuses after the PIN goes to "Perlu kod sertai" with the scan and paste ways', (tester) async {
    var scans = 0;
    final rig = Rig(master: (r) async => r.url.path == '/api/box/info' ? boxInfo() : jsonResponse(404, {'code': 'no_ticket'}));
    await open(tester, host(AppLang.ms, rig, onJoinScan: () => scans++));
    await tester.tap(find.byKey(const ValueKey('move-connect')));
    await tester.pumpAndSettle();
    final fields = find.byType(TextField);
    await tester.enterText(fields.at(0), '280419');
    await tester.enterText(fields.at(1), '280419');
    await tester.tap(find.byKey(const ValueKey('move-submit')));
    await tester.pumpAndSettle();
    expect(find.byKey(const ValueKey('move-needcode')), findsOneWidget);
    expect(find.text('Perlu kod sertai'), findsOneWidget);
    expect(find.byKey(const ValueKey('move-join-paste')), findsOneWidget);
    await tester.tap(find.byKey(const ValueKey('move-join-scan')));
    expect(scans, 1);
  });

  testWidgets('"Kemudian" leaves the move alone', (tester) async {
    var later = 0;
    await open(tester, host(AppLang.ms, Rig(), onLater: () => later++));
    await tester.tap(find.byKey(const ValueKey('move-later')));
    expect(later, 1);
  });

  testWidgets('no ticket: ask the admin of the main box by name; the phone is left as it is', (tester) async {
    final rig = refusing(404, 'no_ticket');
    await open(tester, host(AppLang.ms, rig));
    expect(find.text('Perlu kod sertai'), findsOneWidget);
    expect(find.text('Minta kod sertai daripada Pentadbir Dewan Utama.'), findsOneWidget);
    expect(find.byKey(const ValueKey('move-connect')), findsNothing);
  });

  testWidgets('no ticket: the scan and paste ways in are offered, and "Kemudian" leaves the screen', (tester) async {
    var later = 0;
    var scans = 0;
    await open(tester, host(AppLang.ms, refusing(404, 'no_ticket'), onLater: () => later++, onJoinScan: () => scans++));
    expect(find.text('Imbas kod sertai'), findsOneWidget);
    expect(find.text('Tampal kod'), findsOneWidget);
    await tester.tap(find.byKey(const ValueKey('move-join-scan')));
    expect(scans, 1);
    await tester.tap(find.byKey(const ValueKey('move-later')));
    expect(later, 1);
  });

  testWidgets('no ticket: a pasted join code goes to the enrolment; text that is not one is refused here', (tester) async {
    String? joined;
    await open(tester, host(AppLang.ms, refusing(404, 'no_ticket'), onJoinCode: (c) => joined = c));
    await tester.tap(find.byKey(const ValueKey('move-join-paste')));
    await tester.pumpAndSettle();
    await tester.enterText(find.byKey(const ValueKey('move-join-field')), 'hello');
    await tester.tap(find.byKey(const ValueKey('move-join-submit')));
    await tester.pumpAndSettle();
    expect(joined, isNull);
    expect(find.text('Kod QR tidak dikenali'), findsOneWidget);
    await tester.enterText(find.byKey(const ValueKey('move-join-field')), '  surau1:abc  ');
    await tester.tap(find.byKey(const ValueKey('move-join-submit')));
    expect(joined, 'surau1:abc');
  });

  testWidgets('bad signature reads the same', (tester) async {
    await open(tester, host(AppLang.ms, refusing(401, 'bad_signature')));
    expect(find.text('Minta kod sertai daripada Pentadbir Dewan Utama.'), findsOneWidget);
  });

  testWidgets('away from the surau Wi-Fi: open the app there once; retry is offered', (tester) async {
    final rig = Rig(old: (r) async => throw http.ClientException('down'));
    await open(tester, host(AppLang.ms, rig));
    expect(find.text('Buka aplikasi di Wi-Fi surau sekali untuk menyambung ke Box utama'), findsOneWidget);
    expect(find.byKey(const ValueKey('move-retry')), findsOneWidget);
  });

  testWidgets('a wrong box at the main box address is said and nothing is changed', (tester) async {
    final rig = Rig(master: (r) async => boxInfoOf('f' * 16));
    await open(tester, host(AppLang.ms, rig));
    await tester.tap(find.byKey(const ValueKey('move-connect')));
    await tester.pumpAndSettle();
    final fields = find.byType(TextField);
    await tester.enterText(fields.at(0), '280419');
    await tester.enterText(fields.at(1), '280419');
    await tester.tap(find.byKey(const ValueKey('move-submit')));
    await tester.pumpAndSettle();
    expect(find.text('Box yang menjawab bukan Box utama yang dinyatakan. Tiada apa yang diubah.'), findsOneWidget);
    expect(await rig.store.load(), isNull);
  });

  for (final (lang, away, need) in [
    (AppLang.en, 'Open the app on the surau Wi-Fi once to connect to the main Box', 'Ask the admin of Dewan Utama for a join code.'),
    (AppLang.ar, 'افتح التطبيق على شبكة Wi-Fi المصلى مرة واحدة للاتصال بـ Box الرئيسي', 'اطلب رمز انضمام من مسؤول Dewan Utama.'),
  ]) {
    testWidgets('the refusals in ${lang.name}', (tester) async {
      await open(tester, host(lang, Rig(old: (r) async => throw http.ClientException('down'))));
      expect(find.text(away), findsOneWidget);
      await open(tester, host(lang, refusing(404, 'no_ticket')));
      expect(find.text(need), findsOneWidget);
    });
  }

  for (final lang in AppLang.values) {
    testWidgets('golden: the question and the join-code line in ${lang.name}', (tester) async {
      final ask = host(lang, Rig());
      await open(tester, ask);
      await expectLater(find.byWidget(ask), matchesGoldenFile('link_move_ask_${lang.name}_phone.png'));
      final need = host(lang, refusing(404, 'no_ticket'));
      await open(tester, need);
      await expectLater(find.byWidget(need), matchesGoldenFile('link_move_needcode_${lang.name}_phone.png'));
    });
  }
}

http.Response boxInfoOf(String id) => jsonResponse(200, {
  'boxId': id,
  'keyFp': 'a1a1a1a1a1a1a1a1',
  'name': 'X',
  'state': 'active',
  'reason': '',
  'linked': true,
  'https': true,
});
