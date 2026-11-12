// Recovery from the box screen's QR: the recovery code on paper, a new Pentadbir, a new code shown once.

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:surau_app/app/theme.dart';
import 'package:surau_app/box/box_qr.dart';
import 'package:surau_app/features/enrol/enrol_flow.dart';
import 'package:surau_app/features/setup/recovery_screen.dart';
import 'package:surau_app/features/setup/setup_flow.dart';
import 'package:surau_app/l10n/generated/s.dart';

import '../features/fakes.dart';
import '../support/box_qr_fixture.dart';

Widget app(Widget home) => MaterialApp(
  debugShowCheckedModeBanner: false,
  theme: SurauTheme.light(),
  locale: const Locale('ms'),
  localizationsDelegates: S.localizationsDelegates,
  supportedLocales: S.supportedLocales,
  home: home,
);

class Rig {
  Rig({String state = 'recovery', int status = 201, Object? body}) {
    box = FakeBox((r) async {
      switch (r.url.path) {
        case '/api/box/info':
          return boxInfoResponse('recovery', state: state);
        case '/api/recovery/complete':
          return status == 201
              ? jsonResponse(201, body ?? {...completedBody, 'recoveryCode': 'WXYZ-2345-6789-ABCD'})
              : jsonResponse(status, body ?? {'errors': ['x'], 'code': 'bad_code'});
      }
      return http.Response('{}', 404);
    });
    key = FakeDeviceKey();
    store = MemoryEnrolledBoxStore();
    flow = SetupFlow(clientFor: box.client, key: key, trust: FakeTrust(), store: store, platform: 'ios-web', now: fixedNow);
  }

  late final FakeBox box;
  late final FakeDeviceKey key;
  late final MemoryEnrolledBoxStore store;
  late final SetupFlow flow;
  EnrolledBox? adopted;
  int done = 0;
  int scanAnother = 0;

  Widget screen() => app(
    RecoveryScreen(
      flow: flow,
      qrText: boxQrText('recovery'),
      defaultPhoneName: 'iPad',
      onAdopt: (b) => adopted = b,
      onDone: () => done++,
      onScanAnother: () => scanAnother++,
      toLocal: fixedToLocal,
    ),
  );
}

Future<void> tapKey(WidgetTester t, String k) async {
  final f = find.byKey(ValueKey(k));
  await t.ensureVisible(f);
  await t.pumpAndSettle();
  await t.tap(f);
  await t.pumpAndSettle();
}

Future<void> fill(WidgetTester t, {String code = 'abcd efgh jklm npqr'}) async {
  await t.enterText(find.byKey(const ValueKey('recovery-code-field')), code);
  await t.enterText(find.byKey(const ValueKey('recovery-admin')), 'Hajjah Aminah');
  await t.enterText(find.byKey(const ValueKey('recovery-pin')), '482916');
  await t.enterText(find.byKey(const ValueKey('recovery-pin-again')), '482916');
}

void main() {
  test('the code formatter upper-cases, groups by four and stops at 16', () {
    const f = RecoveryCodeFormatter();
    expect(f.formatEditUpdate(TextEditingValue.empty, const TextEditingValue(text: 'abcd efgh')).text, 'ABCD-EFGH');
    expect(f.formatEditUpdate(TextEditingValue.empty, const TextEditingValue(text: 'abcdefghjklmnpqrstuv')).text, 'ABCD-EFGH-JKLM-NPQR');
    expect(normalisedRecoveryCode('abcd-efgh-jklm-npqr'), 'ABCDEFGHJKLMNPQR');
    expect(normalisedRecoveryCode('ABCD-EFGH-JKLM-NPQ'), isNull);
  });

  testWidgets('found: the fingerprint is large and must be confirmed before the code field exists', (tester) async {
    final r = Rig();
    await tester.pumpWidget(r.screen());
    await tester.pumpAndSettle();
    expect(find.text('MAXCOM dalam mod pemulihan'), findsOneWidget);
    final p = BoxQrPayload.parse(boxQrText('recovery'), requireCa: false);
    expect(tester.widget<Text>(find.byKey(const ValueKey('recovery-found-fp'))).data, p.fingerprintGroups);
    expect(find.text('Pastikan kod ini sama dengan kod pada skrin TV'), findsOneWidget);
    expect(find.text('Sama, teruskan'), findsOneWidget);
    expect(find.text('Tidak sama, batalkan'), findsOneWidget);
    expect(find.byKey(const ValueKey('recovery-code-field')), findsNothing, reason: 'nothing can be typed before the comparison');
    expect(find.byKey(const ValueKey('recovery-pin')), findsNothing);
    await tapKey(tester, 'recovery-found-continue');
    expect(find.byKey(const ValueKey('recovery-code-field')), findsOneWidget);
    expect(find.byKey(const ValueKey('recovery-linked-hint')), findsOneWidget, reason: 'the recovery vector is a linked box');
  });

  testWidgets('Tidak sama, batalkan leaves without sending or making a key', (tester) async {
    final r = Rig();
    await tester.pumpWidget(r.screen());
    await tester.pumpAndSettle();
    await tapKey(tester, 'recovery-found-cancel');
    expect(r.scanAnother, 1);
    expect(r.box.byPath('/api/recovery/complete'), isNull);
    expect(r.key.generateCalls, 0);
  });

  testWidgets('a 15-symbol code is refused on the phone, nothing is sent', (tester) async {
    final r = Rig();
    await tester.pumpWidget(r.screen());
    await tester.pumpAndSettle();
    await tapKey(tester, 'recovery-found-continue');
    await fill(tester, code: 'ABCD-EFGH-JKLM-NPQ');
    await tapKey(tester, 'recovery-submit');
    expect(find.text('Kod pemulihan ada 16 aksara'), findsOneWidget);
    expect(r.box.byPath('/api/recovery/complete'), isNull);
    expect(r.key.generateCalls, 0);
  });

  testWidgets('sends the normalised code, then shows the NEW code once, then the Pentadbir line', (tester) async {
    final r = Rig();
    await tester.pumpWidget(r.screen());
    await tester.pumpAndSettle();
    await tapKey(tester, 'recovery-found-continue');
    await fill(tester);
    await tapKey(tester, 'recovery-submit');
    final body = r.box.bodyOf('/api/recovery/complete');
    expect(body['recoveryCode'], 'ABCDEFGHJKLMNPQR');
    expect(body['platform'], 'ios-web');
    expect(body['pin'], '482916');
    expect(find.text('WXYZ-2345-6789-ABCD'), findsOneWidget);
    expect(r.adopted, isNull);
    await tester.tap(find.byKey(const ValueKey('recovery-code-written')));
    await tester.pumpAndSettle();
    await tapKey(tester, 'recovery-code-continue');
    expect(find.text('WXYZ-2345-6789-ABCD'), findsNothing);
    expect(find.text('Anda Pentadbir Surau'), findsOneWidget);
    await tapKey(tester, 'recovery-to-dashboard');
    expect(r.adopted?.userName, 'Hajjah Aminah');
    expect(r.done, 1);
  });

  testWidgets('401 bad_code: the wrong-code message and "scan again"; the key is cleared', (tester) async {
    final r = Rig(status: 401);
    await tester.pumpWidget(r.screen());
    await tester.pumpAndSettle();
    await tapKey(tester, 'recovery-found-continue');
    await fill(tester);
    await tapKey(tester, 'recovery-submit');
    expect(find.text('Kod pemulihan salah. Kod QR di TV perlu diimbas semula'), findsOneWidget);
    expect(r.key.present, isFalse);
    await tester.tap(find.byKey(const ValueKey('join-error-scan')));
    expect(r.scanAnother, 1);
  });

  testWidgets('409 not_in_recovery has its own words', (tester) async {
    final a = Rig(status: 409, body: {'errors': ['x'], 'code': 'not_in_recovery'});
    await tester.pumpWidget(a.screen());
    await tester.pumpAndSettle();
    await tapKey(tester, 'recovery-found-continue');
    await fill(tester);
    await tapKey(tester, 'recovery-submit');
    expect(find.text('MAXCOM ini sudah ada Pentadbir aktif'), findsOneWidget);
  });

  testWidgets('429 has its own words', (tester) async {
    final b = Rig(status: 429, body: {'errors': ['x']});
    await tester.pumpWidget(b.screen());
    await tester.pumpAndSettle();
    await tapKey(tester, 'recovery-found-continue');
    await fill(tester);
    await tapKey(tester, 'recovery-submit');
    expect(find.textContaining('Terlalu banyak percubaan'), findsOneWidget);
  });

  testWidgets('a box that is not in recovery is explained before the form', (tester) async {
    final r = Rig(state: 'active');
    await tester.pumpWidget(r.screen());
    await tester.pumpAndSettle();
    expect(find.text('MAXCOM ini sudah ada Pentadbir aktif'), findsOneWidget);
    expect(find.byKey(const ValueKey('recovery-code-field')), findsNothing);
  });
}
