// Tetapan tabung (Plan 7 Task 8b): the fund list with archive rules, rename,
// add, the TV card settings, the module switch, and the Pentadbir-only guard.
// Goldens: finance_funds.

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:surau_app/features/finance/funds_screen.dart';
import 'package:surau_app/store/local_store.dart';

import '../golden_sizes.dart';
import 'finance_b_harness.dart';

Future<void> settle(WidgetTester tester) async {
  for (var i = 0; i < 6; i++) {
    await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 5)));
    await tester.pump(const Duration(milliseconds: 100));
  }
}

Future<void> reveal(WidgetTester tester, Finder f) async {
  await tester.scrollUntilVisible(
    f,
    200,
    scrollable: find.byType(Scrollable).first,
  );
  await tester.pump();
}

Future<FinHarness> seeded() async {
  final h = await FinHarness.create();
  await h.putFund('f1', 'Tabung Jumaat', order: 0, public: true);
  await h.putFund('f2', 'Tabung Am', order: 1);
  await h.putFund('f3', 'Tabung Lama', order: 2, archivedAt: '2026-03-15T01:00:00.000Z');
  await h.putPerihal('in-j', 'in', 'Kutipan solat Jumaat');
  await h.putPerihal('out-p', 'out', 'Penceramah', system: 'penceramah');
  await h.putPerihal('out-u', 'out', 'Utiliti');
  // Tabung Jumaat holds RM 1,356.80; Tabung Am is empty.
  await h.store.putDoc(Collections.financeEntries, 'e1', {
    'id': 'e1',
    'kind': 'opening',
    'entryDate': '2026-09-01',
    'fundId': 'f1',
    'amountSen': 135680,
    'createdBy': 'u1',
    'editedAt': '2026-09-01T04:00:00.000Z',
    'receivedAt': '2026-09-01T04:00:00.000Z',
    'refNo': 'A-0001',
  });
  return h;
}

void main() {
  testWidgets('a fund with a balance cannot be archived and says why', (tester) async {
    final h = await seeded();
    addTearDown(h.dispose);
    await tester.pumpWidget(h.app(const FundsScreen()));
    await settle(tester);

    expect(find.text('Tabung Jumaat'), findsOneWidget);
    expect(find.textContaining('RM 1,356.80'), findsOneWidget);
    final withBalance = tester.widget<TextButton>(find.byKey(const Key('finr-archive-f1')));
    expect(withBalance.onPressed, isNull);
    expect(find.byKey(const Key('finr-archive-hint-f1')), findsOneWidget);
    expect(find.text('Baki mesti RM 0.00'), findsOneWidget);
    // The empty fund can be archived, and the old one shows as archived.
    final empty = tester.widget<TextButton>(find.byKey(const Key('finr-archive-f2')));
    expect(empty.onPressed, isNotNull);
    expect(find.byKey(const Key('finr-archived-f3')), findsOneWidget);
    expect(find.byKey(const Key('finr-archive-hint-f2')), findsNothing);
  });

  testWidgets('archiving an empty fund asks, then queues the change', (tester) async {
    final h = await seeded();
    addTearDown(h.dispose);
    await tester.pumpWidget(h.app(const FundsScreen()));
    await settle(tester);

    await tester.tap(find.byKey(const Key('finr-archive-f2')));
    await settle(tester);
    expect(find.byKey(const Key('finr-archive-confirm')), findsOneWidget);
    await tester.tap(find.byKey(const Key('finr-archive-yes')));
    await settle(tester);

    final ops = await tester.runAsync(() => h.engine.outbox.pending());
    expect(ops, hasLength(1));
    expect(ops!.single.kind, 'finance.lookup.put');
    expect(ops.single.entity, 'finance:fund');
    expect(ops.single.entityId, 'f2');
    final doc = await tester.runAsync(() => h.store.getDoc(Collections.financeFunds, 'f2'));
    expect(doc!['archivedAt'], isNotNull);
  });

  testWidgets('renaming to a name that is taken shows the message and queues nothing', (tester) async {
    final h = await seeded();
    addTearDown(h.dispose);
    await tester.pumpWidget(h.app(const FundsScreen()));
    await settle(tester);

    await tester.tap(find.byKey(const Key('finr-rename-f2')));
    await settle(tester);
    await tester.enterText(find.byKey(const Key('finr-fund-name')), '  tabung jumaat ');
    await tester.tap(find.byKey(const Key('finr-fund-save')));
    await settle(tester);
    expect(find.text('Nama tabung itu sudah digunakan'), findsOneWidget);
    expect(await tester.runAsync(() => h.engine.outbox.pending()), isEmpty);

    // A free name goes through.
    await tester.enterText(find.byKey(const Key('finr-fund-name')), 'Tabung Anak Yatim');
    await tester.tap(find.byKey(const Key('finr-fund-save')));
    await settle(tester);
    final ops = await tester.runAsync(() => h.engine.outbox.pending());
    expect(ops, hasLength(1));
    final doc = await tester.runAsync(() => h.store.getDoc(Collections.financeFunds, 'f2'));
    expect(doc!['name'], 'Tabung Anak Yatim');
    expect(find.text('Tabung Anak Yatim'), findsOneWidget);
  });

  testWidgets('adding a fund enqueues finance.lookup.put with its target and TV switch', (tester) async {
    final h = await seeded();
    addTearDown(h.dispose);
    await tester.pumpWidget(h.app(const FundsScreen()));
    await settle(tester);

    await tester.tap(find.byKey(const Key('finr-add-fund')));
    await settle(tester);
    await tester.enterText(find.byKey(const Key('finr-fund-name')), 'Tabung Pembangunan');
    await tester.tap(find.byKey(const Key('finr-fund-public')));
    await tester.enterText(find.byKey(const Key('finr-fund-target')), '120,000');
    await tester.tap(find.byKey(const Key('finr-fund-save')));
    await settle(tester);

    final ops = await tester.runAsync(() => h.engine.outbox.pending());
    expect(ops, hasLength(1));
    expect(ops!.single.kind, 'finance.lookup.put');
    expect(ops.single.entity, 'finance:fund');
    final funds = await tester.runAsync(() => h.repo.funds());
    final added = funds!.firstWhere((f) => f.name == 'Tabung Pembangunan');
    expect(added.public, isTrue);
    expect(added.targetSen, 12000000);
    expect(added.sortOrder, 3);
    expect(find.text('Tabung Pembangunan'), findsOneWidget);
  });

  testWidgets('a bad target is refused in the dialog', (tester) async {
    final h = await seeded();
    addTearDown(h.dispose);
    await tester.pumpWidget(h.app(const FundsScreen()));
    await settle(tester);

    await tester.tap(find.byKey(const Key('finr-add-fund')));
    await settle(tester);
    await tester.enterText(find.byKey(const Key('finr-fund-name')), 'Tabung Baharu');
    await tester.enterText(find.byKey(const Key('finr-fund-target')), '12.345');
    await tester.tap(find.byKey(const Key('finr-fund-save')));
    await settle(tester);
    expect(find.textContaining('Jumlah tidak sah'), findsOneWidget);
    expect(await tester.runAsync(() => h.engine.outbox.pending()), isEmpty);
  });

  testWidgets('the TV switch of a fund is written at once', (tester) async {
    final h = await seeded();
    addTearDown(h.dispose);
    await tester.pumpWidget(h.app(const FundsScreen()));
    await settle(tester);

    await tester.tap(find.byKey(const Key('finr-pub-f2')));
    await settle(tester);
    final doc = await tester.runAsync(() => h.store.getDoc(Collections.financeFunds, 'f2'));
    expect(doc!['public'], isTrue);
    expect(await tester.runAsync(() => h.engine.outbox.pending()), hasLength(1));
  });

  testWidgets('the TV card settings are saved as the changed keys only', (tester) async {
    final h = await seeded();
    addTearDown(h.dispose);
    await tester.pumpWidget(h.app(const FundsScreen()));
    await settle(tester);

    await reveal(tester, find.byKey(const Key('finr-card-save')));
    final save = tester.widget<FilledButton>(find.byKey(const Key('finr-card-save')));
    expect(save.onPressed, isNull, reason: 'nothing changed yet');
    await reveal(tester, find.text('Kutipan bulan ini'));
    await tester.tap(find.text('Kutipan bulan ini'));
    await tester.pump();
    await reveal(tester, find.byKey(const Key('finr-card-target')));
    await tester.tap(find.byKey(const Key('finr-card-target')));
    await tester.pump();
    await reveal(tester, find.byKey(const Key('finr-card-save')));
    await tester.tap(find.byKey(const Key('finr-card-save')));
    await settle(tester);

    expect(h.box.saved, hasLength(1));
    expect(h.box.saved.single.$1, 'tabungCard');
    expect(h.box.saved.single.$2, {'figure': 'month', 'showTarget': false});
  });

  testWidgets('system perihal Penceramah is locked; another can be renamed', (tester) async {
    final h = await seeded();
    addTearDown(h.dispose);
    await tester.pumpWidget(h.app(const FundsScreen()));
    await settle(tester);

    await reveal(tester, find.byKey(const Key('finr-perihal-out-p')));
    final locked = tester.widget<InputChip>(find.byKey(const Key('finr-perihal-out-p')));
    expect(locked.onPressed, isNull);
    await reveal(tester, find.byKey(const Key('finr-perihal-out-u')));
    await tester.tap(find.byKey(const Key('finr-perihal-out-u')));
    await settle(tester);
    await tester.enterText(find.byKey(const Key('finr-perihal-label')), 'Bil utiliti');
    await tester.tap(find.byKey(const Key('finr-perihal-save')));
    await settle(tester);
    final p = await tester.runAsync(() => h.store.getDoc(Collections.financePerihal, 'out-u'));
    expect(p!['label'], 'Bil utiliti');
  });

  testWidgets('switching the module off asks first; on writes at once', (tester) async {
    final h = await seeded();
    addTearDown(h.dispose);
    await tester.pumpWidget(h.app(const FundsScreen()));
    await settle(tester);

    await reveal(tester, find.byKey(const Key('finr-module-switch')));
    await tester.tap(find.byKey(const Key('finr-module-switch')));
    await settle(tester);
    expect(find.byKey(const Key('finr-module-off-confirm')), findsOneWidget);
    expect(h.box.saved, isEmpty);
    await tester.tap(find.byKey(const Key('finr-module-off-yes')));
    await settle(tester);
    expect(h.box.saved.single.$1, 'finance');
    expect(h.box.saved.single.$2, {'enabled': false});

    await reveal(tester, find.byKey(const Key('finr-module-switch')));
    await tester.tap(find.byKey(const Key('finr-module-switch')));
    await settle(tester);
    expect(h.box.saved.last.$2, {'enabled': true});
  });

  testWidgets('Baki pembukaan row shows the entered date and opens setup', (tester) async {
    final h = await seeded();
    addTearDown(h.dispose);
    await tester.pumpWidget(h.app(const FundsScreen()));
    await settle(tester);
    await reveal(tester, find.byKey(const Key('finr-opening-row')));
    expect(find.text('Dimasukkan 01/09/2026, 1 tabung'), findsOneWidget);
    await tester.tap(find.byKey(const Key('finr-opening-row')));
    await settle(tester);
    expect(h.visited, contains('/finance/setup'));
  });

  testWidgets('an AJK, a Bendahari or any role without settings:write sees nothing of it', (tester) async {
    for (final roles in [
      {'ajk'},
      {'treasurer'},
    ]) {
      final h = await seeded();
      addTearDown(h.dispose);
      await tester.pumpWidget(h.app(const FundsScreen(), roles: roles));
      await settle(tester);
      expect(find.byKey(const Key('finr-funds-forbidden')), findsOneWidget, reason: '$roles');
      expect(find.byKey(const Key('finr-add-fund')), findsNothing);
      expect(find.byKey(const Key('finr-archive-f2')), findsNothing);
    }
  });

  testWidgets('goldens', (tester) async {
    final h = await seeded();
    addTearDown(h.dispose);
    final app = h.app(const FundsScreen());
    for (final size in GoldenSize.values) {
      await pumpAtSize(tester, app, size);
      await settle(tester);
      await expectLater(
        find.byWidget(app),
        matchesGoldenFile('finance_funds_${size.name}.png'),
      );
    }
  });
}
