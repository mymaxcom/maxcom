// The Dart twins of packages/core/src/finance/types.ts. Every amount is an
// integer number of sen (Dart `int`, never double). Each class reads the JSON
// the box serves (and the local copy keeps) and writes it back in the same
// key set, so a report built here compares equal to the one core builds.

import 'ledger.dart' show tempRefLabel;

String? _str(Object? v) => v is String ? v : null;

int _int(Object? v, [int fallback = 0]) {
  if (v is int) return v;
  if (v is num && v == v.truncate()) return v.toInt();
  return fallback;
}

int? _intOrNull(Object? v) => v == null ? null : _int(v);

/// A person who counted cash: an app user (`userId`) or a named outsider.
class Counter {
  const Counter.user(String this.userId) : name = null;
  const Counter.named(String this.name) : userId = null;

  final String? userId;
  final String? name;

  static Counter? fromJson(Object? v) {
    if (v is! Map) return null;
    final u = _str(v['userId']);
    if (u != null) return Counter.user(u);
    final n = _str(v['name']);
    return n == null ? null : Counter.named(n);
  }

  Map<String, dynamic> toJson() =>
      userId != null ? {'userId': userId} : {'name': name};
}

class Fund {
  const Fund({
    required this.id,
    required this.name,
    this.public = false,
    this.targetSen,
    this.jumaat = false,
    this.sortOrder = 0,
    this.archivedAt,
    this.updatedAt = '',
    this.updatedBy = '',
  });

  final String id;
  final String name;
  final bool public;
  final int? targetSen;
  final bool jumaat;
  final int sortOrder;
  final String? archivedAt;
  final String updatedAt;
  final String updatedBy;

  bool get archived => archivedAt != null;

  factory Fund.fromJson(Map<String, dynamic> j) => Fund(
    id: _str(j['id']) ?? '',
    name: _str(j['name']) ?? '',
    public: j['public'] == true,
    targetSen: _intOrNull(j['targetSen']),
    jumaat: j['jumaat'] == true,
    sortOrder: _int(j['sortOrder']),
    archivedAt: _str(j['archivedAt']),
    updatedAt: _str(j['updatedAt']) ?? '',
    updatedBy: _str(j['updatedBy']) ?? '',
  );

  Map<String, dynamic> toJson() => {
    'id': id,
    'name': name,
    'public': public,
    'targetSen': targetSen,
    'jumaat': jumaat,
    'sortOrder': sortOrder,
    'archivedAt': archivedAt,
    'updatedAt': updatedAt,
    'updatedBy': updatedBy,
  };
}

class Perihal {
  const Perihal({
    required this.id,
    required this.direction,
    required this.label,
    this.system,
    this.sortOrder = 0,
    this.archivedAt,
    this.updatedAt = '',
    this.updatedBy = '',
  });

  final String id;

  /// `in` or `out`.
  final String direction;
  final String label;

  /// `penceramah` for the fixed one, else null.
  final String? system;
  final int sortOrder;
  final String? archivedAt;
  final String updatedAt;
  final String updatedBy;

  bool get archived => archivedAt != null;

  factory Perihal.fromJson(Map<String, dynamic> j) => Perihal(
    id: _str(j['id']) ?? '',
    direction: _str(j['direction']) ?? 'in',
    label: _str(j['label']) ?? '',
    system: _str(j['system']),
    sortOrder: _int(j['sortOrder']),
    archivedAt: _str(j['archivedAt']),
    updatedAt: _str(j['updatedAt']) ?? '',
    updatedBy: _str(j['updatedBy']) ?? '',
  );

  Map<String, dynamic> toJson() => {
    'id': id,
    'direction': direction,
    'label': label,
    'system': system,
    'sortOrder': sortOrder,
    'archivedAt': archivedAt,
    'updatedAt': updatedAt,
    'updatedBy': updatedBy,
  };
}

/// One ledger row. `kind` is `in`, `out`, `opening` or `adjust`.
class FinanceEntry {
  const FinanceEntry({
    required this.id,
    required this.kind,
    required this.entryDate,
    required this.fundId,
    this.perihalId,
    this.amountSen = 0,
    this.method,
    this.reference,
    this.note,
    this.payee,
    this.counters,
    this.denominations,
    this.photoId,
    this.kuliahId,
    this.penceramahId,
    this.penceramahName,
    this.correctsId,
    this.correctionKind,
    this.toFundId,
    this.reason,
    this.refNo,
    this.createdBy = '',
    this.deviceId,
    this.editedAt = '',
    String? receivedAt,
    this.cloudReceivedAt,
    this.pending = false,
  }) : receivedAt = receivedAt ?? editedAt;

  final String id;
  final String kind;
  final String entryDate;
  final String fundId;
  final String? perihalId;
  final int amountSen;
  final String? method;
  final String? reference;
  final String? note;
  final String? payee;
  final List<Counter>? counters;
  final Map<String, int>? denominations;
  final String? photoId;
  final String? kuliahId;
  final String? penceramahId;
  final String? penceramahName;
  final String? correctsId;
  final String? correctionKind;
  final String? toFundId;
  final String? reason;
  final String? refNo;
  final String createdBy;
  final String? deviceId;
  final String editedAt;
  final String receivedAt;
  final String? cloudReceivedAt;

  /// The op that made this row still waits in the outbox (local only, never
  /// part of [toJson]).
  final bool pending;

  /// The number to show: the server's, or the device's temporary label.
  String get refLabel => refNo ?? '${tempRefLabel(id, kind)} (sementara)';

  factory FinanceEntry.fromJson(Map<String, dynamic> j) {
    final rawCounters = j['counters'];
    final rawDenoms = j['denominations'];
    final editedAt = _str(j['editedAt']) ?? '';
    return FinanceEntry(
      id: _str(j['id']) ?? '',
      kind: _str(j['kind']) ?? 'in',
      entryDate: _str(j['entryDate']) ?? '',
      fundId: _str(j['fundId']) ?? '',
      perihalId: _str(j['perihalId']),
      amountSen: _int(j['amountSen']),
      method: _str(j['method']),
      reference: _str(j['reference']),
      note: _str(j['note']),
      payee: _str(j['payee']),
      counters: rawCounters is List
          ? [
              for (final c in rawCounters)
                if (Counter.fromJson(c) case final Counter ok) ok,
            ]
          : null,
      denominations: rawDenoms is Map
          ? {
              for (final e in rawDenoms.entries)
                if (e.key is String && e.value is num)
                  e.key as String: (e.value as num).toInt(),
            }
          : null,
      photoId: _str(j['photoId']),
      kuliahId: _str(j['kuliahId']),
      penceramahId: _str(j['penceramahId']),
      penceramahName: _str(j['penceramahName']),
      correctsId: _str(j['correctsId']),
      correctionKind: _str(j['correctionKind']),
      toFundId: _str(j['toFundId']),
      reason: _str(j['reason']),
      refNo: _str(j['refNo']),
      createdBy: _str(j['createdBy']) ?? '',
      deviceId: _str(j['deviceId']),
      editedAt: editedAt,
      receivedAt: _str(j['receivedAt']) ?? editedAt,
      cloudReceivedAt: _str(j['cloudReceivedAt']),
      pending: j['pending'] == true,
    );
  }

  Map<String, dynamic> toJson() => {
    'id': id,
    'kind': kind,
    'entryDate': entryDate,
    'fundId': fundId,
    'perihalId': perihalId,
    'amountSen': amountSen,
    'method': method,
    'reference': reference,
    'note': note,
    'payee': payee,
    'counters': counters == null
        ? null
        : [for (final c in counters!) c.toJson()],
    'denominations': denominations,
    'photoId': photoId,
    'kuliahId': kuliahId,
    'penceramahId': penceramahId,
    'penceramahName': penceramahName,
    'correctsId': correctsId,
    'correctionKind': correctionKind,
    'toFundId': toFundId,
    'reason': reason,
    'refNo': refNo,
    'createdBy': createdBy,
    'deviceId': deviceId,
    'editedAt': editedAt,
    'receivedAt': receivedAt,
    'cloudReceivedAt': cloudReceivedAt,
  };

  FinanceEntry copyWith({
    String? fundId,
    int? amountSen,
    String? photoId,
    bool? pending,
  }) => FinanceEntry(
    id: id,
    kind: kind,
    entryDate: entryDate,
    fundId: fundId ?? this.fundId,
    perihalId: perihalId,
    amountSen: amountSen ?? this.amountSen,
    method: method,
    reference: reference,
    note: note,
    payee: payee,
    counters: counters,
    denominations: denominations,
    photoId: photoId ?? this.photoId,
    kuliahId: kuliahId,
    penceramahId: penceramahId,
    penceramahName: penceramahName,
    correctsId: correctsId,
    correctionKind: correctionKind,
    toFundId: toFundId,
    reason: reason,
    refNo: refNo,
    createdBy: createdBy,
    deviceId: deviceId,
    editedAt: editedAt,
    receivedAt: receivedAt,
    cloudReceivedAt: cloudReceivedAt,
    pending: pending ?? this.pending,
  );
}

/// An original entry with its corrections applied.
class EffectiveEntry {
  const EffectiveEntry({
    required this.entry,
    required this.effFundId,
    required this.effAmountSen,
    required this.voided,
    required this.corrections,
  });

  final FinanceEntry entry;
  final String effFundId;
  final int effAmountSen;
  final bool voided;

  /// In (editedAt, id) order.
  final List<FinanceEntry> corrections;

  String get id => entry.id;
  String get kind => entry.kind;
}

class MonthState {
  const MonthState({
    required this.ym,
    required this.status,
    this.closedAt,
    this.closedBy,
    this.report,
    this.pending = false,
  });

  final String ym;

  /// `open` or `closed`.
  final String status;
  final String? closedAt;
  final String? closedBy;

  /// The report as it was when the month was closed; null while open.
  final MonthReport? report;
  final bool pending;

  bool get closed => status == 'closed';

  factory MonthState.fromJson(Map<String, dynamic> j) {
    final r = j['report'];
    return MonthState(
      ym: _str(j['ym']) ?? _str(j['id']) ?? '',
      status: j['status'] == 'closed' ? 'closed' : 'open',
      closedAt: _str(j['closedAt']),
      closedBy: _str(j['closedBy']),
      report: r is Map<String, dynamic> ? MonthReport.fromJson(r) : null,
      pending: j['pending'] == true,
    );
  }

  Map<String, dynamic> toJson() => {
    'ym': ym,
    'status': status,
    'closedAt': closedAt,
    'closedBy': closedBy,
    'report': report?.toJson(),
  };
}

class PhotoMeta {
  const PhotoMeta({
    required this.id,
    required this.entryId,
    this.mime = 'image/jpeg',
    this.bytes = 0,
    this.present = true,
  });

  final String id;
  final String entryId;
  final String mime;
  final int bytes;
  final bool present;

  factory PhotoMeta.fromJson(Map<String, dynamic> j) => PhotoMeta(
    id: _str(j['id']) ?? '',
    entryId: _str(j['entryId']) ?? '',
    mime: _str(j['mime']) ?? 'image/jpeg',
    bytes: _int(j['bytes']),
    present: j['present'] != false,
  );

  Map<String, dynamic> toJson() => {
    'id': id,
    'entryId': entryId,
    'mime': mime,
    'bytes': bytes,
    'present': present,
  };
}

// ---- the monthly report ----

class ReportFundRow {
  const ReportFundRow({
    required this.fundId,
    required this.name,
    required this.openingSen,
    required this.inSen,
    required this.outSen,
    required this.correctionsSen,
    required this.closingSen,
  });

  final String fundId;
  final String name;
  final int openingSen;
  final int inSen;
  final int outSen;
  final int correctionsSen;
  final int closingSen;

  factory ReportFundRow.fromJson(Map<String, dynamic> j) => ReportFundRow(
    fundId: _str(j['fundId']) ?? '',
    name: _str(j['name']) ?? '',
    openingSen: _int(j['openingSen']),
    inSen: _int(j['inSen']),
    outSen: _int(j['outSen']),
    correctionsSen: _int(j['correctionsSen']),
    closingSen: _int(j['closingSen']),
  );

  Map<String, dynamic> toJson() => {
    'fundId': fundId,
    'name': name,
    'openingSen': openingSen,
    'inSen': inSen,
    'outSen': outSen,
    'correctionsSen': correctionsSen,
    'closingSen': closingSen,
  };
}

/// A row of money in; [ReportOutRow] adds the payment fields.
class ReportInRow {
  const ReportInRow({
    required this.date,
    this.refNo,
    this.note,
    required this.amountSen,
  });

  final String date;
  final String? refNo;
  final String? note;
  final int amountSen;

  factory ReportInRow.fromJson(Map<String, dynamic> j) => ReportInRow(
    date: _str(j['date']) ?? '',
    refNo: _str(j['refNo']),
    note: _str(j['note']),
    amountSen: _int(j['amountSen']),
  );

  Map<String, dynamic> toJson() => {
    'date': date,
    'refNo': refNo,
    'note': note,
    'amountSen': amountSen,
  };
}

class ReportOutRow extends ReportInRow {
  const ReportOutRow({
    required super.date,
    super.refNo,
    super.note,
    required super.amountSen,
    this.payee,
    this.penceramahName,
    this.kuliahTitle,
    this.kuliahDate,
  });

  final String? payee;
  final String? penceramahName;
  final String? kuliahTitle;
  final String? kuliahDate;

  factory ReportOutRow.fromJson(Map<String, dynamic> j) => ReportOutRow(
    date: _str(j['date']) ?? '',
    refNo: _str(j['refNo']),
    note: _str(j['note']),
    amountSen: _int(j['amountSen']),
    payee: _str(j['payee']),
    penceramahName: _str(j['penceramahName']),
    kuliahTitle: _str(j['kuliahTitle']),
    kuliahDate: _str(j['kuliahDate']),
  );

  @override
  Map<String, dynamic> toJson() => {
    ...super.toJson(),
    'payee': payee,
    'penceramahName': penceramahName,
    'kuliahTitle': kuliahTitle,
    'kuliahDate': kuliahDate,
  };
}

class ReportGroup<R extends ReportInRow> {
  const ReportGroup({
    required this.perihalId,
    required this.label,
    required this.fundId,
    required this.rows,
    required this.totalSen,
  });

  final String perihalId;
  final String label;
  final String fundId;
  final List<R> rows;
  final int totalSen;

  static ReportGroup<R> fromJson<R extends ReportInRow>(
    Map<String, dynamic> j,
    R Function(Map<String, dynamic>) row,
  ) => ReportGroup<R>(
    perihalId: _str(j['perihalId']) ?? '',
    label: _str(j['label']) ?? '',
    fundId: _str(j['fundId']) ?? '',
    rows: [
      for (final r in (j['rows'] as List? ?? const []))
        if (r is Map<String, dynamic>) row(r),
    ],
    totalSen: _int(j['totalSen']),
  );

  Map<String, dynamic> toJson() => {
    'perihalId': perihalId,
    'label': label,
    'fundId': fundId,
    'rows': [for (final r in rows) r.toJson()],
    'totalSen': totalSen,
  };
}

class ReportCorrection {
  const ReportCorrection({
    required this.id,
    required this.date,
    this.refNo,
    this.originalRefNo,
    required this.kind,
    required this.reason,
    required this.deltaSen,
    required this.fundName,
    required this.lastMonth,
  });

  final String id;
  final String date;
  final String? refNo;
  final String? originalRefNo;
  final String kind;
  final String reason;
  final int deltaSen;
  final String fundName;
  final bool lastMonth;

  factory ReportCorrection.fromJson(Map<String, dynamic> j) => ReportCorrection(
    id: _str(j['id']) ?? '',
    date: _str(j['date']) ?? '',
    refNo: _str(j['refNo']),
    originalRefNo: _str(j['originalRefNo']),
    kind: _str(j['kind']) ?? 'amount',
    reason: _str(j['reason']) ?? '',
    deltaSen: _int(j['deltaSen']),
    fundName: _str(j['fundName']) ?? '',
    lastMonth: j['lastMonth'] == true,
  );

  Map<String, dynamic> toJson() => {
    'id': id,
    'date': date,
    'refNo': refNo,
    'originalRefNo': originalRefNo,
    'kind': kind,
    'reason': reason,
    'deltaSen': deltaSen,
    'fundName': fundName,
    'lastMonth': lastMonth,
  };
}

class ReportTotals {
  const ReportTotals({
    required this.openingSen,
    required this.inSen,
    required this.outSen,
    required this.correctionsSen,
    required this.closingSen,
  });

  final int openingSen;
  final int inSen;
  final int outSen;
  final int correctionsSen;
  final int closingSen;

  factory ReportTotals.fromJson(Map<String, dynamic> j) => ReportTotals(
    openingSen: _int(j['openingSen']),
    inSen: _int(j['inSen']),
    outSen: _int(j['outSen']),
    correctionsSen: _int(j['correctionsSen']),
    closingSen: _int(j['closingSen']),
  );

  Map<String, dynamic> toJson() => {
    'openingSen': openingSen,
    'inSen': inSen,
    'outSen': outSen,
    'correctionsSen': correctionsSen,
    'closingSen': closingSen,
  };
}

class MonthReport {
  const MonthReport({
    required this.ym,
    required this.status,
    required this.generatedAt,
    required this.syncedUntil,
    required this.funds,
    required this.inByPerihal,
    required this.outByPerihal,
    required this.corrections,
    required this.totals,
  });

  final String ym;
  final String status;
  final String generatedAt;
  final String? syncedUntil;
  final List<ReportFundRow> funds;
  final List<ReportGroup<ReportInRow>> inByPerihal;
  final List<ReportGroup<ReportOutRow>> outByPerihal;
  final List<ReportCorrection> corrections;
  final ReportTotals totals;

  factory MonthReport.fromJson(Map<String, dynamic> j) {
    List<Map<String, dynamic>> maps(Object? v) => [
      for (final x in (v as List? ?? const []))
        if (x is Map<String, dynamic>) x,
    ];
    return MonthReport(
      ym: _str(j['ym']) ?? '',
      status: j['status'] == 'closed' ? 'closed' : 'open',
      generatedAt: _str(j['generatedAt']) ?? '',
      syncedUntil: _str(j['syncedUntil']),
      funds: [for (final f in maps(j['funds'])) ReportFundRow.fromJson(f)],
      inByPerihal: [
        for (final g in maps(j['inByPerihal']))
          ReportGroup.fromJson<ReportInRow>(g, ReportInRow.fromJson),
      ],
      outByPerihal: [
        for (final g in maps(j['outByPerihal']))
          ReportGroup.fromJson<ReportOutRow>(g, ReportOutRow.fromJson),
      ],
      corrections: [
        for (final c in maps(j['corrections'])) ReportCorrection.fromJson(c),
      ],
      totals: ReportTotals.fromJson(
        (j['totals'] as Map?)?.cast<String, dynamic>() ?? const {},
      ),
    );
  }

  Map<String, dynamic> toJson() => {
    'ym': ym,
    'status': status,
    'generatedAt': generatedAt,
    'syncedUntil': syncedUntil,
    'funds': [for (final f in funds) f.toJson()],
    'inByPerihal': [for (final g in inByPerihal) g.toJson()],
    'outByPerihal': [for (final g in outByPerihal) g.toJson()],
    'corrections': [for (final c in corrections) c.toJson()],
    'totals': totals.toJson(),
  };
}

/// The keys an entry input may carry; anything else (a `refNo`, a
/// `createdBy`, a time the box stamps) is dropped before signing.
const Set<String> financeEntryInputKeys = {
  'kind',
  'entryDate',
  'fundId',
  'perihalId',
  'amountSen',
  'method',
  'reference',
  'note',
  'payee',
  'counters',
  'denominations',
  'photoId',
  'kuliahId',
  'penceramahId',
  'penceramahName',
  'correctsId',
  'correctionKind',
  'toFundId',
  'reason',
};

// ---- what the repository hands the screens ----

/// A fund with its current balance.
class FundBalance {
  const FundBalance(this.fund, this.balanceSen);

  final Fund fund;
  final int balanceSen;
}

class FinanceSummary {
  const FinanceSummary({
    required this.funds,
    required this.ym,
    required this.monthStatus,
    required this.monthInSen,
    required this.monthOutSen,
    required this.entryCount,
    required this.pendingCount,
    required this.unseenCorrections,
  });

  final List<FundBalance> funds;
  final String ym;
  final String monthStatus;
  final int monthInSen;
  final int monthOutSen;
  final int entryCount;

  /// Finance ops still in the outbox ("N catatan belum di skrin TV").
  final int pendingCount;
  final int unseenCorrections;

  int get totalSen => funds.fold(0, (a, f) => a + f.balanceSen);
}

/// One entry with its corrections and current value.
class EntryDetail {
  const EntryDetail({
    required this.entry,
    required this.corrections,
    required this.effective,
  });

  final FinanceEntry entry;
  final List<FinanceEntry> corrections;
  final EffectiveEntry effective;
}

/// A kuliah the Bendahari may pay for.
class KuliahCandidate {
  const KuliahCandidate({
    required this.kuliahId,
    required this.date,
    required this.title,
    required this.penceramahId,
    required this.penceramahName,
    required this.paid,
    required this.cancelled,
    required this.tonight,
  });

  final String kuliahId;

  /// KL date YYYY-MM-DD.
  final String date;
  final String title;
  final String penceramahId;
  final String penceramahName;

  /// An `out` entry already carries this kuliah's id.
  final bool paid;

  /// The kuliah is `batal`: still listed, flagged "Dibatalkan".
  final bool cancelled;

  /// Dated today (KL).
  final bool tonight;
}
