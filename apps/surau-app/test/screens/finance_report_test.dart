// Laporan bulanan (Plan 7 Task 8b): the A4 preview of the shared vector month
// with its five sections and the DRAF stamp, a Muktamad month, the live-only
// refusal, the share warning and the audit note (only when the share really
// completed), the AJK view without a download, and close and reopen.
// Goldens: finance_report.

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:surau_app/features/finance/report_screen.dart';
import 'package:surau_app/features/finance/share.dart';
import 'package:surau_app/store/local_store.dart';

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

Future<void> reveal(WidgetTester tester, Finder f) async {
  await tester.scrollUntilVisible(
    f,
    300,
    scrollable: find.byType(Scrollable).first,
  );
  await tester.pump();
}

const String _oct = '2026-10';

/// The vector month 2026-10 (scenario 10), seen on 2026-11-02 KL.
Future<(FinHarness, Map<String, dynamic>)> vectorMonth() async {
  final h = await FinHarness.create();
  final sc = await h.loadVector(9);
  return (h, sc);
}

Future<void> closeMonthDoc(FinHarness h, Map<String, dynamic> sc, String ym) {
  final report = Map<String, dynamic>.of(
    (sc['report'] as Map<String, dynamic>)['expected'] as Map<String, dynamic>,
  )..['status'] = 'closed';
  return h.store.putDoc(Collections.financeMonths, ym, {
    'ym': ym,
    'status': 'closed',
    'closedAt': '2026-11-02T01:00:00.000Z',
    'closedBy': 'u1',
    'report': report,
  });
}

void main() {
  testWidgets('the vector month renders its five sections, the figures and the DRAF stamp', (tester) async {
    final (h, sc) = await vectorMonth();
    addTearDown(h.dispose);
    await tester.pumpWidget(h.app(const ReportScreen(initialYm: _oct)));
    await settle(tester);

    expect(find.text('Surau D\'Waqaf'), findsWidgets);
    expect(find.text('Penyata Kewangan Bulanan'), findsOneWidget);
    expect(find.text('Oktober 2026'), findsOneWidget);
    expect(find.text('DRAF: belum dimuktamadkan'), findsOneWidget);
    expect(find.byKey(const Key('finr-a4-stamp')), findsOneWidget);
    for (final t in [
      '1. Ringkasan tabung',
      '2. Kutipan mengikut tabung dan perihal',
      '3. Bayaran mengikut perihal',
      '4. Pembetulan',
      '5. Tandatangan',
    ]) {
      // The first page only shows what fits: switch to the whole sheet.
      if (find.text(t).evaluate().isEmpty) {
        await reveal(tester, find.byKey(const Key('finr-full-page')));
        await tester.tap(find.byKey(const Key('finr-full-page')));
        await settle(tester);
      }
      expect(find.text(t), findsOneWidget, reason: t);
    }
    // Figures from the shared fixture: totals row and a few lines.
    final expected = (sc['report'] as Map<String, dynamic>)['expected'] as Map<String, dynamic>;
    final totals = expected['totals'] as Map<String, dynamic>;
    expect(totals['closingSen'], 150000);
    expect(find.text('RM 1,500.00'), findsWidgets);
    expect(find.text('Tabung Jumaat'), findsWidgets);
    expect(find.text('K-0002'), findsOneWidget);
    expect(find.text('Air Selangor, Bil air'), findsOneWidget);
    expect(find.textContaining('Salah taip jumlah: 450'), findsOneWidget);
    expect(find.text('(RM 50.00)'), findsWidgets, reason: 'money out and cuts are in brackets');
    expect(find.byKey(const Key('finr-a4-footer')), findsOneWidget);
    expect(find.text('Draf sedia untuk mesyuarat AJK'), findsOneWidget);
  });

  testWidgets('a closed month shows MUKTAMAD, no stamp and no Tutup bulan', (tester) async {
    final (h, sc) = await vectorMonth();
    addTearDown(h.dispose);
    await closeMonthDoc(h, sc, _oct);
    await tester.pumpWidget(h.app(const ReportScreen(initialYm: _oct)));
    await settle(tester);

    expect(find.textContaining('MUKTAMAD, ditutup 02/11/2026'), findsOneWidget);
    expect(find.byKey(const Key('finr-a4-stamp')), findsNothing);
    expect(find.text('Muktamad'), findsWidgets);
    await reveal(tester, find.byKey(const Key('finr-download')));
    expect(find.byKey(const Key('finr-close-month')), findsNothing);
    expect(find.byKey(const Key('finr-reopen')), findsOneWidget, reason: 'Pentadbir may reopen');
  });

  testWidgets('the current month says it is not over and offers no close', (tester) async {
    final (h, _) = await vectorMonth();
    addTearDown(h.dispose);
    await tester.pumpWidget(h.app(const ReportScreen()));
    await settle(tester);
    expect(find.text('Bulan belum tamat'), findsOneWidget);
    await reveal(tester, find.byKey(const Key('finr-download')));
    expect(find.byKey(const Key('finr-close-month')), findsNothing);
  });

  testWidgets('Muat turun PDF offline shows the live-only dialog and saves nothing', (tester) async {
    final (h, _) = await vectorMonth();
    addTearDown(h.dispose);
    h.box.offline = true;
    await tester.pumpWidget(h.app(const ReportScreen(initialYm: _oct)));
    await settle(tester);

    await reveal(tester, find.byKey(const Key('finr-download')));
    await tester.tap(find.byKey(const Key('finr-download')));
    await settle(tester);
    expect(find.byKey(const Key('finr-live-only')), findsOneWidget);
    expect(find.text('Perlukan sambungan'), findsOneWidget);
    expect(h.ops.savedNames, isEmpty);
    expect(h.box.pdfRequests, [_oct]);
  });

  testWidgets('Muat turun PDF online saves the file under the box name', (tester) async {
    final (h, _) = await vectorMonth();
    addTearDown(h.dispose);
    await tester.pumpWidget(h.app(const ReportScreen(initialYm: _oct)));
    await settle(tester);
    await reveal(tester, find.byKey(const Key('finr-download')));
    await tester.tap(find.byKey(const Key('finr-download')));
    await settle(tester);
    expect(h.ops.savedNames, ['Penyata-Kewangan-Surau-D-Waqaf-2026-10.pdf']);
    expect(find.text('PDF disimpan dalam Muat turun.'), findsOneWidget);
    expect(find.byKey(const Key('finr-live-only')), findsNothing);
  });

  testWidgets('Kongsi: the warning first, then the share, then the audit note after it returns', (tester) async {
    final (h, _) = await vectorMonth();
    addTearDown(h.dispose);
    await tester.pumpWidget(h.app(const ReportScreen(initialYm: _oct)));
    await settle(tester);
    await reveal(tester, find.byKey(const Key('finr-share')));
    await tester.tap(find.byKey(const Key('finr-share')));
    await settle(tester);

    expect(find.byKey(const Key('finr-share-warning')), findsOneWidget);
    expect(
      find.text(
        'Laporan ini mengandungi data kewangan surau dan nama penderma. Kongsi hanya kepada AJK. Perkongsian direkodkan dalam sejarah audit.',
      ),
      findsOneWidget,
    );
    expect(h.ops.sharedNames, isEmpty, reason: 'nothing leaves before the person goes on');
    expect(h.box.shared, isEmpty);

    h.ops.shareResult = const ShareResult('email');
    await tester.tap(find.byKey(const Key('finr-share-go')));
    await settle(tester);
    expect(h.ops.sharedNames, ['Penyata-Kewangan-Surau-D-Waqaf-2026-10.pdf']);
    expect(h.box.shared, [(_oct, 'email')]);
  });

  testWidgets('Kongsi: backing out of the system sheet posts no note', (tester) async {
    final (h, _) = await vectorMonth();
    addTearDown(h.dispose);
    h.ops.shareResult = const ShareResult('other', completed: false);
    await tester.pumpWidget(h.app(const ReportScreen(initialYm: _oct)));
    await settle(tester);
    await reveal(tester, find.byKey(const Key('finr-share')));
    await tester.tap(find.byKey(const Key('finr-share')));
    await settle(tester);
    await tester.tap(find.byKey(const Key('finr-share-go')));
    await settle(tester);
    expect(h.ops.sharedNames, hasLength(1), reason: 'the system sheet did open');
    expect(h.box.shared, isEmpty);
  });

  testWidgets('Kongsi: closing the warning shares nothing; a failed note is told', (tester) async {
    final (h, _) = await vectorMonth();
    addTearDown(h.dispose);
    await tester.pumpWidget(h.app(const ReportScreen(initialYm: _oct)));
    await settle(tester);
    await reveal(tester, find.byKey(const Key('finr-share')));
    await tester.tap(find.byKey(const Key('finr-share')));
    await settle(tester);
    await tester.tap(find.byKey(const Key('finr-share-close')));
    await settle(tester);
    expect(h.ops.sharedNames, isEmpty);
    expect(h.box.pdfRequests, isEmpty);

    h.box.sharedFails = true;
    await tester.tap(find.byKey(const Key('finr-share')));
    await settle(tester);
    await tester.tap(find.byKey(const Key('finr-share-go')));
    await settle(tester);
    expect(find.text('Perkongsian tidak dapat direkodkan dalam sejarah audit.'), findsOneWidget);
  });

  testWidgets('an AJK reads the report and gets no file buttons', (tester) async {
    final (h, _) = await vectorMonth();
    addTearDown(h.dispose);
    await tester.pumpWidget(h.app(const ReportScreen(initialYm: _oct), roles: {'ajk'}));
    await settle(tester);
    expect(find.text('Penyata Kewangan Bulanan'), findsOneWidget);
    await reveal(tester, find.byKey(const Key('finr-full-page')));
    for (final k in ['finr-download', 'finr-share', 'finr-print', 'finr-close-month', 'finr-reopen']) {
      expect(find.byKey(Key(k)), findsNothing, reason: k);
    }
  });

  testWidgets('Tutup bulan waits for the earlier month, then closes with a confirm', (tester) async {
    final (h, sc) = await vectorMonth();
    addTearDown(h.dispose);
    await tester.pumpWidget(h.app(const ReportScreen(initialYm: _oct), roles: {'treasurer'}));
    await settle(tester);

    await reveal(tester, find.byKey(const Key('finr-close-month')));
    final blocked = tester.widget<OutlinedButton>(find.byKey(const Key('finr-close-month')));
    expect(blocked.onPressed, isNull);
    expect(find.text('Tutup September 2026 dahulu.'), findsOneWidget);
    expect(find.byKey(const Key('finr-reopen')), findsNothing, reason: 'a Bendahari cannot reopen');

    // September is made Muktamad: October can follow.
    await closeMonthDoc(h, sc, '2026-09');
    await tester.pumpWidget(h.app(const ReportScreen(initialYm: _oct), roles: {'treasurer'}));
    await settle(tester);
    await reveal(tester, find.byKey(const Key('finr-close-month')));
    expect(find.byKey(const Key('finr-close-order')), findsNothing);
    await tester.tap(find.byKey(const Key('finr-close-month')));
    await settle(tester);
    expect(find.byKey(const Key('finr-confirm')), findsOneWidget);
    expect(await tester.runAsync(() => h.engine.outbox.pending()), isEmpty, reason: 'asked first');
    await tester.tap(find.byKey(const Key('finr-confirm-yes')));
    await settle(tester);

    final ops = await tester.runAsync(() => h.engine.outbox.pending());
    expect(ops, hasLength(1));
    expect(ops!.single.kind, 'finance.month.put');
    expect(ops.single.entityId, _oct);
    expect((ops.single.payload as Map)['status'], 'closed');
    final doc = await tester.runAsync(() => h.store.getDoc(Collections.financeMonths, _oct));
    expect(doc!['status'], 'closed');
  });

  testWidgets('a Pentadbir reopens a Muktamad month after a confirm', (tester) async {
    final (h, sc) = await vectorMonth();
    addTearDown(h.dispose);
    await closeMonthDoc(h, sc, _oct);
    await tester.pumpWidget(h.app(const ReportScreen(initialYm: _oct)));
    await settle(tester);

    await reveal(tester, find.byKey(const Key('finr-reopen')));
    await tester.tap(find.byKey(const Key('finr-reopen')));
    await settle(tester);
    expect(find.byKey(const Key('finr-confirm')), findsOneWidget);
    expect(find.textContaining('direkodkan dalam sejarah audit'), findsOneWidget);
    await tester.tap(find.byKey(const Key('finr-confirm-yes')));
    await settle(tester);

    final ops = await tester.runAsync(() => h.engine.outbox.pending());
    expect(ops, hasLength(1));
    expect(ops!.single.kind, 'finance.month.put');
    expect((ops.single.payload as Map)['status'], 'open');
    // The sheet is a draft again.
    expect(find.text('DRAF: belum dimuktamadkan'), findsOneWidget);
  });

  testWidgets('goldens', (tester) async {
    final (h, _) = await vectorMonth();
    addTearDown(h.dispose);
    final app = h.app(const ReportScreen(initialYm: _oct));
    for (final size in GoldenSize.values) {
      await pumpAtSize(tester, app, size);
      await settle(tester);
      await expectLater(
        find.byWidget(app),
        matchesGoldenFile('finance_report_${size.name}.png'),
      );
    }
  });
}
