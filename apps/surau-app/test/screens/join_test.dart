// Joining a surau: the "Sertai Surau X?" review with the box's own fingerprint, the error cards for an expired or
// used code, a phone that belongs to another surau, a box that cannot be reached, and the one scan router.

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:surau_app/app/theme.dart';
import 'package:surau_app/box/box_client.dart';
import 'package:surau_app/box/box_qr.dart';
import 'package:surau_app/box/setup_client.dart';
import 'package:surau_app/features/enrol/enrol_flow.dart';
import 'package:surau_app/features/enrol/enrol_screen.dart';
import 'package:surau_app/features/enrol/join_errors.dart';
import 'package:surau_app/features/enrol/scan_router.dart';
import 'package:surau_app/features/setup/setup_flow.dart';
import 'package:surau_app/l10n/generated/s.dart';

import '../features/fakes.dart';
import '../support/box_qr_fixture.dart';

Widget app(Widget home) => MaterialApp(
  key: UniqueKey(),
  debugShowCheckedModeBanner: false,
  theme: SurauTheme.light(),
  locale: const Locale('ms'),
  localizationsDelegates: S.localizationsDelegates,
  supportedLocales: S.supportedLocales,
  home: Scaffold(body: SingleChildScrollView(child: home)),
);

BoxInfo infoOf({String boxId = '0123456789abcdef', String keyFp = '4f2a9c1e77b0d3a1'}) => BoxInfo(
  boxId: boxId,
  keyFp: keyFp,
  name: 'MAXCOM Dewan Utama',
  state: 'active',
  reason: 'none',
  linked: false,
  https: true,
  caSha256: null,
);

void main() {
  group('JoinErrorView', () {
    Future<void> show(WidgetTester t, Object error, {String? current, Uri? cloud, DateTime? at}) => t.pumpWidget(
      app(
        JoinErrorView(
          error: error,
          currentSurau: current,
          cloud: cloud,
          expiredAt: at,
          toLocal: fixedToLocal,
          onRetry: () {},
          onScanAnother: () {},
          onLeave: () {},
        ),
      ),
    );

    testWidgets('an expired code names the time and offers another scan', (t) async {
      await show(t, const EnrolExpired(), at: DateTime.utc(2026, 11, 4, 14, 45));
      expect(find.text('Kod sudah tamat'), findsOneWidget);
      expect(find.textContaining('Kod ini tamat pada 22:45'), findsOneWidget);
      expect(find.byKey(const ValueKey('join-error-scan')), findsOneWidget);
    });

    testWidgets('a used code', (t) async {
      await show(t, const BoxError(401, 'x', code: 'bad_enrol_code'));
      expect(find.text('Kod sudah digunakan'), findsOneWidget);
      expect(find.textContaining('maklumkan kepada Pentadbir'), findsOneWidget);
    });

    testWidgets('a phone already in another surau names that surau and offers to leave it', (t) async {
      await show(t, const EnrolAlreadyEnrolled(), current: 'Surau Al-Hidayah');
      expect(find.text('Telefon ini sudah menyertai surau lain'), findsOneWidget);
      expect(find.text('Telefon ini sudah berdaftar dengan Surau Al-Hidayah. Keluar dahulu.'), findsOneWidget);
      expect(find.text('Keluar dari Surau Al-Hidayah'), findsOneWidget);
      expect(find.byKey(const ValueKey('join-error-retry')), findsNothing);
    });

    testWidgets('a box that cannot be reached: three steps, retry, and the cloud line by whether the box is linked', (t) async {
      await show(t, const BoxUnreachable());
      expect(find.text('Tidak dapat menghubungi MAXCOM'), findsOneWidget);
      expect(find.textContaining('Wi-Fi utama surau'), findsOneWidget);
      expect(find.byKey(const ValueKey('join-error-retry')), findsOneWidget);
      expect(find.textContaining('belum dipautkan ke awan'), findsOneWidget);
      await show(t, const BoxUnreachable(), cloud: Uri.parse('https://api.mymaxcom.my'));
      expect(find.text('Pendaftaran melalui awan MAXCOM: akan datang'), findsOneWidget);
      await show(t, const TrustError('x'));
      expect(find.text('Tidak dapat menghubungi MAXCOM'), findsOneWidget);
    });

    testWidgets('a QR from another box', (t) async {
      await show(t, const BoxQrMismatch());
      expect(find.textContaining('Cap jari tidak sepadan'), findsOneWidget);
    });

    test('classification is closed over the known failures and null for anything else', () {
      expect(classifyJoinError(const BoxError(500, 'x')), isNull);
      expect(classifyJoinError(StateError('x')), isNull);
      expect(classifyJoinError(const SetupAlreadyDone()), JoinErrorKind.alreadySetUp);
      expect(classifyJoinError(const TooManyAttempts(30)), JoinErrorKind.tooMany);
    });
  });

  group('the enrol page in Plan 14 form', () {
    late FakeBox box;
    late EnrolFlow flow;
    late List<String> routed;

    Widget screen({
      Future<BoxInfo?> Function(Uri, String?)? info,
      Future<ScanOutcome> Function(String)? onBoxQr,
      String? initialCode,
      Future<http.Response> Function(http.Request)? handler,
    }) {
      box = FakeBox(handler ?? happyBox);
      flow = EnrolFlow(
        clientFor: box.client,
        key: FakeDeviceKey(),
        trust: FakeTrust(),
        store: MemoryEnrolledBoxStore(),
        platform: 'android',
        now: fixedNow,
      );
      routed = [];
      return app(
        SizedBox(
          height: 1400,
          child: EnrolScreen(
            flow: flow,
            cameraAvailable: false,
            onEnrolled: (_) {},
            pairingUi: true,
            initialCode: initialCode,
            boxInfoLoader: info,
            onBoxQr:
                onBoxQr ??
                (text) async {
                  routed.add(text);
                  return const ScanNavigated(ScannedKind.setup);
                },
            toLocal: fixedToLocal,
            now: fixedNow,
          ),
        ),
      );
    }

    testWidgets('the start copy tells a new MAXCOM from an invitation', (t) async {
      await t.pumpWidget(screen());
      await t.pumpAndSettle();
      expect(find.text('Telefon ini belum menyertai mana-mana surau'), findsOneWidget);
      expect(find.textContaining('imbas kod QR persediaan'), findsOneWidget);
      expect(find.textContaining('Jika anda dijemput'), findsOneWidget);
    });

    testWidgets('a pasted maxcom1 text goes to the scan router; a surau1 text to the review', (t) async {
      await t.pumpWidget(screen());
      await t.pumpAndSettle();
      await t.enterText(find.byKey(const ValueKey('enrol-code-field')), boxQrText('setup'));
      await t.tap(find.text('Teruskan'));
      await t.pumpAndSettle();
      expect(routed, [boxQrText('setup')]);
      expect(find.byKey(const ValueKey('join-review')), findsNothing);

      await t.enterText(find.byKey(const ValueKey('enrol-code-field')), fixturePayload(exp: fixtureExpToday));
      await t.tap(find.text('Teruskan'));
      await t.pumpAndSettle();
      expect(routed.length, 1);
      expect(find.byKey(const ValueKey('join-review')), findsOneWidget);
    });

    testWidgets('a failed route shows the card (a phone already in another surau)', (t) async {
      await t.pumpWidget(screen(onBoxQr: (_) async => const ScanFailed(EnrolAlreadyEnrolled())));
      await t.pumpAndSettle();
      await t.enterText(find.byKey(const ValueKey('enrol-code-field')), boxQrText('setup'));
      await t.tap(find.text('Teruskan'));
      await t.pumpAndSettle();
      expect(find.text('Telefon ini sudah menyertai surau lain'), findsOneWidget);
    });

    testWidgets('a probe QR gives the toast', (t) async {
      await t.pumpWidget(screen(onBoxQr: (_) async => const ScanProbeOk()));
      await t.pumpAndSettle();
      await t.enterText(find.byKey(const ValueKey('enrol-code-field')), boxQrText('probe'));
      await t.tap(find.text('Teruskan'));
      await t.pumpAndSettle();
      expect(find.text('Sambungan ke MAXCOM berjaya'), findsOneWidget);
    });

    testWidgets('an unknown scan says the QR is not recognised', (t) async {
      await t.pumpWidget(screen(onBoxQr: (_) async => const ScanUnknown()));
      await t.pumpAndSettle();
      // a maxcom1 prefix with junk is a kind the router decides on
      await t.enterText(find.byKey(const ValueKey('enrol-code-field')), boxQrText('setup'));
      await t.tap(find.text('Teruskan'));
      await t.pumpAndSettle();
      expect(find.text('Kod QR tidak dikenali'), findsOneWidget);
    });

    testWidgets('the review shows the surau, the inviter, and the box id and fingerprint the BOX gave', (t) async {
      await t.pumpWidget(screen(initialCode: fixturePayload(exp: fixtureExpToday), info: (b, ca) async => infoOf()));
      await t.pumpAndSettle();
      expect(find.text('Sertai Surau D\'Waqaf?'), findsOneWidget);
      expect(find.text('Assalamualaikum, Ustaz Ali'), findsWidgets);
      expect(find.text('Dijemput oleh Encik Hafiz'), findsOneWidget);
      expect(find.textContaining('Jemputan sah hingga'), findsOneWidget);
      expect(find.text('4F2A 9C1E 77B0 D3A1'), findsOneWidget);
      expect(find.textContaining('0123 4567 89AB CDEF'), findsOneWidget);
      expect(find.text('Ya, sertai surau ini'), findsOneWidget);
      expect(find.text('Bukan surau saya'), findsOneWidget);
    });

    testWidgets('a box that says another id than the invitation stops the join', (t) async {
      await t.pumpWidget(screen(initialCode: fixturePayload(exp: fixtureExpToday), info: (b, ca) async => infoOf(boxId: 'ffffffffffffffff')));
      await t.pumpAndSettle();
      expect(find.textContaining('Cap jari tidak sepadan'), findsOneWidget);
      final b = t.widget<FilledButton>(find.widgetWithText(FilledButton, 'Ya, sertai surau ini'));
      expect(b.onPressed, isNull);
    });

    testWidgets('a code that was already used becomes the "Kod sudah digunakan" card, not one red line', (t) async {
      await t.pumpWidget(
        screen(
          initialCode: fixturePayload(exp: fixtureExpToday, appLock: false),
          info: (b, ca) async => infoOf(),
          handler: (r) async => r.url.path == '/api/enrol/complete'
              ? jsonResponse(401, {'errors': ['Kod pendaftaran tidak sah atau telah tamat'], 'code': 'bad_enrol_code'})
              : happyBox(r),
        ),
      );
      await t.pumpAndSettle();
      final nameField = find.widgetWithText(TextField, 'Nama peranti');
      await t.ensureVisible(nameField);
      await t.pumpAndSettle();
      await t.enterText(nameField, 'Telefon Ali');
      await t.pump();
      final go = find.widgetWithText(FilledButton, 'Ya, sertai surau ini');
      await t.ensureVisible(go);
      await t.pumpAndSettle();
      await t.tap(go);
      await t.pumpAndSettle();
      expect(find.text('Kod sudah digunakan'), findsOneWidget);
    });
  });

  group('ScanRouter', () {
    late List<(String, Object?)> went;
    ScanRouter routerFor({required bool enrolled, FakeBox? box}) {
      went = [];
      final b = box ?? FakeBox((r) async => r.url.path == '/api/box/info' ? boxInfoResponse('probe', state: 'active') : jsonResponse(200, {'ok': true}));
      return ScanRouter(
        enrolled: enrolled,
        go: (path, {extra}) => went.add((path, extra)),
        flow: SetupFlow(clientFor: b.client, key: FakeDeviceKey(), trust: FakeTrust(), store: MemoryEnrolledBoxStore(), platform: 'android', now: fixedNow),
      );
    }

    test('setup, recovery and enrolment texts go to their pages carrying the text', () async {
      final r = routerFor(enrolled: false);
      expect(await r.route(boxQrText('setup')), isA<ScanNavigated>());
      expect(await r.route(boxQrText('recovery')), isA<ScanNavigated>());
      expect(await r.route('surau1:eyJ2IjoxfQ'), isA<ScanNavigated>());
      expect(went.map((w) => w.$1), ['/setup', '/recovery', '/enrol']);
      expect(went.first.$2, boxQrText('setup'));
    });

    test('a phone with a surau is refused all three, with the "leave first" error, and goes nowhere', () async {
      final r = routerFor(enrolled: true);
      for (final text in [boxQrText('setup'), boxQrText('recovery'), 'surau1:eyJ2IjoxfQ']) {
        final o = await r.route(text);
        expect(o, isA<ScanFailed>());
        expect((o as ScanFailed).error, isA<EnrolAlreadyEnrolled>());
      }
      expect(went, isEmpty);
    });

    test('a probe QR names its host and contacts nothing until confirmed; then it proves the connection', () async {
      final seen = <String>[];
      final b = FakeBox((r) async {
        seen.add(r.url.path);
        return r.url.path == '/api/box/info' ? boxInfoResponse('probe', state: 'active') : jsonResponse(200, {'ok': true});
      });
      final router = ScanRouter(
        enrolled: true,
        go: (path, {extra}) {},
        flow: SetupFlow(clientFor: b.client, key: FakeDeviceKey(), trust: FakeTrust(), store: MemoryEnrolledBoxStore(), platform: 'android', now: fixedNow),
      );
      final ask = await router.route(boxQrText('probe'));
      expect(ask, isA<ScanProbeAsk>());
      expect((ask as ScanProbeAsk).host, Uri.parse(boxQrPayloadJson('probe')['box'] as String).authority);
      expect(seen, isEmpty, reason: 'not a single request before the person says yes');
      expect(await ask.confirm(), isA<ScanProbeOk>());
      expect(seen, contains('/api/setup/probe'));
    });

    test('a probe that cannot reach the box is reported after the confirm, not thrown', () async {
      final down = FakeBox((r) async => throw http.ClientException('no route'));
      final ask = await routerFor(enrolled: true, box: down).route(boxQrText('probe'));
      expect(ask, isA<ScanProbeAsk>());
      expect(down.seen, isEmpty);
      final o = await (ask as ScanProbeAsk).confirm();
      expect(o, isA<ScanFailed>());
      expect(classifyJoinError((o as ScanFailed).error), JoinErrorKind.unreachable);
    });

    test('a forged probe QR is refused without any request', () async {
      final b = FakeBox((r) async => jsonResponse(200, {'ok': true}));
      final r = ScanRouter(
        enrolled: true,
        go: (path, {extra}) {},
        flow: SetupFlow(clientFor: b.client, key: FakeDeviceKey(), trust: FakeTrust(), store: MemoryEnrolledBoxStore(), platform: 'android', now: fixedNow),
      );
      final text = boxQrText('probe');
      final forged = '${text.substring(0, text.length - 6)}AAAAAA';
      final o = await r.route(forged);
      expect(o is ScanFailed || o is ScanUnknown, isTrue);
      expect(b.seen, isEmpty);
    });

    test('anything else is unknown', () async {
      final r = routerFor(enrolled: false);
      expect(await r.route('https://example.com'), isA<ScanUnknown>());
      expect(await r.route(''), isA<ScanUnknown>());
      expect(went, isEmpty);
    });
  });
}
