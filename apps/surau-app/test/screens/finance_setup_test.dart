// Baki pembukaan setup (Plan 7 Task 8b): one opening entry per fund, then
// the home. Goldens: finance_setup.

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:surau_app/features/finance/setup_screen.dart';

import '../golden_sizes.dart';
import 'finance_b_harness.dart';

Future<void> settle(WidgetTester tester) async {
  for (var i = 0; i < 6; i++) {
    await tester.runAsync(
      () => Future<void>.delayed(const Duration(milliseconds: 5)),
    );
    await tester.pump(const Duration(milliseconds: 100));
  }
}

Future<FinHarness> seeded() async {
  final h = await FinHarness.create();
  await h.putFund('f1', 'Tabung Jumaat', order: 0);
  await h.putFund('f2', 'Tabung Am', order: 1);
  await h.putFund(
    'f3',
    'Tabung Lama',
    order: 2,
    archivedAt: '2026-03-15T01:00:00.000Z',
  );
  return h;
}

void main() {
  testWidgets('posts one opening per fund dated the start day, then opens home', (
    tester,
  ) async {
    final h = await seeded();
    addTearDown(h.dispose);
    await tester.pumpWidget(h.app(const FinanceSetupScreen()));
    await settle(tester);
    expect(find.byKey(const Key('finr-open-f3')), findsNothing);
    await tester.enterText(find.byKey(const Key('finr-open-f1')), '1,356.80');
    await tester.tap(find.byKey(const Key('finr-setup-save')));
    await settle(tester);

    final ops = await tester.runAsync(() => h.engine.outbox.pending());
    expect(ops, hasLength(2));
    expect(ops!.map((o) => o.kind).toSet(), {'finance.append'});
    final entries = await tester.runAsync(() => h.repo.entries());
    expect(
      entries!.every((e) => e.kind == 'opening' && e.entryDate == '2026-09-01'),
      isTrue,
    );
    expect({for (final e in entries) e.fundId: e.amountSen}, {
      'f1': 135680,
      'f2': 0,
    });
    expect(h.visited, contains('/finance'));
    expect(find.text('HOME-STUB'), findsOneWidget);
  });

  testWidgets('a bad amount posts nothing', (tester) async {
    final h = await seeded();
    addTearDown(h.dispose);
    await tester.pumpWidget(h.app(const FinanceSetupScreen()));
    await settle(tester);
    await tester.enterText(find.byKey(const Key('finr-open-f2')), '12.345');
    await tester.tap(find.byKey(const Key('finr-setup-save')));
    await settle(tester);
    expect(find.textContaining('Jumlah tidak sah'), findsOneWidget);
    expect(await tester.runAsync(() => h.engine.outbox.pending()), isEmpty);
    expect(h.visited, isEmpty);
  });

  testWidgets('once entered, the form is not offered again', (tester) async {
    final h = await seeded();
    addTearDown(h.dispose);
    await tester.runAsync(
      () => h.repo.appendOpening({
        'entryDate': '2026-09-01',
        'fundId': 'f1',
        'amountSen': 0,
      }),
    );
    await tester.pumpWidget(h.app(const FinanceSetupScreen()));
    await settle(tester);
    expect(find.byKey(const Key('finr-setup-done')), findsOneWidget);
    expect(find.byKey(const Key('finr-setup-save')), findsNothing);
  });

  testWidgets('goldens', (tester) async {
    final h = await seeded();
    addTearDown(h.dispose);
    final app = h.app(const FinanceSetupScreen());
    for (final size in GoldenSize.values) {
      await pumpAtSize(tester, app, size);
      await settle(tester);
      await expectLater(
        find.byWidget(app),
        matchesGoldenFile('finance_setup_${size.name}.png'),
      );
    }
  });
}
