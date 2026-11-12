// Enrol screen: paste a code, recognise the surau and yourself, pick a
// PIN, enrol; help where a person can get stuck. Goldens: enrol_scan,
// enrol_manual, enrol_review, enrol_expired, enrol_done at the three sizes.

import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:surau_app/app/theme.dart';
import 'package:surau_app/box/box_client.dart';
import 'package:surau_app/features/common/surau_info.dart';
import 'package:surau_app/features/enrol/enrol_flow.dart';
import 'package:surau_app/features/enrol/enrol_screen.dart';
import 'package:surau_app/l10n/generated/s.dart';

import '../../golden_sizes.dart';
import '../fakes.dart';
import '../shell/harness.dart'
    show fixtureLogoPng, fixtureMaxcomRemovedPng, settleImages;

late FakeDeviceKey key;
late FakeTrust trust;
late MemoryEnrolledBoxStore store;
late MemorySurauInfoStore infoStore;
late FakeOpener opener;

EnrolFlow flowFor(FakeBox box) {
  key = FakeDeviceKey();
  trust = FakeTrust();
  store = MemoryEnrolledBoxStore();
  infoStore = MemorySurauInfoStore();
  return EnrolFlow(
    clientFor: box.client,
    key: key,
    trust: trust,
    store: store,
    surauInfoStore: infoStore,
    platform: 'android',
    now: fixedNow,
  );
}

Widget app(Widget home) => MaterialApp(
  key: UniqueKey(),
  debugShowCheckedModeBanner: false,
  theme: SurauTheme.light(),
  locale: const Locale('ms'),
  localizationsDelegates: S.localizationsDelegates,
  supportedLocales: S.supportedLocales,
  home: home,
);

/// Stands in for the camera preview in tests: a dark fill.
Widget fakeScanner(
  BuildContext context,
  void Function(String) onCode,
  VoidCallback onCameraError,
) => const ColoredBox(color: Color(0xFF17201E));

/// A scanner whose camera fails as soon as it is built.
Widget failingScanner(
  BuildContext context,
  void Function(String) onCode,
  VoidCallback onCameraError,
) {
  WidgetsBinding.instance.addPostFrameCallback((_) => onCameraError());
  return const ColoredBox(color: Color(0xFF17201E));
}

Widget screen(
  EnrolFlow flow, {
  bool cameraAvailable = false,
  EnrolMode initialMode = EnrolMode.scan,
  String? initialCode,
  void Function(EnrolOutcome)? onEnrolled,
  ScannerBuilder scannerBuilder = fakeScanner,
  SurauInfo? knownSurau,
  LogoLoader logoLoader = noLogo,
}) {
  opener = FakeOpener();
  return app(
    EnrolScreen(
      flow: flow,
      cameraAvailable: cameraAvailable,
      scannerBuilder: scannerBuilder,
      initialMode: initialMode,
      initialCode: initialCode,
      knownSurau: knownSurau,
      logoLoader: logoLoader,
      onEnrolled: onEnrolled ?? (_) {},
      openUrl: opener.call,
      now: fixedNow,
      toLocal: fixedToLocal,
    ),
  );
}

/// [fixturePayload] as the box now issues it, with `pinSet`.
String payloadWithPinSet(bool pinSet) {
  final raw = fixturePayload().substring('surau1:'.length);
  final m = jsonDecode(
    utf8.decode(base64Url.decode(base64Url.normalize(raw))),
  ) as Map<String, Object?>;
  m['pinSet'] = pinSet;
  return 'surau1:${base64Url.encode(utf8.encode(jsonEncode(m))).replaceAll('=', '')}';
}

Future<void> pasteAndContinue(WidgetTester t, String code) async {
  await t.enterText(find.byType(TextField).first, code);
  await t.tap(find.widgetWithText(FilledButton, 'Teruskan'));
  await t.pumpAndSettle();
}

Future<void> typePin(WidgetTester t, String pin, String again) async {
  final fields = find.byType(TextField);
  // Fields: device name, PIN, PIN again (the paste field is gone in review).
  await t.enterText(fields.at(1), pin);
  await t.enterText(fields.at(2), again);
}

Future<void> tapEnrol(WidgetTester t) async {
  await t.ensureVisible(find.widgetWithText(FilledButton, 'Daftar peranti'));
  await t.pumpAndSettle();
  await t.tap(find.widgetWithText(FilledButton, 'Daftar peranti'));
  await t.pumpAndSettle();
}

/// Scrolls a PIN choice tile into view and taps it.
Future<void> choose(WidgetTester t, String label) async {
  await t.ensureVisible(find.text(label));
  await t.pumpAndSettle();
  await t.tap(find.text(label));
  await t.pumpAndSettle();
}

/// Opens "Butiran teknikal" on the review step.
Future<void> openTechnical(WidgetTester t) async {
  await t.ensureVisible(find.text('Butiran teknikal'));
  await t.pumpAndSettle();
  await t.tap(find.text('Butiran teknikal'));
  await t.pumpAndSettle();
}

void main() {
  testWidgets(
    'no camera: paste field shown; pasting shows the surau, the person and the steps',
    (tester) async {
      await pumpAtSize(
        tester,
        screen(flowFor(FakeBox(happyBox))),
        GoldenSize.phone,
      );
      expect(
        find.text(
          'Kamera tidak tersedia di sini. Tampal kod pendaftaran yang diberikan pentadbir.',
        ),
        findsOneWidget,
      );
      expect(find.byType(TextField), findsOneWidget);
      expect(find.text('Imbas kod'), findsOneWidget);
      expect(find.text('Semak'), findsOneWidget);
      expect(find.text('Tetapkan PIN'), findsOneWidget);

      await pasteAndContinue(tester, fixturePayload(exp: fixtureExpToday));

      expect(find.text('Surau D\'Waqaf'), findsOneWidget);
      expect(find.text('Assalamualaikum, Ustaz Ali'), findsOneWidget);
      expect(find.text('Pentadbir'), findsOneWidget);
      expect(
        find.text(
          'Dijemput oleh Encik Hafiz. Jemputan sah hingga 10:45 malam.',
        ),
        findsOneWidget,
      );
      expect(find.text('Saya sudah ada PIN'), findsOneWidget);
      expect(find.text('Cipta PIN baharu'), findsOneWidget);
      expect(find.textContaining('Kotak'), findsNothing);

      // The address and fingerprint wait behind Butiran teknikal.
      expect(find.text('https://127.0.0.1:8443'), findsNothing);
      await openTechnical(tester);
      expect(find.text('https://127.0.0.1:8443'), findsOneWidget);
      expect(
        find.text('abcd ef01 2345 6789\nabcd ef01 2345 6789'),
        findsOneWidget,
      );
      expect(
        find.text('Bandingkan dengan cetakan pentadbir sebelum teruskan.'),
        findsOneWidget,
      );
    },
  );

  testWidgets('several roles and no inviter read calmly', (tester) async {
    await pumpAtSize(
      tester,
      screen(
        flowFor(FakeBox(happyBox)),
        initialCode: fixturePayload(
          exp: fixtureExpToday,
          roles: ['ajk', 'media'],
          invitedBy: null,
        ),
      ),
      GoldenSize.phone,
    );
    expect(find.text('Media dan AJK'), findsOneWidget);
    expect(find.text('Jemputan sah hingga 10:45 malam.'), findsOneWidget);
  });

  testWidgets(
    'the review card carries the invitation box\'s logo when it has one; a failure leaves the card as before',
    (tester) async {
      final asked = <Uri>[];
      await pumpAtSize(
        tester,
        screen(
          flowFor(FakeBox(happyBox)),
          initialCode: fixturePayload(exp: fixtureExpToday),
          logoLoader: (box) async {
            asked.add(box);
            return LoadedLogo(fixtureLogoPng());
          },
        ),
        GoldenSize.phone,
      );
      expect(asked, [
        Uri.parse('https://127.0.0.1:8443'),
      ], reason: 'the box named in the code, once');
      expect(find.byKey(const ValueKey('surau-logo')), findsOneWidget);
      expect(find.text('Surau D\'Waqaf'), findsOneWidget);

      await pumpAtSize(
        tester,
        screen(
          flowFor(FakeBox(happyBox)),
          initialCode: fixturePayload(exp: fixtureExpToday),
          logoLoader: (box) async => throw const BoxUnreachable(),
        ),
        GoldenSize.phone,
      );
      expect(find.byKey(const ValueKey('surau-logo')), findsNothing);
      expect(find.text('Surau D\'Waqaf'), findsOneWidget);
    },
  );

  testWidgets(
    'an old payload without the new fields still works, with fallbacks',
    (tester) async {
      await pumpAtSize(
        tester,
        screen(
          flowFor(FakeBox(happyBox)),
          initialCode: fixturePayload(exp: fixtureExpToday, legacy: true),
        ),
        GoldenSize.phone,
      );
      expect(find.text('MAXCOM'), findsOneWidget);
      expect(find.text('Assalamualaikum, Ustaz Ali'), findsOneWidget);
      expect(find.text('Pentadbir'), findsNothing);
      expect(find.text('Jemputan sah hingga 10:45 malam.'), findsOneWidget);
    },
  );

  testWidgets('the pasted code is hidden as dots until the eye is pressed', (
    tester,
  ) async {
    await pumpAtSize(
      tester,
      screen(flowFor(FakeBox(happyBox))),
      GoldenSize.phone,
    );
    await tester.enterText(
      find.byKey(const ValueKey('enrol-code-field')),
      'surau1:abc',
    );
    await tester.pump();
    bool obscured() => tester
        .widget<TextField>(find.byKey(const ValueKey('enrol-code-field')))
        .obscureText;
    expect(obscured(), isTrue);
    await tester.tap(find.byKey(const ValueKey('enrol-code-eye')));
    await tester.pump();
    expect(obscured(), isFalse);
    await tester.tap(find.byKey(const ValueKey('enrol-code-eye')));
    await tester.pump();
    expect(obscured(), isTrue);
  });

  testWidgets('a bad code shows the box wording and stays on the paste field', (
    tester,
  ) async {
    await pumpAtSize(
      tester,
      screen(flowFor(FakeBox(happyBox))),
      GoldenSize.phone,
    );
    await pasteAndContinue(tester, 'surau1:abc');
    expect(find.text('Kod QR pendaftaran tidak sah'), findsOneWidget);
    expect(find.byType(TextField), findsOneWidget);
    expect(find.text('Perlukan bantuan?'), findsNothing);
  });

  testWidgets('an expired invitation names the helper from the payload', (
    tester,
  ) async {
    await pumpAtSize(
      tester,
      screen(flowFor(FakeBox(happyBox))),
      GoldenSize.phone,
    );
    await pasteAndContinue(tester, fixturePayload(exp: 1000));
    expect(
      find.text(
        'Kod pendaftaran telah tamat. Minta kod baharu daripada pentadbir.',
      ),
      findsOneWidget,
    );
    expect(find.text('Hubungi Encik Hafiz'), findsOneWidget);
    await tester.tap(find.text('WhatsApp'));
    expect(opener.opened.single.toString(), 'https://wa.me/60123456789');
  });

  testWidgets(
    'Cipta PIN baharu with 123456 says PIN terlalu mudah, no request',
    (tester) async {
      final box = FakeBox(happyBox);
      await pumpAtSize(
        tester,
        screen(flowFor(box), initialCode: fixturePayload()),
        GoldenSize.phone,
      );
      await tester.enterText(find.byType(TextField).at(0), 'Telefon Ali');
      await choose(tester, 'Cipta PIN baharu');
      await typePin(tester, '123456', '123456');
      await tapEnrol(tester);
      expect(find.textContaining('PIN terlalu mudah'), findsOneWidget);
      expect(box.seen, isEmpty);
      expect(key.generateCalls, 0);
    },
  );

  testWidgets('mismatched PINs say PIN tidak sepadan', (tester) async {
    final box = FakeBox(happyBox);
    await pumpAtSize(
      tester,
      screen(flowFor(box), initialCode: fixturePayload()),
      GoldenSize.phone,
    );
    await tester.enterText(find.byType(TextField).at(0), 'Telefon Ali');
    await choose(tester, 'Cipta PIN baharu');
    await typePin(tester, '280419', '280418');
    await tapEnrol(tester);
    expect(find.text('PIN tidak sepadan'), findsOneWidget);
    expect(box.seen, isEmpty);
  });

  testWidgets(
    '280419 twice enrols with pin and a 4-field JWK; onEnrolled fires; surau cached',
    (tester) async {
      final box = FakeBox(happyBox);
      EnrolOutcome? done;
      await pumpAtSize(
        tester,
        screen(
          flowFor(box),
          initialCode: fixturePayload(),
          onEnrolled: (o) => done = o,
        ),
        GoldenSize.phone,
      );
      await tester.enterText(find.byType(TextField).at(0), 'Telefon Ali');
      await choose(tester, 'Cipta PIN baharu');
      await typePin(tester, '280419', '280419');
      await tapEnrol(tester);
      expect(find.text('Peranti didaftarkan'), findsOneWidget);
      expect(find.text('Ustaz Ali\nSurau D\'Waqaf'), findsOneWidget);
      expect(
        find.text('Lain kali, buka aplikasi ini dan masukkan PIN anda.'),
        findsOneWidget,
      );
      expect(done, isNull);
      await tester.tap(find.widgetWithText(FilledButton, 'Teruskan'));
      await tester.pump();

      final body = box.bodyOf('/api/enrol/complete');
      expect(body['pin'], '280419');
      expect(body['deviceName'], 'Telefon Ali');
      expect((body['publicJwk'] as Map).keys.toSet(), {'kty', 'crv', 'x', 'y'});
      expect(done?.box.deviceId, 'dev-1');
      expect(done?.surau?.name, 'Surau D\'Waqaf');
      final cached = await infoStore.load();
      expect(cached?.name, 'Surau D\'Waqaf');
      expect(cached?.help?.phone, '012-345 6789');
    },
  );

  testWidgets('pinSet true: only the existing-PIN path, no PIN fields', (
    tester,
  ) async {
    final box = FakeBox(happyBox);
    await pumpAtSize(
      tester,
      screen(flowFor(box), initialCode: payloadWithPinSet(true)),
      GoldenSize.phone,
    );
    expect(
      find.text('Guna PIN yang sama seperti di peranti anda yang lain'),
      findsOneWidget,
    );
    expect(find.text('Saya sudah ada PIN'), findsNothing);
    expect(find.text('Cipta PIN baharu'), findsNothing);
    expect(find.byType(TextField), findsOneWidget); // device name only
    await tester.enterText(find.byType(TextField).at(0), 'Telefon Ali');
    await tapEnrol(tester);
    expect(box.bodyOf('/api/enrol/complete').containsKey('pin'), isFalse);
  });

  testWidgets('pinSet false: only the create-PIN path, with the fields', (
    tester,
  ) async {
    final box = FakeBox(happyBox);
    await pumpAtSize(
      tester,
      screen(flowFor(box), initialCode: payloadWithPinSet(false)),
      GoldenSize.phone,
    );
    expect(find.text('Cipta PIN 6 digit untuk akaun anda'), findsOneWidget);
    expect(find.text('Saya sudah ada PIN'), findsNothing);
    expect(find.text('Cipta PIN baharu'), findsNothing);
    expect(find.byType(TextField), findsNWidgets(3));
    await tester.enterText(find.byType(TextField).at(0), 'Telefon Ali');
    await typePin(tester, '280419', '280419');
    await tapEnrol(tester);
    expect(box.bodyOf('/api/enrol/complete')['pin'], '280419');
  });

  testWidgets('appLock false: no PIN step, a line says so, two steps, no pin sent', (
    tester,
  ) async {
    final box = FakeBox(happyBox);
    EnrolOutcome? got;
    await pumpAtSize(
      tester,
      screen(
        flowFor(box),
        initialCode: fixturePayload(appLock: false),
        onEnrolled: (o) => got = o,
      ),
      GoldenSize.phone,
    );
    expect(
      find.text(
        'Kunci aplikasi dimatikan oleh pentadbir. Peranti ini membuka MAXCOM tanpa PIN.',
      ),
      findsOneWidget,
    );
    expect(find.text('Tetapkan PIN'), findsNothing, reason: 'two steps only');
    expect(find.text('Saya sudah ada PIN'), findsNothing);
    expect(find.text('Cipta PIN baharu'), findsNothing);
    expect(find.byType(TextField), findsOneWidget);
    await tester.enterText(find.byType(TextField).at(0), 'Telefon Ali');
    await tapEnrol(tester);
    expect(box.bodyOf('/api/enrol/complete').containsKey('pin'), isFalse);
    expect(find.text('Lain kali, buka aplikasi ini dan ia terbuka terus tanpa PIN.'), findsOneWidget);
    expect(got, isNull);
    expect((await store.load())?.appLock, isFalse);
  });

  testWidgets('no pinSet (older box): both choices as before', (tester) async {
    final box = FakeBox(happyBox);
    await pumpAtSize(
      tester,
      screen(flowFor(box), initialCode: fixturePayload()),
      GoldenSize.phone,
    );
    expect(find.text('Saya sudah ada PIN'), findsOneWidget);
    expect(find.text('Cipta PIN baharu'), findsOneWidget);
  });

  testWidgets('Saya sudah ada PIN sends no pin', (tester) async {
    final box = FakeBox(happyBox);
    await pumpAtSize(
      tester,
      screen(flowFor(box), initialCode: fixturePayload()),
      GoldenSize.phone,
    );
    await tester.enterText(find.byType(TextField).at(0), 'Telefon Ali');
    await choose(tester, 'Saya sudah ada PIN');
    expect(find.byType(TextField), findsOneWidget); // no PIN fields
    await tapEnrol(tester);
    expect(box.bodyOf('/api/enrol/complete').containsKey('pin'), isFalse);
  });

  testWidgets('an empty device name is refused before any request', (
    tester,
  ) async {
    final box = FakeBox(happyBox);
    await pumpAtSize(
      tester,
      screen(flowFor(box), initialCode: fixturePayload()),
      GoldenSize.phone,
    );
    await choose(tester, 'Saya sudah ada PIN');
    await tapEnrol(tester);
    expect(find.text('Masukkan nama peranti'), findsOneWidget);
    expect(box.seen, isEmpty);
  });

  testWidgets(
    'a TrustError aborts before generate() and shows the CA message with help',
    (tester) async {
      final box = FakeBox(happyBox);
      final flow = flowFor(box);
      trust.fail = true;
      await pumpAtSize(
        tester,
        screen(flow, initialCode: fixturePayload()),
        GoldenSize.phone,
      );
      await tester.enterText(find.byType(TextField).at(0), 'Telefon Ali');
      await choose(tester, 'Saya sudah ada PIN');
      await tapEnrol(tester);
      expect(find.text('Sijil akar tidak sepadan'), findsOneWidget);
      expect(find.text('Hubungi Encik Hafiz'), findsOneWidget);
      expect(key.generateCalls, 0);
      expect(box.seen, isEmpty);
    },
  );

  testWidgets('box away: named by the surau, with the help card', (
    tester,
  ) async {
    final box = FakeBox((r) async => throw const BoxUnreachable());
    await pumpAtSize(
      tester,
      screen(flowFor(box), initialCode: fixturePayload()),
      GoldenSize.phone,
    );
    await tester.enterText(find.byType(TextField).at(0), 'Telefon Ali');
    await choose(tester, 'Saya sudah ada PIN');
    await tapEnrol(tester);
    expect(
      find.text('Tidak dapat menghubungi Surau D\'Waqaf'),
      findsOneWidget,
    );
    expect(find.text('Hubungi Encik Hafiz'), findsOneWidget);
  });

  testWidgets(
    'box says PIN exists: hint to pick Saya sudah ada PIN, code kept',
    (tester) async {
      final box = FakeBox(
        (r) async => jsonResponse(400, {
          'errors': ['PIN sudah ditetapkan untuk pengguna ini'],
        }),
      );
      await pumpAtSize(
        tester,
        screen(flowFor(box), initialCode: fixturePayload()),
        GoldenSize.phone,
      );
      await tester.enterText(find.byType(TextField).at(0), 'Telefon Ali');
      await choose(tester, 'Cipta PIN baharu');
      await typePin(tester, '280419', '280419');
      await tapEnrol(tester);
      expect(
        find.text('Anda sudah ada PIN. Pilih "Saya sudah ada PIN".'),
        findsOneWidget,
      );
      // Still on the review step with the same code.
      expect(find.text('Assalamualaikum, Ustaz Ali'), findsOneWidget);
      await openTechnical(tester);
      expect(find.text('https://127.0.0.1:8443'), findsOneWidget);
    },
  );

  testWidgets(
    'box says pinRequired: the done view explains the PIN comes at unlock',
    (tester) async {
      final box = FakeBox(
        (r) async => jsonResponse(200, {
          'deviceId': 'dev-1',
          'userId': 'u1',
          'roles': ['ajk'],
          'pinRequired': true,
        }),
      );
      await pumpAtSize(
        tester,
        screen(flowFor(box), initialCode: fixturePayload()),
        GoldenSize.phone,
      );
      await tester.enterText(find.byType(TextField).at(0), 'Telefon Ali');
      await choose(tester, 'Saya sudah ada PIN');
      await tapEnrol(tester);
      expect(find.text('Peranti didaftarkan'), findsOneWidget);
      expect(find.textContaining('PIN belum ditetapkan'), findsOneWidget);
    },
  );

  testWidgets(
    'scan mode with a camera shows the viewfinder and a manual button',
    (tester) async {
      await pumpAtSize(
        tester,
        screen(flowFor(FakeBox(happyBox)), cameraAvailable: true),
        GoldenSize.phone,
      );
      expect(
        find.text('Imbas kod QR yang ditunjukkan oleh pentadbir'),
        findsOneWidget,
      );
      expect(find.text('Masukkan kod secara manual'), findsOneWidget);
      expect(find.byType(TextField), findsNothing);
      await tester.tap(find.text('Masukkan kod secara manual'));
      await tester.pumpAndSettle();
      expect(find.byType(TextField), findsOneWidget);
      expect(find.text('Imbas kod QR'), findsOneWidget);
    },
  );

  testWidgets(
    'a camera failure falls back to the paste field, no scan button',
    (tester) async {
      await pumpAtSize(
        tester,
        screen(
          flowFor(FakeBox(happyBox)),
          cameraAvailable: true,
          scannerBuilder: failingScanner,
        ),
        GoldenSize.phone,
      );
      await tester.pumpAndSettle();
      expect(find.byType(TextField), findsOneWidget);
      expect(
        find.text(
          'Kamera tidak tersedia di sini. Tampal kod pendaftaran yang diberikan pentadbir.',
        ),
        findsOneWidget,
      );
      expect(find.text('Imbas kod QR'), findsNothing);
      expect(
        find.text('Perlukan bantuan?'),
        findsNothing,
        reason: 'no contact known yet',
      );
    },
  );

  testWidgets(
    'a camera failure on a re-enrolment shows the known surau helper',
    (tester) async {
      await pumpAtSize(
        tester,
        screen(
          flowFor(FakeBox(happyBox)),
          cameraAvailable: true,
          scannerBuilder: failingScanner,
          knownSurau: SurauInfo.fromJson(fixtureInfoJson),
        ),
        GoldenSize.phone,
      );
      await tester.pumpAndSettle();
      expect(find.text('Hubungi Encik Hafiz'), findsOneWidget);
    },
  );

  group('goldens', () {
    testWidgets('enrol_scan', (tester) async {
      for (final size in GoldenSize.values) {
        final w = screen(flowFor(FakeBox(happyBox)), cameraAvailable: true);
        await pumpAtSize(tester, w, size);
        await expectLater(
          find.byWidget(w),
          matchesGoldenFile('enrol_scan_${size.name}.png'),
        );
      }
    });

    testWidgets('enrol_manual', (tester) async {
      for (final size in GoldenSize.values) {
        final w = screen(
          flowFor(FakeBox(happyBox)),
          cameraAvailable: true,
          initialMode: EnrolMode.manual,
        );
        await pumpAtSize(tester, w, size);
        await expectLater(
          find.byWidget(w),
          matchesGoldenFile('enrol_manual_${size.name}.png'),
        );
      }
    });

    testWidgets('enrol_review', (tester) async {
      for (final size in GoldenSize.values) {
        final w = screen(
          flowFor(FakeBox(happyBox)),
          initialCode: fixturePayload(
            exp: fixtureExpToday,
            roles: ['admin', 'media'],
          ),
        );
        await pumpAtSize(tester, w, size);
        await tester.enterText(find.byType(TextField).at(0), 'Telefon Ali');
        await choose(tester, 'Cipta PIN baharu');
        FocusManager.instance.primaryFocus?.unfocus();
        await tester.drag(find.byType(ListView), const Offset(0, 2000));
        await tester.pumpAndSettle();
        await expectLater(
          find.byWidget(w),
          matchesGoldenFile('enrol_review_${size.name}.png'),
        );
      }
    });

    // The wordmark carries the surau's name (showName off): the review card
    // draws it wide by height, sized by its own shape, and leaves the text
    // name out; the greeting stays.
    testWidgets('enrol_review_wide_logo', (tester) async {
      for (final size in GoldenSize.values) {
        final w = screen(
          flowFor(FakeBox(happyBox)),
          initialCode: payloadWithPinSet(true),
          logoLoader: (box) async =>
              LoadedLogo(fixtureMaxcomRemovedPng(), showName: false),
        );
        await pumpAtSize(tester, w, size);
        await settleImages(tester);
        expect(find.byKey(const ValueKey('surau-logo')), findsOneWidget);
        expect(
          find.text('Surau D\'Waqaf'),
          findsNothing,
          reason: 'the logo is the name',
        );
        expect(
          find.textContaining('Assalamualaikum, '),
          findsOneWidget,
          reason: 'the greeting stays',
        );
        final logo = tester.getSize(find.byKey(const ValueKey('surau-logo')));
        expect(logo.height, 56);
        expect(
          logo.width / logo.height,
          closeTo((0.8 * 465 / 119) + 0.2, 0.1),
          reason: 'its own wide shape on its light card, not a square',
        );
        await expectLater(
          find.byWidget(w),
          matchesGoldenFile('enrol_review_wide_logo_${size.name}.png'),
        );
      }
    });

    // The box now says in the payload whether the person already has a
    // PIN: one path each, no choice to make.
    testWidgets('enrol_pin_set', (tester) async {
      for (final size in GoldenSize.values) {
        final w = screen(
          flowFor(FakeBox(happyBox)),
          initialCode: payloadWithPinSet(true),
        );
        await pumpAtSize(tester, w, size);
        await tester.enterText(find.byType(TextField).at(0), 'Telefon Ali');
        FocusManager.instance.primaryFocus?.unfocus();
        await tester.pumpAndSettle();
        expect(
          find.text('Guna PIN yang sama seperti di peranti anda yang lain'),
          findsOneWidget,
        );
        await expectLater(
          find.byWidget(w),
          matchesGoldenFile('enrol_pin_set_${size.name}.png'),
        );
      }
    });

    testWidgets('enrol_review_nolock', (tester) async {
      for (final size in GoldenSize.values) {
        final w = screen(
          flowFor(FakeBox(happyBox)),
          initialCode: fixturePayload(appLock: false),
        );
        await pumpAtSize(tester, w, size);
        await tester.enterText(find.byType(TextField).at(0), 'Telefon Ali');
        FocusManager.instance.primaryFocus?.unfocus();
        await tester.pumpAndSettle();
        expect(find.byKey(const ValueKey('enrol-no-lock')), findsOneWidget);
        await expectLater(
          find.byWidget(w),
          matchesGoldenFile('enrol_review_nolock_${size.name}.png'),
        );
      }
    });

    testWidgets('enrol_pin_new', (tester) async {
      for (final size in GoldenSize.values) {
        final w = screen(
          flowFor(FakeBox(happyBox)),
          initialCode: payloadWithPinSet(false),
        );
        await pumpAtSize(tester, w, size);
        await tester.enterText(find.byType(TextField).at(0), 'Telefon Ali');
        FocusManager.instance.primaryFocus?.unfocus();
        await tester.pumpAndSettle();
        expect(find.text('Cipta PIN 6 digit untuk akaun anda'), findsOneWidget);
        expect(find.byType(TextField), findsNWidgets(3));
        await expectLater(
          find.byWidget(w),
          matchesGoldenFile('enrol_pin_new_${size.name}.png'),
        );
      }
    });

    testWidgets('enrol_expired', (tester) async {
      for (final size in GoldenSize.values) {
        final w = screen(flowFor(FakeBox(happyBox)));
        await pumpAtSize(tester, w, size);
        await pasteAndContinue(tester, fixturePayload(exp: 1000));
        FocusManager.instance.primaryFocus?.unfocus();
        await tester.pumpAndSettle();
        await expectLater(
          find.byWidget(w),
          matchesGoldenFile('enrol_expired_${size.name}.png'),
        );
      }
    });

    testWidgets('enrol_done', (tester) async {
      for (final size in GoldenSize.values) {
        final w = screen(
          flowFor(FakeBox(happyBox)),
          initialCode: fixturePayload(),
        );
        await pumpAtSize(tester, w, size);
        await tester.enterText(find.byType(TextField).at(0), 'Telefon Ali');
        await choose(tester, 'Saya sudah ada PIN');
        await tapEnrol(tester);
        await expectLater(
          find.byWidget(w),
          matchesGoldenFile('enrol_done_${size.name}.png'),
        );
      }
    });
  });
}
