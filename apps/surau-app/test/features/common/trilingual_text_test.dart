// The waiting screen: BM at normal size, small muted English and Arabic
// under it, the Arabic line right to left. Golden: waiting_trilingual
// (phone). Open the PNG: three lines, centred, Arabic joined and legible.

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:surau_app/app/theme.dart';
import 'package:surau_app/features/common/trilingual_strings.dart';
import 'package:surau_app/features/common/trilingual_text.dart';
import 'package:surau_app/l10n/generated/s.dart';

import '../../golden_sizes.dart';

Widget app(Widget body) => MaterialApp(
  debugShowCheckedModeBanner: false,
  theme: SurauTheme.light(),
  locale: const Locale('ms'),
  localizationsDelegates: S.localizationsDelegates,
  supportedLocales: S.supportedLocales,
  home: Scaffold(backgroundColor: SurauColors.glass, body: body),
);

Widget waiting() => app(
  const Center(
    child: TrilingualWait(
      ms: TrilingualStrings.loadingMs,
      en: TrilingualStrings.loadingEn,
      ar: TrilingualStrings.loadingAr,
    ),
  ),
);

/// The spinner never settles, so the window is sized and pumped once.
Future<void> pumpWaiting(WidgetTester tester) async {
  final view = tester.view;
  view.physicalSize = GoldenSize.phone.size * goldenPixelRatio;
  view.devicePixelRatio = goldenPixelRatio;
  addTearDown(view.resetPhysicalSize);
  addTearDown(view.resetDevicePixelRatio);
  await tester.pumpWidget(waiting());
  await tester.pump(const Duration(milliseconds: 100));
}

void main() {
  testWidgets('shows the three texts, BM large and EN and AR at 0.7x', (tester) async {
    await pumpWaiting(tester);
    expect(find.text('Memuatkan MAXCOM'), findsOneWidget);
    expect(find.text('Loading MAXCOM'), findsOneWidget);
    expect(find.text('جارٍ تحميل MAXCOM'), findsOneWidget);
    final ms = tester.widget<Text>(find.text('Memuatkan MAXCOM'));
    final en = tester.widget<Text>(find.text('Loading MAXCOM'));
    final ar = tester.widget<Text>(find.text('جارٍ تحميل MAXCOM'));
    expect(ms.style!.fontSize, 20);
    expect(en.style!.fontSize, closeTo(14, 0.001));
    expect(ar.style!.fontSize, closeTo(14, 0.001));
    expect(en.style!.color!.a, lessThan(ms.style!.color!.a));
    expect(ar.style!.color!.a, lessThan(ms.style!.color!.a));
  });

  testWidgets('the Arabic line is right to left, the others left to right', (tester) async {
    await pumpWaiting(tester);
    TextDirection dirOf(String text) => tester.widget<Text>(find.text(text)).textDirection!;
    expect(dirOf('جارٍ تحميل MAXCOM'), TextDirection.rtl);
    expect(dirOf('Loading MAXCOM'), TextDirection.ltr);
    expect(dirOf('Memuatkan MAXCOM'), TextDirection.ltr);
  });

  testWidgets('looks the same whatever language the app is in', (tester) async {
    await pumpAtSize(
      tester,
      MaterialApp(
        theme: SurauTheme.light(),
        locale: const Locale('ar'),
        localizationsDelegates: S.localizationsDelegates,
        supportedLocales: S.supportedLocales,
        home: const Scaffold(
          body: Center(
            child: TrilingualText(
              ms: TrilingualStrings.connectingMs,
              en: TrilingualStrings.connectingEn,
              ar: TrilingualStrings.connectingAr,
            ),
          ),
        ),
      ),
      GoldenSize.phone,
    );
    expect(find.text('Menyambung ke kotak'), findsOneWidget);
    expect(find.text('Connecting to the box'), findsOneWidget);
    expect(find.text('جارٍ الاتصال بالصندوق'), findsOneWidget);
  });

  test('the fixed texts carry no dash, arrow or approximation sign', () {
    for (final t in TrilingualStrings.all) {
      expect(RegExp('[\u2014\u2013\u2248\u2192\u2190]|->|=>').hasMatch(t), isFalse, reason: t);
      expect(RegExp('[\u0660-\u0669]').hasMatch(t), isFalse, reason: t);
    }
  });

  testWidgets('golden: waiting screen', (tester) async {
    await pumpWaiting(tester);
    await expectLater(find.byType(Scaffold), matchesGoldenFile('waiting_trilingual_phone.png'));
  });
}
