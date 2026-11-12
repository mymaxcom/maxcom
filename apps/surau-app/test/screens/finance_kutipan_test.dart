// Kutipan baharu: the form, the two counters, the reference for money that
// is not cash, the live amount, the notes and coins check, the review sheet
// with the big-amount warning, and the saved page. Golden: finance_kutipan.

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:surau_app/finance/finance_models.dart';

import '../features/shell/harness.dart';
import '../golden_sizes.dart';
import 'finance_a_harness.dart';

const _review = Key('fin-review');

Future<void> _twoCounters(WidgetTester tester) async {
  await tapAt(tester, find.byKey(const Key('fin-counter-u3')));
  await tapAt(tester, find.byKey(const Key('fin-counter-u4')));
}

void main() {
  late FinA f;

  setUp(() async {
    f = await FinA.create();
  });
  tearDown(() => f.dispose());

  testWidgets('save is disabled with one counter and enabled with two', (
    tester,
  ) async {
    final h = await pumpFinance(tester, f, route: '/finance/kutipan');
    expect(h.location, '/finance/kutipan');
    await typeAt(tester, find.byKey(const Key('fin-amount')), '1356.80');
    expect(await buttonEnabled(tester, find.byKey(_review)), isFalse);
    await tapAt(tester, find.byKey(const Key('fin-counter-u3')));
    expect(find.text('1 daripada 2 dipilih'), findsOneWidget);
    expect(await buttonEnabled(tester, find.byKey(_review)), isFalse);
    await tapAt(tester, find.byKey(const Key('fin-counter-u4')));
    expect(find.text('2 daripada 2 dipilih'), findsOneWidget);
    expect(await buttonEnabled(tester, find.byKey(_review)), isTrue);
    // A third person cannot be added; the box wants exactly two.
    await tapAt(tester, find.byKey(const Key('fin-counter-u2')));
    expect(find.text('2 daripada 2 dipilih'), findsOneWidget);
    await tester.drag(find.byType(ListView).first, const Offset(0, 4000));
    await settle(tester);
    await expectGoldens(tester, h.app, 'finance_kutipan');
  });

  testWidgets('a name outside the app counts as a counter', (tester) async {
    await pumpFinance(tester, f, route: '/finance/kutipan');
    await typeAt(tester, find.byKey(const Key('fin-amount')), '50');
    await tapAt(tester, find.byKey(const Key('fin-counter-u3')));
    await tapAt(tester, find.byKey(const Key('fin-counter-other')));
    await typeAt(
      tester,
      find.byKey(const Key('fin-counter-name')),
      'Tuan Haji Ali',
    );
    await tapAt(tester, find.byKey(const Key('fin-counter-add')));
    expect(
      find.byKey(const Key('fin-counter-named-Tuan Haji Ali')),
      findsOneWidget,
    );
    expect(await buttonEnabled(tester, find.byKey(_review)), isTrue);
  });

  testWidgets('bank hides the counters and asks for a reference', (
    tester,
  ) async {
    await pumpFinance(tester, f, route: '/finance/kutipan');
    await typeAt(tester, find.byKey(const Key('fin-amount')), '500');
    expect(find.byKey(const Key('fin-counter-u3')), findsOneWidget);
    expect(find.byKey(const Key('fin-reference')), findsNothing);
    await tapAt(tester, find.byKey(const Key('fin-chip-bank')));
    expect(find.byKey(const Key('fin-counter-u3')), findsNothing);
    expect(find.byKey(const Key('fin-reference')), findsOneWidget);
    expect(await buttonEnabled(tester, find.byKey(_review)), isFalse);
    await typeAt(tester, find.byKey(const Key('fin-reference')), 'DuitNow 0511');
    expect(await buttonEnabled(tester, find.byKey(_review)), isTrue);
  });

  testWidgets('1,356.8 shows RM 1,356.80 and a bad amount shows why', (
    tester,
  ) async {
    await pumpFinance(tester, f, route: '/finance/kutipan');
    await typeAt(tester, find.byKey(const Key('fin-amount')), '1,356.8');
    expect(find.text('RM 1,356.80'), findsOneWidget);
    await typeAt(tester, find.byKey(const Key('fin-amount')), '1.234');
    expect(find.text('Jumlah tidak sah. Contoh: 1,356.80'), findsOneWidget);
    await typeAt(tester, find.byKey(const Key('fin-amount')), '0');
    expect(find.text('Jumlah mesti lebih daripada RM 0.00'), findsOneWidget);
  });

  testWidgets('notes and coins that do not add up block the save', (
    tester,
  ) async {
    await pumpFinance(tester, f, route: '/finance/kutipan');
    await typeAt(tester, find.byKey(const Key('fin-amount')), '200');
    await _twoCounters(tester);
    expect(await buttonEnabled(tester, find.byKey(_review)), isTrue);
    await tapAt(tester, find.byKey(const Key('fin-den-toggle')));
    await typeAt(tester, find.byKey(const Key('fin-den-100')), '1');
    expect(find.byKey(const Key('fin-den-mismatch')), findsOneWidget);
    expect(
      find.text('Pecahan wang berjumlah RM 100.00, tidak sama dengan jumlah RM 200.00.'),
      findsOneWidget,
    );
    expect(await buttonEnabled(tester, find.byKey(_review)), isFalse);
    // Success path: two RM100 notes add up, the block goes, save is on.
    await typeAt(tester, find.byKey(const Key('fin-den-100')), '2');
    expect(find.byKey(const Key('fin-den-mismatch')), findsNothing);
    expect(
      tester.widget<Text>(find.byKey(const Key('fin-den-sum'))).data,
      'RM 200.00',
    );
    expect(await buttonEnabled(tester, find.byKey(_review)), isTrue);
    // Notes and coins together: RM50 + RM100 notes + 50 sen coins.
    await typeAt(tester, find.byKey(const Key('fin-amount')), '150.50');
    await typeAt(tester, find.byKey(const Key('fin-den-100')), '1');
    await typeAt(tester, find.byKey(const Key('fin-den-50')), '1');
    await typeAt(tester, find.byKey(const Key('fin-den-coins')), '0.50');
    expect(find.byKey(const Key('fin-den-mismatch')), findsNothing);
    expect(await buttonEnabled(tester, find.byKey(_review)), isTrue);
  });

  testWidgets('RM 20,000.01 opens the big amount warning, RM 20,000.00 does not', (
    tester,
  ) async {
    await pumpFinance(tester, f, route: '/finance/kutipan');
    await _twoCounters(tester);
    await typeAt(tester, find.byKey(const Key('fin-amount')), '20000.00');
    await tapAt(tester, find.byKey(_review));
    expect(find.byKey(const Key('fin-confirm-sheet')), findsOneWidget);
    expect(find.byKey(const Key('fin-big-warning')), findsNothing);
    await tapAt(tester, find.byKey(const Key('fin-confirm-back')));
    expect(find.byKey(const Key('fin-confirm-sheet')), findsNothing);

    await typeAt(tester, find.byKey(const Key('fin-amount')), '20000.01');
    await tapAt(tester, find.byKey(_review));
    expect(find.byKey(const Key('fin-confirm-sheet')), findsOneWidget);
    expect(find.byKey(const Key('fin-big-warning')), findsOneWidget);
    expect(find.textContaining('lebih daripada RM 20,000.00'), findsOneWidget);
    expect(find.text('RM 20,000.01'), findsWidgets);
    // Going back saves nothing.
    await tapAt(tester, find.byKey(const Key('fin-confirm-back')));
    expect(await f.ops(), isEmpty);
  });

  testWidgets('the date has shortcuts and last month shows a warning', (
    tester,
  ) async {
    await pumpFinance(tester, f, route: '/finance/kutipan');
    expect(find.text('04/11/2026'), findsOneWidget);
    expect(find.byKey(const Key('fin-prev-month')), findsNothing);
    await tapAt(tester, find.byKey(const Key('fin-date-friday')));
    expect(find.text('30/10/2026'), findsOneWidget);
    expect(find.text('Jumaat lepas, 30/10'), findsOneWidget);
    expect(find.byKey(const Key('fin-prev-month')), findsOneWidget);
    await tapAt(tester, find.byKey(const Key('fin-date-today')));
    expect(find.byKey(const Key('fin-prev-month')), findsNothing);
  });

  testWidgets('saving shows the temporary number and Belum di skrin TV', (
    tester,
  ) async {
    final h = await pumpFinance(tester, f, route: '/finance/kutipan');
    await tapAt(tester, find.byKey(const Key('fin-chip-f2')));
    await tapAt(tester, find.byKey(const Key('fin-chip-in-p')));
    await typeAt(tester, find.byKey(const Key('fin-amount')), '1356.80');
    await _twoCounters(tester);
    await typeAt(tester, find.byKey(const Key('fin-note')), 'Dibuka selepas Subuh');
    await tapAt(tester, find.byKey(_review));
    expect(find.text('Simpan kutipan ini?'), findsOneWidget);
    expect(find.text('Tabung Am'), findsWidgets);
    expect(find.text('Encik Hafiz, Encik Kamal bin Hassan'), findsOneWidget);
    await tapAt(tester, find.byKey(const Key('fin-confirm-save')));

    expect(find.byKey(const Key('fin-saved-title')), findsOneWidget);
    expect(find.text('Disimpan di peranti ini'), findsOneWidget);
    expect(find.textContaining('(sementara)'), findsWidgets);
    expect(find.byKey(const Key('fin-not-on-tv')), findsOneWidget);
    expect(
      find.textContaining('Belum di skrin TV', findRichText: true),
      findsOneWidget,
    );

    final ops = await f.ops();
    expect(ops, hasLength(1));
    expect(ops.single.kind, 'finance.append');
    expect(ops.single.entity, 'finance:entry');
    final p = ops.single.payload as Map;
    expect(p['kind'], 'in');
    expect(p['amountSen'], 135680);
    expect(p['entryDate'], '2026-11-04');
    expect(p['fundId'], 'f2');
    expect(p['perihalId'], 'in-p');
    expect(p['method'], 'tunai');
    expect(p['note'], 'Dibuka selepas Subuh');
    expect(p['counters'], [
      {'userId': 'u3'},
      {'userId': 'u4'},
    ]);
    expect(p.containsKey('denominations'), isFalse);
    expect(p.containsKey('refNo'), isFalse);
    expect(p.containsKey('photoId'), isFalse);

    // The row is in the local ledger, pending, and Kutipan lain starts over.
    final entries = await f.repo.entries();
    expect(entries.first.pending, isTrue);
    await tapAt(tester, find.byKey(const Key('fin-again')));
    expect(await buttonEnabled(tester, find.byKey(_review)), isFalse);
    h.router.go('/finance');
    await settle(tester);
    expect(h.location, '/finance');
    expect(find.text('1 catatan belum di skrin TV'), findsOneWidget);
  });

  testWidgets('a photo is shrunk, queued with the entry and kept as photoId', (
    tester,
  ) async {
    await pumpFinance(
      tester,
      f,
      route: '/finance/kutipan',
      picked: testJpeg(2400, 1800),
    );
    await typeAt(tester, find.byKey(const Key('fin-amount')), '75.50');
    await _twoCounters(tester);
    await tapAt(tester, find.byKey(const Key('fin-photo-pick')));
    for (var i = 0; i < 40; i++) {
      await tester.runAsync(
        () => Future<void>.delayed(const Duration(milliseconds: 100)),
      );
      await tester.pump();
      if (find.byKey(const Key('fin-photo-ready')).evaluate().isNotEmpty) break;
    }
    await settle(tester);
    expect(find.byKey(const Key('fin-photo-ready')), findsOneWidget);
    await tapAt(tester, find.byKey(_review));
    await tapAt(tester, find.byKey(const Key('fin-confirm-save')));
    final ops = await f.ops();
    expect(ops.map((o) => o.kind), ['finance.photo.put', 'finance.append']);
    final entry = (ops.last.payload as Map);
    expect(entry['photoId'], isA<String>());
    expect((entry['photoId'] as String).length, 64);
    final saved = (await f.repo.entries()).first;
    expect(saved.photoId, entry['photoId']);
  });

  testWidgets('a counter is the Bendahari too, and a saved entry keeps notes and coins', (
    tester,
  ) async {
    await pumpFinance(tester, f, route: '/finance/kutipan');
    await typeAt(tester, find.byKey(const Key('fin-amount')), '236.40');
    expect(find.text('Ustaz Ali (anda)'), findsOneWidget);
    await tapAt(tester, find.byKey(const Key('fin-counter-u1')));
    await tapAt(tester, find.byKey(const Key('fin-counter-u3')));
    await tapAt(tester, find.byKey(const Key('fin-den-toggle')));
    await typeAt(tester, find.byKey(const Key('fin-den-100')), '2');
    await typeAt(tester, find.byKey(const Key('fin-den-20')), '1');
    await typeAt(tester, find.byKey(const Key('fin-den-10')), '1');
    await typeAt(tester, find.byKey(const Key('fin-den-5')), '1');
    await typeAt(tester, find.byKey(const Key('fin-den-1')), '1');
    await typeAt(tester, find.byKey(const Key('fin-den-coins')), '0.40');
    expect(await buttonEnabled(tester, find.byKey(_review)), isTrue);
    await tapAt(tester, find.byKey(_review));
    await tapAt(tester, find.byKey(const Key('fin-confirm-save')));
    final p = (await f.ops()).single.payload as Map;
    expect(p['denominations'], {
      '100': 2,
      '20': 1,
      '10': 1,
      '5': 1,
      '1': 1,
      'coinsSen': 40,
    });
    final e = (await f.repo.entries()).first;
    expect(e.counters!.map((c) => c.userId), ['u1', 'u3']);
    expect(e.kind, 'in');
    expect(e, isA<FinanceEntry>());
  });
}
