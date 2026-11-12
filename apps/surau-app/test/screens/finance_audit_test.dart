// Sejarah audit kewangan (Plan 7 Task 8b): rows in words, a refused row in
// red with its reason, the filter, the detail sheet, the guard.
// Goldens: finance_audit.

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:surau_app/features/finance/audit_screen.dart';
import 'package:surau_app/features/finance/finance_box_api.dart';

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

FinanceAuditRow row(
  String id,
  String entity,
  Map<String, dynamic>? after, {
  String? detail,
  String? entityId,
  String? cloud,
}) => FinanceAuditRow(
  id: id,
  at: '2026-11-07T01:02:00.000Z',
  actor: 'user:u1',
  userName: 'Haji Rosli',
  deviceId: 'dev-abcdef123',
  entity: entity,
  entityId: entityId,
  editedAt: '2026-11-07T01:00:00.000Z',
  cloudReceivedAt: cloud,
  after: after,
  refusedDetail: detail,
);

Future<FinHarness> seeded() async {
  final h = await FinHarness.create();
  await h.putFund('f1', 'Tabung Jumaat');
  h.box.auditRows = [
    row(
      'c5',
      'finance:entry',
      {'kind': 'in', 'fundId': 'f1', 'refNo': 'K-0135', 'amountSen': 23640},
      cloud: '2026-11-07T01:03:00.000Z',
    ),
    row('c4', 'finance:entry', {
      'kind': 'adjust',
      'fundId': 'f1',
      'refNo': 'P-0009',
      'amountSen': 1000,
      'reason': 'Kiraan semula, satu not RM10 terselit',
    }),
    row('c3', 'finance:entry', {
      'kind': 'out',
      'fundId': 'f1',
      'refNo': 'B-0088',
      'amountSen': 15000,
    }),
    row(
      'c2',
      'finance:report',
      {'ym': '2026-10', 'action': 'download'},
      entityId: '2026-10',
    ),
    row('r1', 'finance:refused', null, detail: 'device_revoked'),
  ];
  return h;
}

void main() {
  testWidgets('rows read in words and a refused row shows its reason', (
    tester,
  ) async {
    final h = await seeded();
    addTearDown(h.dispose);
    await tester.pumpWidget(h.app(const FinanceAuditScreen()));
    await settle(tester);
    expect(find.text('Kutipan K-0135, Tabung Jumaat'), findsOneWidget);
    expect(find.text('RM 236.40'), findsOneWidget);
    expect(find.text('Bayaran B-0088, Tabung Jumaat'), findsOneWidget);
    expect(
      find.text('Laporan Oktober 2026 dimuat turun (PDF)'),
      findsOneWidget,
    );
    expect(find.text('Ditolak: Peranti dibatalkan'), findsOneWidget);
    expect(find.byKey(const Key('finr-audit-reason')), findsOneWidget);
  });

  testWidgets('the filter narrows and the detail sheet gives the columns', (
    tester,
  ) async {
    final h = await seeded();
    addTearDown(h.dispose);
    await tester.pumpWidget(h.app(const FinanceAuditScreen()));
    await settle(tester);
    await tester.tap(find.byKey(const Key('finr-filter-refused')));
    await settle(tester);
    expect(find.text('Kutipan K-0135, Tabung Jumaat'), findsNothing);
    expect(find.text('Ditolak: Peranti dibatalkan'), findsOneWidget);
    await tester.tap(find.byKey(const Key('finr-filter-all')));
    await settle(tester);
    await tester.tap(find.text('Kutipan K-0135, Tabung Jumaat'));
    await settle(tester);
    expect(find.byKey(const Key('finr-audit-detail')), findsOneWidget);
    for (final t in [
      'Siapa',
      'Peranti',
      'Tandatangan peranti',
      'Dimasukkan',
      'Diterima di MAXCOM',
      'Sampai ke awan',
      'Sah',
    ]) {
      expect(find.text(t), findsWidgets, reason: t);
    }
    expect(find.text('07/11/2026 09:00'), findsOneWidget);
    expect(find.text('07/11/2026 09:03'), findsOneWidget);
  });

  testWidgets('an empty log, and an AJK is refused', (tester) async {
    final h = await seeded();
    addTearDown(h.dispose);
    h.box.auditRows = [];
    await tester.pumpWidget(
      h.app(const FinanceAuditScreen(), roles: {'treasurer'}),
    );
    await settle(tester);
    expect(find.byKey(const Key('finr-audit-empty')), findsOneWidget);
    await tester.pumpWidget(h.app(const FinanceAuditScreen(), roles: {'ajk'}));
    await settle(tester);
    expect(find.byKey(const Key('finr-audit-forbidden')), findsOneWidget);
  });

  testWidgets('goldens', (tester) async {
    final h = await seeded();
    addTearDown(h.dispose);
    final app = h.app(const FinanceAuditScreen());
    for (final size in GoldenSize.values) {
      await pumpAtSize(tester, app, size);
      await settle(tester);
      await expectLater(
        find.byWidget(app),
        matchesGoldenFile('finance_audit_${size.name}.png'),
      );
    }
  });
}
