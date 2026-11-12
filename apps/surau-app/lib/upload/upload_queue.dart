// The catch-up upload queue (Plan 6 Task 10, spec 12b B). A job is one
// recorded session going to YouTube as a video (Android joins the segments
// first; the browser uploads one video per segment). Jobs live in the local
// store's `uploads` collection so they survive a restart; a runner (the
// browser loop, or the Android WorkManager worker) does the sending and
// reports back as [UploadEvent]s.
//
// The queue never deletes, moves or renames a recording: removing a job
// removes the job only (spec 12b B). The upload URI is a bearer secret kept
// in the job only until the part is done, never in a string this file makes.

import 'dart:async';
import 'dart:typed_data';

import '../features/live/recordings_store.dart';
import '../store/local_store.dart';
import '../sync/outbox.dart' show UlidGenerator;
import 'upload_api.dart';

export 'upload_api.dart';

enum UploadPartState {
  queued,
  joining,
  beginning,
  uploading,
  done,
  failed,
  quota,
  paused,
}

/// What the queue decides for a job right now.
enum UploadPolicy {
  run('run'),
  waitWifi('wait_wifi'),
  waitNetwork('wait_network'),
  waitQuota('wait_quota');

  const UploadPolicy(this.wire);
  final String wire;
}

/// The kind of network the phone is on. The browser cannot tell Wi-Fi from
/// mobile data, so it reports [unknown] and the upload runs.
enum UploadNetwork { wifi, cellular, none, unknown }

const Object _keep = Object();

class UploadPart {
  const UploadPart({
    required this.index,
    required this.source,
    required this.bytes,
    this.uploadId,
    this.uploadUri,
    this.offset = 0,
    this.videoId,
    this.state = UploadPartState.queued,
  });

  factory UploadPart.fromJson(Map<String, dynamic> j) => UploadPart(
    index: (j['index'] as num).toInt(),
    source: j['source'] as String,
    bytes: (j['bytes'] as num).toInt(),
    uploadId: j['uploadId'] as String?,
    uploadUri: j['uploadUri'] as String?,
    offset: (j['offset'] as num? ?? 0).toInt(),
    videoId: j['videoId'] as String?,
    state: UploadPartState.values.firstWhere(
      (s) => s.name == j['state'],
      orElse: () => UploadPartState.queued,
    ),
  );

  /// 1-based position in the session (`Bahagian <index> daripada <count>`).
  final int index;

  /// `web:<segmentId>` or `android:<contentUri>` (`android:joined` once the
  /// segments were joined into one file).
  final String source;
  final int bytes;
  final String? uploadId;

  /// The YouTube session URI: a secret, held until the part is done.
  final String? uploadUri;
  final int offset;
  final String? videoId;
  final UploadPartState state;

  bool get isDone => state == UploadPartState.done;

  bool get isActive =>
      state == UploadPartState.queued ||
      state == UploadPartState.joining ||
      state == UploadPartState.beginning ||
      state == UploadPartState.uploading;

  UploadPart copyWith({
    Object? uploadId = _keep,
    Object? uploadUri = _keep,
    int? offset,
    Object? videoId = _keep,
    UploadPartState? state,
    String? source,
    int? bytes,
  }) => UploadPart(
    index: index,
    source: source ?? this.source,
    bytes: bytes ?? this.bytes,
    uploadId: identical(uploadId, _keep) ? this.uploadId : uploadId as String?,
    uploadUri: identical(uploadUri, _keep)
        ? this.uploadUri
        : uploadUri as String?,
    offset: offset ?? this.offset,
    videoId: identical(videoId, _keep) ? this.videoId : videoId as String?,
    state: state ?? this.state,
  );

  Map<String, dynamic> toJson() => {
    'index': index,
    'source': source,
    'bytes': bytes,
    'uploadId': uploadId,
    'uploadUri': uploadUri,
    'offset': offset,
    'videoId': videoId,
    'state': state.name,
  };

  // No URI, no source path: both can be secrets or personal.
  @override
  String toString() => 'UploadPart($index, ${state.name}, $offset/$bytes)';
}

class UploadJob {
  const UploadJob({
    required this.id,
    required this.sessionId,
    required this.kuliahId,
    required this.parts,
    required this.joined,
    required this.allowMobile,
    required this.createdAt,
    this.replaceLiveVideoId,
    this.joinSegments = false,
    this.lastError,
    this.quotaResetsAt,
    this.segments = const [],
  });

  factory UploadJob.fromJson(Map<String, dynamic> j) => UploadJob(
    id: j['id'] as String,
    sessionId: j['sessionId'] as String,
    kuliahId: j['kuliahId'] as String?,
    parts: [
      for (final p in (j['parts'] as List? ?? const []))
        UploadPart.fromJson(p as Map<String, dynamic>),
    ],
    joined: j['joined'] == true,
    allowMobile: j['allowMobile'] == true,
    createdAt: DateTime.parse(j['createdAt'] as String),
    replaceLiveVideoId: j['replaceLiveVideoId'] as String?,
    joinSegments: j['joinSegments'] == true,
    lastError: j['lastError'] as String?,
    quotaResetsAt: j['quotaResetsAt'] is String
        ? DateTime.tryParse(j['quotaResetsAt'] as String)
        : null,
    segments: [
      for (final e in (j['segments'] as List? ?? const []))
        if (e is Map && e['source'] is String)
          UploadSegment(e['source'] as String, (e['bytes'] as num? ?? 0).toInt()),
    ],
  );

  /// ULID.
  final String id;
  final String sessionId;
  final String? kuliahId;
  final List<UploadPart> parts;

  /// The segments were joined into one file (Android only).
  final bool joined;
  final bool allowMobile;
  final DateTime createdAt;

  /// The gappy live video to set private after the upload succeeds.
  final String? replaceLiveVideoId;

  /// Additive: join the segments before upload (Android, from the setting).
  final bool joinSegments;

  /// A reason code (`youtube_reauthorise`, `join_failed`, `needs_unlock`...),
  /// never wording.
  final String? lastError;

  /// Additive: when the YouTube quota resets (set with a `quota` part).
  final DateTime? quotaResetsAt;

  /// Additive: the original segment files once the job collapsed into one
  /// `android:joined` part. The worker re-joins from them when the joined
  /// cache file was purged. Empty before the join (then the parts are the
  /// segments).
  final List<UploadSegment> segments;

  bool get isDone => parts.isNotEmpty && parts.every((p) => p.isDone);

  bool get isPaused {
    final open = parts.where((p) => !p.isDone).toList();
    return open.isNotEmpty && open.every((p) => p.state == UploadPartState.paused);
  }

  bool get hasActive => parts.any((p) => p.isActive);

  bool get hasQuota => parts.any((p) => p.state == UploadPartState.quota);

  int get totalBytes => parts.fold(0, (a, p) => a + p.bytes);

  int get sentBytes => parts.fold(0, (a, p) => a + (p.isDone ? p.bytes : p.offset));

  UploadJob copyWith({
    List<UploadPart>? parts,
    bool? joined,
    bool? allowMobile,
    Object? lastError = _keep,
    Object? quotaResetsAt = _keep,
    List<UploadSegment>? segments,
  }) => UploadJob(
    id: id,
    sessionId: sessionId,
    kuliahId: kuliahId,
    parts: parts ?? this.parts,
    joined: joined ?? this.joined,
    allowMobile: allowMobile ?? this.allowMobile,
    createdAt: createdAt,
    replaceLiveVideoId: replaceLiveVideoId,
    joinSegments: joinSegments,
    lastError: identical(lastError, _keep)
        ? this.lastError
        : lastError as String?,
    quotaResetsAt: identical(quotaResetsAt, _keep)
        ? this.quotaResetsAt
        : quotaResetsAt as DateTime?,
    segments: segments ?? this.segments,
  );

  Map<String, dynamic> toJson() => {
    'id': id,
    'sessionId': sessionId,
    'kuliahId': kuliahId,
    'parts': [for (final p in parts) p.toJson()],
    'joined': joined,
    'allowMobile': allowMobile,
    'createdAt': createdAt.toUtc().toIso8601String(),
    'replaceLiveVideoId': replaceLiveVideoId,
    'joinSegments': joinSegments,
    'lastError': lastError,
    'quotaResetsAt': quotaResetsAt?.toUtc().toIso8601String(),
    if (segments.isNotEmpty)
      'segments': [
        for (final s in segments) {'source': s.source, 'bytes': s.bytes},
      ],
  };

  @override
  String toString() => 'UploadJob($id, ${parts.length} parts)';
}

/// One recorded file a session can be uploaded from.
class UploadSegment {
  const UploadSegment(this.source, this.bytes);

  final String source;
  final int bytes;
}

/// What a runner tells the queue. Android events carry the worker's progress;
/// the browser runner emits the same from its loop.
class UploadEvent {
  const UploadEvent({
    required this.jobId,
    required this.partIndex,
    required this.state,
    this.offset,
    this.total,
    this.uploadId,
    this.uploadUri,
    this.videoId,
    this.error,
    this.resetsAt,
    this.joined,
    this.clearSession = false,
  });

  final String jobId;
  final int partIndex;
  final UploadPartState state;
  final int? offset;
  final int? total;
  final String? uploadId;
  final String? uploadUri;
  final String? videoId;
  final String? error;
  final DateTime? resetsAt;

  /// Set once the segments were joined: the job becomes one part.
  final bool? joined;

  /// The session URI was lost (404/410): forget it and the offset.
  final bool clearSession;

  @override
  String toString() => 'UploadEvent($jobId, $partIndex, ${state.name})';
}

/// How a runner reaches the cloud: the Dart API for the browser runner, and
/// the raw base, session token and CA for the Android worker (which makes
/// the same calls itself).
class UploadAuth {
  const UploadAuth({
    required this.api,
    required this.base,
    required this.token,
    this.caDer,
  });

  final UploadApi api;
  final Uri base;
  final String token;
  final Uint8List? caDer;

  @override
  String toString() => 'UploadAuth($base)';
}

abstract class UploadRunner {
  /// The runner keeps going while the app is closed (Android WorkManager):
  /// a restart must not reset the parts it was sending.
  bool get survivesRestart;

  Stream<UploadEvent> get events;

  Future<UploadNetwork> network();

  /// The files of one recorded session, in order.
  Future<List<UploadSegment>> segmentsFor(String sessionId, String? kuliahId);

  /// Starts (or continues) sending [job]. The browser runner returns when
  /// the run ends; the Android runner returns once the work is queued.
  Future<void> start(UploadJob job, UploadAuth auth);

  /// Stops sending [jobId] (the position is kept in the events already sent).
  Future<void> cancel(String jobId);

  /// The job is finished or removed: drop what the runner kept for it
  /// (Android: the worker's saved session and the joined cache file). Never
  /// touches a recording.
  Future<void> forget(String jobId);

  Future<void> dispose();
}

/// The browser's files of one session, from [RecordingsStore.forSession].
Future<List<UploadSegment>> segmentsFromRecordings(
  RecordingsStore store,
  String sessionId,
) async {
  final l = await store.forSession(sessionId);
  return [for (final s in l) UploadSegment('web:${s.id}', s.bytes)];
}

/// There was nothing recorded for the session.
class NoRecordings implements Exception {
  const NoRecordings();

  @override
  String toString() => 'NoRecordings';
}

class UploadQueue {
  UploadQueue({
    required this.store,
    required this.runner,
    required this.now,
    this.auth,
    this.wifiOnly,
    this.joinSegments,
    UlidGenerator? ids,
  }) : _ids = ids ?? UlidGenerator(now: now);

  final LocalStore store;
  final UploadRunner runner;
  final DateTime Function() now;

  /// Cloud access for a run; null result means no cloud is linked.
  final Future<UploadAuth?> Function()? auth;

  /// `youtubeCatchUp.wifiOnly`; defaults to true.
  final bool Function()? wifiOnly;

  /// `youtubeCatchUp.joinSegments`; defaults to true.
  final bool Function()? joinSegments;

  final UlidGenerator _ids;
  final Map<String, UploadJob> _jobs = {};
  final Set<String> _running = {};
  final StreamController<List<UploadJob>> _changes =
      StreamController.broadcast();
  StreamSubscription<UploadEvent>? _sub;
  Future<void> _writes = Future.value();
  bool _kicking = false;
  Future<void>? _loading;

  /// The current list whenever it changes.
  Stream<List<UploadJob>> get changes => _changes.stream;

  /// Reads the jobs from the store; later calls share the first one.
  Future<void> load() => _loading ??= _load();

  Future<void> _load() async {
    _jobs.clear();
    for (final doc in await store.list(Collections.uploads)) {
      try {
        var job = UploadJob.fromJson(doc);
        if (!runner.survivesRestart) {
          // Nothing is sending any more; keep each part's session and offset.
          job = job.copyWith(
            parts: [
              for (final p in job.parts)
                p.isActive && p.state != UploadPartState.queued
                    ? p.copyWith(state: UploadPartState.queued)
                    : p,
            ],
          );
        }
        _jobs[job.id] = job;
      } on Object {
        // an unreadable job doc is skipped, never fatal
      }
    }
    _sub = runner.events.listen(_onEvent);
    _emit();
  }

  Future<List<UploadJob>> jobs() async {
    await load();
    return _sorted();
  }

  List<UploadJob> _sorted() => _jobs.values.toList()
    ..sort((a, b) => a.createdAt.compareTo(b.createdAt));

  Future<UploadJob> enqueueFromSession(
    String sessionId,
    String? kuliahId, {
    String? replaceLive,
  }) async {
    await load();
    final segs = await runner.segmentsFor(sessionId, kuliahId);
    if (segs.isEmpty) throw const NoRecordings();
    final job = UploadJob(
      id: _ids.next(),
      sessionId: sessionId,
      kuliahId: kuliahId,
      parts: [
        for (final (i, s) in segs.indexed)
          UploadPart(index: i + 1, source: s.source, bytes: s.bytes),
      ],
      joined: false,
      allowMobile: false,
      createdAt: now().toUtc(),
      replaceLiveVideoId: replaceLive,
      joinSegments: joinSegments?.call() ?? true,
    );
    await _put(job);
    return job;
  }

  Future<void> pause(String jobId) async {
    final j = _jobs[jobId];
    if (j == null) return;
    _running.remove(jobId);
    await runner.cancel(jobId);
    await _put(
      j.copyWith(
        parts: [
          for (final p in j.parts)
            p.isDone ? p : p.copyWith(state: UploadPartState.paused),
        ],
      ),
    );
  }

  Future<void> resume(String jobId) async {
    final j = _jobs[jobId];
    if (j == null) return;
    await _put(
      j.copyWith(
        parts: [
          for (final p in j.parts)
            p.state == UploadPartState.paused
                ? p.copyWith(state: UploadPartState.queued)
                : p,
        ],
      ),
    );
  }

  Future<void> allowMobileData(String jobId, bool allow) async {
    final j = _jobs[jobId];
    if (j == null) return;
    await _put(j.copyWith(allowMobile: allow));
  }

  /// Failed and quota parts go back to the queue.
  Future<void> retry(String jobId) async {
    final j = _jobs[jobId];
    if (j == null) return;
    await _put(
      j.copyWith(
        parts: [
          for (final p in j.parts)
            p.state == UploadPartState.failed || p.state == UploadPartState.quota
                ? p.copyWith(state: UploadPartState.queued)
                : p,
        ],
        lastError: null,
        quotaResetsAt: null,
      ),
    );
  }

  /// Removes the job only. The recordings stay exactly where they are.
  Future<void> remove(String jobId) async {
    _running.remove(jobId);
    await runner.cancel(jobId);
    await runner.forget(jobId);
    if (_jobs.remove(jobId) == null) return;
    _enqueueWrite(() => store.deleteDoc(Collections.uploads, jobId));
    _emit();
    await _writes;
  }

  UploadPolicy policy(UploadJob job, UploadNetwork network) {
    final resets = job.quotaResetsAt;
    if (job.hasQuota && resets != null && now().isBefore(resets)) {
      return UploadPolicy.waitQuota;
    }
    if (network == UploadNetwork.none) return UploadPolicy.waitNetwork;
    final onlyWifi = wifiOnly?.call() ?? true;
    if (onlyWifi && !job.allowMobile && network == UploadNetwork.cellular) {
      return UploadPolicy.waitWifi;
    }
    return UploadPolicy.run;
  }

  /// Looks at every job and starts or stops its runner by the policy. Safe to
  /// call often (the provider calls it on a timer, on a change and when the
  /// app comes to the front).
  Future<void> kick() async {
    if (_kicking) return;
    _kicking = true;
    try {
      await load();
      final net = await runner.network();
      for (var job in _sorted()) {
        if (job.isDone || job.isPaused) {
          _running.remove(job.id);
          continue;
        }
        // The quota day rolled over: the parts that waited try again.
        final resets = job.quotaResetsAt;
        if (job.hasQuota && resets != null && !now().isBefore(resets)) {
          job = job.copyWith(
            parts: [
              for (final p in job.parts)
                p.state == UploadPartState.quota
                    ? p.copyWith(state: UploadPartState.queued)
                    : p,
            ],
            quotaResetsAt: null,
            lastError: null,
          );
          await _put(job);
        }
        if (!job.hasActive) {
          _running.remove(job.id);
          continue;
        }
        final p = policy(job, net);
        if (p == UploadPolicy.run) {
          if (_running.contains(job.id)) continue;
          final a = await auth?.call();
          if (a == null) {
            if (job.lastError != 'no_cloud') {
              await _put(job.copyWith(lastError: 'no_cloud'));
            }
            continue;
          }
          if (job.lastError == 'no_cloud') {
            job = job.copyWith(lastError: null);
            await _put(job);
          }
          _running.add(job.id);
          unawaited(_run(job, a));
        } else if (_running.remove(job.id)) {
          await runner.cancel(job.id);
          // Parts caught mid-send wait as queued, keeping session and offset.
          await _put(
            job.copyWith(
              parts: [
                for (final q in job.parts)
                  q.isActive && q.state != UploadPartState.queued
                      ? q.copyWith(state: UploadPartState.queued)
                      : q,
              ],
            ),
          );
        }
      }
    } finally {
      _kicking = false;
    }
  }

  Future<void> _run(UploadJob job, UploadAuth a) async {
    try {
      await runner.start(job, a);
    } on Object {
      _running.remove(job.id);
      final j = _jobs[job.id];
      if (j != null) await _put(j.copyWith(lastError: 'runner_error'));
    }
  }

  void _onEvent(UploadEvent e) {
    var j = _jobs[e.jobId];
    if (j == null) return;
    var parts = [...j.parts];
    var joined = j.joined;
    var segments = j.segments;

    if (e.joined == true && !j.joined) {
      // The worker joined the segments: one file, one video. The original
      // segment files are kept, so a purged joined file can be made again.
      final total = e.total ?? j.totalBytes;
      segments = [
        for (final p in parts) UploadSegment(p.source, p.bytes),
      ];
      parts = [
        UploadPart(index: 1, source: 'android:joined', bytes: total),
      ];
      joined = true;
    }
    final at = parts.indexWhere((p) => p.index == e.partIndex);
    if (at < 0) {
      _jobs[j.id] = j.copyWith(parts: parts, joined: joined, segments: segments);
      _persist(_jobs[j.id]!);
      return;
    }
    final p = parts[at];
    if (p.isDone && e.state != UploadPartState.done) return;

    // A stopped run's last report must not undo a pause.
    final keepPaused = p.state == UploadPartState.paused &&
        (e.state == UploadPartState.queued ||
            e.state == UploadPartState.beginning ||
            e.state == UploadPartState.uploading ||
            e.state == UploadPartState.joining);
    var np = p.copyWith(
      state: keepPaused ? p.state : e.state,
      offset: e.clearSession ? 0 : (e.offset ?? p.offset),
      uploadId: e.clearSession ? null : (e.uploadId ?? p.uploadId),
      uploadUri: e.clearSession ? null : (e.uploadUri ?? p.uploadUri),
      videoId: e.videoId ?? p.videoId,
      bytes: e.total != null && joined ? e.total : null,
    );
    if (e.state == UploadPartState.done) {
      np = np.copyWith(uploadUri: null, offset: np.bytes);
    }
    parts[at] = np;

    Object? lastError = _keep;
    Object? resets = _keep;
    if (e.state == UploadPartState.failed) lastError = e.error ?? 'error';
    if (e.state == UploadPartState.quota) {
      resets = e.resetsAt ?? now().add(const Duration(hours: 1));
      lastError = 'quota';
    }
    if (e.error == 'join_failed') lastError = 'join_failed';
    if (e.error == 'needs_unlock') lastError = 'needs_unlock';

    j = j.copyWith(
      parts: parts,
      joined: joined,
      lastError: lastError,
      quotaResetsAt: resets,
      segments: segments,
    );
    if (j.isDone) {
      j = j.copyWith(
        parts: [
          for (final q in j.parts) q.copyWith(uploadUri: null, uploadId: null),
        ],
        lastError: null,
        quotaResetsAt: null,
      );
    }
    if (!j.hasActive) _running.remove(j.id);
    final wasDone = _jobs[e.jobId]?.isDone ?? false;
    _jobs[j.id] = j;
    _persist(j);
    if (j.isDone && !wasDone) unawaited(runner.forget(j.id));
  }

  Future<void> _put(UploadJob job) async {
    _jobs[job.id] = job;
    _persist(job);
    await _writes;
  }

  void _persist(UploadJob job) {
    _enqueueWrite(() => store.putDoc(Collections.uploads, job.id, job.toJson()));
    _emit();
  }

  void _enqueueWrite(Future<void> Function() w) {
    _writes = _writes.then((_) => w()).catchError((Object _) {});
  }

  void _emit() {
    if (!_changes.isClosed) _changes.add(_sorted());
  }

  Future<void> dispose() async {
    await _sub?.cancel();
    _sub = null;
    await _writes;
    await _changes.close();
  }
}
