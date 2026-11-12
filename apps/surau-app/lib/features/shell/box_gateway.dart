// Every authed request goes through here.
//
// Offline-first (Plan 6 Task 8), when a [SyncEngine] and its [LocalStore] are
// given: reads of the known data paths come from the encrypted local copy
// (marked `stale` from the last sync), content/settings/user edits and image
// uploads are signed, applied locally and queued in the outbox (the answer is
// the optimistic one), and the operations in `live_only.dart` go straight to
// the network and throw [LiveOnly] when no connection answers.
//
// Without an engine (older tests, a device with no local store) the Plan 4
// rules hold: reads fall back to the cache when the box is away and say so
// (`stale`); writes are refused before any request leaves the device while
// the box is known to be away. A 401 clears the session so the guard sends
// the person to the unlock screen with every cache intact.

import 'dart:typed_data';

import '../../box/box_client.dart';
import '../../finance/finance_local.dart';
import '../../finance/finance_models.dart';
import '../../finance/ledger.dart';
import '../../store/local_store.dart';
import '../../sync/live_only.dart';
import '../../sync/sync_engine.dart';
import 'read_cache.dart';

export '../../sync/live_only.dart' show LiveOnly;

/// A write attempted while the box cannot be reached (Plan 4 behaviour, kept
/// for a gateway with no sync engine). The message equals
/// `offlineWriteRefused` in app_ms.arb (a test checks); the UI shows it
/// as is.
class OfflineWriteRefused implements Exception {
  const OfflineWriteRefused();

  static const String message =
      'MAXCOM tidak dapat dihubungi. Cuba lagi di surau.';

  @override
  String toString() => 'OfflineWriteRefused($message)';
}

/// Whether the box answered lately. [lastContact] is the time of the last
/// successful request in this run; [downSince] the first failure of the
/// current outage, null while reachable.
class BoxReach {
  const BoxReach({this.lastContact, this.downSince});

  static const BoxReach unknown = BoxReach();

  final DateTime? lastContact;
  final DateTime? downSince;

  bool get down => downSince != null;

  BoxReach up(DateTime at) => BoxReach(lastContact: at);

  BoxReach failed(DateTime at) =>
      BoxReach(lastContact: lastContact, downSince: downSince ?? at);
}

/// Who learns about reachability: the connectivity provider.
abstract class ReachSink {
  BoxReach get reach;
  void markUp(DateTime at);
  void markDown(DateTime at);
}

class BoxGateway {
  BoxGateway({
    required this.client,
    required this.token,
    required this.cache,
    required this.reach,
    required this.now,
    required this.onSessionExpired,
    this.store,
    this.engine,
  });

  final BoxClient client;
  final String token;
  final ReadCache cache;
  final ReachSink reach;
  final DateTime Function() now;

  /// Called once per 401; the caller clears the session.
  final void Function() onSessionExpired;

  /// The encrypted local copy and the engine that keeps it (Plan 6); both
  /// null keeps the Plan 4 behaviour.
  final LocalStore? store;
  final SyncEngine? engine;

  bool get _offlineFirst => store != null && engine != null;

  /// A local copy older than this, or a failed last sync, is shown as stale.
  static const Duration staleAfter = Duration(minutes: 15);

  /// `GET path`: the local copy for the known data paths (offline-first),
  /// else fresh when the box answers, else the cached body marked stale.
  /// Throws [BoxUnreachable] only when there is nothing cached, and
  /// [SessionExpired] (after [onSessionExpired]) on a 401.
  Future<Read<Map<String, dynamic>>> get(String path) async {
    if (_offlineFirst) {
      final local = await _localRead(path);
      if (local != null) return local;
    }
    try {
      final body = await client.getJson(path, token: token);
      final at = now();
      cache.put(path, body, at);
      reach.markUp(at);
      return Read(body, at: at, stale: false);
    } on SessionExpired {
      onSessionExpired();
      rethrow;
    } on BoxUnreachable {
      reach.markDown(now());
      final cached = cache.get(path);
      if (cached == null) rethrow;
      return Read(cached.body, at: cached.at, stale: true);
    }
  }

  /// `GET path` that is never cached or answered from the cache: an
  /// analysis of one picture. A 401 reaches [onSessionExpired].
  ///
  /// [quiet] is asked when the box does not answer: true keeps that failure
  /// from marking the whole app offline (a poll that overlaps the caller's
  /// own stop of a live; the exception still reaches the caller).
  Future<Map<String, dynamic>> getFresh(
    String path, {
    bool Function()? quiet,
  }) async {
    final cloud = await _cloudFor(path);
    if (cloud != null) {
      return _viaCloud(path, cloud, (c, t) => c.getJson(path, token: t));
    }
    try {
      final body = await client.getJson(path, token: token);
      reach.markUp(now());
      return body;
    } on SessionExpired {
      onSessionExpired();
      rethrow;
    } on BoxUnreachable {
      if (quiet?.call() != true) reach.markDown(now());
      if (_offlineFirst && isLiveOnly('GET', path)) throw LiveOnly(path);
      rethrow;
    }
  }

  /// The bytes at [path] (a picture). Offline-first: a picture kept on the
  /// device (queued, or fetched before) is served from the store, and one
  /// fetched now is kept (the oldest are evicted over 200 MB). A 401 reaches
  /// [onSessionExpired] and an unreachable box is reported and rethrown.
  Future<Uint8List> getBytes(String path) async {
    final assetId = _offlineFirst ? _assetIdOf(path) : null;
    // A finance photo (a counting sheet): kept when queued here or opened
    // before; live-only otherwise.
    final photoId = _offlineFirst
        ? _finPhoto.firstMatch(path.split('?').first)?.group(1)
        : null;
    final blob = assetId != null
        ? 'asset-$assetId'
        : (photoId != null ? SyncEngine.financePhotoBlob(photoId) : null);
    if (blob != null) {
      final kept = await store!.getBlob(blob);
      if (kept != null) return kept;
    }
    try {
      final out = await client.getBytes(path, token: token);
      reach.markUp(now());
      if (blob != null) await store!.putBlob(blob, out);
      return out;
    } on SessionExpired {
      onSessionExpired();
      rethrow;
    } on BoxUnreachable {
      reach.markDown(now());
      if (photoId != null) throw LiveOnly(path);
      rethrow;
    }
  }

  /// `POST /api/assets`. Offline-first: signed and queued, the answer carries
  /// the sha256 id the box will give the same bytes. Otherwise refused while
  /// the box is away; a 401 reaches [onSessionExpired].
  Future<AssetMeta> uploadAsset(Uint8List bytes, String mime) async {
    if (_offlineFirst) {
      final r = await engine!.enqueueAsset(bytes, mime);
      return AssetMeta(id: r.id, mime: r.mime, bytes: r.bytes);
    }
    return _write(() => client.uploadAsset(bytes, mime, token: token));
  }

  Future<Map<String, dynamic>> put(String path, Object body) async {
    if (_offlineFirst) {
      final queued = await _queuePut(path, body);
      if (queued != null) return queued;
    }
    return _send(path, (c, t) => c.putJson(path, body, token: t));
  }

  Future<Map<String, dynamic>> post(String path, Object body) async {
    if (_offlineFirst) {
      final queued = await _queuePost(path);
      if (queued != null) return queued;
    }
    return _send(path, (c, t) => c.postJson(path, body, token: t));
  }

  /// `POST path` with raw bytes and their own content type (for example a
  /// zip). Goes straight to the network like any live-only write; never
  /// queued.
  ///
  /// A finance photo (`POST /api/finance/photos`, [headers] `X-Entry-Id`) is
  /// the exception: offline-first it is signed and queued like an asset, and
  /// the answer carries the sha256 id the box will give the same bytes.
  Future<Map<String, dynamic>> postRaw(
    String path,
    Uint8List bytes,
    String contentType, {
    Map<String, String> headers = const {},
  }) async {
    if (_offlineFirst && path == '/api/finance/photos') {
      final entryId = headers['X-Entry-Id'];
      if (entryId != null && _safeId.hasMatch(entryId)) {
        final r = await engine!.enqueueFinancePhoto(entryId, bytes);
        return {'id': r.id, 'bytes': r.bytes};
      }
    }
    return _send(path, (c, t) => c.postRaw(path, bytes, contentType, token: t));
  }

  Future<void> delete(String path) async {
    if (_offlineFirst) {
      final m = _contentItem.firstMatch(path);
      if (m != null) {
        await engine!.enqueue(
          kind: 'content.delete',
          entity: 'content:${m.group(1)}',
          entityId: m.group(2)!,
        );
        return;
      }
    }
    return _send(path, (c, t) => c.delete(path, token: t));
  }

  /// A write that goes to the network, sent with a client and its token.
  Future<T> _send<T>(
    String path,
    Future<T> Function(BoxClient client, String token) send,
  ) async {
    final cloud = await _cloudFor(path);
    if (cloud != null) return _viaCloud(path, cloud, send);
    return _offlineFirst
        ? _writeLive(path, send)
        : _write(() => send(client, token));
  }

  /// The YouTube sign-in and catch-up routes (`/api/live/youtube/*`,
  /// `/api/youtube/*`) live on the cloud (plan Task 8).
  static final RegExp _youtubeRoute = RegExp(
    r'^/api/(live/)?youtube(?!/ingest$)(/|$)',
  );

  /// The cloud link for a YouTube route when cloudSync is on, a cloud URL
  /// is known and this device has a session there; null sends it to the box.
  Future<SyncLink?> _cloudFor(String path) async {
    if (!_offlineFirst || !_youtubeRoute.hasMatch(path.split('?').first)) {
      return null;
    }
    try {
      return await engine!.cloudLinkIfOn();
    } on Object {
      return null;
    }
  }

  /// One request on the cloud. The box is not asked in its place when the
  /// cloud does not answer: the person is told ([LiveOnly]).
  Future<T> _viaCloud<T>(
    String path,
    SyncLink link,
    Future<T> Function(BoxClient client, String token) send,
  ) async {
    try {
      return await send(link.client, link.token);
    } on SessionExpired {
      onSessionExpired();
      rethrow;
    } on BoxUnreachable {
      throw LiveOnly(path);
    }
  }

  /// Offline-first network write. The box first; when it does not answer,
  /// whichever base the sync engine's locator finds (the cloud away from
  /// the surau, Task 9: enrol a device from home, revoke one, sync now).
  /// With no base it throws [LiveOnly] (nothing is queued and nothing is
  /// lost silently).
  Future<T> _writeLive<T>(
    String path,
    Future<T> Function(BoxClient client, String token) send,
  ) async {
    try {
      final out = await send(client, token);
      reach.markUp(now());
      return out;
    } on SessionExpired {
      onSessionExpired();
      rethrow;
    } on BoxUnreachable {
      reach.markDown(now());
    }
    // Only the cloud is worth a second try: the box just failed to answer.
    final SyncLink link;
    try {
      link = await engine!.transport.connect();
    } on Object {
      throw LiveOnly(path);
    }
    if (link.via != 'cloud') throw LiveOnly(path);
    try {
      return await send(link.client, link.token);
    } on BoxUnreachable {
      throw LiveOnly(path);
    }
  }

  /// Plan 4: refused before any request while the box is known to be away; a
  /// request that then fails to reach the box is reported the same way.
  Future<T> _write<T>(Future<T> Function() send) async {
    if (reach.reach.down) throw const OfflineWriteRefused();
    try {
      final out = await send();
      reach.markUp(now());
      return out;
    } on SessionExpired {
      onSessionExpired();
      rethrow;
    } on BoxUnreachable {
      reach.markDown(now());
      throw const OfflineWriteRefused();
    }
  }

  // ---- offline-first: reads from the local copy ----

  static final RegExp _contentList = RegExp(r'^/api/content/([a-z0-9_]+)$');
  static final RegExp _contentItem = RegExp(
    r'^/api/content/([a-z0-9_]+)/([A-Za-z0-9._~-]+)$',
  );
  static final RegExp _settingsOne = RegExp(r'^/api/settings/([A-Za-z0-9_]+)$');
  static final RegExp _userRoles = RegExp(r'^/api/users/([^/]+)/roles$');
  static final RegExp _userDeactivate = RegExp(
    r'^/api/users/([^/]+)/deactivate$',
  );
  static final RegExp _assetPath = RegExp(r'^/assets/([0-9a-f]{64})$');
  static final RegExp _safeId = RegExp(r'^[A-Za-z0-9_-]{1,100}$');
  static final RegExp _finPhoto = RegExp(
    r'^/api/finance/photos/([0-9a-f]{64})$',
  );
  static final RegExp _finEntryOne = RegExp(
    r'^/api/finance/entries/([A-Za-z0-9_-]{1,100})$',
  );
  static final RegExp _finFundOne = RegExp(
    r'^/api/finance/funds/([A-Za-z0-9_-]{1,100})$',
  );
  static final RegExp _finPerihalOne = RegExp(
    r'^/api/finance/perihal/([A-Za-z0-9_-]{1,100})$',
  );
  static final RegExp _finMonthOne = RegExp(
    r'^/api/finance/months/(\d{4}-(?:0[1-9]|1[0-2]))$',
  );
  static final RegExp _finReport = RegExp(
    r'^/api/finance/report/(\d{4}-(?:0[1-9]|1[0-2]))$',
  );
  static final RegExp _finYm = RegExp(r'^\d{4}-(?:0[1-9]|1[0-2])$');
  static final RegExp _finIso = RegExp(r'^\d{4}-\d{2}-\d{2}T[\d:.]+Z$');

  static String? _assetIdOf(String path) =>
      _assetPath.firstMatch(path)?.group(1);

  /// Bookkeeping keys the engine adds to local documents; never served.
  static const Set<String> _internal = {
    'rev',
    '_serverRev',
    '_deleted',
    '_feature',
  };

  /// A document as the screens see it: without bookkeeping, `pending: true`
  /// kept while its edit still waits in the outbox.
  static Map<String, dynamic> _serve(Map<String, dynamic> doc) => {
    for (final e in doc.entries)
      if (!_internal.contains(e.key) &&
          !(e.key == 'pending' && e.value != true))
        e.key: e.value,
  };

  static Map<String, dynamic> _serveSetting(Map<String, dynamic> doc) => {
    for (final e in doc.entries)
      if (!_internal.contains(e.key) && e.key != 'pending') e.key: e.value,
  };

  Read<Map<String, dynamic>> _read(Map<String, dynamic> body) {
    final v = engine!.view;
    final last = v.lastSync;
    final stale =
        last == null ||
        v.lastError != null ||
        now().difference(last) > staleAfter;
    return Read(body, at: last ?? now(), stale: stale);
  }

  Future<Read<Map<String, dynamic>>?> _localRead(String path) async {
    final st = store!;
    final bare = path.split('?').first;
    final meta = await st.meta();
    // Nothing pulled yet: the local copy is not a copy of anything.
    if (meta['seq'] == null) return null;

    if (bare == '/api/settings') {
      final docs = await st.list(Collections.settings);
      if (docs.isEmpty) return null;
      return _read({
        for (final d in docs)
          if (d['_feature'] is String)
            d['_feature'] as String: _serveSetting(d),
      });
    }
    final list = _contentList.firstMatch(bare);
    if (list != null) {
      final docs = await st.list(Collections.content(list.group(1)!));
      return _read({
        'items': [
          for (final d in docs)
            if (d['_deleted'] != true) _serve(d),
        ],
      });
    }
    final one = _contentItem.firstMatch(bare);
    if (one != null) {
      final d = await st.getDoc(
        Collections.content(one.group(1)!),
        one.group(2)!,
      );
      if (d == null || d['_deleted'] == true) return null;
      return _read({'item': _serve(d)});
    }
    if (bare == '/api/users' || bare == '/api/devices') {
      final users = bare == '/api/users';
      final docs = await st.list(
        users ? Collections.users : Collections.devices,
      );
      // An AJK device holds neither: the box answers (or refuses) itself.
      if (docs.isEmpty) return null;
      return _read({
        users ? 'users' : 'devices': [for (final d in docs) _serve(d)],
      });
    }
    if (bare == '/api/surau/info') {
      final d = await st.getDoc(Collections.surauInfo, 'info');
      return d == null ? null : _read(d);
    }
    if (bare.startsWith('/api/finance/')) return _financeRead(path, bare, st);
    return null;
  }

  // ---- offline-first: the finance reads, from the local ledger ----

  Map<String, dynamic> _entryJson(FinanceEntry e) => {
    ...e.toJson(),
    if (e.pending) 'pending': true,
  };

  /// `GET /api/finance/*` answered from the local copy in the box's own
  /// shapes. Null (the box answers) when nothing finance was pulled, the
  /// path is not a known read, or a query is not valid (the box says why).
  Future<Read<Map<String, dynamic>>?> _financeRead(
    String path,
    String bare,
    LocalStore st,
  ) async {
    if ((await st.list(Collections.financeFunds)).isEmpty) return null;
    final fl = FinanceLocal(st);
    final q = Uri.tryParse(path)?.queryParameters ?? const <String, String>{};

    if (bare == '/api/finance/summary') {
      final today = klDate(now());
      final ym = today.substring(0, 7);
      final entries = await fl.allEntries();
      final funds = await fl.funds();
      final bal = balances(entries, funds);
      final adjusts = [
        for (final e in entries)
          if (e.kind == 'adjust') e,
      ];
      final since = q['since'];
      final started = (await st.getDoc(
        Collections.settings,
        'finance',
      ))?['startedOn'];
      return _read({
        'funds': [
          for (final f in funds) {...f.toJson(), 'balanceSen': bal[f.id] ?? 0},
        ],
        'month': {
          'ym': ym,
          'status': await fl.monthStatus(ym),
          'inSen': monthIn(entries, ym),
          'outSen': monthOut(entries, ym),
        },
        'counts': {
          'entries': entries.length,
          'corrections': adjusts.length,
          'correctionsSince': since != null && _finIso.hasMatch(since)
              ? adjusts.where((e) => e.receivedAt.compareTo(since) > 0).length
              : null,
        },
        'startedOn': started is String && started != '' ? started : null,
      });
    }
    if (bare == '/api/finance/entries') {
      final ym = q['ym'];
      final fund = q['fund'];
      final since = q['since'];
      final limit = q['limit'] == null ? 500 : int.tryParse(q['limit']!);
      if ((ym != null && !_finYm.hasMatch(ym)) ||
          (fund != null && !_safeId.hasMatch(fund)) ||
          (since != null && !_finIso.hasMatch(since)) ||
          limit == null ||
          limit < 1) {
        return null;
      }
      final rows = await fl.entries(
        ym: ym,
        fundId: fund,
        sinceEditedAt: since,
        limit: limit,
      );
      return _read({
        'entries': [for (final e in rows) _entryJson(e)],
      });
    }
    final one = _finEntryOne.firstMatch(bare);
    if (one != null) {
      final d = await fl.detail(one.group(1)!);
      if (d == null) return null;
      final eff = d.effective;
      return _read({
        'entry': _entryJson(d.entry),
        'corrections': [for (final c in d.corrections) _entryJson(c)],
        'effective': {
          ..._entryJson(d.entry),
          'effFundId': eff.effFundId,
          'effAmountSen': eff.effAmountSen,
          'voided': eff.voided,
          'corrections': [for (final c in eff.corrections) _entryJson(c)],
        },
      });
    }
    final all = q['all'] == '1';
    if (bare == '/api/finance/funds') {
      return _read({
        'funds': [
          for (final f in await fl.funds(includeArchived: all)) f.toJson(),
        ],
      });
    }
    if (bare == '/api/finance/perihal') {
      return _read({
        'perihal': [
          for (final p in await fl.perihal(includeArchived: all)) p.toJson(),
        ],
      });
    }
    if (bare == '/api/finance/months') {
      return _read({
        'months': [for (final m in await fl.months()) m.toJson()],
      });
    }
    final rep = _finReport.firstMatch(bare);
    if (rep != null) {
      final report = await fl.report(
        rep.group(1)!,
        now: now(),
        syncedUntil: engine!.view.lastSync,
      );
      return _read(report.toJson());
    }
    return null;
  }

  // ---- offline-first: writes into the outbox ----

  Future<Map<String, dynamic>?> _queuePut(String path, Object body) async {
    final eng = engine!;
    if (body is! Map<String, dynamic>) return null;
    final c = _contentItem.firstMatch(path);
    if (c != null) {
      final entity = 'content:${c.group(1)}';
      await eng.enqueue(
        kind: 'content.put',
        entity: entity,
        entityId: c.group(2)!,
        payload: body,
      );
      final d = await store!.getDoc(entity, c.group(2)!);
      return {'item': d == null ? body : _serve(d)};
    }
    final sm = _settingsOne.firstMatch(path);
    if (sm != null && !isLiveOnly('PUT', path)) {
      await eng.enqueue(
        kind: 'settings.put',
        entity: 'settings',
        entityId: sm.group(1)!,
        payload: body,
      );
      return (await _localRead('/api/settings'))?.value ?? {};
    }
    // Plan 7 finance. Only the keys the box takes are signed; the box fills
    // in the rest (number, user, times).
    final fe = _finEntryOne.firstMatch(path);
    if (fe != null) {
      final id = fe.group(1)!;
      await eng.enqueue(
        kind: 'finance.append',
        entity: 'finance:entry',
        entityId: id,
        payload: {
          for (final e in body.entries)
            if (financeEntryInputKeys.contains(e.key)) e.key: e.value,
        },
      );
      final d = await store!.getDoc(Collections.financeEntries, id);
      return {'entry': d == null ? body : _serve(d)};
    }
    for (final (re, entity, keys, answer) in [
      (
        _finFundOne,
        'finance:fund',
        const {
          'name',
          'public',
          'targetSen',
          'jumaat',
          'sortOrder',
          'archivedAt',
        },
        'fund',
      ),
      (
        _finPerihalOne,
        'finance:perihal',
        const {'direction', 'label', 'sortOrder', 'archivedAt'},
        'perihal',
      ),
    ]) {
      final m = re.firstMatch(path);
      if (m == null) continue;
      await eng.enqueue(
        kind: 'finance.lookup.put',
        entity: entity,
        entityId: m.group(1)!,
        payload: {
          for (final e in body.entries)
            if (keys.contains(e.key)) e.key: e.value,
        },
      );
      final d = await store!.getDoc(
        entity == 'finance:fund'
            ? Collections.financeFunds
            : Collections.financePerihal,
        m.group(1)!,
      );
      return {answer: d == null ? body : _serve(d)};
    }
    final fm = _finMonthOne.firstMatch(path);
    if (fm != null) {
      await eng.enqueue(
        kind: 'finance.month.put',
        entity: 'finance:month',
        entityId: fm.group(1)!,
        payload: {'status': body['status']},
      );
      final d = await store!.getDoc(Collections.financeMonths, fm.group(1)!);
      return {'month': d == null ? body : _serve(d)};
    }
    final ur = _userRoles.firstMatch(path);
    if (ur != null) {
      await eng.enqueue(
        kind: 'user.put',
        entity: 'user',
        entityId: ur.group(1)!,
        payload: {'roles': body['roles']},
      );
      final d = await store!.getDoc(Collections.users, ur.group(1)!);
      return d == null ? <String, dynamic>{} : _serve(d);
    }
    return null;
  }

  Future<Map<String, dynamic>?> _queuePost(String path) async {
    final dm = _userDeactivate.firstMatch(path);
    if (dm == null) return null;
    await engine!.enqueue(
      kind: 'user.put',
      entity: 'user',
      entityId: dm.group(1)!,
      payload: {'active': false},
    );
    return {'ok': true};
  }
}
