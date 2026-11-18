// [F12] Money in the Kewangan screens keeps its order in Arabic: the leading
// minus of "-RM 18.00" stays first, so the amount is wrapped as a
// left-to-right isolate; in BM and English the text is unchanged.

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:surau_app/features/common/ltr.dart';
import 'package:surau_app/features/finance/finance_widgets.dart';
import 'package:surau_app/finance/finance_models.dart';
import 'package:surau_app/l10n/generated/s.dart';

FinanceEntry _payment() => const FinanceEntry(
  id: 'e9',
  kind: 'out',
  entryDate: '2026-11-03',
  fundId: 'f1',
  amountSen: 1800,
  editedAt: '2026-11-03T12:31:00.000Z',
  receivedAt: '2026-11-03T12:31:00.000Z',
  createdBy: 'u1',
);

Widget _app(Locale locale) => MaterialApp(
  locale: locale,
  localizationsDelegates: S.localizationsDelegates,
  supportedLocales: S.supportedLocales,
  home: Scaffold(
    body: FinEntryTile(entry: _payment(), lookups: const FinLookups()),
  ),
);

void main() {
  testWidgets('[F12] "-RM 18.00" inside an Arabic ledger row is isolated, left to right', (tester) async {
    await tester.pumpWidget(_app(const Locale('ar')));
    await tester.pump();
    expect(find.text(ltr('-RM 18.00')), findsOneWidget);
    expect(find.text('-RM 18.00'), findsNothing);
  });

  testWidgets('[F12] BM and English show the amount as it was', (tester) async {
    for (final l in const ['ms', 'en']) {
      await tester.pumpWidget(_app(Locale(l)));
      await tester.pump();
      expect(find.text('-RM 18.00'), findsOneWidget, reason: l);
    }
  });
}
