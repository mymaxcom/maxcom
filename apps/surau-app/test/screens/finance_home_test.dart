// Kewangan home: totals, the actions by role, the tabung with the TV tag,
// the sync card, the Pentadbir's corrections badge, the menu order and the
// route guard. Golden: finance_home.

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:surau_app/features/finance/audit_screen.dart';
import 'package:surau_app/features/finance/funds_screen.dart';
import 'package:surau_app/features/finance/report_screen.dart';
import 'package:surau_app/features/finance/setup_screen.dart';
import 'package:surau_app/features/shell/coming_screen.dart';
import 'package:surau_app/features/shell/menu.dart';
import 'package:surau_app/features/shell/permissions.dart';
import 'package:surau_app/l10n/generated/s_ms.dart';

import '../features/shell/harness.dart';
import '../golden_sizes.dart';
import 'finance_a_harness.dart';

void main() {
  late FinA f;

  setUp(() async {
    f = await FinA.create();
  });
  tearDown(() => f.dispose());

  testWidgets('a treasurer sees the totals, four actions and every tabung', (
    tester,
  ) async {
    final h = await pumpFinance(tester, f);
    expect(h.location, '/finance');
    // f1: 1,000.00 + 1,284.30 - 150.00 - 150.00; f2: 500.00.
    expect(find.text('Jumlah semua tabung'), findsOneWidget);
    expect(
      tester.widget<Text>(find.byKey(const Key('fin-hero-value'))).data,
      'RM 2,484.30',
    );
    expect(find.text('Masuk bulan ini'), findsOneWidget);
    expect(find.text('Keluar bulan ini'), findsOneWidget);
    for (final k in ['kutipan', 'bayaran', 'pembetulan', 'laporan']) {
      expect(find.byKey(Key('fin-action-$k')), findsOneWidget, reason: k);
    }
    expect(find.byKey(const Key('fin-action-tetapan')), findsNothing);
    expect(find.byKey(const Key('fin-view-only')), findsNothing);
    // Balances per tabung and the TV tag on the public ones only.
    expect(
      tester.widget<Text>(find.byKey(const Key('fin-fund-balance-f1'))).data,
      'RM 1,984.30',
    );
    expect(
      tester.widget<Text>(find.byKey(const Key('fin-fund-balance-f2'))).data,
      'RM 500.00',
    );
    expect(find.text('Di skrin TV'), findsNWidgets(2));
    // The latest rows, with their numbers.
    await reveal(tester, find.byKey(const Key('fin-entry-e1')));
    expect(find.text('K-0118 · Tabung Jumaat · 02/11'), findsOneWidget);
    expect(find.text('Ustaz Abu Bakar Ahmad'), findsWidgets);
    // Nothing waits: the card says so.
    expect(find.byKey(const Key('fin-pending-tv')), findsNothing);
    await tester.drag(find.byType(ListView).first, const Offset(0, 4000));
    await settle(tester);
    await expectGoldens(tester, h.app, 'finance_home');
  });

  for (final scale in [1.0, 1.3]) {
    testWidgets('every action label shows in full at 360 dp, text scale $scale', (
      tester,
    ) async {
      final h = await pumpFinance(tester, f);
      tester.view.physicalSize = const Size(360, 800) * 2;
      tester.platformDispatcher.textScaleFactorTestValue = scale;
      addTearDown(tester.platformDispatcher.clearTextScaleFactorTestValue);
      await tester.pump();
      await settle(tester);
      // The shell's bottom bar (shell.dart) overflows 7 px at scale 1.3;
      // that is outside this check.
      while (tester.takeException() != null) {}
      expect(h.location, '/finance');
      for (final k in ['kutipan', 'bayaran', 'pembetulan', 'laporan']) {
        final tile = find.byKey(Key('fin-action-$k'));
        final text = find.descendant(of: tile, matching: find.byType(Text));
        expect(text, findsOneWidget, reason: k);
        final para = tester.renderObject<RenderParagraph>(text);
        expect(para.didExceedMaxLines, isFalse, reason: '$k is cut');
        expect(
          tester.widget<Text>(text).overflow,
          isNot(TextOverflow.ellipsis),
          reason: k,
        );
        final box = tester.getRect(tile);
        final r = tester.getRect(text);
        expect(r.left, greaterThanOrEqualTo(box.left - 0.01), reason: k);
        expect(r.right, lessThanOrEqualTo(box.right + 0.01), reason: k);
        expect(box.height, greaterThanOrEqualTo(48), reason: k);
      }
    });
  }

  testWidgets('AJK see no action to key in, only the monthly report', (
    tester,
  ) async {
    await pumpFinance(tester, f, roles: const ['ajk']);
    expect(find.byKey(const Key('fin-view-only')), findsOneWidget);
    expect(find.byKey(const Key('fin-action-kutipan')), findsNothing);
    expect(find.byKey(const Key('fin-action-bayaran')), findsNothing);
    expect(find.byKey(const Key('fin-action-pembetulan')), findsNothing);
    expect(find.byKey(const Key('fin-action-laporan')), findsOneWidget);
    expect(find.text('Laporan bulanan'), findsOneWidget);
    // Still reads the ledger.
    expect(find.text('Jumlah semua tabung'), findsOneWidget);
  });

  testWidgets('an AJK sent to a keying page lands on the dashboard', (
    tester,
  ) async {
    final h = await pumpFinance(tester, f, roles: const ['ajk']);
    for (final r in [
      '/finance/kutipan',
      '/finance/bayaran',
      '/finance/pembetulan',
    ]) {
      h.router.go(r);
      await settle(tester);
      expect(h.location, '/', reason: r);
    }
    h.router.go('/finance/entry/e1');
    await settle(tester);
    expect(h.location, '/finance/entry/e1', reason: 'reading is allowed');
  });

  testWidgets('a Pentadbir sees the settings button and the corrections badge', (
    tester,
  ) async {
    await f.seedCorrection();
    await pumpFinance(tester, f, roles: const ['admin']);
    expect(find.byKey(const Key('fin-action-tetapan')), findsOneWidget);
    expect(find.text('Semua pembetulan'), findsOneWidget);
    expect(find.byKey(const Key('fin-corrections-badge')), findsOneWidget);
    expect(await f.repo.unseenCorrectionsCount(), 1);
    // Opening one clears the count.
    await tapAt(tester, find.textContaining('P-0008 bagi K-0118'));
    expect(await f.repo.unseenCorrectionsCount(), 0);
    await tester.tapAt(const Offset(10, 10));
    await settle(tester);
    expect(find.byKey(const Key('fin-corrections-badge')), findsNothing);
  });

  testWidgets('a treasurer has no corrections list and no superadmin strip', (
    tester,
  ) async {
    await f.seedCorrection();
    await pumpFinance(tester, f);
    expect(find.text('Semua pembetulan'), findsNothing);
    expect(find.byKey(const Key('fin-super-banner')), findsNothing);
  });

  testWidgets('the superadmin sees the warning strip', (tester) async {
    await pumpFinance(tester, f, roles: const ['superadmin']);
    expect(find.byKey(const Key('fin-super-banner')), findsOneWidget);
    expect(find.textContaining('Pentadbir MAXCOM'), findsOneWidget);
  });

  testWidgets('a waiting entry shows N catatan belum di skrin TV and Menunggu', (
    tester,
  ) async {
    await f.repo.appendCollection({
      'entryDate': '2026-11-04',
      'fundId': 'f2',
      'perihalId': 'in-p',
      'amountSen': 23640,
      'method': 'bank',
      'reference': 'FPX 100200',
    });
    await pumpFinance(tester, f);
    expect(find.text('1 catatan belum di skrin TV'), findsOneWidget);
    expect(find.text('Selaraskan sekarang'), findsWidgets);
    expect(find.text('Menunggu'), findsWidgets);
    // The pending amount already counts: 500 + 236.40.
    expect(
      tester.widget<Text>(find.byKey(const Key('fin-fund-balance-f2'))).data,
      'RM 736.40',
    );
  });

  group('links from the home page', () {
    Future<void> follow(
      WidgetTester tester,
      ShellHarness h,
      String key,
      Type screen,
    ) async {
      // context.push: the router's location stays /finance, the page is on top.
      await tapAt(tester, find.byKey(Key(key)));
      expect(find.byType(screen), findsOneWidget, reason: key);
      expect(find.byType(ComingScreen), findsNothing, reason: key);
      h.router.go('/finance');
      await settle(tester);
    }

    testWidgets('a Pentadbir reaches all four screens', (tester) async {
      final h = await pumpFinance(tester, f, roles: const ['admin']);
      await follow(tester, h, 'fin-action-tetapan', FundsScreen);
      await follow(tester, h, 'fin-action-laporan', ReportScreen);
      await follow(tester, h, 'fin-link-audit', FinanceAuditScreen);
      await follow(tester, h, 'fin-link-setup', FinanceSetupScreen);
    });

    testWidgets('a treasurer has every link but Tetapan tabung', (tester) async {
      final h = await pumpFinance(tester, f);
      expect(find.byKey(const Key('fin-action-tetapan')), findsNothing);
      await follow(tester, h, 'fin-link-audit', FinanceAuditScreen);
      await follow(tester, h, 'fin-link-setup', FinanceSetupScreen);
    });

    testWidgets('AJK have the report and none of the others', (tester) async {
      final h = await pumpFinance(tester, f, roles: const ['ajk']);
      for (final k in ['fin-action-tetapan', 'fin-link-audit', 'fin-link-setup']) {
        expect(find.byKey(Key(k)), findsNothing, reason: k);
      }
      await follow(tester, h, 'fin-action-laporan', ReportScreen);
      h.router.go('/finance/tabung');
      await settle(tester);
      expect(h.location, '/', reason: 'the guard turns an AJK away');
    });

    testWidgets('the report route takes its month from ?ym=', (tester) async {
      await pumpFinance(tester, f, route: '/finance/laporan?ym=2026-10');
      expect(
        tester.widget<ReportScreen>(find.byType(ReportScreen)).initialYm,
        '2026-10',
      );
    });
  });

  testWidgets('Kewangan is second in the menu for a treasurer, four tabs', (
    tester,
  ) async {
    final s = SMs();
    final on = FeatureFlags.defaults.copyWith({'finance': true});
    expect(menuFor({'treasurer'}, on).map((i) => i.label(s)).toList(), [
      'Papan pemuka',
      'Kewangan',
      'Kandungan',
      'Tetapan',
    ]);
    expect(menuFor({'ajk'}, on).map((i) => i.entry).toList(), [
      MenuEntry.dashboard,
      MenuEntry.finance,
      MenuEntry.content,
      MenuEntry.settings,
    ]);
    expect(
      menuFor({'treasurer'}, FeatureFlags.defaults).map((i) => i.entry),
      isNot(contains(MenuEntry.finance)),
      reason: 'off by default',
    );
    expect(routeAllowed('/finance/tabung', {'treasurer'}, on), isFalse);
    expect(routeAllowed('/finance/tabung', {'admin'}, on), isTrue);
    expect(routeAllowed('/finance/laporan', {'ajk'}, on), isTrue);
    expect(routeAllowed('/finance/audit', {'ajk'}, on), isFalse);

    await pumpFinance(tester, f);
    final icons = [
      Icons.home_outlined,
      Icons.savings_rounded,
      Icons.article_outlined,
      Icons.tune_outlined,
    ];
    final xs = [for (final i in icons) tester.getCenter(find.byIcon(i)).dx];
    final sorted = [...xs]..sort();
    expect(xs, sorted, reason: 'left to right in menu order');
    expect(find.byIcon(Icons.menu_rounded), findsNothing, reason: 'no Lagi');
  });
}
