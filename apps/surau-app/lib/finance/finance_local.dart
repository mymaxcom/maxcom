// Reads of the finance data from the app's local copy ([LocalStore]); no
// Riverpod, no network. The repository (screens) and the offline gateway
// (the `/api/finance/*` reads) both build on it, so a figure is computed in
// one place: ledger.dart.

import '../store/local_store.dart';
import 'finance_models.dart';
import 'ledger.dart';

/// An instant as core writes it: ISO UTC with exactly three decimals.
String isoMs(DateTime t) => DateTime.fromMillisecondsSinceEpoch(
  t.millisecondsSinceEpoch,
  isUtc: true,
).toIso8601String();

/// The Kuala Lumpur calendar date (UTC+8, no daylight saving) of [t].
String klDate(DateTime t) {
  final kl = DateTime.fromMillisecondsSinceEpoch(
    t.millisecondsSinceEpoch,
    isUtc: true,
  ).add(const Duration(hours: 8));
  String two(int n) => n.toString().padLeft(2, '0');
  return '${kl.year.toString().padLeft(4, '0')}-${two(kl.month)}-${two(kl.day)}';
}

class FinanceLocal {
  FinanceLocal(this.store);

  final LocalStore store;

  /// Every ledger row held here, in no particular order.
  Future<List<FinanceEntry>> allEntries() async => [
    for (final d in await store.list(Collections.financeEntries))
      FinanceEntry.fromJson(d),
  ];

  Future<List<Fund>> funds({bool includeArchived = false}) async {
    final all = [
      for (final d in await store.list(Collections.financeFunds))
        Fund.fromJson(d),
    ];
    final list = [
      for (final f in all)
        if (includeArchived || !f.archived) f,
    ];
    list.sort((a, b) {
      final o = a.sortOrder - b.sortOrder;
      if (o != 0) return o;
      final n = a.name.compareTo(b.name);
      return n != 0 ? n : a.id.compareTo(b.id);
    });
    return list;
  }

  /// [direction] `in` or `out`, or null for both.
  Future<List<Perihal>> perihal({
    String? direction,
    bool includeArchived = false,
  }) async {
    final list = [
      for (final d in await store.list(Collections.financePerihal))
        if (Perihal.fromJson(d) case final p
            when (direction == null || p.direction == direction) &&
                (includeArchived || !p.archived))
          p,
    ];
    list.sort((a, b) {
      final d = a.direction.compareTo(b.direction);
      if (d != 0) return d;
      final o = a.sortOrder - b.sortOrder;
      if (o != 0) return o;
      final l = a.label.compareTo(b.label);
      return l != 0 ? l : a.id.compareTo(b.id);
    });
    return list;
  }

  Future<List<MonthState>> months() async {
    final list = [
      for (final d in await store.list(Collections.financeMonths))
        MonthState.fromJson(d),
    ];
    list.sort((a, b) => a.ym.compareTo(b.ym));
    return list;
  }

  Future<String> monthStatus(String ym) async {
    for (final m in await months()) {
      if (m.ym == ym) return m.status;
    }
    return 'open';
  }

  /// Rows filtered the way `GET /api/finance/entries` does, oldest first
  /// within the newest [limit] (the box's order: date, edited time, id).
  Future<List<FinanceEntry>> entries({
    String? ym,
    String? fundId,
    String? sinceEditedAt,
    int limit = 500,
  }) async {
    final rows = [
      for (final e in await allEntries())
        if ((ym == null || e.entryDate.startsWith(ym)) &&
            (fundId == null || e.fundId == fundId) &&
            (sinceEditedAt == null || e.editedAt.compareTo(sinceEditedAt) > 0))
          e,
    ];
    int asc(FinanceEntry a, FinanceEntry b) {
      final d = a.entryDate.compareTo(b.entryDate);
      if (d != 0) return d;
      final t = a.editedAt.compareTo(b.editedAt);
      return t != 0 ? t : a.id.compareTo(b.id);
    }

    rows.sort((a, b) => asc(b, a));
    final newest = rows.take(limit.clamp(1, 5000).toInt()).toList();
    newest.sort(asc);
    return newest;
  }

  /// One original entry with its corrections; null for an unknown id or the
  /// id of a correction row (it has no chain of its own).
  Future<EntryDetail?> detail(String id) async {
    final doc = await store.getDoc(Collections.financeEntries, id);
    if (doc == null) return null;
    final entry = FinanceEntry.fromJson(doc);
    if (entry.kind == 'adjust') return null;
    final chain = [
      for (final e in await allEntries())
        if (e.correctsId == id) e,
    ];
    final eff = effective([entry, ...chain]);
    if (eff.isEmpty) return null;
    return EntryDetail(
      entry: entry,
      corrections: eff.first.corrections,
      effective: eff.first,
    );
  }

  /// Funds (not archived) with their balances, this month's totals and the
  /// counts, for the home screen.
  Future<FinanceSummary> summary({
    required String todayKl,
    int pendingCount = 0,
    int unseenCorrections = 0,
  }) async {
    final entries = await allEntries();
    final funds = await this.funds();
    final bal = balances(entries, funds);
    final ym = todayKl.substring(0, 7);
    return FinanceSummary(
      funds: [for (final f in funds) FundBalance(f, bal[f.id] ?? 0)],
      ym: ym,
      monthStatus: await monthStatus(ym),
      monthInSen: monthIn(entries, ym),
      monthOutSen: monthOut(entries, ym),
      entryCount: entries.length,
      pendingCount: pendingCount,
      unseenCorrections: unseenCorrections,
    );
  }

  String _kuliahTitle(Map<String, dynamic> k) {
    final topic = k['topic'];
    if (topic is String && topic.trim().isNotEmpty) return topic;
    return (k['label'] as String?) ?? '';
  }

  /// The month's report: the frozen copy of a closed month, else computed
  /// here from the ledger rows (what the box would compute).
  Future<MonthReport> report(
    String ym, {
    required DateTime now,
    DateTime? syncedUntil,
  }) async {
    final months = await this.months();
    MonthState? state;
    for (final m in months) {
      if (m.ym == ym) state = m;
    }
    if (state != null && state.closed && state.report != null) {
      return state.report!;
    }
    final entries = await allEntries();
    final titles = <String, String>{};
    final dates = <String, String>{};
    for (final e in entries) {
      final kid = e.kuliahId;
      if (kid == null || titles.containsKey(kid)) continue;
      final k = await store.getDoc(Collections.content('kuliah'), kid);
      if (k == null || k['_deleted'] == true) continue;
      titles[kid] = _kuliahTitle(k);
      dates[kid] = (k['date'] as String?) ?? '';
    }
    return monthReport(
      MonthReportInput(
        ym: ym,
        entries: entries,
        funds: await funds(includeArchived: true),
        perihal: await perihal(includeArchived: true),
        kuliahTitles: titles,
        kuliahDates: dates,
        now: isoMs(now),
        syncedUntil: syncedUntil == null ? null : isoMs(syncedUntil),
        status: state != null && state.closed ? 'closed' : 'open',
      ),
    );
  }

  /// Kuliah the Bendahari may pay for: dated [todayKl] or earlier (tomorrow
  /// and later are left out), newest first. A cancelled (`batal`) kuliah is
  /// listed and flagged. `paid` is true when a payment that is not voided
  /// carries the kuliah's id.
  Future<List<KuliahCandidate>> kuliahCandidates({
    required String todayKl,
  }) async {
    final paid = <String>{
      for (final e in effective(await allEntries()))
        if (e.kind == 'out' && !e.voided && e.entry.kuliahId != null)
          e.entry.kuliahId!,
    };
    final out = <(String, KuliahCandidate)>[];
    for (final k in await store.list(Collections.content('kuliah'))) {
      if (k['_deleted'] == true) continue;
      final id = k['id'];
      final date = k['date'];
      if (id is! String || date is! String || date.compareTo(todayKl) > 0) {
        continue;
      }
      final pid = (k['penceramahId'] as String?) ?? '';
      final p = await store.getDoc(Collections.content('penceramah'), pid);
      out.add((
        '$date|${k['time'] ?? ''}',
        KuliahCandidate(
          kuliahId: id,
          date: date,
          title: _kuliahTitle(k),
          penceramahId: pid,
          penceramahName: (p?['name'] as String?) ?? '',
          paid: paid.contains(id),
          cancelled: k['status'] == 'batal',
          tonight: date == todayKl,
        ),
      ));
    }
    out.sort((a, b) => b.$1.compareTo(a.$1));
    return [for (final c in out) c.$2];
  }

  /// The latest payment to this penceramah that is not voided (corrected
  /// amount and tabung), or null.
  Future<FinanceEntry?> lastPayment(String penceramahId) async =>
      lastPenceramahPayment(await allEntries(), penceramahId);

  /// Rows added by a correction that the person has not looked at yet:
  /// received after [seenAt] (all of them when it is null).
  Future<int> unseenCorrections(String? seenAt) async => [
    for (final e in await allEntries())
      if (e.kind == 'adjust' &&
          (seenAt == null || e.receivedAt.compareTo(seenAt) > 0))
        e,
  ].length;
}
