// First setup from the box screen's QR: found, form, confirm (fingerprint), PIN, the recovery code once, done.

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:surau_app/app/theme.dart';
import 'package:surau_app/box/box_qr.dart';
import 'package:surau_app/features/enrol/enrol_flow.dart';
import 'package:surau_app/features/setup/setup_flow.dart';
import 'package:surau_app/features/setup/setup_screen.dart';
import 'package:surau_app/l10n/generated/s.dart';
import 'package:http/http.dart' as http;

import '../features/fakes.dart';
import '../support/box_qr_fixture.dart';

Widget app(Widget home) => MaterialApp(
  key: UniqueKey(),
  debugShowCheckedModeBanner: false,
  theme: SurauTheme.light(),
  locale: const Locale('ms'),
  localizationsDelegates: S.localizationsDelegates,
  supportedLocales: S.supportedLocales,
  home: home,
);

class Rig {
  Rig({String state = 'setup', int status = 201, Object? body}) {
    box = FakeBox((r) async {
      switch (r.url.path) {
        case '/api/box/info':
          return boxInfoResponse('setup', state: state);
        case '/api/setup/complete':
          return status == 201 ? jsonResponse(201, body ?? completedBody) : jsonResponse(status, body ?? {'errors': ['x'], 'code': 'already_set_up'});
      }
      return http.Response('{}', 404);
    });
    key = FakeDeviceKey();
    store = MemoryEnrolledBoxStore();
    flow = SetupFlow(clientFor: box.client, key: key, trust: FakeTrust(), store: store, platform: 'android', now: fixedNow);
  }

  late final FakeBox box;
  late final FakeDeviceKey key;
  late final MemoryEnrolledBoxStore store;
  late final SetupFlow flow;
  EnrolledBox? adopted;
  int done = 0;
  int scanAnother = 0;

  Widget screen({String? text}) => app(
    SetupScreen(
      flow: flow,
      qrText: text ?? boxQrText('setup'),
      defaultPhoneName: 'Telefon Android',
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

Future<void> fillForm(WidgetTester t) async {
  await t.enterText(find.byKey(const ValueKey('setup-surau')), 'Surau Al-Hidayah');
  await t.enterText(find.byKey(const ValueKey('setup-admin')), 'Haji Ali');
  await t.enterText(find.byKey(const ValueKey('setup-box')), 'MAXCOM Dewan Utama');
}

void main() {
  testWidgets('found: the box, its id and the fingerprint groups from the signed QR', (tester) async {
    final r = Rig();
    await tester.pumpWidget(r.screen());
    await tester.pumpAndSettle();
    expect(find.text('MAXCOM ditemui'), findsOneWidget);
    final p = BoxQrPayload.parse(boxQrText('setup'), requireCa: false);
    expect(find.text(p.fingerprintGroups), findsOneWidget);
    expect(find.text('Belum disediakan'), findsOneWidget);
    expect(find.byKey(const ValueKey('setup-found-continue')), findsOneWidget);
    expect(r.key.generateCalls, 0, reason: 'nothing is made until the person submits');
  });

  testWidgets('found: the fingerprint is large and compared with the TV before the form; a mismatch cancels', (tester) async {
    final r = Rig();
    await tester.pumpWidget(r.screen());
    await tester.pumpAndSettle();
    final p = BoxQrPayload.parse(boxQrText('setup'), requireCa: false);
    expect(tester.widget<Text>(find.byKey(const ValueKey('setup-found-fp'))).data, p.fingerprintGroups);
    expect(find.text('Pastikan kod ini sama dengan kod pada skrin TV'), findsOneWidget);
    expect(find.text('Sama, teruskan'), findsOneWidget);
    expect(find.text('Tidak sama, batalkan'), findsOneWidget);
    expect(find.byKey(const ValueKey('setup-surau')), findsNothing, reason: 'no form before the comparison');
    await tapKey(tester, 'setup-found-cancel');
    expect(r.scanAnother, 1);
    expect(r.box.byPath('/api/setup/complete'), isNull);
    expect(r.key.generateCalls, 0);
    await tapKey(tester, 'setup-found-continue');
    expect(find.byKey(const ValueKey('setup-surau')), findsOneWidget);
  });

  testWidgets('the form refuses an empty surau name and prefills the phone and box names', (tester) async {
    final r = Rig();
    await tester.pumpWidget(r.screen());
    await tester.pumpAndSettle();
    await tapKey(tester, 'setup-found-continue');
    expect(find.text('Telefon Android'), findsOneWidget, reason: 'the phone name is prefilled');
    final p = BoxQrPayload.parse(boxQrText('setup'), requireCa: false);
    expect(find.text(p.name), findsOneWidget, reason: 'the box name is prefilled');
    await tapKey(tester, 'setup-form-continue');
    expect(find.text('Ruangan ini diperlukan'), findsWidgets);
    expect(find.byKey(const ValueKey('setup-confirm-fp')), findsNothing);
  });

  testWidgets('confirm shows the fingerprint equal to the payload and the only-first note', (tester) async {
    final r = Rig();
    await tester.pumpWidget(r.screen());
    await tester.pumpAndSettle();
    await tapKey(tester, 'setup-found-continue');
    await fillForm(tester);
    await tapKey(tester, 'setup-form-continue');
    final p = BoxQrPayload.parse(boxQrText('setup'), requireCa: false);
    expect(tester.widget<Text>(find.byKey(const ValueKey('setup-confirm-fp'))).data, p.fingerprintGroups);
    expect(find.text('Mesti sama dengan cap jari di bawah kod QR di skrin TV'), findsOneWidget);
    expect(find.textContaining('Hanya telefon pertama'), findsOneWidget);
    expect(find.text('Surau Al-Hidayah'), findsOneWidget);
  });

  testWidgets('a weak or mismatched PIN never leaves the phone; then the whole path to the dashboard', (tester) async {
    final r = Rig();
    await tester.pumpWidget(r.screen());
    await tester.pumpAndSettle();
    await tapKey(tester, 'setup-found-continue');
    await fillForm(tester);
    await tapKey(tester, 'setup-form-continue');
    await tapKey(tester, 'setup-confirm-continue');
    await tester.enterText(find.byKey(const ValueKey('setup-pin')), '123456');
    await tester.enterText(find.byKey(const ValueKey('setup-pin-again')), '123456');
    await tapKey(tester, 'setup-submit');
    expect(find.text('PIN terlalu mudah. Pilih 6 digit yang bukan sama dan bukan turutan.'), findsOneWidget);
    expect(r.box.byPath('/api/setup/complete'), isNull);
    await tester.enterText(find.byKey(const ValueKey('setup-pin')), '482916');
    await tester.enterText(find.byKey(const ValueKey('setup-pin-again')), '482917');
    await tapKey(tester, 'setup-submit');
    expect(r.box.byPath('/api/setup/complete'), isNull);

    await tester.enterText(find.byKey(const ValueKey('setup-pin-again')), '482916');
    await tapKey(tester, 'setup-submit');
    expect(r.box.byPath('/api/setup/complete'), isNotNull);
    // the recovery code, once; "Teruskan" waits for the tick
    expect(find.text('ABCD-EFGH-JKLM-NPQR'), findsOneWidget);
    expect(find.text('Kod ini hanya ditunjukkan sekali'), findsOneWidget);
    expect(tester.widget<FilledButton>(find.byKey(const ValueKey('recovery-code-continue'))).onPressed, isNull);
    expect(r.adopted, isNull, reason: 'the app is not locked away from the code page');
    await tester.tap(find.byKey(const ValueKey('recovery-code-written')));
    await tester.pumpAndSettle();
    expect(tester.widget<FilledButton>(find.byKey(const ValueKey('recovery-code-continue'))).onPressed, isNotNull);
    await tapKey(tester, 'recovery-code-continue');
    // the code is gone from the screen for good
    expect(find.text('ABCD-EFGH-JKLM-NPQR'), findsNothing);
    expect(find.text('Surau Al-Hidayah sudah sedia'), findsOneWidget);
    expect(find.text('Daftar telefon AJK lain'), findsOneWidget);
    expect(find.text('Pautkan ke awan MAXCOM'), findsOneWidget);
    await tapKey(tester, 'setup-to-dashboard');
    expect(r.adopted?.deviceId, 'dev-new');
    expect(r.done, 1);
    expect(r.key.present, isTrue);
  });

  testWidgets('a box that is already set up: "Surau sudah disediakan", with a way to scan another', (tester) async {
    final r = Rig(state: 'active');
    await tester.pumpWidget(r.screen());
    await tester.pumpAndSettle();
    expect(find.text('Surau sudah disediakan'), findsOneWidget);
    expect(find.byKey(const ValueKey('setup-found-continue')), findsNothing);
    await tester.tap(find.byKey(const ValueKey('join-error-scan')));
    expect(r.scanAnother, 1);
  });

  testWidgets('a 409 at the very end (someone else won) says so and keeps nothing', (tester) async {
    final r = Rig(status: 409);
    await tester.pumpWidget(r.screen());
    await tester.pumpAndSettle();
    await tapKey(tester, 'setup-found-continue');
    await fillForm(tester);
    await tapKey(tester, 'setup-form-continue');
    await tapKey(tester, 'setup-confirm-continue');
    await tester.enterText(find.byKey(const ValueKey('setup-pin')), '482916');
    await tester.enterText(find.byKey(const ValueKey('setup-pin-again')), '482916');
    await tapKey(tester, 'setup-submit');
    expect(find.text('Surau sudah disediakan'), findsOneWidget);
    expect(r.key.present, isFalse);
    expect(await r.store.load(), isNull);
    expect(r.adopted, isNull);
  });

  testWidgets('an expired QR is explained without any network call', (tester) async {
    final r = Rig();
    final late = SetupFlow(
      clientFor: r.box.client,
      key: r.key,
      trust: FakeTrust(),
      store: r.store,
      platform: 'android',
      now: () => DateTime.utc(2027, 1, 1),
    );
    await tester.pumpWidget(
      app(SetupScreen(flow: late, qrText: boxQrText('setup'), defaultPhoneName: 'x', onAdopt: (_) {}, onDone: () {}, onScanAnother: () {}, toLocal: fixedToLocal)),
    );
    await tester.pumpAndSettle();
    expect(find.text('Kod sudah tamat'), findsOneWidget);
    expect(r.box.seen, isEmpty);
  });

  testWidgets('a QR that is not for this box (fingerprint differs) is refused', (tester) async {
    final box = FakeBox((r) async => boxInfoResponse('setup', keyFp: '0123456789abcdef'));
    final flow = SetupFlow(clientFor: box.client, key: FakeDeviceKey(), trust: FakeTrust(), store: MemoryEnrolledBoxStore(), platform: 'android', now: fixedNow);
    await tester.pumpWidget(
      app(SetupScreen(flow: flow, qrText: boxQrText('setup'), defaultPhoneName: 'x', onAdopt: (_) {}, onDone: () {}, onScanAnother: () {}, toLocal: fixedToLocal)),
    );
    await tester.pumpAndSettle();
    expect(find.textContaining('Cap jari tidak sepadan'), findsOneWidget);
  });
}
