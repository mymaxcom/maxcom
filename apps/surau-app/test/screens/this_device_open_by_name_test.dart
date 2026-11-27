// This device: the "enrolled through an IP address" notice (web only).

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:surau_app/box/open_by_name.dart';

import '../features/shell/harness.dart';
import '../golden_sizes.dart';

Future<ShellHarness> open(WidgetTester tester, {Uri? page, String? boxName, List<Uri>? opened}) async {
  final h = ShellHarness(
    roles: const ['admin'],
    features: const {'appLock': true},
    boxName: boxName,
    overrides: [
      pageOriginProvider.overrideWithValue(page),
      originOpenerProvider.overrideWithValue((o) => opened?.add(o)),
    ],
  );
  h.unlock();
  await pumpAtSize(tester, h.app, GoldenSize.phone);
  h.router.go('/this-device');
  await settle(tester);
  return h;
}

void main() {
  testWidgets('web page at an IP, enrolled by IP, box has a name: notice and open button', (tester) async {
    final opened = <Uri>[];
    await open(tester, page: Uri.parse('https://127.0.0.1:8443'), boxName: 'box1-surau.local', opened: opened);
    expect(find.text('Buka melalui nama MAXCOM'), findsOneWidget);
    expect(
      find.textContaining('Untuk kekal, buka https://box1-surau.local:8443 dan daftarkan peranti ini di sana.'),
      findsOneWidget,
    );
    expect(find.widgetWithText(FilledButton, 'Buka box1-surau.local'), findsOneWidget);
    await tester.ensureVisible(find.byKey(const ValueKey('open-by-name-open')));
    await tester.tap(find.byKey(const ValueKey('open-by-name-open')));
    expect(opened.map((u) => u.toString()), ['https://box1-surau.local:8443']);
  });

  testWidgets('native (no page) or no name: no notice', (tester) async {
    await open(tester, page: null, boxName: 'box1-surau.local');
    expect(find.byKey(const ValueKey('open-by-name-notice')), findsNothing);
    await open(tester, page: Uri.parse('https://127.0.0.1:8443'), boxName: null);
    expect(find.byKey(const ValueKey('open-by-name-notice')), findsNothing);
  });
}
