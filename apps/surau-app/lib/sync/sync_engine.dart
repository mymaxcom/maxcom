// The sync engine (Plan 6 Task 8): signs each edit with the device key, applies
// it to the local store at once (optimistic), queues it in the outbox, and
// sends the queue to whichever base answers (the box, else the cloud), then
// pulls what changed there. Nothing is dropped silently: every refusal and
// every lost edit becomes a visible conflict, every failure a `lastError`.
//
// Plain Dart (no Riverpod): `sync_providers.dart` wraps it for the UI.

import 'dart:async';
import 'dart:convert';
import 'dart:typed_data';

import '../box/box_client.dart';
import '../box/device_key.dart';
import '../features/enrol/enrol_flow.dart' show EnrolledBox;
import '../finance/finance_models.dart';
import '../finance/ledger.dart' show maxPhotoBytes;
import '../store/local_store.dart';
import 'canonical.dart';
import 'outbox.dart';
import 'sync_wire.dart';

/// Why the engine has no base to talk to, as a state the UI can word.
enum SyncState {
  /// Nothing to do, or the last exchange finished.
  idle,

  /// The cloud is starting (503 `waking`): normal, not an error.
  waking,

  /// An exchange is running.
  syncing,

  /// No base answered; edits wait in the outbox.
  offline,
}

class SyncView {
  const SyncView({
    this.pendingOut = 0,
    this.lastSync,
    this.lastError,
    this.via,
    this.conflicts = 0,
    this.state = SyncState.idle,
  });

  static const SyncView empty = SyncView();

  /// Edits waiting in the outbox.
  final int pendingOut;
  final DateTime? lastSync;

  /// A short code (`unreachable`, `needs_unlock`, `session_expired`, ...);
  /// null when the last exchange succeeded.
  final String? lastError;

  /// `box`, `cloud` or null (never synced).
  final String? via;

  /// Refused or superseded edits the person has not dismissed.
  final int conflicts;
  final SyncState state;

  SyncView copyWith({
    int? pendingOut,
    DateTime? lastSync,
    Object? lastError = _keep,
    Object? via = _keep,
    int? conflicts,
    SyncState? state,
  }) => SyncView(
    pendingOut: pendingOut ?? this.pendingOut,
    lastSync: lastSync ?? this.lastSync,
    lastError: identical(lastError, _keep)
        ? this.lastError
        : lastError as String?,
    via: identical(via, _keep) ? this.via : via as String?,
    conflicts: conflicts ?? this.conflicts,
    state: state ?? this.state,
  );
}

const Object _keep = Object();

/// One located base with a way to talk to it as this device.
class SyncLink {
  const SyncLink({
    required this.base,
    required this.via,
    required this.client,
    required this.token,
  });

  final Uri base;
  final String via;
  final BoxClient client;
  final String token;
}

/// Finds a base and the session token for it. Throws [BoxUnreachable] when
/// nothing answers, [CloudWakingSignal] (a 503 `waking`) when the cloud is
/// starting, [NeedsUnlock] when a base answers but this device holds no
/// session for it yet.
abstract class SyncTransport {
  Future<SyncLink> connect();
}

/// A transport that can name the cloud directly, without locating the box
/// first: the YouTube sign-in routes always go there when cloud sync is on
/// (plan Task 8). Null when this device holds no session on the cloud.
abstract interface class CloudLinkSource {
  Future<SyncLink?> cloudLink();
}

class NeedsUnlock implements Exception {
  const NeedsUnlock();

  @override
  String toString() => 'NeedsUnlock';
}

/// The cloud answered `waking`; ask again after [retryAfterSec].
class CloudWakingSignal implements Exception {
  const CloudWakingSignal({this.retryAfterSec});

  final int? retryAfterSec;
}

/// Most raw bytes a queued asset op may carry. The box refuses an asset over
/// 8 MiB (8388608) and accepts a body of about 24.4 MB (SYNC_BODY_LIMIT); 8 MB
/// (8000000) stays under the first, and its base64 (~10.7 MB) far under the second.
const int maxQueuedAssetBytes = 8000000;

class AssetTooLarge implements Exception {
  const AssetTooLarge();

  static const String message = 'Gambar terlalu besar';

  @override
  String toString() => 'AssetTooLarge';
}

/// `seq` mirrors the cursor last written (the offline gateway reads it only
/// as "something was pulled"). The real cursor is per base: `seq@box`,
/// `seq@cloud`, because change_log ids are per database.
const String _metaSeq = 'seq';
String _cursorKey(String via) => 'seq@$via';
const String _metaLastSync = 'lastSync';
const String _metaVia = 'via';
const String _metaSurauId = 'surauId';

/// `surauId` of a box that never said otherwise (core's DEFAULT_SURAU_ID).
const String defaultSurauId = 'sdm';

class SyncEngine {
  SyncEngine({
    required this.store,
    required this.key,
    required this.box,
    required this.transport,
    DateTime Function()? now,
    UlidGenerator? ulid,
    this.autoSync = true,
    Timer Function(Duration, void Function())? schedule,
    this.onChanged,
    this.onRevoked,
    this.onSessionExpired,
    this.onNeedsUnlock,
    this.onWakeNeeded,
    this.backoff = const [
      Duration(seconds: 15),
      Duration(seconds: 60),
      Duration(minutes: 5),
    ],
    this.batchSize = 50,
  }) : now = now ?? DateTime.now,
       _ulid = ulid ?? UlidGenerator(now: now),
       _schedule = schedule ?? ((d, f) => Timer(d, f)),
       outbox = Outbox(store);

  final LocalStore store;
  final DeviceKey key;
  final EnrolledBox box;
  final SyncTransport transport;
  final DateTime Function() now;
  final Outbox outbox;
  final UlidGenerator _ulid;
  final Timer Function(Duration, void Function()) _schedule;

  /// `enqueue` starts a sync by itself. Tests turn it off.
  final bool autoSync;

  /// Called after a pull that changed local data (the UI refetches).
  final void Function()? onChanged;

  /// The server refused this device as revoked; the store is already wiped.
  /// The caller clears the session and routes to the unlock screen with
  /// `Peranti ini telah dibatalkan`.
  final void Function()? onRevoked;

  /// A 401 on the located base: the caller clears the session.
  final void Function()? onSessionExpired;

  /// A base answered but this device holds no session there (the offline
  /// session, or a cloud session when the box is back): unlock silently.
  final void Function()? onNeedsUnlock;

  /// The cloud is needed but down or sleeping: send a (debounced) wake.
  final void Function()? onWakeNeeded;

  final List<Duration> backoff;
  final int batchSize;

  /// The cloud link for the YouTube routes, or null to use the box: the
  /// `cloudSync` feature is on (the local settings copy; on when it has
  /// never said otherwise, the registry default), the box knows a cloud URL
  /// and this device holds a session there.
  Future<SyncLink?> cloudLinkIfOn() async {
    if (box.cloud == null) return null;
    final Object t = transport;
    if (t is! CloudLinkSource) return null;
    final doc = await store.getDoc(Collections.settings, 'cloudSync');
    if (doc != null && doc['enabled'] == false) return null;
    return t.cloudLink();
  }

  static const String revokedMessage = 'Peranti ini telah dibatalkan';

  final StreamController<SyncView> _views = StreamController.broadcast();
  SyncView _view = SyncView.empty;
  Future<SyncView>? _running;
  Timer? _retry;
  int _failures = 0;
  bool _dead = false;

  SyncView get view => _view;
  Stream<SyncView> get views => _views.stream;
  bool get isRunning => _running != null;

  void _emit(SyncView v) {
    _view = v;
    if (!_views.isClosed) _views.add(v);
  }

  /// Reads the counters from the store (call once after opening it).
  Future<SyncView> load() async {
    final meta = await store.meta();
    final last = DateTime.tryParse(meta[_metaLastSync] ?? '');
    _emit(
      SyncView(
        pendingOut: await outbox.count,
        lastSync: last,
        via: meta[_metaVia],
        conflicts: (await store.list(Collections.conflicts)).length,
        state: _view.state,
        lastError: _view.lastError,
      ),
    );
    return _view;
  }

  void dispose() {
    _dead = true;
    _retry?.cancel();
    _views.close();
  }

  // ---- enqueue ----

  String _iso(DateTime t) => DateTime.fromMillisecondsSinceEpoch(
    t.millisecondsSinceEpoch,
    isUtc: true,
  ).toIso8601String();

  static const Set<String> _reserved = {
    'rev',
    'pending',
    '_serverRev',
    '_deleted',
    '_feature',
  };

  /// [payload] without the engine's own bookkeeping keys.
  static Map<String, dynamic> cleanItem(Map<String, dynamic> item) => {
    for (final e in item.entries)
      if (!_reserved.contains(e.key)) e.key: e.value,
  };

  String? _collectionOf(String entity) {
    if (entity.startsWith('content:')) return entity;
    switch (entity) {
      case 'settings':
        return Collections.settings;
      case 'user':
        return Collections.users;
      case 'device':
        return Collections.devices;
      case 'finance:entry':
        return Collections.financeEntries;
      case 'finance:fund':
        return Collections.financeFunds;
      case 'finance:perihal':
        return Collections.financePerihal;
      case 'finance:month':
        return Collections.financeMonths;
      case 'finance:photo':
        return Collections.financePhotos;
    }
    return null;
  }

  /// Ops whose payload carries photo or image bytes: each is pushed alone,
  /// and its bytes wait in an `upload-` blob until the base accepts it.
  static bool carriesBytes(String kind) =>
      kind == 'asset.put' || kind == 'finance.photo.put';

  /// Builds, signs, applies locally and queues one op. Returns it. With
  /// [autoSync] it also starts a sync (never awaited).
  Future<OutboxOp> enqueue({
    required String kind,
    required String entity,
    required String entityId,
    Object? payload,
  }) async {
    if (_dead) throw StateError('SyncEngine disposed');
    final meta = await store.meta();
    final coll = _collectionOf(entity);
    final existing = coll == null ? null : await store.getDoc(coll, entityId);
    final baseRev = _serverRevOf(existing);
    final Object? body = switch (payload) {
      final Map<String, dynamic> m when entity.startsWith('content:') =>
        cleanItem(m),
      _ => payload,
    };
    final op = <String, dynamic>{
      'v': 1,
      'opId': _ulid.next(),
      'surauId': meta[_metaSurauId] ?? defaultSurauId,
      'boxId': box.boxId,
      'deviceId': box.deviceId,
      'userId': box.userId,
      'kind': kind,
      'entity': entity,
      'entityId': entityId,
      'baseRev': baseRev,
      'editedAt': _iso(now()),
      'payload': body,
    };
    final sig = b64url(await key.sign(opMessage(op)));
    op['sig'] = sig;
    final out = OutboxOp(op);
    await _applyLocal(out, existing);
    await outbox.add(out);
    _emit(_view.copyWith(pendingOut: await outbox.count));
    if (autoSync) unawaited(sync());
    return out;
  }

  String? _serverRevOf(Map<String, dynamic>? doc) {
    if (doc == null) return null;
    final rev = doc['rev'];
    if (rev is String && rev.startsWith('pending:')) {
      final s = doc['_serverRev'];
      return s is String ? s : null;
    }
    return rev is String ? rev : null;
  }

  Future<void> _applyLocal(OutboxOp op, Map<String, dynamic>? existing) async {
    final coll = _collectionOf(op.entity);
    final marker = <String, dynamic>{
      'rev': 'pending:${op.opId}',
      'pending': true,
      if (_serverRevOf(existing) != null) '_serverRev': _serverRevOf(existing),
    };
    switch (op.kind) {
      case 'content.put':
        final p = op.payload;
        if (coll == null || p is! Map<String, dynamic>) return;
        // A HadeethEnc hadis is switched or moved with `shown` and/or `order`
        // alone; the box puts its own text back under it, and so does the
        // local copy.
        final patch =
            op.entity == 'content:hadis' &&
            existing?['ext'] is Map &&
            p.keys.every((k) => k == 'shown' || k == 'order');
        await store.putDoc(coll, op.entityId, {
          if (patch) ...cleanItem(existing!),
          ...p,
          'id': op.entityId,
          ...marker,
        });
      case 'content.delete':
        if (coll == null) return;
        await store.putDoc(coll, op.entityId, {
          'id': op.entityId,
          '_deleted': true,
          ...marker,
        });
      case 'settings.put':
      case 'user.put':
        final p = op.payload;
        if (coll == null || p is! Map<String, dynamic>) return;
        final base = existing == null
            ? <String, dynamic>{}
            : cleanItem(existing);
        final merged = op.kind == 'settings.put'
            ? _deepMerge(base, p)
            : {...base, ...p};
        await store.putDoc(coll, op.entityId, {
          ...merged,
          if (op.kind == 'settings.put') '_feature': op.entityId,
          ...marker,
        });
      case 'asset.put':
        final p = op.payload;
        if (p is Map && p['bytesBase64'] is String) {
          await store.putBlob(
            'asset-${op.entityId}',
            Uint8List.fromList(base64.decode(p['bytesBase64'] as String)),
          );
        }
      case 'finance.append':
        // A ledger row is only ever added. The local copy is the row as the
        // box will store it, without the number the box assigns (refNo) and
        // the times it stamps; `pending` shows until the box accepts it.
        final p = op.payload;
        if (coll == null || p is! Map<String, dynamic>) return;
        await store.putDoc(coll, op.entityId, {
          ...FinanceEntry.fromJson({
            for (final e in p.entries)
              if (!_serverEntryKeys.contains(e.key)) e.key: e.value,
            'id': op.entityId,
            'createdBy': op.json['userId'],
            'deviceId': op.json['deviceId'],
            'editedAt': op.editedAt,
            'receivedAt': op.editedAt,
          }).toJson(),
          ...marker,
        });
      case 'finance.lookup.put':
        final p = op.payload;
        if (coll == null || p is! Map<String, dynamic>) return;
        final base = existing == null
            ? <String, dynamic>{}
            : cleanItem(existing);
        final merged = {
          ...base,
          ...p,
          'id': op.entityId,
          'updatedAt': op.editedAt,
          'updatedBy': op.json['userId'],
        };
        await store.putDoc(coll, op.entityId, {
          ...(op.entity == 'finance:fund'
              ? Fund.fromJson(merged).toJson()
              : Perihal.fromJson(merged).toJson()),
          ...marker,
        });
      case 'finance.month.put':
        final p = op.payload;
        if (coll == null || p is! Map<String, dynamic>) return;
        final closed = p['status'] == 'closed';
        await store.putDoc(coll, op.entityId, {
          ...MonthState.fromJson({
            'ym': op.entityId,
            'status': closed ? 'closed' : 'open',
            'closedAt': closed ? op.editedAt : null,
            'closedBy': closed ? op.json['userId'] : null,
            // The box freezes the report when it closes the month; the feed
            // brings it back.
            'report': null,
          }).toJson(),
          ...marker,
        });
      case 'finance.photo.put':
        final p = op.payload;
        if (coll == null || p is! Map || p['bytesBase64'] is! String) return;
        final bytes = Uint8List.fromList(
          base64.decode(p['bytesBase64'] as String),
        );
        await store.putBlob(financePhotoBlob(op.entityId), bytes);
        await store.putDoc(coll, op.entityId, {
          ...PhotoMeta(
            id: op.entityId,
            entryId: (p['entryId'] as String?) ?? '',
            bytes: bytes.length,
          ).toJson(),
          ...marker,
        });
    }
  }

  /// Keys of a finance entry the box owns: never taken from a payload.
  static const Set<String> _serverEntryKeys = {
    'id',
    'refNo',
    'createdBy',
    'deviceId',
    'editedAt',
    'receivedAt',
    'cloudReceivedAt',
    'pending',
    'rev',
  };

  /// The blob that keeps a finance photo's bytes readable on this device.
  static String financePhotoBlob(String photoId) => 'finance-photo-$photoId';

  static Map<String, dynamic> _deepMerge(
    Map<String, dynamic> a,
    Map<String, dynamic> b,
  ) {
    final out = Map<String, dynamic>.of(a);
    for (final e in b.entries) {
      final x = out[e.key];
      final y = e.value;
      out[e.key] = x is Map<String, dynamic> && y is Map<String, dynamic>
          ? _deepMerge(x, y)
          : y;
    }
    return out;
  }

  /// Queues an image for upload and makes its bytes readable offline. The id
  /// is the sha256 of the bytes, which is how the box names assets.
  Future<({String id, String mime, int bytes})> enqueueAsset(
    Uint8List bytes,
    String mime,
  ) async {
    if (bytes.length > maxQueuedAssetBytes) throw const AssetTooLarge();
    final id = sha256HexOf(bytes);
    await enqueue(
      kind: 'asset.put',
      entity: 'asset',
      entityId: id,
      payload: {'mime': mime, 'bytesBase64': base64.encode(bytes)},
    );
    return (id: id, mime: mime, bytes: bytes.length);
  }

  /// Queues a finance photo (a JPEG made by `prepareFinancePhoto`) for
  /// [entryId] and keeps its bytes readable offline. The id is the sha256 of
  /// the bytes, which is how the box names finance photos.
  Future<({String id, int bytes})> enqueueFinancePhoto(
    String entryId,
    Uint8List bytes,
  ) async {
    if (bytes.length > maxPhotoBytes) throw const AssetTooLarge();
    final id = sha256HexOf(bytes);
    await enqueue(
      kind: 'finance.photo.put',
      entity: 'finance:photo',
      entityId: id,
      payload: {'entryId': entryId, 'bytesBase64': base64.encode(bytes)},
    );
    return (id: id, bytes: bytes.length);
  }

  // ---- sync ----

  /// Pushes the outbox, then pulls. At most one runs; a second call joins
  /// the first. Never throws: failures land in [SyncView.lastError].
  Future<SyncView> sync() {
    final running = _running;
    if (running != null) return running;
    _retry?.cancel();
    final f = _run().whenComplete(() => _running = null);
    _running = f;
    return f;
  }

  void _later(Duration d) {
    if (_dead) return;
    _retry?.cancel();
    _retry = _schedule(d, () => unawaited(sync()));
  }

  void _fail(String code, {bool retry = true}) {
    _emit(_view.copyWith(lastError: code, state: SyncState.offline));
    if (retry) {
      final i = _failures < backoff.length ? _failures : backoff.length - 1;
      _failures++;
      _later(backoff[i]);
    }
  }

  /// Ids the last [_push] had in hand; ops queued after that are "new".
  Set<String> _pushed = {};

  Future<SyncView> _run([int round = 0]) async {
    if (_dead) return _view;
    _emit(_view.copyWith(state: SyncState.syncing));
    final SyncLink link;
    try {
      link = await transport.connect();
    } on CloudWakingSignal catch (w) {
      _emit(
        _view.copyWith(
          lastError: null,
          state: SyncState.waking,
          pendingOut: await outbox.count,
        ),
      );
      onWakeNeeded?.call();
      _later(Duration(seconds: w.retryAfterSec ?? 60));
      return _view;
    } on NeedsUnlock {
      _emit(_view.copyWith(lastError: 'needs_unlock', state: SyncState.idle));
      onNeedsUnlock?.call();
      return _view;
    } on BoxUnreachable {
      if (await outbox.count > 0) onWakeNeeded?.call();
      _fail('unreachable');
      return _view;
    } on BoxError {
      _fail('unreachable');
      return _view;
    }

    try {
      final ok = await _push(link);
      if (!ok) return _view;
      final changed = await _pull(link);
      final t = now();
      await store.setMeta(_metaLastSync, _iso(t));
      await store.setMeta(_metaVia, link.via);
      _failures = 0;
      _emit(
        SyncView(
          pendingOut: await outbox.count,
          lastSync: t,
          lastError: null,
          via: link.via,
          conflicts: (await store.list(Collections.conflicts)).length,
          state: SyncState.idle,
        ),
      );
      if (changed) onChanged?.call();
      // An op queued while this run was sending is not in it: go again
      // (bounded; ops that got no verdict are not "new", so no tight loop).
      if (round < 3 && !_dead) {
        final more = await outbox.pending();
        if (more.any((o) => !_pushed.contains(o.opId))) {
          return await _run(round + 1);
        }
      }
    } on SessionExpired {
      onSessionExpired?.call();
      _emit(
        _view.copyWith(lastError: 'session_expired', state: SyncState.idle),
      );
    } on BoxUnreachable {
      _fail('unreachable');
    } on BoxError catch (e) {
      if (e.status == 503) {
        _emit(_view.copyWith(lastError: null, state: SyncState.waking));
        onWakeNeeded?.call();
        _later(Duration(seconds: e.retryAfterSec ?? 60));
      } else {
        _fail(e.code ?? 'http_${e.status}');
      }
    } on Object catch (_) {
      _fail('sync_failed');
    }
    return _view;
  }

  // ---- push ----

  /// False when the exchange stopped (view already updated).
  Future<bool> _push(SyncLink link) async {
    await _surfaceNotices();
    await _dropLostUploads();
    final all = await outbox.pending();
    _pushed = {for (final o in all) o.opId};
    var i = 0;
    while (i < all.length) {
      final batch = <OutboxOp>[all[i]];
      i++;
      if (!carriesBytes(batch.first.kind)) {
        while (i < all.length &&
            !carriesBytes(all[i].kind) &&
            batch.length < batchSize) {
          batch.add(all[i]);
          i++;
        }
      }
      final Map<String, dynamic> out;
      try {
        out = await link.client.postJson('/api/sync/ops', {
          'ops': [for (final o in batch) o.json],
        }, token: link.token);
      } on SessionExpired {
        onSessionExpired?.call();
        _emit(
          _view.copyWith(lastError: 'session_expired', state: SyncState.idle),
        );
        return false;
      }
      final results = <String, OpResultDto>{
        for (final r in (out['results'] as List? ?? const []))
          if (r is Map<String, dynamic>)
            (r['opId'] as String): OpResultDto.fromJson(r),
      };
      for (final op in batch) {
        final r = results[op.opId];
        if (r == null) continue; // no verdict: stays queued, retried
        if (await _settle(op, r)) return false;
      }
    }
    return true;
  }

  /// An upload whose bytes are gone cannot be sent: show it as a conflict
  /// and take it off the queue (it would otherwise wait forever, unseen).
  Future<void> _dropLostUploads() async {
    for (final op in await outbox.missingBlobOps()) {
      await outbox.remove(op.opId);
      final p = op.payload;
      await store.putDoc(Collections.conflicts, op.opId, {
        'opId': op.opId,
        'kind': op.kind,
        'entity': op.entity,
        'entityId': op.entityId,
        'reason': 'blob_missing',
        'mine': p is Map<String, dynamic> ? _withoutBytes(p) : p,
        'winner': null,
        'editedAt': op.editedAt,
        'at': _iso(now()),
      });
    }
    _emit(
      _view.copyWith(
        pendingOut: await outbox.count,
        conflicts: (await store.list(Collections.conflicts)).length,
      ),
    );
  }

  /// The store set a notice (an unreadable outbox was set aside): turn it
  /// into a visible conflict once, then clear it.
  Future<void> _surfaceNotices() async {
    final meta = await store.meta();
    final at = meta[metaOutboxUnreadable];
    if (at == null) return;
    await store.putDoc(Collections.conflicts, 'outbox-$at', {
      'opId': 'outbox-$at',
      'kind': 'outbox.lost',
      'entity': 'outbox',
      'entityId': '',
      'reason': 'outbox_unreadable',
      'mine': null,
      'winner': null,
      'editedAt': at,
      'at': _iso(now()),
    });
    await store.setMeta(metaOutboxUnreadable, null);
    _emit(
      _view.copyWith(
        lastError: 'outbox_unreadable',
        conflicts: (await store.list(Collections.conflicts)).length,
      ),
    );
  }

  /// Handles one verdict. True when the device was revoked (stop everything).
  Future<bool> _settle(OutboxOp op, OpResultDto r) async {
    final coll = _collectionOf(op.entity);
    final doc = coll == null ? null : await store.getDoc(coll, op.entityId);
    final mine = doc != null && doc['rev'] == 'pending:${op.opId}';

    if (r.done) {
      await outbox.remove(op.opId);
      if (doc != null && coll != null) {
        if (mine) {
          if (op.kind == 'settings.put') {
            // The box merges settings per field: its copy may hold fields I
            // did not touch. Take the server's doc on this run's pull.
            await store.setMeta(metaNeedsSnapshot, '1');
          }
          if (op.kind == 'content.delete') {
            await store.deleteDoc(coll, op.entityId);
          } else {
            final next = Map<String, dynamic>.of(doc)
              ..remove('pending')
              ..remove('_serverRev');
            if (r.rev != null) next['rev'] = r.rev;
            await store.putDoc(coll, op.entityId, next);
          }
        } else if (doc['pending'] == true && r.rev != null) {
          await store.putDoc(coll, op.entityId, {...doc, '_serverRev': r.rev});
        }
      }
      return false;
    }

    if (r.status == 'refused' && r.reason == 'device_revoked') {
      await _wipeRevoked();
      return true;
    }

    // An audit note (the clean-up's `recording/deleted`) is a record, not an
    // edit: a server that does not know it, or refuses it, just never gets
    // it. Dropped without a conflict and without a fresh snapshot.
    if (op.kind == 'audit.put') {
      await outbox.remove(op.opId);
      return false;
    }

    // superseded or refused: the edit did not land. Show it, drop it from
    // the queue, undo the optimistic copy (a fresh snapshot restores it).
    await outbox.remove(op.opId);
    final p = op.payload;
    await store.putDoc(Collections.conflicts, op.opId, {
      'opId': op.opId,
      'kind': op.kind,
      'entity': op.entity,
      'entityId': op.entityId,
      'reason': r.status == 'superseded'
          ? 'superseded'
          : (r.reason ?? 'refused'),
      'mine': p is Map<String, dynamic> ? _withoutBytes(p) : p,
      'winner': r.winner?.toJson(),
      'editedAt': op.editedAt,
      'at': _iso(now()),
    });
    if (mine && coll != null) {
      if (op.kind == 'finance.append' || op.kind == 'finance.photo.put') {
        // A row the box refused does not exist: take it off the screens now.
        await store.deleteDoc(coll, op.entityId);
      } else {
        final next = Map<String, dynamic>.of(doc)
          ..remove('pending')
          ..['rev'] = (doc['_serverRev'] as String?) ?? 'stale';
        await store.putDoc(coll, op.entityId, next);
      }
    }
    if (!carriesBytes(op.kind)) {
      await store.setMeta(metaNeedsSnapshot, '1');
    }
    return false;
  }

  Map<String, dynamic> _withoutBytes(Map<String, dynamic> p) => {
    for (final e in p.entries)
      if (e.key != 'bytesBase64') e.key: e.value,
  };

  Future<void> _wipeRevoked() async {
    _dead = true;
    _retry?.cancel();
    await store.wipe();
    _emit(const SyncView(lastError: 'device_revoked', state: SyncState.idle));
    onRevoked?.call();
  }

  // ---- pull ----

  /// This base's cursor, or null (take a snapshot). A cursor saved before
  /// cursors were per base moves to the base in `via`; with no `via` it is
  /// dropped, because a number from the other database would skip changes.
  String? _cursorFor(Map<String, String> meta, String via) {
    final own = meta[_cursorKey(via)];
    if (own != null) return own;
    final anyPerBase = meta.keys.any((k) => k.startsWith('seq@'));
    if (!anyPerBase && meta[_metaVia] == via) return meta[_metaSeq];
    return null;
  }

  Future<void> _saveCursor(String via, int cursor) async {
    await store.setMeta(_cursorKey(via), '$cursor');
    await store.setMeta(_metaSeq, '$cursor');
  }

  /// True when local data changed.
  Future<bool> _pull(SyncLink link) async {
    final meta = await store.meta();
    final seqText = _cursorFor(meta, link.via);
    var needSnapshot = seqText == null || meta[metaNeedsSnapshot] == '1';
    var changed = false;
    if (!needSnapshot) {
      try {
        changed = await _pullChanges(link, int.tryParse(seqText) ?? 0);
      } on BoxError catch (e) {
        if (e.status == 410) {
          needSnapshot = true;
        } else {
          rethrow;
        }
      }
    }
    if (needSnapshot) {
      final snap = await link.client.getJson(
        '/api/sync/snapshot',
        token: link.token,
      );
      await _applySnapshot(snap, link.via);
      changed = true;
    }
    return changed;
  }

  Future<bool> _pullChanges(SyncLink link, int since) async {
    var cursor = since;
    var changed = false;
    for (var page = 0; page < 200; page++) {
      final out = await link.client.getJson(
        '/api/sync/changes?since=$cursor&limit=500',
        token: link.token,
      );
      final targets = await outbox.targets();
      final entries = (out['entries'] as List? ?? const [])
          .whereType<Map<String, dynamic>>()
          .map(FeedEntryDto.fromJson)
          .toList();
      if (await _applyPage(entries, targets)) changed = true;
      for (final e in entries) {
        if (e.seq > cursor) cursor = e.seq;
      }
      final next = (out['next'] as num?)?.toInt();
      if (next == null) {
        final head =
            (out['head'] as num?)?.toInt() ?? (out['seq'] as num?)?.toInt();
        if (head != null && head > cursor) cursor = head;
        await _saveCursor(link.via, cursor);
        return changed;
      }
      cursor = next;
      await _saveCursor(link.via, cursor);
    }
    return changed;
  }

  /// Applies one feed page, writing each collection once (a store file is
  /// rewritten whole, so one write per entry would be quadratic).
  Future<bool> _applyPage(
    List<FeedEntryDto> entries,
    Set<String> queued,
  ) async {
    // coll -> id -> new doc (null = delete); later entries win.
    final staged = <String, Map<String, Map<String, dynamic>?>>{};
    var changed = false;
    for (final e in entries) {
      final coll = _collectionOf(e.entity);
      if (coll == null) continue;
      if (e.entity == 'settings' && e.entityId == 'appLock') continue;
      final st = staged[coll];
      final Map<String, dynamic>? local =
          st != null && st.containsKey(e.entityId)
          ? st[e.entityId]
          : await store.getDoc(coll, e.entityId);
      // Never overwrite an edit of mine that is still waiting to be sent.
      if (local != null &&
          local['pending'] == true &&
          queued.contains('${e.entity}|${e.entityId}')) {
        continue;
      }
      final after = e.after;
      Map<String, dynamic>? doc;
      if (after == null ||
          (after is Map<String, dynamic> &&
              e.entity.startsWith('content:') &&
              after.containsKey('deletedAt') &&
              after.length <= 2)) {
        if (local == null) continue;
        doc = null;
      } else if (after is Map<String, dynamic>) {
        doc = <String, dynamic>{...cleanItem(after)};
        if (e.entity.startsWith('content:')) doc['id'] = e.entityId;
        if (e.entity.startsWith('finance:')) doc['id'] ??= e.entityId;
        if (e.entity == 'settings') doc['_feature'] = e.entityId;
        if (e.rev.isNotEmpty) doc['rev'] = e.rev;
      } else {
        continue;
      }
      (staged[coll] ??= {})[e.entityId] = doc;
      changed = true;
    }
    for (final c in staged.entries) {
      final puts = <String, Map<String, dynamic>>{};
      final dels = <String>{};
      for (final d in c.value.entries) {
        final v = d.value;
        if (v == null) {
          dels.add(d.key);
        } else {
          puts[d.key] = v;
        }
      }
      await store.applyDocs(c.key, puts: puts, deletes: dels);
    }
    return changed;
  }

  Future<void> _applySnapshot(Map<String, dynamic> snap, String via) async {
    final queued = await outbox.targets();

    Future<void> replace(
      String coll,
      String entity,
      Map<String, Map<String, dynamic>> fresh,
    ) async {
      // Keep my waiting edits on top of the server's copy.
      final prefix = '$entity|';
      for (final t in queued) {
        if (!t.startsWith(prefix)) continue;
        final id = t.substring(prefix.length);
        final d = await store.getDoc(coll, id);
        if (d != null && d['pending'] == true) fresh[id] = d;
      }
      await store.putAll(coll, fresh);
    }

    final content = snap['content'];
    if (content is Map<String, dynamic>) {
      for (final kind in content.keys) {
        final items = content[kind];
        if (items is! List) continue;
        final fresh = <String, Map<String, dynamic>>{};
        for (final item in items) {
          if (item is! Map<String, dynamic>) continue;
          final id = item['id'];
          if (id is! String) continue;
          if (item.containsKey('deletedAt') && item.length <= 2) continue;
          fresh[id] = {...cleanItem(item)};
        }
        await replace('content:$kind', 'content:$kind', fresh);
      }
    }
    final settings = snap['settings'];
    if (settings is Map<String, dynamic>) {
      final fresh = <String, Map<String, dynamic>>{
        for (final e in settings.entries)
          if (e.value is Map<String, dynamic> && e.key != 'appLock')
            e.key: {
              ...cleanItem(e.value as Map<String, dynamic>),
              '_feature': e.key,
            },
      };
      await replace(Collections.settings, 'settings', fresh);
    }
    for (final pair in [
      ('users', Collections.users, 'user'),
      ('devices', Collections.devices, 'device'),
    ]) {
      final list = snap[pair.$1];
      final fresh = <String, Map<String, dynamic>>{};
      if (list is List) {
        for (final item in list) {
          if (item is Map<String, dynamic> && item['id'] is String) {
            fresh[item['id'] as String] = {...cleanItem(item)};
          }
        }
      }
      await replace(pair.$2, pair.$3, fresh);
    }
    // The finance ledger: the five collections, each replaced whole. A reader
    // without finance:read gets no block, so its copies are emptied.
    final finance = snap['finance'];
    for (final f in [
      ('entries', Collections.financeEntries, 'finance:entry', 'id'),
      ('funds', Collections.financeFunds, 'finance:fund', 'id'),
      ('perihal', Collections.financePerihal, 'finance:perihal', 'id'),
      ('months', Collections.financeMonths, 'finance:month', 'ym'),
      ('photos', Collections.financePhotos, 'finance:photo', 'id'),
    ]) {
      final list = finance is Map<String, dynamic> ? finance[f.$1] : null;
      final fresh = <String, Map<String, dynamic>>{};
      if (list is List) {
        for (final item in list) {
          if (item is Map<String, dynamic> && item[f.$4] is String) {
            fresh[item[f.$4] as String] = {
              ...cleanItem(item),
              if (f.$4 != 'id') 'id': item[f.$4],
            };
          }
        }
      }
      await replace(f.$2, f.$3, fresh);
    }
    final info = snap['surauInfo'];
    if (info is Map<String, dynamic>) {
      await store.putAll(Collections.surauInfo, {'info': info});
    }
    await _saveCursor(via, (snap['seq'] as num?)?.toInt() ?? 0);
    if (snap['surauId'] is String) {
      await store.setMeta(_metaSurauId, snap['surauId'] as String);
    }
    await store.setMeta(metaNeedsSnapshot, null);
  }

  // ---- conflicts ----

  Future<List<Map<String, dynamic>>> conflicts() async {
    final list = await store.list(Collections.conflicts);
    list.sort((a, b) => (b['at'] as String).compareTo(a['at'] as String));
    return list;
  }

  Future<void> dismissConflict(String opId) async {
    await store.deleteDoc(Collections.conflicts, opId);
    _emit(
      _view.copyWith(
        conflicts: (await store.list(Collections.conflicts)).length,
      ),
    );
  }
}
