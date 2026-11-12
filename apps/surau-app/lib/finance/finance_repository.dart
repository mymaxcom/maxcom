// The finance data layer the Kewangan screens use. Reads come from the local
// copy (works at the surau and away); every write is signed, applied to the
// local copy at once (the row shows `pending: true` and a temporary number)
// and queued by the sync engine until the box or the cloud accepts it.
//
// Rules this class keeps:
//  - Money is integer sen. Ids are ULIDs made here; `createdBy`, `deviceId`
//    and `editedAt` come from the signed op (session and device clock).
//  - The app never writes `refNo`: the box assigns it. Until the row held
//    here carries one, `FinanceEntry.refLabel` shows `K-1A2B (sementara)`.
//  - A correction always points at the ORIGINAL entry, never at another
//    correction.

import 'dart:async';
import 'dart:typed_data';

import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../app/providers.dart';
import '../store/local_store.dart';
import '../sync/outbox.dart';
import '../sync/sync_engine.dart';
import '../sync/sync_providers.dart';
import 'finance_local.dart';
import 'finance_models.dart';
import 'ledger.dart';
import 'photo_prep.dart';

final RegExp _ymPattern = RegExp(r'^\d{4}-(0[1-9]|1[0-2])$');

class FinanceRepository {
  FinanceRepository({
    required this.store,
    required this.engine,
    DateTime Function()? now,
    UlidGenerator? ulid,
  }) : _now = now ?? DateTime.now,
       _ulid = ulid ?? UlidGenerator(now: now),
       local = FinanceLocal(store);

  final LocalStore store;
  final SyncEngine engine;
  final FinanceLocal local;
  final DateTime Function() _now;
  final UlidGenerator _ulid;
  final StreamController<void> _changes = StreamController<void>.broadcast();

  void dispose() {
    if (!_changes.isClosed) _changes.close();
  }

  /// A fresh id for a new entry, fund or perihal.
  String newId() => _ulid.next();

  String get todayKl => klDate(_now());

  // ---- reads ----

  Future<FinanceSummary> summary() async => local.summary(
    todayKl: todayKl,
    pendingCount: await pendingFinanceCount(),
    unseenCorrections: await unseenCorrectionsCount(),
  );

  /// The summary now, and again after every local write and every sync
  /// state change (a pull that brought rows, an op the box accepted).
  Stream<FinanceSummary> watchSummary() {
    late final StreamController<FinanceSummary> out;
    final subs = <StreamSubscription<Object?>>[];
    var busy = false;
    var again = false;

    Future<void> emit() async {
      if (busy) {
        again = true;
        return;
      }
      busy = true;
      try {
        do {
          again = false;
          final s = await summary();
          if (!out.isClosed) out.add(s);
        } while (again);
      } on Object catch (e, st) {
        if (!out.isClosed) out.addError(e, st);
      } finally {
        busy = false;
      }
    }

    out = StreamController<FinanceSummary>(
      onListen: () {
        subs.add(_changes.stream.listen((_) => unawaited(emit())));
        subs.add(engine.views.listen((_) => unawaited(emit())));
        unawaited(emit());
      },
      onCancel: () async {
        for (final s in subs) {
          await s.cancel();
        }
      },
    );
    return out.stream;
  }

  /// Rows of the ledger, newest first. [ym] is `YYYY-MM`; [fundId] filters
  /// on the tabung the row was first posted to.
  Future<List<FinanceEntry>> entries({String? ym, String? fundId}) async {
    final rows = await local.entries(ym: ym, fundId: fundId, limit: 5000);
    return rows.reversed.toList();
  }

  Future<EntryDetail?> entry(String id) => local.detail(id);

  Future<List<Fund>> funds({bool includeArchived = false}) =>
      local.funds(includeArchived: includeArchived);

  Future<List<Perihal>> perihal([
    String? direction,
    bool includeArchived = false,
  ]) => local.perihal(direction: direction, includeArchived: includeArchived);

  Future<List<MonthState>> months() => local.months();

  /// The month's report as data: the frozen copy of a closed month, else
  /// computed from the local ledger (works offline).
  Future<MonthReport> report(String ym) async {
    return local.report(ym, now: _now(), syncedUntil: engine.view.lastSync);
  }

  /// Finance ops still waiting in the outbox.
  Future<int> pendingFinanceCount() async => [
    for (final d in await store.list(Collections.outbox))
      if (((d['op'] as Map?)?['kind'] as String? ?? '').startsWith('finance.'))
        d,
  ].length;

  /// The entry's own op has not been accepted yet.
  Future<bool> isPending(String entryId) async {
    final d = await store.getDoc(Collections.financeEntries, entryId);
    return d != null && d['pending'] == true;
  }

  Future<int> unseenCorrectionsCount() async {
    final meta = await store.meta();
    return local.unseenCorrections(meta[metaFinanceCorrectionsSeenAt]);
  }

  Future<void> markCorrectionsSeen() async {
    await store.setMeta(metaFinanceCorrectionsSeenAt, isoMs(_now()));
    _changes.add(null);
  }

  Future<List<KuliahCandidate>> kuliahCandidates() =>
      local.kuliahCandidates(todayKl: todayKl);

  /// The fee last paid to this penceramah (corrected amount), or null.
  Future<int?> suggestedFee(String penceramahId) async =>
      (await local.lastPayment(penceramahId))?.amountSen;

  /// The whole last payment (fee and tabung), for a screen that fills both.
  Future<FinanceEntry?> lastPayment(String penceramahId) =>
      local.lastPayment(penceramahId);

  // ---- writes ----

  /// A collection of money in (`kind: in`). [photo] is a JPEG from
  /// [prepareFinancePhoto]; it is queued with the entry.
  Future<FinanceEntry> appendCollection(
    Map<String, dynamic> input, {
    Uint8List? photo,
  }) => _append('in', input, photo);

  /// A payment (`kind: out`). A penceramah payment carries `kuliahId`; the
  /// penceramah's id and name are copied from the kuliah here for the local
  /// copy (the box copies its own).
  Future<FinanceEntry> appendPayment(
    Map<String, dynamic> input, {
    Uint8List? photo,
  }) async {
    final fill = Map<String, dynamic>.of(input);
    final kid = fill['kuliahId'];
    if (kid is String && fill['penceramahId'] == null) {
      final k = await store.getDoc(Collections.content('kuliah'), kid);
      final pid = k?['penceramahId'];
      if (pid is String) {
        fill['penceramahId'] = pid;
        final p = await store.getDoc(Collections.content('penceramah'), pid);
        if (p?['name'] is String) fill['penceramahName'] = p!['name'];
      }
    }
    return _append('out', fill, photo);
  }

  /// An opening balance (`kind: opening`) for one tabung, dated on the day
  /// the module started. Setup posts one per tabung (RM 0.00 allowed).
  Future<FinanceEntry> appendOpening(Map<String, dynamic> input) =>
      _append('opening', input, null);

  /// A correction (`kind: adjust`) of `correctsId`. When that id is itself a
  /// correction, the original it points at is used. The tabung is the
  /// original's.
  Future<FinanceEntry> appendCorrection(Map<String, dynamic> input) async {
    final fill = Map<String, dynamic>.of(input);
    final target = fill['correctsId'];
    if (target is! String || target.isEmpty) {
      throw ArgumentError('a correction needs correctsId');
    }
    var origin = await store.getDoc(Collections.financeEntries, target);
    if (origin != null && origin['kind'] == 'adjust') {
      final up = origin['correctsId'];
      if (up is String) {
        fill['correctsId'] = up;
        origin = await store.getDoc(Collections.financeEntries, up);
      }
    }
    if (origin != null) fill['fundId'] = origin['fundId'];
    fill.remove('perihalId');
    fill['amountSen'] ??= 0;
    return _append('adjust', fill, null);
  }

  Future<FinanceEntry> _append(
    String kind,
    Map<String, dynamic> input,
    Uint8List? photo,
  ) async {
    final payload = <String, dynamic>{};
    for (final e in input.entries) {
      if (!financeEntryInputKeys.contains(e.key) || e.value == null) continue;
      payload[e.key] = _jsonable(e.value);
    }
    payload['kind'] = kind;
    final amount = payload['amountSen'];
    if (amount is! int || amount < 0) {
      throw ArgumentError('amountSen must be a whole number of sen');
    }
    for (final k in const ['entryDate', 'fundId']) {
      if (payload[k] is! String || (payload[k] as String).isEmpty) {
        throw ArgumentError('$k is required');
      }
    }
    final id = _ulid.next();
    if (photo != null) {
      // Queued first, so the bytes are there when the entry lands.
      payload['photoId'] = await attachPhoto(id, photo);
    }
    await engine.enqueue(
      kind: 'finance.append',
      entity: 'finance:entry',
      entityId: id,
      payload: payload,
    );
    _changes.add(null);
    final doc = await store.getDoc(Collections.financeEntries, id);
    return FinanceEntry.fromJson(doc!);
  }

  /// Counters and denominations may be given as model objects.
  Object? _jsonable(Object? v) {
    if (v is Counter) return v.toJson();
    if (v is List) return [for (final x in v) _jsonable(x)];
    if (v is Map) {
      return {for (final e in v.entries) e.key as String: _jsonable(e.value)};
    }
    return v;
  }

  /// Queues a photo (a JPEG from [prepareFinancePhoto]) for [entryId] and
  /// returns its id (the sha256 of the bytes). Put that id in the entry's
  /// `photoId` when the entry is appended after the photo; with
  /// `appendCollection(..., photo:)` it is done for you. An entry is never
  /// edited afterwards, so a photo cannot be added to a row already made.
  Future<String> attachPhoto(String entryId, Uint8List bytes) async {
    final isJpeg =
        bytes.length > 3 &&
        bytes[0] == 0xFF &&
        bytes[1] == 0xD8 &&
        bytes[2] == 0xFF;
    if (!isJpeg) throw const FinancePhotoError(FinancePhotoError.notAnImage);
    if (bytes.length > maxPhotoBytes) {
      throw const FinancePhotoError(FinancePhotoError.tooBig);
    }
    final r = await engine.enqueueFinancePhoto(entryId, bytes);
    _changes.add(null);
    return r.id;
  }

  /// Adds or changes a tabung. Every field is sent (the box validates the
  /// whole object); use [newId] for a new one.
  Future<Fund> putFund(Fund fund) async {
    await engine.enqueue(
      kind: 'finance.lookup.put',
      entity: 'finance:fund',
      entityId: fund.id,
      payload: {
        'name': fund.name,
        'public': fund.public,
        'targetSen': fund.targetSen,
        'jumaat': fund.jumaat,
        'sortOrder': fund.sortOrder,
        'archivedAt': fund.archivedAt,
      },
    );
    _changes.add(null);
    final d = await store.getDoc(Collections.financeFunds, fund.id);
    return Fund.fromJson(d!);
  }

  Future<Perihal> putPerihal(Perihal p) async {
    await engine.enqueue(
      kind: 'finance.lookup.put',
      entity: 'finance:perihal',
      entityId: p.id,
      payload: {
        'direction': p.direction,
        'label': p.label,
        'sortOrder': p.sortOrder,
        'archivedAt': p.archivedAt,
      },
    );
    _changes.add(null);
    final d = await store.getDoc(Collections.financePerihal, p.id);
    return Perihal.fromJson(d!);
  }

  /// Closes (`closed`, "Muktamad") or reopens (`open`) a month.
  Future<MonthState> setMonth(String ym, String status) async {
    if (!_ymPattern.hasMatch(ym)) throw ArgumentError('ym must be YYYY-MM');
    if (status != 'open' && status != 'closed') {
      throw ArgumentError('status must be open or closed');
    }
    await engine.enqueue(
      kind: 'finance.month.put',
      entity: 'finance:month',
      entityId: ym,
      payload: {'status': status},
    );
    _changes.add(null);
    final d = await store.getDoc(Collections.financeMonths, ym);
    return MonthState.fromJson(d!);
  }
}

/// Null until unlocked (no engine, no store), like the settings repository.
final financeRepositoryProvider = Provider<FinanceRepository?>((ref) {
  final engine = ref.watch(syncEngineProvider);
  final store = ref.watch(localStoreProvider).value;
  if (engine == null || store == null) return null;
  final repo = FinanceRepository(
    store: store,
    engine: engine,
    now: ref.watch(appDepsProvider).now,
  );
  ref.onDispose(repo.dispose);
  return repo;
});
