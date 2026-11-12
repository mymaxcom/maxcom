// The ledger as a pure function of its rows: the Dart port of
// packages/core/src/finance/ledger.ts and money.ts. test/finance/ledger_test.dart
// runs every scenario of test/fixtures/finance-vectors.json (the same file
// core tests) through it, so both sides give the same sen.
//
// All arithmetic is on integer sen. Sorting is stable on purpose (Dart's
// List.sort is not), because core's chain order is (editedAt, id) with
// insertion order as the last tiebreak.

import 'finance_models.dart';

/// Core's MAX_AMOUNT_SEN: RM 10,000,000.00.
const int maxAmountSen = 1000000000;

/// The photo limits core and the box share.
const int maxPhotoBytes = 2 * 1024 * 1024;
const int maxPhotoSide = 1280;

const List<String> _originals = ['in', 'out', 'opening'];

/// +1 for money in (in, opening), -1 for money out, 0 for a correction row.
int signOf(String kind) => kind == 'in' || kind == 'opening'
    ? 1
    : kind == 'out'
    ? -1
    : 0;

/// Display letter of the server-assigned reference number.
String refLetter(String kind) => kind == 'in'
    ? 'K'
    : kind == 'out'
    ? 'B'
    : kind == 'adjust'
    ? 'P'
    : 'A';

/// The label a device shows until the box assigns the real number: the
/// letter, a dash and the last 4 characters of the id.
String tempRefLabel(String id, [String kind = 'in']) {
  final tail = id.length <= 4 ? id : id.substring(id.length - 4);
  return '${refLetter(kind)}-${tail.toUpperCase()}';
}

// ---- money ----

/// `135680` -> `RM 1,356.80`. A negative amount is `-RM 18.00`, or
/// `(RM 18.00)` with [parens] (reports).
String formatRm(int sen, {bool parens = false}) {
  if (sen.abs() > 9007199254740991) {
    throw RangeError('amount must be a whole number of sen');
  }
  final neg = sen < 0;
  final abs = neg ? -sen : sen;
  final whole = (abs ~/ 100).toString();
  final frac = (abs % 100).toString().padLeft(2, '0');
  final b = StringBuffer();
  for (var i = 0; i < whole.length; i++) {
    if (i > 0 && (whole.length - i) % 3 == 0) b.write(',');
    b.write(whole[i]);
  }
  final body = 'RM $b.$frac';
  if (!neg) return body;
  return parens ? '($body)' : '-$body';
}

final RegExp _plain = RegExp(r'^\d+(\.\d{1,2})?$');
final RegExp _grouped = RegExp(r'^\d{1,3}(,\d{3})+(\.\d{1,2})?$');

/// Text typed by a person -> sen, or null. Accepts `1356.80`, `1,356.80`,
/// `RM 1356.8`, `1356`. Refuses more than two decimals, negatives,
/// exponents, bad comma groups and anything over [maxAmountSen]. Digit
/// strings only: no float is ever involved.
int? parseRm(String text) {
  var t = text.trim();
  if (t.length >= 2 && t.substring(0, 2).toUpperCase() == 'RM') {
    t = t.substring(2).trim();
  }
  if (!_plain.hasMatch(t) && !_grouped.hasMatch(t)) return null;
  t = t.replaceAll(',', '');
  final dot = t.indexOf('.');
  final whole = dot < 0 ? t : t.substring(0, dot);
  final frac = dot < 0 ? '' : t.substring(dot + 1);
  if (whole.length > 12) return null;
  final sen = int.parse(whole) * 100 + int.parse(frac.padRight(2, '0'));
  if (sen > maxAmountSen) return null;
  return sen;
}

// ---- stable ordering ----

List<T> _sorted<T>(Iterable<T> items, int Function(T a, T b) cmp) {
  final list = [for (final (i, x) in items.indexed) (i, x)];
  list.sort((a, b) {
    final c = cmp(a.$2, b.$2);
    return c != 0 ? c : a.$1.compareTo(b.$1);
  });
  return [for (final p in list) p.$2];
}

int _ms(String iso) => DateTime.tryParse(iso)?.millisecondsSinceEpoch ?? 0;

int _cmpStr(String a, String b) => a == b ? 0 : (a.compareTo(b) < 0 ? -1 : 1);

/// Order of corrections of one entry: (editedAt, id).
int _byEdit(FinanceEntry a, FinanceEntry b) {
  final d = _ms(a.editedAt) - _ms(b.editedAt);
  if (d != 0) return d;
  return _cmpStr(a.id, b.id);
}

int _cmpRow(FinanceEntry a, FinanceEntry b) {
  final c = _cmpStr(a.entryDate, b.entryDate);
  return c != 0 ? c : _byEdit(a, b);
}

class _State {
  const _State(this.fund, this.amount, this.voided);

  final String fund;
  final int amount;
  final bool voided;
}

_State _step(_State s, FinanceEntry c) {
  if (c.correctionKind == 'amount') return _State(s.fund, c.amountSen, false);
  if (c.correctionKind == 'fund' && (c.toFundId ?? '').isNotEmpty) {
    return _State(c.toFundId!, s.amount, false);
  }
  if (c.correctionKind == 'void') return _State(s.fund, s.amount, true);
  return s;
}

/// Each original entry with its corrections applied in (editedAt, id)
/// order; the last state wins.
List<EffectiveEntry> effective(Iterable<FinanceEntry> entries) {
  final all = entries.toList();
  final chains = <String, List<FinanceEntry>>{};
  for (final e in all) {
    if (e.kind == 'adjust' && e.correctsId != null) {
      (chains[e.correctsId!] ??= []).add(e);
    }
  }
  final out = <EffectiveEntry>[];
  for (final e in all) {
    if (!_originals.contains(e.kind)) continue;
    final chain = _sorted(chains[e.id] ?? const <FinanceEntry>[], _byEdit);
    var s = _State(e.fundId, e.amountSen, false);
    for (final c in chain) {
      s = _step(s, c);
    }
    out.add(
      EffectiveEntry(
        entry: e,
        effFundId: s.fund,
        effAmountSen: s.amount,
        voided: s.voided,
        corrections: chain,
      ),
    );
  }
  return out;
}

int _contribution(String kind, _State s) =>
    s.voided ? 0 : signOf(kind) * s.amount;

/// Balance per fund id; every fund in [funds] is present (0 when empty).
Map<String, int> balances(
  Iterable<FinanceEntry> entries,
  Iterable<Fund> funds,
) {
  final out = <String, int>{for (final f in funds) f.id: 0};
  for (final e in effective(entries)) {
    if (e.voided) continue;
    out[e.effFundId] =
        (out[e.effFundId] ?? 0) + signOf(e.kind) * e.effAmountSen;
  }
  return out;
}

bool _inMonth(String date, String ym) =>
    date.length >= 7 && date.substring(0, 7) == ym;

/// Sum of the effective amounts of `in` entries dated in the month: a voided
/// entry counts for nothing and an amount correction replaces the posted
/// amount (the same figures the TV card shows).
int monthIn(Iterable<FinanceEntry> entries, String ym) => effective(entries).fold(
  0,
  (a, e) => e.kind == 'in' && !e.voided && _inMonth(e.entry.entryDate, ym)
      ? a + e.effAmountSen
      : a,
);

int monthOut(Iterable<FinanceEntry> entries, String ym) => effective(entries).fold(
  0,
  (a, e) => e.kind == 'out' && !e.voided && _inMonth(e.entry.entryDate, ym)
      ? a + e.effAmountSen
      : a,
);

String _nextMonthStart(String ym) {
  final y = int.parse(ym.substring(0, 4));
  final m = int.parse(ym.substring(5, 7));
  final ny = m == 12 ? y + 1 : y;
  final nm = m == 12 ? 1 : m + 1;
  return '${ny.toString().padLeft(4, '0')}-${nm.toString().padLeft(2, '0')}-01';
}

List<FinanceEntry> _before(Iterable<FinanceEntry> entries, String cutoff) => [
  for (final e in entries)
    if (e.entryDate.compareTo(cutoff) < 0) e,
];

/// Everything [monthReport] reads.
class MonthReportInput {
  const MonthReportInput({
    required this.ym,
    required this.entries,
    required this.funds,
    required this.perihal,
    this.kuliahTitles = const {},
    this.kuliahDates = const {},
    required this.now,
    required this.syncedUntil,
    required this.status,
  });

  final String ym;
  final List<FinanceEntry> entries;
  final List<Fund> funds;
  final List<Perihal> perihal;
  final Map<String, String> kuliahTitles;
  final Map<String, String> kuliahDates;
  final String now;
  final String? syncedUntil;
  final String status;
}

/// The month's report. Per tabung: opening (what the ledger held at the
/// start of the month, plus any opening balance entered in the month),
/// money in and out as first posted, corrections posted in the month,
/// closing. The corrections column is closing minus the rest, so a row
/// always adds up. A correction posted this month against an earlier month
/// shows here (`lastMonth`) and never changes that earlier month's figures.
MonthReport monthReport(MonthReportInput input) {
  final ym = input.ym;
  final entries = input.entries;
  final start = '$ym-01';
  final end = _nextMonthStart(ym);
  final fundName = {for (final f in input.funds) f.id: f.name};
  final perihalLabel = {for (final p in input.perihal) p.id: p.label};

  final open = <String, int>{};
  final closing = <String, int>{};
  final inSum = <String, int>{};
  final outSum = <String, int>{};
  void add(Map<String, int> m, String k, int n) => m[k] = (m[k] ?? 0) + n;

  for (final e in effective(_before(entries, start))) {
    if (!e.voided) add(open, e.effFundId, signOf(e.kind) * e.effAmountSen);
  }
  final endEntries = _before(entries, end);
  final endEff = effective(endEntries);
  for (final e in endEff) {
    if (!e.voided) add(closing, e.effFundId, signOf(e.kind) * e.effAmountSen);
  }

  final inRows = <FinanceEntry>[];
  final outRows = <FinanceEntry>[];
  for (final e in entries) {
    if (!_inMonth(e.entryDate, ym)) continue;
    if (e.kind == 'opening') {
      add(open, e.fundId, e.amountSen);
    } else if (e.kind == 'in') {
      add(inSum, e.fundId, e.amountSen);
      inRows.add(e);
    } else if (e.kind == 'out') {
      add(outSum, e.fundId, e.amountSen);
      outRows.add(e);
    }
  }

  final fundRows = <ReportFundRow>[];
  final orderedFunds = _sorted<Fund>(input.funds, (a, b) {
    final d = a.sortOrder - b.sortOrder;
    return d != 0 ? d : _cmpStr(a.name, b.name);
  });
  for (final f in orderedFunds) {
    final o = open[f.id] ?? 0;
    final i = inSum[f.id] ?? 0;
    final u = outSum[f.id] ?? 0;
    final c = closing[f.id] ?? 0;
    final corr = c - o - i + u;
    if (f.archivedAt != null && o == 0 && i == 0 && u == 0 && c == 0) continue;
    fundRows.add(
      ReportFundRow(
        fundId: f.id,
        name: f.name,
        openingSen: o,
        inSen: i,
        outSen: u,
        correctionsSen: corr,
        closingSen: c,
      ),
    );
  }

  // Rows grouped by (perihal, fund) in first-seen order, then sorted.
  List<(String, String, List<FinanceEntry>)> grouped(List<FinanceEntry> rows) {
    final map = <String, (String, String, List<FinanceEntry>)>{};
    for (final e in rows) {
      final key = '${e.perihalId ?? ''}\u0000${e.fundId}';
      (map[key] ??= (e.perihalId ?? '', e.fundId, <FinanceEntry>[])).$3.add(e);
    }
    return map.values.toList();
  }

  List<ReportGroup<R>> groups<R extends ReportInRow>(
    List<FinanceEntry> rows,
    R Function(FinanceEntry) toRow,
  ) {
    final out = <ReportGroup<R>>[];
    for (final g in grouped(rows)) {
      final list = _sorted(g.$3, _cmpRow);
      final first = list.first;
      final perihalId = first.perihalId ?? '';
      out.add(
        ReportGroup<R>(
          perihalId: perihalId,
          label: perihalLabel[perihalId] ?? perihalId,
          fundId: first.fundId,
          rows: [for (final e in list) toRow(e)],
          totalSen: list.fold(0, (a, e) => a + e.amountSen),
        ),
      );
    }
    return _sorted<ReportGroup<R>>(out, (a, b) {
      final l = _cmpStr(a.label, b.label);
      return l != 0 ? l : _cmpStr(a.fundId, b.fundId);
    });
  }

  final inByPerihal = groups<ReportInRow>(
    inRows,
    (e) => ReportInRow(
      date: e.entryDate,
      refNo: e.refNo,
      note: e.note,
      amountSen: e.amountSen,
    ),
  );
  final outByPerihal = groups<ReportOutRow>(
    outRows,
    (e) => ReportOutRow(
      date: e.entryDate,
      refNo: e.refNo,
      note: e.note,
      amountSen: e.amountSen,
      payee: e.payee,
      penceramahName: e.penceramahName,
      kuliahTitle: e.kuliahId == null ? null : input.kuliahTitles[e.kuliahId],
      kuliahDate: e.kuliahId == null ? null : input.kuliahDates[e.kuliahId],
    ),
  );

  final corrections = <ReportCorrection>[];
  for (final e in endEff) {
    var s = _State(e.entry.fundId, e.entry.amountSen, false);
    for (final c in e.corrections) {
      final prev = _contribution(e.kind, s);
      s = _step(s, c);
      if (!_inMonth(c.entryDate, ym)) continue;
      corrections.add(
        ReportCorrection(
          id: c.id,
          date: c.entryDate,
          refNo: c.refNo,
          originalRefNo: e.entry.refNo,
          kind: c.correctionKind ?? 'amount',
          reason: c.reason ?? '',
          deltaSen: _contribution(e.kind, s) - prev,
          fundName: fundName[s.fund] ?? s.fund,
          lastMonth: e.entry.entryDate.compareTo(start) < 0,
        ),
      );
    }
  }
  final byId = {for (final e in entries) e.id: e};
  final sortedCorrections = _sorted<ReportCorrection>(corrections, (a, b) {
    if (a.date != b.date) return _cmpStr(a.date, b.date);
    final ea = byId[a.id];
    final eb = byId[b.id];
    return ea != null && eb != null ? _byEdit(ea, eb) : _cmpStr(a.id, b.id);
  });

  int sum(int Function(ReportFundRow) pick) =>
      fundRows.fold(0, (a, r) => a + pick(r));
  return MonthReport(
    ym: ym,
    status: input.status,
    generatedAt: input.now,
    syncedUntil: input.syncedUntil,
    funds: fundRows,
    inByPerihal: inByPerihal,
    outByPerihal: outByPerihal,
    corrections: sortedCorrections,
    totals: ReportTotals(
      openingSen: sum((r) => r.openingSen),
      inSen: sum((r) => r.inSen),
      outSen: sum((r) => r.outSen),
      correctionsSen: sum((r) => r.correctionsSen),
      closingSen: sum((r) => r.closingSen),
    ),
  );
}

/// The latest payment to this penceramah that is not voided, carrying its
/// current (corrected) amount and tabung.
FinanceEntry? lastPenceramahPayment(
  Iterable<FinanceEntry> entries,
  String penceramahId,
) {
  EffectiveEntry? best;
  for (final e in effective(entries)) {
    if (e.kind != 'out' || e.entry.penceramahId != penceramahId || e.voided) {
      continue;
    }
    if (best == null || _cmpRow(best.entry, e.entry) < 0) best = e;
  }
  if (best == null) return null;
  return best.entry.copyWith(
    fundId: best.effFundId,
    amountSen: best.effAmountSen,
  );
}
