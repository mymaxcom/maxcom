// Regression test for the live summary sheet bottom overflow in landscape.

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:surau_app/features/live/live_screen.dart';
import 'package:surau_app/l10n/generated/s.dart';

Widget _wrap(Widget child) => MaterialApp(
  locale: const Locale('ms'),
  localizationsDelegates: S.localizationsDelegates,
  supportedLocales: S.supportedLocales,
  home: Scaffold(body: child),
);

Widget _summary() => LiveSummarySheet(
  durationSec: 1800,
  youtubeSeconds: 1700,
  recorded: true,
  web: false,
  kuliah: null,
  watchUrl: 'https://www.youtube.com/watch?v=abc',
  onWatch: (_) {},
  onSave: () {},
);

void main() {
  group('LiveSummarySheet', () {
    Future<void> pumpAtSize(WidgetTester tester, Size logicalSize) async {
      tester.view.physicalSize = logicalSize;
      tester.view.devicePixelRatio = 1.0;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);
      await tester.pumpWidget(_wrap(_summary()));
      await tester.pumpAndSettle();
    }

    testWidgets('fits at 800x360 landscape without overflow', (tester) async {
      await pumpAtSize(tester, const Size(800, 360));
      expect(tester.takeException(), isNull);
      final button = find.text('Lihat di YouTube');
      expect(button, findsOneWidget);
      expect(tester.getRect(button).top, greaterThanOrEqualTo(0));
      expect(tester.getRect(button).bottom, lessThanOrEqualTo(360));
      await tester.ensureVisible(button);
      await tester.tap(button);
      await tester.pumpAndSettle();
      expect(tester.takeException(), isNull);
    });

    testWidgets('fits at a normal portrait size without overflow', (
      tester,
    ) async {
      await pumpAtSize(tester, const Size(400, 800));
      expect(tester.takeException(), isNull);
      final button = find.text('Lihat di YouTube');
      expect(button, findsOneWidget);
      await tester.ensureVisible(button);
      await tester.tap(button);
      await tester.pumpAndSettle();
      expect(tester.takeException(), isNull);
    });
  });
}
