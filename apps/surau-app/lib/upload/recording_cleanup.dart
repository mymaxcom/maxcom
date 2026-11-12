// Recording clean-up after YouTube verification (Plan 6 Task 13, spec 12b C,
// operator rule 2026-11-06). To save space, a recording on this device is
// deleted once YouTube has been asked and has the whole of it, and then only
// after the kept days (setting `recordingCleanup.keepDays`, default 1).
//
// The rules, all fail-safe (any doubt keeps the file):
//  * Only a session the app itself registered at the end of a live, with the
//    names of the files the app recorded, can ever be deleted. Nothing else on
//    the device is listed, matched or touched. On Android those names are the
//    ones the live engine reported for that very live (never a scan by prefix
//    or date); no reported names, no footprint, no deletion.
//  * Files that may not be deleted (a foreign row) are tried for three passes,
//    then the session is left as `kept` and never touched again.
//  * A candidate is a live whose YouTube leg covered the whole recording (to
//    within a minute, video known), or a catch-up job done for every part.
//  * Verified: every video exists, is processed, is not private (unless the
//    surau publishes private) and the lengths add up to the recording within a
//    minute. YouTube is asked again right before the files go.
//  * Never while a live or recording is on, while any job of the session is
//    queued, uploading, paused or failed, or when the feature is off.
//  * No address, token or stream key is stored or written: names of our own
//    files, video ids, seconds and byte counts only.

import 'dart:async';

import '../store/local_store.dart';
import 'upload_queue.dart';

/// A recording may be this many seconds longer than the video and still count.
const int cleanupToleranceSeconds = 60;

/// An unverified (or due) session is looked at on YouTube at most this often.
const Duration cleanupCheckEvery = Duration(hours: 1);

/// `recordingCleanup` and `liveYoutube.privacy` from the local settings.
class CleanupSettings {
  const CleanupSettings({
    this.enabled = true,
    this.keepDays = 1,
    this.allowPrivate = false,
  });

  /// [clean] is the `recordingCleanup` doc, [live] the `liveYoutube` doc. A
  /// missing doc means the registry's defaults (on, 1 day, unlisted).
  factory CleanupSettings.fromDocs(
    Map<String, dynamic>? clean,
    Map<String, dynamic>? live,
  ) {
    final days = clean?['keepDays'];
    return CleanupSettings(
      enabled: clean == null ? true : clean['enabled'] == true,
      keepDays: days is num && const [0, 1, 3, 7, 30].contains(days.toInt())
          ? days.toInt()
          : 1,
      allowPrivate: live?['privacy'] == 'private',
    );
  }

  final bool enabled;
  final int keepDays;

  /// The surau publishes its videos private, so private is not a reason to wait.
  final bool allowPrivate;
}

/// What YouTube said about one video (`POST /api/youtube/verify`).
class VideoCheck {
  const VideoCheck({
    required this.videoId,
    required this.exists,
    required this.processed,
    this.privacy,
    this.durationSeconds,
  });

  factory VideoCheck.fromJson(Map<String, dynamic> j) => VideoCheck(
    videoId: '${j['videoId']}',
    exists: j['exists'] == true,
    processed: j['processed'] == true,
    privacy: j['privacy'] is String ? j['privacy'] as String : null,
    durationSeconds: j['durationSeconds'] is num
        ? (j['durationSeconds'] as num).toInt()
        : null,
  );

  final String videoId;
  final bool exists;
  final bool processed;
  final String? privacy;
  final int? durationSeconds;
}

/// Most videos asked about in one call to `/api/youtube/verify`.
const int verifyBatchSize = 20;

/// Passes in which files that may not be deleted are tried before the session
/// is left as kept.
const int cleanupSkipPasses = 3;

/// Asks YouTube (through the cloud, or the box when unlinked) about up to 20
/// videos in one call. Throws when the answer cannot be had. The clean-up
/// itself splits longer lists into batches of [verifyBatchSize].
typedef VerifyVideos = Future<List<VideoCheck>> Function(List<String> videoIds);

/// The files the app recorded for one session: their names (never their
/// addresses) and sizes.
class RecordingFootprint {
  const RecordingFootprint({
    required this.names,
    required this.bytes,
    this.sizes = const [],
  });

  final List<String> names;
  final int bytes;

  /// Size of each name, same order; may be empty when not known.
  final List<int> sizes;
}

class RemoveResult {
  const RemoveResult({
    required this.deleted,
    required this.skipped,
    required this.bytes,
  });

  final int deleted;

  /// Files that exist but could not or may not be deleted.
  final int skipped;
  final int bytes;
}

/// The platform's way to find and delete the app's own recording files.
/// Android: `Movies/MAXCOM/MAXCOM-*.mp4` created by this app, and the app's
/// pending copies. Web: the IndexedDB segments of that one session.
abstract class RecordingRemover {
  /// The files of [sessionId] on the device now; null when there are none.
  Future<RecordingFootprint?> footprint(String sessionId, String? kuliahId);

  /// Deletes exactly [fp] of [sessionId].
  Future<RemoveResult> remove(String sessionId, RecordingFootprint fp);
}

/// Writes the audit note `recording/deleted { sessionId, videoIds, bytes }`.
typedef WriteCleanupAudit =
    Future<void> Function(String sessionId, List<String> videoIds, int bytes);

enum CleanupPhase { waiting, scheduled, deleted, kept }

const Object _keep = Object();

class CleanupRecord {
  const CleanupRecord({
    required this.sessionId,
    required this.kuliahId,
    required this.durationSec,
    required this.recordedAt,
    required this.names,
    required this.bytes,
    this.youtubeSeconds,
    this.liveVideoId,
    this.verifiedAt,
    this.videoIds = const [],
    this.lastCheckAt,
    this.deletedAt,
    this.deletedBytes = 0,
    this.auditedAt,
    this.skipPasses = 0,
    this.keptAt,
  });

  factory CleanupRecord.fromJson(Map<String, dynamic> j) => CleanupRecord(
    sessionId: j['sessionId'] as String,
    kuliahId: j['kuliahId'] as String?,
    durationSec: (j['durationSec'] as num).toInt(),
    recordedAt: DateTime.parse(j['recordedAt'] as String),
    names: [for (final n in (j['names'] as List? ?? const [])) '$n'],
    bytes: (j['bytes'] as num? ?? 0).toInt(),
    youtubeSeconds: (j['youtubeSeconds'] as num?)?.toInt(),
    liveVideoId: j['liveVideoId'] as String?,
    verifiedAt: _time(j['verifiedAt']),
    videoIds: [for (final n in (j['videoIds'] as List? ?? const [])) '$n'],
    lastCheckAt: _time(j['lastCheckAt']),
    deletedAt: _time(j['deletedAt']),
    deletedBytes: (j['deletedBytes'] as num? ?? 0).toInt(),
    auditedAt: _time(j['auditedAt']),
    skipPasses: (j['skipPasses'] as num? ?? 0).toInt(),
    keptAt: _time(j['keptAt']),
  );

  static DateTime? _time(Object? v) =>
      v is String ? DateTime.tryParse(v) : null;

  final String sessionId;
  final String? kuliahId;
  final int durationSec;
  final DateTime recordedAt;

  /// Names of the files the app recorded for this session.
  final List<String> names;
  final int bytes;

  /// Seconds the live YouTube leg received, null when it was not used.
  final int? youtubeSeconds;
  final String? liveVideoId;
  final DateTime? verifiedAt;
  final List<String> videoIds;
  final DateTime? lastCheckAt;
  final DateTime? deletedAt;
  final int deletedBytes;
  final DateTime? auditedAt;

  /// Passes in which some of the files could not or may not be deleted.
  final int skipPasses;

  /// Set after [cleanupSkipPasses] such passes: the files stay for good.
  final DateTime? keptAt;

  CleanupPhase get phase => deletedAt != null
      ? CleanupPhase.deleted
      : keptAt != null
      ? CleanupPhase.kept
      : verifiedAt != null
      ? CleanupPhase.scheduled
      : CleanupPhase.waiting;

  /// When the files go, given the kept days; null until verified.
  DateTime? deleteAt(int keepDays) => verifiedAt?.add(Duration(days: keepDays));

  /// The live leg alone covered the whole recording.
  bool get liveCovered {
    final y = youtubeSeconds;
    return liveVideoId != null &&
        y != null &&
        y >= durationSec - cleanupToleranceSeconds;
  }

  CleanupRecord copyWith({
    Object? verifiedAt = _keep,
    List<String>? videoIds,
    Object? lastCheckAt = _keep,
    Object? deletedAt = _keep,
    int? deletedBytes,
    Object? auditedAt = _keep,
    int? skipPasses,
    Object? keptAt = _keep,
  }) => CleanupRecord(
    sessionId: sessionId,
    kuliahId: kuliahId,
    durationSec: durationSec,
    recordedAt: recordedAt,
    names: names,
    bytes: bytes,
    youtubeSeconds: youtubeSeconds,
    liveVideoId: liveVideoId,
    verifiedAt: identical(verifiedAt, _keep)
        ? this.verifiedAt
        : verifiedAt as DateTime?,
    videoIds: videoIds ?? this.videoIds,
    lastCheckAt: identical(lastCheckAt, _keep)
        ? this.lastCheckAt
        : lastCheckAt as DateTime?,
    deletedAt: identical(deletedAt, _keep)
        ? this.deletedAt
        : deletedAt as DateTime?,
    deletedBytes: deletedBytes ?? this.deletedBytes,
    auditedAt: identical(auditedAt, _keep)
        ? this.auditedAt
        : auditedAt as DateTime?,
    skipPasses: skipPasses ?? this.skipPasses,
    keptAt: identical(keptAt, _keep) ? this.keptAt : keptAt as DateTime?,
  );

  Map<String, dynamic> toJson() => {
    'sessionId': sessionId,
    'kuliahId': kuliahId,
    'durationSec': durationSec,
    'recordedAt': recordedAt.toUtc().toIso8601String(),
    'names': names,
    'bytes': bytes,
    'youtubeSeconds': youtubeSeconds,
    'liveVideoId': liveVideoId,
    'verifiedAt': verifiedAt?.toUtc().toIso8601String(),
    'videoIds': videoIds,
    'lastCheckAt': lastCheckAt?.toUtc().toIso8601String(),
    'deletedAt': deletedAt?.toUtc().toIso8601String(),
    'deletedBytes': deletedBytes,
    'auditedAt': auditedAt?.toUtc().toIso8601String(),
    'skipPasses': skipPasses,
    'keptAt': keptAt?.toUtc().toIso8601String(),
  };

  @override
  String toString() => 'CleanupRecord($sessionId, ${phase.name})';
}

class RecordingCleanup {
  RecordingCleanup({
    required this.store,
    required this.now,
    required this.verify,
    required this.remover,
    required this.settings,
    required this.jobs,
    required this.recordingNow,
    this.audit,
  });

  final LocalStore store;
  final DateTime Function() now;
  final VerifyVideos verify;
  final RecordingRemover remover;
  final Future<CleanupSettings> Function() settings;

  /// Every upload job (the queue's), to learn the catch-up video ids and to
  /// see a job still open.
  final Future<List<UploadJob>> Function() jobs;

  /// A live or a recording is going on right now.
  final Future<bool> Function() recordingNow;
  final WriteCleanupAudit? audit;

  final StreamController<void> _changes = StreamController.broadcast();

  /// One pass at a time for the whole app: the provider can be rebuilt (a new
  /// instance over the same store) while a pass of the old one is still
  /// running, and two passes must never delete the same files.
  static bool _running = false;

  Stream<void> get changes => _changes.stream;

  /// Every watched session, oldest recording first.
  Future<Map<String, CleanupRecord>> records() async {
    final out = <CleanupRecord>[];
    for (final d in await store.list(Collections.cleanup)) {
      try {
        out.add(CleanupRecord.fromJson(d));
      } on Object {
        // an unreadable doc is skipped, never fatal and never deleted from
      }
    }
    out.sort((a, b) => a.recordedAt.compareTo(b.recordedAt));
    return {for (final r in out) r.sessionId: r};
  }

  /// At the end of a live: remember which files the app recorded for
  /// [sessionId] and how long the recording is. Does nothing when there are
  /// no files, the recording has no length, or the session is already known.
  Future<void> register({
    required String sessionId,
    required String? kuliahId,
    required int durationSec,
    required int? youtubeSeconds,
    required String? liveVideoId,
  }) async {
    if (durationSec <= 0) return;
    final known = await records();
    if (known.containsKey(sessionId)) return;
    final fp = await remover.footprint(sessionId, kuliahId);
    if (fp == null || fp.names.isEmpty) return;
    final claimed = {for (final r in known.values) ...r.names};
    final names = <String>[];
    var bytes = 0;
    for (final (i, n) in fp.names.indexed) {
      if (claimed.contains(n)) continue;
      names.add(n);
      if (fp.sizes.length == fp.names.length) bytes += fp.sizes[i];
    }
    if (names.isEmpty) return;
    if (fp.sizes.length != fp.names.length) {
      bytes = (fp.bytes * names.length / fp.names.length).round();
    }
    await _put(
      CleanupRecord(
        sessionId: sessionId,
        kuliahId: kuliahId,
        durationSec: durationSec,
        recordedAt: now().toUtc(),
        names: names,
        bytes: bytes,
        youtubeSeconds: youtubeSeconds,
        liveVideoId: liveVideoId,
      ),
    );
  }

  /// One pass: verify what can be verified, delete what is due. Safe to call
  /// often; a second call while one runs does nothing.
  Future<void> run() async {
    if (_running) return;
    _running = true;
    try {
      final s = await settings();
      final all = (await records()).values.toList();
      for (final r in all) {
        if (r.deletedAt != null) await _retryAudit(r);
      }
      if (!s.enabled) return;
      if (await recordingNow()) return;
      final open = await jobs();
      for (final r in all) {
        if (r.deletedAt != null || r.keptAt != null) continue;
        try {
          await _step(r, s, open);
        } on Object {
          // one session failing never stops the others
        }
      }
    } finally {
      _running = false;
    }
  }

  List<String>? _candidateIds(CleanupRecord r, List<UploadJob> own) {
    final done = own.where((j) => j.isDone).toList();
    if (done.isNotEmpty) {
      final ids = [for (final p in done.last.parts) p.videoId];
      if (ids.isNotEmpty && ids.every((i) => i != null && i.isNotEmpty)) {
        return ids.cast<String>();
      }
      return null;
    }
    if (r.liveCovered) return [r.liveVideoId!];
    return null;
  }

  bool _throttled(CleanupRecord r) {
    final last = r.lastCheckAt;
    return last != null && now().difference(last) < cleanupCheckEvery;
  }

  Future<void> _step(
    CleanupRecord r,
    CleanupSettings s,
    List<UploadJob> open,
  ) async {
    final own = [
      for (final j in open)
        if (j.sessionId == r.sessionId) j,
    ];
    // queued, uploading, paused or failed: not ours to judge, not ours to delete
    if (own.any((j) => !j.isDone)) return;
    final fresh = _candidateIds(r, own);
    final ids = fresh ?? (r.verifiedAt != null ? r.videoIds : null);
    if (ids == null || ids.isEmpty) return;

    var justVerified = false;
    if (r.verifiedAt == null) {
      if (_throttled(r)) return;
      final c = await _check(r, ids, s);
      r = c.record;
      if (c.verdict != true) return;
      r = r.copyWith(verifiedAt: now().toUtc(), videoIds: ids);
      await _put(r);
      justVerified = true;
    } else {
      if (now().isBefore(r.deleteAt(s.keepDays)!)) return;
      if (_throttled(r)) return;
      final c = await _check(r, ids, s);
      r = c.record;
      if (c.verdict == null) return;
      if (c.verdict == false) {
        // gone, still processing or made private since: wait for a new verification
        await _put(r.copyWith(verifiedAt: null));
        return;
      }
      // the video ids YouTube was just asked about are the ones noted
      r = r.copyWith(videoIds: ids);
    }
    if (justVerified && now().isBefore(r.deleteAt(s.keepDays)!)) return;
    // the live may have started while YouTube was being asked
    if (await recordingNow()) return;
    await _delete(r);
  }

  /// Asks YouTube. The verdict is true (verified), false (not verified) or
  /// null (could not be asked). The check time is stored either way.
  Future<({bool? verdict, CleanupRecord record})> _check(
    CleanupRecord r,
    List<String> ids,
    CleanupSettings s,
  ) async {
    final stamped = r.copyWith(lastCheckAt: now().toUtc());
    await _put(stamped);
    final got = <VideoCheck>[];
    try {
      for (var i = 0; i < ids.length; i += verifyBatchSize) {
        final end = i + verifyBatchSize > ids.length
            ? ids.length
            : i + verifyBatchSize;
        got.addAll(await verify(ids.sublist(i, end)));
      }
    } on Object {
      return (verdict: null, record: stamped);
    }
    return (verdict: _verified(r, ids, got, s), record: stamped);
  }

  bool _verified(
    CleanupRecord r,
    List<String> ids,
    List<VideoCheck> got,
    CleanupSettings s,
  ) {
    if (r.durationSec <= 0) return false;
    var seconds = 0;
    for (final id in ids) {
      final c = got.where((v) => v.videoId == id).firstOrNull;
      if (c == null || !c.exists || !c.processed) return false;
      if (c.privacy == null) return false;
      if (c.privacy == 'private' && !s.allowPrivate) return false;
      final d = c.durationSeconds;
      if (d == null) return false;
      seconds += d;
    }
    return seconds >= r.durationSec - cleanupToleranceSeconds;
  }

  Future<void> _delete(CleanupRecord r) async {
    final RemoveResult res;
    try {
      res = await remover.remove(
        r.sessionId,
        RecordingFootprint(names: r.names, bytes: r.bytes),
      );
    } on Object {
      return;
    }
    // something left behind that may not be deleted: not done, tried again
    // for a few passes, then left as kept (never deleted, never audited)
    if (res.skipped > 0) {
      final passes = r.skipPasses + 1;
      await _put(
        r.copyWith(
          skipPasses: passes,
          keptAt: passes >= cleanupSkipPasses ? now().toUtc() : null,
        ),
      );
      return;
    }
    final done = r.copyWith(deletedAt: now().toUtc(), deletedBytes: res.bytes);
    await _put(done);
    await _retryAudit(done);
  }

  Future<void> _retryAudit(CleanupRecord r) async {
    final write = audit;
    if (write == null || r.auditedAt != null) return;
    if (r.deletedBytes <= 0) {
      // nothing was left to delete: nothing to note
      await _put(r.copyWith(auditedAt: now().toUtc()));
      return;
    }
    try {
      await write(r.sessionId, r.videoIds, r.deletedBytes);
    } on Object {
      return; // tried again on the next pass
    }
    await _put(r.copyWith(auditedAt: now().toUtc()));
  }

  Future<void> _put(CleanupRecord r) async {
    await store.putDoc(Collections.cleanup, r.sessionId, r.toJson());
    if (!_changes.isClosed) _changes.add(null);
  }

  Future<void> dispose() => _changes.close();
}
