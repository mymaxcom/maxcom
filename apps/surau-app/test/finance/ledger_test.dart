// Parity with packages/core/src/finance (ledger.ts, money.ts): every scenario
// of test/fixtures/finance-vectors.json, the file core tests too, must give
// the same sen here.

import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:surau_app/finance/finance_models.dart';
import 'package:surau_app/finance/ledger.dart';

late Map<String, dynamic> vectors;
late List<Fund> funds;
late List<Perihal> perihal;

FinanceEntry full(Map<String, dynamic> e) => FinanceEntry.fromJson({
  'createdBy': 'u1',
  'editedAt': '2026-10-01T00:00:00.000Z',
  'receivedAt': e['editedAt'] ?? '2026-10-01T00:00:00.000Z',
  'entryDate': '2026-10-01',
  'fundId': 'f1',
  'amountSen': 0,
  'kind': 'in',
  ...e,
});

List<FinanceEntry> entriesOf(Map<String, dynamic> sc) => [
  for (final e in (sc['entries'] as List)) full(e as Map<String, dynamic>),
];

Map<String, dynamic> scenario(String prefix) => (vectors['scenarios'] as List)
    .cast<Map<String, dynamic>>()
    .firstWhere((s) => (s['name'] as String).startsWith(prefix));

void main() {
  setUpAll(() {
    vectors = jsonDecode(
      File('test/fixtures/finance-vectors.json').readAsStringSync(),
    ) as Map<String, dynamic>;
    funds = [
      for (final f in (vectors['funds'] as List).cast<Map<String, dynamic>>())
        Fund(
          id: f['id'] as String,
          name: f['name'] as String,
          public: true,
          sortOrder: f['sortOrder'] as int,
        ),
    ];
    perihal = [
      for (final (i, p)
          in (vectors['perihal'] as List).cast<Map<String, dynamic>>().indexed)
        Perihal(
          id: p['id'] as String,
          direction: p['direction'] as String,
          label: p['label'] as String,
          sortOrder: i,
        ),
    ];
  });

  group('money', () {
    test('formats sen as RM with grouping (core table)', () {
      final money = vectors['money'] as Map<String, dynamic>;
      for (final row in (money['format'] as List)) {
        expect(formatRm((row as List)[0] as int), row[1], reason: '$row');
      }
      for (final row in (money['formatParens'] as List)) {
        expect(
          formatRm((row as List)[0] as int, parens: true),
          row[1],
          reason: '$row',
        );
      }
      expect(formatRm(-1800), '-RM 18.00');
    });

    test('parses what a person types, exactly (core table)', () {
      final rows = (vectors['money'] as Map<String, dynamic>)['parse'] as List;
      expect(rows.length, greaterThan(20));
      for (final row in rows) {
        expect(parseRm((row as List)[0] as String), row[1], reason: '$row');
      }
    });

    test('1,356.80 is 135680 and never a float', () {
      expect(parseRm('1,356.80'), 135680);
      expect(parseRm('0.07'), 7);
      expect(parseRm('19.99'), 1999);
      expect(parseRm('RM 1,356.8'), 135680);
    });

    test('refuses over the cap and negatives', () {
      expect(parseRm('10000000.01'), isNull);
      expect(parseRm('-5'), isNull);
      expect(parseRm('10000000'), 1000000000);
    });
  });

  group('ledger vectors', () {
    test('there are 13 scenarios', () {
      expect((vectors['scenarios'] as List).length, 13);
    });

    test('month totals use effective amounts (vector 13)', () {
      final sc = scenario('13');
      final month = sc['month'] as Map<String, dynamic>;
      final entries = entriesOf(sc);
      expect(monthIn(entries, sc['ym'] as String), month['inSen']);
      expect(monthOut(entries, sc['ym'] as String), month['outSen']);
      // an uncorrected ledger is unchanged: the plain posted sums
      expect(
        monthIn(entries.where((e) => e.kind != 'adjust'), sc['ym'] as String),
        170000,
      );
    });

    test('balances equal the pinned ones for every scenario', () {
      for (final sc
          in (vectors['scenarios'] as List).cast<Map<String, dynamic>>()) {
        final expected = (sc['balances'] as Map).cast<String, int>();
        expect(
          balances(entriesOf(sc), funds),
          expected,
          reason: sc['name'] as String,
        );
      }
    });

    test('effective keeps the corrections in (editedAt, id) order', () {
      final eff = effective(entriesOf(scenario('8')));
      expect(eff, hasLength(1));
      expect(eff.first.corrections.map((c) => c.id), ['adj-a', 'adj-b']);
      expect(eff.first.effAmountSen, 20000);
    });

    test(
      'a later void wins over an earlier amount; a later amount un-voids',
      () {
        expect(effective(entriesOf(scenario('7'))).first.voided, isTrue);
        final un = effective(entriesOf(scenario('5'))).first;
        expect(un.voided, isFalse);
        expect(un.effAmountSen, 40000);
      },
    );

    test('the month report of vector 10 equals the pinned JSON', () {
      final sc = scenario('10');
      final rep = sc['report'] as Map<String, dynamic>;
      final out = monthReport(
        MonthReportInput(
          ym: sc['ym'] as String,
          entries: entriesOf(sc),
          funds: funds,
          perihal: perihal,
          now: rep['now'] as String,
          syncedUntil: rep['syncedUntil'] as String?,
          status: rep['status'] as String,
        ),
      );
      expect(jsonDecode(jsonEncode(out.toJson())), rep['expected']);
    });

    test('a report always adds up, per tabung, in every scenario', () {
      for (final sc
          in (vectors['scenarios'] as List).cast<Map<String, dynamic>>()) {
        final rep = monthReport(
          MonthReportInput(
            ym: '2026-10',
            entries: entriesOf(sc),
            funds: funds,
            perihal: perihal,
            now: 'x',
            syncedUntil: null,
            status: 'open',
          ),
        );
        for (final f in rep.funds) {
          expect(
            f.openingSen + f.inSen - f.outSen + f.correctionsSen,
            f.closingSen,
            reason: sc['name'] as String,
          );
        }
      }
    });

    test('a correction posted in October never changes September', () {
      final sep = monthReport(
        MonthReportInput(
          ym: '2026-09',
          entries: entriesOf(scenario('10')),
          funds: funds,
          perihal: perihal,
          now: 'x',
          syncedUntil: null,
          status: 'closed',
        ),
      );
      final f1 = sep.funds.first;
      expect(f1.fundId, 'f1');
      expect(
        [f1.openingSen, f1.inSen, f1.outSen, f1.correctionsSen, f1.closingSen],
        [100000, 50000, 20000, 0, 130000],
      );
      expect(sep.corrections, isEmpty);
    });

    test('the report round-trips through its own JSON', () {
      final sc = scenario('10');
      final expected =
          (sc['report'] as Map<String, dynamic>)['expected']
              as Map<String, dynamic>;
      expect(
        jsonDecode(jsonEncode(MonthReport.fromJson(expected).toJson())),
        expected,
      );
    });
  });

  group('penceramah payments and labels', () {
    FinanceEntry pay(String id, String date, int sen, String pid, String at) =>
        full({
          'id': id,
          'kind': 'out',
          'entryDate': date,
          'amountSen': sen,
          'penceramahId': pid,
          'editedAt': at,
        });

    test('the last payment carries its corrected amount; none is null', () {
      final es = [
        pay('p1', '2026-10-02', 15000, 'pen1', '2026-10-02T01:00:00.000Z'),
        pay('p2', '2026-10-09', 20000, 'pen1', '2026-10-09T01:00:00.000Z'),
        pay('p3', '2026-10-09', 99999, 'pen2', '2026-10-09T02:00:00.000Z'),
        full({
          'id': 'c1',
          'kind': 'adjust',
          'correctsId': 'p2',
          'correctionKind': 'amount',
          'amountSen': 25000,
          'entryDate': '2026-10-10',
          'editedAt': '2026-10-10T01:00:00.000Z',
          'reason': 'Kiraan semula: 250',
        }),
      ];
      expect(lastPenceramahPayment(es, 'pen1')?.id, 'p2');
      expect(lastPenceramahPayment(es, 'pen1')?.amountSen, 25000);
      expect(lastPenceramahPayment(es, 'pen9'), isNull);
      es.add(
        full({
          'id': 'c2',
          'kind': 'adjust',
          'correctsId': 'p2',
          'correctionKind': 'void',
          'entryDate': '2026-10-11',
          'editedAt': '2026-10-11T01:00:00.000Z',
          'reason': 'Dibayar dua kali',
        }),
      );
      expect(lastPenceramahPayment(es, 'pen1')?.id, 'p1');
    });

    test('the temporary label is the letter and the last 4 of the id', () {
      expect(tempRefLabel('01HXYZABCD1234', 'in'), 'K-1234');
      expect(tempRefLabel('01hxyzabcdef', 'out'), 'B-CDEF');
      expect(tempRefLabel('x', 'adjust'), 'P-X');
      expect(tempRefLabel('abcd1234', 'opening'), 'A-1234');
      expect(refLetter('in'), 'K');
      expect(signOf('out'), -1);
      expect(signOf('adjust'), 0);
    });

    test('a row without a number shows the temporary one with (sementara)', () {
      final e = full({'id': 'abcdWXYZ', 'kind': 'in'});
      expect(e.refLabel, 'K-WXYZ (sementara)');
      expect(full({'id': 'a', 'refNo': 'K-0135'}).refLabel, 'K-0135');
    });
  });
}
