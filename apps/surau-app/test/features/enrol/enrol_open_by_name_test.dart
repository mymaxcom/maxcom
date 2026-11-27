// Enrol review: the "open by the MAXCOM name" notice (web page at an IP address).

import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:surau_app/features/enrol/enrol_screen.dart';

import '../../golden_sizes.dart';
import '../fakes.dart';
import 'enrol_screen_test.dart' show app, fakeScanner, flowFor;

String payloadWithName(String name) {
  final raw = fixturePayload(exp: fixtureExpToday).substring('surau1:'.length);
  final m = jsonDecode(utf8.decode(base64Url.decode(base64Url.normalize(raw)))) as Map<String, Object?>;
  m['name'] = name;
  return 'surau1:${base64Url.encode(utf8.encode(jsonEncode(m))).replaceAll('=', '')}';
}

Widget review(
  String code, {
  Uri? page,
  required List<Uri> opened,
  FakeBox? box,
}) => app(
  EnrolScreen(
    flow: flowFor(box ?? FakeBox(happyBox)),
    cameraAvailable: false,
    scannerBuilder: fakeScanner,
    initialCode: code,
    onEnrolled: (_) {},
    pageOriginOf: () => page,
    openOrigin: opened.add,
    now: fixedNow,
    toLocal: fixedToLocal,
  ),
);

final _ipPage = Uri.parse('https://127.0.0.1:8443');
const _origin = 'https://box1-surau.local:8443';

void main() {
  testWidgets('page at an IP and a named box: notice, open button, join is secondary', (tester) async {
    final opened = <Uri>[];
    await pumpAtSize(tester, review(payloadWithName('box1-surau.local'), page: _ipPage, opened: opened), GoldenSize.phone);
    await tester.pumpAndSettle();
    await tester.scrollUntilVisible(find.text('Teruskan dengan alamat IP'), 300, scrollable: find.byType(Scrollable).first);
    expect(find.text('Buka melalui nama MAXCOM'), findsOneWidget);
    expect(find.textContaining('Buka $_origin dan imbas kod ini sekali lagi di sana.'), findsOneWidget);
    expect(find.widgetWithText(FilledButton, 'Buka box1-surau.local'), findsOneWidget);
    expect(find.widgetWithText(OutlinedButton, 'Teruskan dengan alamat IP'), findsOneWidget);
    expect(find.text('Daftar peranti'), findsNothing);

    await tester.ensureVisible(find.byKey(const ValueKey('open-by-name-open')));
    await tester.tap(find.byKey(const ValueKey('open-by-name-open')));
    expect(opened.map((u) => u.toString()), [_origin]);
  });

  testWidgets('the secondary button enrols as before', (tester) async {
    final opened = <Uri>[];
    final box = FakeBox(happyBox);
    await pumpAtSize(
      tester,
      review(payloadWithName('box1-surau.local'), page: _ipPage, opened: opened, box: box),
      GoldenSize.phone,
    );
    await tester.pumpAndSettle();
    await tester.scrollUntilVisible(find.text('Saya sudah ada PIN'), 300, scrollable: find.byType(Scrollable).first);
    await tester.tap(find.text('Saya sudah ada PIN'));
    await tester.pumpAndSettle();
    await tester.enterText(find.byType(TextField).at(0), 'Telefon Ali');
    final join = find.widgetWithText(OutlinedButton, 'Teruskan dengan alamat IP');
    await tester.scrollUntilVisible(join, 300, scrollable: find.byType(Scrollable).first);
    await tester.tap(join);
    await tester.pumpAndSettle();
    expect(box.byPath('/api/enrol/complete'), isNotNull);
    expect(opened, isEmpty);
  });

  testWidgets('no name, or native (no page): no notice, Join label unchanged', (tester) async {
    final opened = <Uri>[];
    await pumpAtSize(tester, review(fixturePayload(exp: fixtureExpToday), page: _ipPage, opened: opened), GoldenSize.phone);
    await tester.pumpAndSettle();
    expect(find.byKey(const ValueKey('open-by-name-notice')), findsNothing);
    expect(find.widgetWithText(FilledButton, 'Daftar peranti'), findsOneWidget);

    await pumpAtSize(tester, review(payloadWithName('box1-surau.local'), page: null, opened: opened), GoldenSize.phone);
    await tester.pumpAndSettle();
    expect(find.byKey(const ValueKey('open-by-name-notice')), findsNothing);
    expect(find.widgetWithText(FilledButton, 'Daftar peranti'), findsOneWidget);
    expect(find.text('Teruskan dengan alamat IP'), findsNothing);
  });

  testWidgets('page already at the name: no notice', (tester) async {
    await pumpAtSize(
      tester,
      review(payloadWithName('box1-surau.local'), page: Uri.parse(_origin), opened: []),
      GoldenSize.phone,
    );
    await tester.pumpAndSettle();
    expect(find.byKey(const ValueKey('open-by-name-notice')), findsNothing);
  });

  testWidgets('page at an IP the payload does not list, or at another port: no notice', (tester) async {
    await pumpAtSize(
      tester,
      review(payloadWithName('box1-surau.local'), page: Uri.parse('https://10.9.9.9:8443'), opened: []),
      GoldenSize.phone,
    );
    await tester.pumpAndSettle();
    expect(find.byKey(const ValueKey('open-by-name-notice')), findsNothing);

    await pumpAtSize(
      tester,
      review(payloadWithName('box1-surau.local'), page: Uri.parse('https://127.0.0.1:9443'), opened: []),
      GoldenSize.phone,
    );
    await tester.pumpAndSettle();
    expect(find.byKey(const ValueKey('open-by-name-notice')), findsNothing);
  });

  testWidgets('the open button is disabled while the join is in flight', (tester) async {
    final opened = <Uri>[];
    final gate = Completer<void>();
    final box = FakeBox((r) async {
      if (r.url.path == '/api/enrol/complete') await gate.future;
      return happyBox(r);
    });
    await pumpAtSize(tester, review(payloadWithName('box1-surau.local'), page: _ipPage, opened: opened, box: box), GoldenSize.phone);
    await tester.pumpAndSettle();
    await tester.scrollUntilVisible(find.text('Saya sudah ada PIN'), 300, scrollable: find.byType(Scrollable).first);
    await tester.tap(find.text('Saya sudah ada PIN'));
    await tester.pumpAndSettle();
    await tester.enterText(find.byType(TextField).at(0), 'Telefon Ali');
    final join = find.widgetWithText(OutlinedButton, 'Teruskan dengan alamat IP');
    await tester.scrollUntilVisible(join, 300, scrollable: find.byType(Scrollable).first);
    await tester.tap(join);
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 50));
    final open = tester.widget<FilledButton>(find.byKey(const ValueKey('open-by-name-open')));
    expect(open.onPressed, isNull);
    gate.complete();
    await tester.pumpAndSettle();
  });
}
