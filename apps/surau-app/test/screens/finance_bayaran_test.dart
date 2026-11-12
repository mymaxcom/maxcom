// Bayaran: the kuliah picker (grouped, a coming kuliah greyed), the fields
// filled from the kuliah, the suggested fee, the balance after the payment
// and the overdraw warning that still saves, and other spending.
// Golden: finance_bayaran.

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:surau_app/features/finance/finance_widgets.dart' show FinanceSettings;

import '../features/shell/harness.dart';
import '../golden_sizes.dart';
import 'finance_a_harness.dart';

const _review = Key('fin-review');

Future<void> _openPicker(WidgetTester tester) =>
    tapAt(tester, find.byKey(const Key('fin-kuliah-field')));

void main() {
  late FinA f;

  setUp(() async {
    f = await FinA.create();
  });
  tearDown(() => f.dispose());

  testWidgets('the picker groups the lectures and greys the coming one', (
    tester,
  ) async {
    await pumpFinance(tester, f, route: '/finance/bayaran');
    await _openPicker(tester);
    expect(find.byKey(const Key('fin-kuliah-sheet')), findsOneWidget);
    for (final g in ['Malam ini', 'Belum dibayar', 'Dibayar', 'Akan datang']) {
      expect(find.text(g), findsOneWidget, reason: g);
    }
    // Tonight (k3), due (k2, k5), paid (k1), coming (k4).
    for (final id in ['k1', 'k2', 'k3', 'k4', 'k5']) {
      expect(find.byKey(Key('fin-kuliah-$id')), findsOneWidget, reason: id);
    }
    expect(find.text('Dibatalkan'), findsOneWidget, reason: 'k5 is cancelled');
    // Order: Malam ini above Belum dibayar above Dibayar above Akan datang.
    double y(String t) => tester.getTopLeft(find.text(t)).dy;
    expect(y('Malam ini'), lessThan(y('Belum dibayar')));
    expect(y('Belum dibayar'), lessThan(y('Dibayar')));
    expect(y('Dibayar'), lessThan(y('Akan datang')));
    // A coming lecture cannot be picked.
    final future = tester.widget<ListTile>(find.byKey(const Key('fin-kuliah-k4')));
    expect(future.enabled, isFalse);
    await tester.tap(find.byKey(const Key('fin-kuliah-k4')), warnIfMissed: false);
    await settle(tester);
    expect(find.byKey(const Key('fin-kuliah-sheet')), findsOneWidget);
    // A past one can.
    final past = tester.widget<ListTile>(find.byKey(const Key('fin-kuliah-k2')));
    expect(past.enabled, isTrue);
  });

  testWidgets('tonight fills the speaker and suggests the last fee', (
    tester,
  ) async {
    final h = await pumpFinance(tester, f, route: '/finance/bayaran');
    await _openPicker(tester);
    await tapAt(tester, find.byKey(const Key('fin-kuliah-k3')));
    expect(find.byKey(const Key('fin-kuliah-sheet')), findsNothing);
    expect(
      tester.widget<Text>(find.byKey(const Key('fin-penceramah-name'))).data,
      'Ustaz Haji Ahmad Fauzi bin Ismail',
    );
    expect(find.text('Sifat 20: Wujud, Qidam dan Baqa'), findsWidgets);
    expect(
      tester.widget<TextField>(find.byKey(const Key('fin-amount'))).controller!.text,
      '150.00',
    );
    expect(
      find.text('Dicadangkan daripada bayaran terakhir kepada penceramah ini: RM 150.00'),
      findsOneWidget,
    );
    expect(find.byKey(const Key('fin-kuliah-tonight')), findsOneWidget);
    // The fund of that last payment (Jumaat) is chosen, and the balance after.
    expect(
      find.text('Baki Tabung Jumaat: RM 1,984.30. Selepas bayaran ini: RM 1,834.30'),
      findsOneWidget,
    );
    expect(find.byKey(const Key('fin-overdraw')), findsNothing);
    expect(await buttonEnabled(tester, find.byKey(_review)), isTrue);
    await tester.drag(find.byType(ListView).first, const Offset(0, 4000));
    await settle(tester);
    await expectGoldens(tester, h.app, 'finance_bayaran');
  });

  testWidgets('the penceramah fund from the settings is the default', (
    tester,
  ) async {
    await pumpFinance(
      tester,
      f,
      route: '/finance/bayaran',
      settings: const FinanceSettings(penceramahFundId: 'f2'),
    );
    await _openPicker(tester);
    await tapAt(tester, find.byKey(const Key('fin-kuliah-k3')));
    expect(
      find.text('Baki Tabung Am: RM 500.00. Selepas bayaran ini: RM 350.00'),
      findsOneWidget,
    );
  });

  testWidgets('paying more than the balance warns but still saves', (
    tester,
  ) async {
    final h = await pumpFinance(tester, f, route: '/finance/bayaran');
    await _openPicker(tester);
    await tapAt(tester, find.byKey(const Key('fin-kuliah-k2')));
    await tapAt(tester, find.byKey(const Key('fin-chip-f2')));
    await typeAt(tester, find.byKey(const Key('fin-amount')), '600');
    expect(find.byKey(const Key('fin-overdraw')), findsOneWidget);
    expect(
      find.text('Baki Tabung Am: RM 500.00. Selepas bayaran ini: -RM 100.00'),
      findsOneWidget,
    );
    expect(await buttonEnabled(tester, find.byKey(_review)), isTrue);
    await tapAt(tester, find.byKey(_review));
    expect(find.text('Simpan bayaran ini?'), findsOneWidget);
    await tapAt(tester, find.byKey(const Key('fin-confirm-save')));

    expect(find.text('Disimpan di peranti ini'), findsOneWidget);
    final ops = await f.ops();
    expect(ops, hasLength(1));
    final p = ops.single.payload as Map;
    expect(ops.single.kind, 'finance.append');
    expect(p['kind'], 'out');
    expect(p['amountSen'], 60000);
    expect(p['fundId'], 'f2');
    expect(p['perihalId'], 'out-pc');
    expect(p['kuliahId'], 'k2');
    expect(p['penceramahId'], 'p2');
    expect(p['penceramahName'], 'Ustaz Mohd Hafiz bin Rahman');
    expect(p['entryDate'], '2026-11-02', reason: "the kuliah's own day");
    expect(p['method'], 'tunai');
    // Back on home the new payment shows, waiting.
    await tapAt(tester, find.byKey(const Key('fin-to-home')));
    expect(h.location, '/finance');
    expect(find.text('1 catatan belum di skrin TV'), findsOneWidget);
  });

  testWidgets('a cancelled and an already paid kuliah show their warning', (
    tester,
  ) async {
    await pumpFinance(tester, f, route: '/finance/bayaran');
    await _openPicker(tester);
    await tapAt(tester, find.byKey(const Key('fin-kuliah-k5')));
    expect(find.byKey(const Key('fin-kuliah-cancelled')), findsOneWidget);
    await _openPicker(tester);
    await tapAt(tester, find.byKey(const Key('fin-kuliah-k1')));
    expect(find.byKey(const Key('fin-kuliah-paid')), findsOneWidget);
    expect(find.byKey(const Key('fin-kuliah-cancelled')), findsNothing);
  });

  testWidgets('other spending needs a payee and posts under its perihal', (
    tester,
  ) async {
    await pumpFinance(tester, f, route: '/finance/bayaran');
    await tapAt(tester, find.text('Perbelanjaan lain'));
    expect(find.byKey(const Key('fin-kuliah-field')), findsNothing);
    expect(find.text('Penceramah'), findsOneWidget, reason: 'the segment only');
    await tapAt(tester, find.byKey(const Key('fin-chip-out-u')));
    await typeAt(tester, find.byKey(const Key('fin-amount')), '471.20');
    expect(await buttonEnabled(tester, find.byKey(_review)), isFalse);
    await typeAt(tester, find.byKey(const Key('fin-payee')), 'Tenaga Nasional Berhad');
    expect(await buttonEnabled(tester, find.byKey(_review)), isTrue);
    await tapAt(tester, find.byKey(const Key('fin-chip-bank')));
    expect(await buttonEnabled(tester, find.byKey(_review)), isFalse);
    await typeAt(tester, find.byKey(const Key('fin-reference')), 'FPX 7790514');
    await tapAt(tester, find.byKey(_review));
    await tapAt(tester, find.byKey(const Key('fin-confirm-save')));
    final p = (await f.ops()).single.payload as Map;
    expect(p['kind'], 'out');
    expect(p['perihalId'], 'out-u');
    expect(p['payee'], 'Tenaga Nasional Berhad');
    expect(p['method'], 'bank');
    expect(p['reference'], 'FPX 7790514');
    expect(p['amountSen'], 47120);
    expect(p.containsKey('kuliahId'), isFalse);
  });
}
