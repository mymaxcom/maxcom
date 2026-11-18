// The `BM | EN | ع` switch (language plan Task 4): on the dashboard header
// and the first-time screens only; a tap changes the whole app at once, to
// right-to-left for Arabic, without losing what was typed; addresses and
// times stay left-to-right inside Arabic.
//
// Goldens: language_switch_ms, language_switch_en, language_switch_ar
// (the dashboard on a phone after each tap).

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart' show RenderParagraph;
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:surau_app/app/app_lang.dart';
import 'package:surau_app/app/providers.dart';
import 'package:surau_app/app/theme.dart';
import 'package:surau_app/features/common/help_card.dart';
import 'package:surau_app/features/common/language_switch.dart';
import 'package:surau_app/l10n/generated/s.dart';

import '../../golden_sizes.dart';
import '../../support/box_qr_fixture.dart';
import '../shell/harness.dart';

Future<void> _tap(WidgetTester tester, AppLang lang) async {
  await tester.tap(find.byKey(ValueKey('lang-${lang.code}')));
  await settle(tester);
}

void main() {
  testWidgets('three choices, the current one marked, each named in its own language', (tester) async {
    await pumpShell(tester, roles: const ['admin']);
    expect(find.byType(LanguageSwitch), findsOneWidget);
    expect(find.text('BM'), findsOneWidget);
    expect(find.text('EN'), findsOneWidget);
    expect(find.text('ع'), findsOneWidget);
    expect(find.bySemanticsLabel('Bahasa Melayu'), findsOneWidget);
    expect(find.bySemanticsLabel('English'), findsOneWidget);
    expect(find.bySemanticsLabel('العربية'), findsOneWidget);
    expect(tester.getSemantics(find.byKey(const ValueKey('lang-ms'))), isSemantics(isSelected: true, isButton: true));
    expect(tester.getSemantics(find.byKey(const ValueKey('lang-en'))), isSemantics(isSelected: false));
    expect(tester.getSize(find.byType(LanguageSwitch)).height, LanguageSwitch.height);
  });

  testWidgets('EN turns the dashboard to English; it is kept for the next start', (tester) async {
    final h = await pumpShell(tester, roles: const ['admin']);
    expect(find.text('Butiran sistem'), findsOneWidget);
    await _tap(tester, AppLang.en);
    expect(find.text('System details'), findsOneWidget);
    expect(find.text('Butiran sistem'), findsNothing);
    expect(h.container.read(appLangProvider), AppLang.en);
    expect(h.container.read(appLangStoreProvider).read(), AppLang.en);
  });

  testWidgets('Arabic turns the app right to left', (tester) async {
    await pumpShell(tester, roles: const ['admin']);
    await _tap(tester, AppLang.ar);
    final ctx = tester.element(find.text('تفاصيل النظام'));
    expect(Directionality.of(ctx), TextDirection.rtl);
    await _tap(tester, AppLang.ms);
    expect(Directionality.of(tester.element(find.text('Butiran sistem'))), TextDirection.ltr);
  });

  testWidgets('goldens: the dashboard after each tap', (tester) async {
    final h = await pumpShell(tester, roles: const ['admin', 'treasurer', 'media'], features: const {'finance': true});
    for (final lang in [AppLang.en, AppLang.ar, AppLang.ms]) {
      await _tap(tester, lang);
      await expectGoldens(tester, h.app, 'language_switch_${lang.code}', sizes: const [GoldenSize.phone]);
    }
  });

  testWidgets('on the dashboard and enrolment; not on the other pages', (tester) async {
    final h = await pumpShell(tester, roles: const ['admin']);
    expect(find.byType(LanguageSwitch), findsOneWidget, reason: 'dashboard');
    for (final path in const ['/settings', '/content', '/users', '/this-device']) {
      h.router.go(path);
      await settle(tester);
      expect(find.byType(LanguageSwitch), findsNothing, reason: path);
    }
    final fresh = ShellHarness(roles: const ['ajk']);
    await fresh.container.read(enrolledBoxProvider.notifier).forget();
    await pumpAtSize(tester, fresh.app, GoldenSize.phone);
    expect(fresh.location, '/enrol');
    expect(find.byType(LanguageSwitch), findsOneWidget, reason: 'enrol');
    for (final type in const ['setup', 'recovery']) {
      fresh.router.go('/$type', extra: boxQrText(type));
      await settle(tester);
      expect(fresh.location, '/$type');
      expect(
        find.descendant(of: find.byType(AppBar), matching: find.byType(LanguageSwitch)),
        findsOneWidget,
        reason: type,
      );
    }
  });

  testWidgets('switching mid-form keeps what was typed and changes the words', (tester) async {
    final fresh = ShellHarness(roles: const ['ajk']);
    await fresh.container.read(enrolledBoxProvider.notifier).forget();
    await pumpAtSize(tester, fresh.app, GoldenSize.phone);
    final title = find.descendant(of: find.byType(AppBar), matching: find.byType(Text)).first;
    final before = tester.widget<Text>(title).data;
    await tester.enterText(find.byType(TextField).first, 'ABCD-EFGH-2345');
    await _tap(tester, AppLang.en);
    expect(find.text('ABCD-EFGH-2345'), findsOneWidget);
    expect(tester.widget<Text>(title).data, isNot(before));
  });

  testWidgets('in Arabic an address and a time stay left to right', (tester) async {
    await tester.pumpWidget(
      ProviderScope(
        child: MaterialApp(
          locale: const Locale('ar'),
          localizationsDelegates: S.localizationsDelegates,
          supportedLocales: S.supportedLocales,
          theme: SurauTheme.light(),
          home: const Scaffold(
            body: TechnicalDetails(
              boxAddress: '192.0.2.10:8443',
              rows: [(label: 'الوقت', value: '8:30')],
              initiallyOpen: true,
            ),
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();
    for (final v in ['192.0.2.10:8443', '8:30']) {
      final p = tester.renderObject<RenderParagraph>(find.text(v));
      expect(p.textDirection, TextDirection.ltr, reason: v);
    }
  });
}
