import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:surau_app/features/live/recordings_store.dart';
import 'package:surau_app/store/local_store.dart';
import 'package:surau_app/upload/recording_cleanup.dart';
import 'package:surau_app/upload/recording_remover.dart';
import 'package:surau_app/upload/session_files.dart';
import 'package:surau_app/upload/upload_queue.dart';

class _Clock {
  DateTime t = DateTime.utc(2026, 11, 6, 20, 0);
  DateTime call() => t;
  void add(Duration d) => t = t.add(d);
}

class _Remover implements RecordingRemover {
  final Map<String, RecordingFootprint> prints = {};
  final List<String> removed = [];
  int skipped = 0;
  Object? fail;

  @override
  Future<RecordingFootprint?> footprint(
    String sessionId,
    String? kuliahId,
  ) async => prints[sessionId];

  @override
  Future<RemoveResult> remove(String sessionId, RecordingFootprint fp) async {
    if (fail != null) throw fail!;
    removed.add(sessionId);
    return RemoveResult(
      deleted: skipped > 0 ? 0 : fp.names.length,
      skipped: skipped,
      bytes: skipped > 0 ? 0 : fp.bytes,
    );
  }
}

/// An Android-like remover over a pretend device: footprints come from the
/// stored names only, as the real one does.
class _NamedRemover implements RecordingRemover {
  _NamedRemover(this.files, this.device);

  final SessionFiles files;
  final Map<String, int> device;
  static final List<String> removedNames = [];

  @override
  Future<RecordingFootprint?> footprint(
    String sessionId,
    String? kuliahId,
  ) async {
    final names = [
      for (final n in await files.names(sessionId))
        if (device.containsKey(n)) n,
    ];
    if (names.isEmpty) return null;
    return RecordingFootprint(
      names: names,
      sizes: [for (final n in names) device[n]!],
      bytes: names.fold(0, (a, n) => a + device[n]!),
    );
  }

  @override
  Future<RemoveResult> remove(String sessionId, RecordingFootprint fp) async {
    removedNames
      ..clear()
      ..addAll(fp.names);
    return RemoveResult(deleted: fp.names.length, skipped: 0, bytes: fp.bytes);
  }
}

class _Audit {
  final List<({String sessionId, List<String> videoIds, int bytes})> rows = [];
  bool failNext = false;

  Future<void> call(String sessionId, List<String> videoIds, int bytes) async {
    if (failNext) {
      failNext = false;
      throw StateError('audit');
    }
    rows.add((sessionId: sessionId, videoIds: videoIds, bytes: bytes));
  }
}

UploadJob _job(
  String session, {
  required List<String?> videoIds,
  bool done = true,
  UploadPartState? last,
}) => UploadJob(
  id: 'job-$session',
  sessionId: session,
  kuliahId: 'k1',
  parts: [
    for (final (i, v) in videoIds.indexed)
      UploadPart(
        index: i + 1,
        source: 'android:x',
        bytes: 100,
        videoId: v,
        state: done || (last == null || i < videoIds.length - 1)
            ? UploadPartState.done
            : last,
      ),
  ],
  joined: false,
  allowMobile: false,
  createdAt: DateTime.utc(2026, 11, 6),
);

VideoCheck _ok(String id, int seconds, {String privacy = 'unlisted'}) =>
    VideoCheck(
      videoId: id,
      exists: true,
      processed: true,
      privacy: privacy,
      durationSeconds: seconds,
    );

class _Rig {
  _Rig() {
    cleanup = RecordingCleanup(
      store: store,
      now: clock.call,
      verify: (ids) async {
        verifyCalls.add(List.of(ids));
        if (verifyFail) throw StateError('network');
        return [for (final id in ids) answers[id] ?? _ok(id, 1800)];
      },
      remover: remover,
      settings: () async => settings,
      jobs: () async => jobs,
      recordingNow: () async => recordingNow,
      audit: audit.call,
    );
  }

  final MemoryLocalStore store = MemoryLocalStore();
  final _Clock clock = _Clock();
  final _Remover remover = _Remover();
  final _Audit audit = _Audit();
  late final RecordingCleanup cleanup;
  CleanupSettings settings = const CleanupSettings();
  List<UploadJob> jobs = [];
  bool recordingNow = false;
  bool verifyFail = false;
  final List<List<String>> verifyCalls = [];
  final Map<String, VideoCheck> answers = {};

  /// A 30 minute recording whose files are on the device.
  Future<void> record(
    String session, {
    int duration = 1800,
    int? youtubeSeconds,
    String? liveVideoId,
    List<String>? names,
    int bytes = 5000,
  }) async {
    remover.prints[session] = RecordingFootprint(
      names: names ?? ['MAXCOM-2026-11-06-k1-$session.mp4'],
      bytes: bytes,
    );
    await cleanup.register(
      sessionId: session,
      kuliahId: 'k1',
      durationSec: duration,
      youtubeSeconds: youtubeSeconds,
      liveVideoId: liveVideoId,
    );
  }

  Future<CleanupRecord?> rec(String session) async =>
      (await cleanup.records())[session];
}

void main() {
  late _Rig r;
  setUp(() async {
    r = _Rig();
    await r.store.open('box1');
  });

  group('who is a candidate', () {
    test('a live with a gap never counts: no check, no delete', () async {
      await r.record('s1', youtubeSeconds: 1700, liveVideoId: 'live1');
      await r.cleanup.run();
      r.clock.add(const Duration(days: 40));
      await r.cleanup.run();
      expect(r.verifyCalls, isEmpty);
      expect(r.remover.removed, isEmpty);
      expect((await r.rec('s1'))!.verifiedAt, isNull);
    });

    test('a live that YouTube never had (no video) never counts', () async {
      await r.record('s1', youtubeSeconds: 1800);
      await r.cleanup.run();
      expect(r.verifyCalls, isEmpty);
    });

    test('a live within a minute of the whole counts', () async {
      await r.record('s1', youtubeSeconds: 1740, liveVideoId: 'live1');
      await r.cleanup.run();
      expect(r.verifyCalls, [
        ['live1'],
      ]);
      expect((await r.rec('s1'))!.verifiedAt, isNotNull);
    });

    test('a catch-up with every part done counts, by its video ids', () async {
      await r.record('s1', youtubeSeconds: 0);
      r.jobs = [_job('s1', videoIds: ['p1', 'p2'])];
      r.answers['p1'] = _ok('p1', 900);
      r.answers['p2'] = _ok('p2', 900);
      await r.cleanup.run();
      expect(r.verifyCalls, [
        ['p1', 'p2'],
      ]);
      expect((await r.rec('s1'))!.verifiedAt, isNotNull);
    });

    test('a part with no video id yet blocks the catch-up', () async {
      await r.record('s1', youtubeSeconds: 0);
      r.jobs = [_job('s1', videoIds: ['p1', null])];
      await r.cleanup.run();
      expect(r.verifyCalls, isEmpty);
    });

    test('a queued or uploading job blocks even a full live', () async {
      await r.record('s1', youtubeSeconds: 1800, liveVideoId: 'live1');
      r.jobs = [
        _job('s1', videoIds: ['p1'], done: false, last: UploadPartState.queued),
      ];
      await r.cleanup.run();
      r.jobs = [
        _job(
          's1',
          videoIds: ['p1'],
          done: false,
          last: UploadPartState.uploading,
        ),
      ];
      await r.cleanup.run();
      expect(r.verifyCalls, isEmpty);
      expect(r.remover.removed, isEmpty);
    });
  });

  group('verified means YouTube says so', () {
    Future<void> full() =>
        r.record('s1', youtubeSeconds: 1800, liveVideoId: 'live1');

    test('a video still processing blocks', () async {
      await full();
      r.answers['live1'] = const VideoCheck(
        videoId: 'live1',
        exists: true,
        processed: false,
        privacy: 'unlisted',
        durationSeconds: 1800,
      );
      await r.cleanup.run();
      expect((await r.rec('s1'))!.verifiedAt, isNull);
    });

    test('one part processing blocks a recording in parts', () async {
      await r.record('s1', youtubeSeconds: 0);
      r.jobs = [_job('s1', videoIds: ['p1', 'p2'])];
      r.answers['p1'] = _ok('p1', 900);
      r.answers['p2'] = const VideoCheck(
        videoId: 'p2',
        exists: true,
        processed: false,
        privacy: 'unlisted',
        durationSeconds: 900,
      );
      await r.cleanup.run();
      expect((await r.rec('s1'))!.verifiedAt, isNull);
    });

    test('a video that does not exist blocks', () async {
      await full();
      r.answers['live1'] = const VideoCheck(
        videoId: 'live1',
        exists: false,
        processed: false,
      );
      await r.cleanup.run();
      expect((await r.rec('s1'))!.verifiedAt, isNull);
    });

    test('a private video blocks, unless the surau publishes private', () async {
      await full();
      r.answers['live1'] = _ok('live1', 1800, privacy: 'private');
      await r.cleanup.run();
      expect((await r.rec('s1'))!.verifiedAt, isNull);

      r.clock.add(const Duration(hours: 2));
      r.settings = const CleanupSettings(allowPrivate: true);
      await r.cleanup.run();
      expect((await r.rec('s1'))!.verifiedAt, isNotNull);
    });

    test('a video shorter than the recording by over a minute blocks', () async {
      await full();
      r.answers['live1'] = _ok('live1', 1700);
      await r.cleanup.run();
      expect((await r.rec('s1'))!.verifiedAt, isNull);
    });

    test('a video with no length yet blocks', () async {
      await full();
      r.answers['live1'] = const VideoCheck(
        videoId: 'live1',
        exists: true,
        processed: true,
        privacy: 'unlisted',
      );
      await r.cleanup.run();
      expect((await r.rec('s1'))!.verifiedAt, isNull);
    });

    test('the parts add up: 2 x 900 s covers 1800 s, 2 x 800 s does not',
        () async {
      await r.record('s1', youtubeSeconds: 0);
      r.jobs = [_job('s1', videoIds: ['p1', 'p2'])];
      r.answers['p1'] = _ok('p1', 800);
      r.answers['p2'] = _ok('p2', 800);
      await r.cleanup.run();
      expect((await r.rec('s1'))!.verifiedAt, isNull);
    });

    test('the check cannot be made: nothing changes, nothing is deleted',
        () async {
      await full();
      r.verifyFail = true;
      await r.cleanup.run();
      r.clock.add(const Duration(days: 3));
      await r.cleanup.run();
      expect((await r.rec('s1'))!.verifiedAt, isNull);
      expect(r.remover.removed, isEmpty);
    });
  });

  group('when the files go', () {
    Future<void> verified() async {
      await r.record('s1', youtubeSeconds: 1800, liveVideoId: 'live1');
      await r.cleanup.run();
      expect((await r.rec('s1'))!.verifiedAt, isNotNull);
    }

    test('a full live is deleted 1 day after verification, not before',
        () async {
      await verified();
      expect(r.remover.removed, isEmpty);
      r.clock.add(const Duration(hours: 23, minutes: 59));
      await r.cleanup.run();
      expect(r.remover.removed, isEmpty);
      r.clock.add(const Duration(minutes: 2));
      await r.cleanup.run();
      expect(r.remover.removed, ['s1']);
      final rec = (await r.rec('s1'))!;
      expect(rec.deletedAt, isNotNull);
      expect(rec.phase, CleanupPhase.deleted);
    });

    test('keepDays 0 deletes at once, after verifying', () async {
      r.settings = const CleanupSettings(keepDays: 0);
      await verified();
      expect(r.remover.removed, ['s1']);
    });

    test('keepDays 7 waits a week; shortening it later releases the file',
        () async {
      r.settings = const CleanupSettings(keepDays: 7);
      await verified();
      r.clock.add(const Duration(days: 3));
      await r.cleanup.run();
      expect(r.remover.removed, isEmpty);
      r.settings = const CleanupSettings(keepDays: 1);
      await r.cleanup.run();
      expect(r.remover.removed, ['s1']);
    });

    test('the deletion time is shown while waiting', () async {
      r.settings = const CleanupSettings(keepDays: 3);
      await verified();
      final rec = (await r.rec('s1'))!;
      expect(rec.phase, CleanupPhase.scheduled);
      expect(rec.deleteAt(3), r.clock.t.add(const Duration(days: 3)));
    });

    test('the feature off: no check, no delete, even when due', () async {
      await verified();
      r.settings = const CleanupSettings(enabled: false);
      r.verifyCalls.clear();
      r.clock.add(const Duration(days: 30));
      await r.cleanup.run();
      expect(r.verifyCalls, isEmpty);
      expect(r.remover.removed, isEmpty);
      expect((await r.rec('s1'))!.deletedAt, isNull);
    });

    test('a live or recording in progress stops every deletion', () async {
      await verified();
      r.recordingNow = true;
      r.clock.add(const Duration(days: 5));
      await r.cleanup.run();
      expect(r.remover.removed, isEmpty);
      r.recordingNow = false;
      await r.cleanup.run();
      expect(r.remover.removed, ['s1']);
    });

    test('a video removed in the meantime cancels the deletion', () async {
      await verified();
      r.answers['live1'] = const VideoCheck(
        videoId: 'live1',
        exists: false,
        processed: false,
      );
      r.clock.add(const Duration(days: 2));
      await r.cleanup.run();
      expect(r.remover.removed, isEmpty);
      final rec = (await r.rec('s1'))!;
      expect(rec.verifiedAt, isNull);
      expect(rec.deletedAt, isNull);
    });

    test('a video made private in the meantime cancels the deletion',
        () async {
      await verified();
      r.answers['live1'] = _ok('live1', 1800, privacy: 'private');
      r.clock.add(const Duration(days: 2));
      await r.cleanup.run();
      expect(r.remover.removed, isEmpty);
      expect((await r.rec('s1'))!.verifiedAt, isNull);
    });

    test('the re-check cannot be made: kept, tried again later', () async {
      await verified();
      r.clock.add(const Duration(days: 2));
      r.verifyFail = true;
      await r.cleanup.run();
      expect(r.remover.removed, isEmpty);
      expect((await r.rec('s1'))!.verifiedAt, isNotNull);
      r.verifyFail = false;
      r.clock.add(const Duration(hours: 2));
      await r.cleanup.run();
      expect(r.remover.removed, ['s1']);
    });

    test('a file that could not be deleted is not marked deleted', () async {
      await verified();
      r.remover.skipped = 1;
      r.clock.add(const Duration(days: 2));
      await r.cleanup.run();
      expect((await r.rec('s1'))!.deletedAt, isNull);
      expect(r.audit.rows, isEmpty);
      r.remover.skipped = 0;
      r.clock.add(const Duration(hours: 2));
      await r.cleanup.run();
      expect((await r.rec('s1'))!.deletedAt, isNotNull);
    });

    test('a remover that throws leaves the record as it was', () async {
      await verified();
      r.remover.fail = StateError('boom');
      r.clock.add(const Duration(days: 2));
      await r.cleanup.run();
      expect((await r.rec('s1'))!.deletedAt, isNull);
    });

    test('a deleted session is never touched again', () async {
      await verified();
      r.clock.add(const Duration(days: 2));
      await r.cleanup.run();
      r.verifyCalls.clear();
      r.remover.removed.clear();
      r.clock.add(const Duration(days: 20));
      await r.cleanup.run();
      expect(r.verifyCalls, isEmpty);
      expect(r.remover.removed, isEmpty);
    });

    test('a new job that appeared after verification stops the deletion',
        () async {
      await verified();
      r.jobs = [
        _job('s1', videoIds: [null], done: false, last: UploadPartState.queued),
      ];
      r.clock.add(const Duration(days: 2));
      await r.cleanup.run();
      expect(r.remover.removed, isEmpty);
    });
  });

  group('how often YouTube is asked', () {
    test('an unverified session is checked at most once an hour', () async {
      await r.record('s1', youtubeSeconds: 1800, liveVideoId: 'live1');
      r.answers['live1'] = _ok('live1', 100);
      await r.cleanup.run();
      await r.cleanup.run();
      r.clock.add(const Duration(minutes: 59));
      await r.cleanup.run();
      expect(r.verifyCalls, hasLength(1));
      r.clock.add(const Duration(minutes: 2));
      await r.cleanup.run();
      expect(r.verifyCalls, hasLength(2));
    });

    test('one call carries the ids of one session only', () async {
      await r.record('s1', youtubeSeconds: 1800, liveVideoId: 'a');
      await r.record('s2', youtubeSeconds: 1800, liveVideoId: 'b');
      await r.cleanup.run();
      expect(r.verifyCalls, [
        ['a'],
        ['b'],
      ]);
    });
  });

  group('the audit row', () {
    test('carries the session, the video ids and the bytes, nothing else',
        () async {
      r.settings = const CleanupSettings(keepDays: 0);
      await r.record(
        's1',
        youtubeSeconds: 1800,
        liveVideoId: 'live1',
        bytes: 9876,
      );
      await r.cleanup.run();
      expect(r.audit.rows, hasLength(1));
      expect(r.audit.rows.single.sessionId, 's1');
      expect(r.audit.rows.single.videoIds, ['live1']);
      expect(r.audit.rows.single.bytes, 9876);
    });

    test('is retried when it could not be written, once only', () async {
      r.settings = const CleanupSettings(keepDays: 0);
      r.audit.failNext = true;
      await r.record('s1', youtubeSeconds: 1800, liveVideoId: 'live1');
      await r.cleanup.run();
      expect((await r.rec('s1'))!.deletedAt, isNotNull);
      expect(r.audit.rows, isEmpty);
      await r.cleanup.run();
      expect(r.audit.rows, hasLength(1));
      await r.cleanup.run();
      expect(r.audit.rows, hasLength(1));
    });
  });

  group('registering a recording', () {
    test('no files on the device: nothing is registered', () async {
      await r.cleanup.register(
        sessionId: 'none',
        kuliahId: 'k1',
        durationSec: 1800,
        youtubeSeconds: 1800,
        liveVideoId: 'live1',
      );
      expect(await r.cleanup.records(), isEmpty);
    });

    test('a zero length recording is not registered', () async {
      await r.record('s1', duration: 0, youtubeSeconds: 0, liveVideoId: 'x');
      expect(await r.cleanup.records(), isEmpty);
    });

    test('files already claimed by another session are not claimed twice',
        () async {
      await r.record(
        's1',
        youtubeSeconds: 1800,
        liveVideoId: 'a',
        names: ['MAXCOM-2026-11-06-siaran-01.mp4'],
      );
      await r.record(
        's2',
        youtubeSeconds: 1800,
        liveVideoId: 'b',
        names: [
          'MAXCOM-2026-11-06-siaran-01.mp4',
          'MAXCOM-2026-11-06-siaran-02.mp4',
        ],
      );
      expect((await r.rec('s2'))!.names, ['MAXCOM-2026-11-06-siaran-02.mp4']);
    });

    test('only that session is deleted, with its own names', () async {
      r.settings = const CleanupSettings(keepDays: 0);
      await r.record('s1', youtubeSeconds: 1800, liveVideoId: 'a');
      await r.record('s2', youtubeSeconds: 900, liveVideoId: 'b');
      await r.cleanup.run();
      expect(r.remover.removed, ['s1']);
    });
  });

  group('gate 2 fixes', () {
    test('25 videos are verified in batches of at most 20 and combined', () async {
      r.settings = const CleanupSettings(keepDays: 0);
      await r.record('s1', duration: 1800);
      final ids = [for (var i = 0; i < 25; i++) 'v$i'];
      r.jobs = [_job('s1', videoIds: ids)];
      await r.cleanup.run();
      expect([for (final c in r.verifyCalls) c.length], [20, 5]);
      expect([for (final c in r.verifyCalls) ...c], ids);
      expect(r.remover.removed, ['s1']);
    });

    test('a failing batch means the check could not be made: nothing is deleted',
        () async {
      r.settings = const CleanupSettings(keepDays: 0);
      await r.record('s1', duration: 1800);
      r.jobs = [_job('s1', videoIds: [for (var i = 0; i < 25; i++) 'v$i'])];
      var n = 0;
      final c = RecordingCleanup(
        store: r.store,
        now: r.clock.call,
        verify: (ids) async {
          if (++n == 2) throw StateError('network');
          return [for (final id in ids) _ok(id, 1800)];
        },
        remover: r.remover,
        settings: () async => r.settings,
        jobs: () async => r.jobs,
        recordingNow: () async => false,
      );
      await c.run();
      expect(r.remover.removed, isEmpty);
    });

    test('a batch that misses a video blocks the deletion', () async {
      r.settings = const CleanupSettings(keepDays: 0);
      await r.record('s1', duration: 1800);
      final ids = [for (var i = 0; i < 25; i++) 'v$i'];
      r.jobs = [_job('s1', videoIds: ids)];
      final c = RecordingCleanup(
        store: r.store,
        now: r.clock.call,
        // the answer for the second batch is empty
        verify: (batch) async => batch.contains('v22')
            ? const []
            : [for (final id in batch) _ok(id, 1800)],
        remover: r.remover,
        settings: () async => r.settings,
        jobs: () async => r.jobs,
        recordingNow: () async => false,
      );
      await c.run();
      expect(r.remover.removed, isEmpty);
    });

    test('the audit carries the videos verified just now, not the old ones',
        () async {
      await r.record('s1', youtubeSeconds: 1800, liveVideoId: 'live1');
      await r.cleanup.run(); // verified against the live video
      expect((await r.rec('s1'))!.videoIds, ['live1']);
      // a catch-up finished meanwhile: its video is the fresh one
      r.jobs = [_job('s1', videoIds: ['catch1'])];
      r.clock.add(const Duration(days: 2));
      await r.cleanup.run();
      expect(r.remover.removed, ['s1']);
      expect(r.audit.rows.single.videoIds, ['catch1']);
      expect((await r.rec('s1'))!.videoIds, ['catch1']);
    });

    test('files that may not be deleted: three passes, then kept for ever',
        () async {
      r.settings = const CleanupSettings(keepDays: 0);
      r.remover.skipped = 1; // a foreign row
      await r.record('s1', youtubeSeconds: 1800, liveVideoId: 'live1');
      for (var i = 0; i < 6; i++) {
        await r.cleanup.run();
        r.clock.add(const Duration(hours: 2));
      }
      expect(r.remover.removed, hasLength(3));
      final rec = (await r.rec('s1'))!;
      expect(rec.phase, CleanupPhase.kept);
      expect(rec.deletedAt, isNull);
      // even if the files become deletable later, a kept session is left alone
      r.remover.skipped = 0;
      r.clock.add(const Duration(days: 9));
      await r.cleanup.run();
      expect(r.remover.removed, hasLength(3));
      expect(r.audit.rows, isEmpty);
    });

    test('two clean-ups over one store never run at once (provider rebuild)',
        () async {
      r.settings = const CleanupSettings(keepDays: 0);
      await r.record('s1', youtubeSeconds: 1800, liveVideoId: 'live1');
      final gate = Completer<void>();
      var asked = 0;
      RecordingCleanup make() => RecordingCleanup(
        store: r.store,
        now: r.clock.call,
        verify: (ids) async {
          asked++;
          await gate.future;
          return [for (final id in ids) _ok(id, 1800)];
        },
        remover: r.remover,
        settings: () async => r.settings,
        jobs: () async => r.jobs,
        recordingNow: () async => false,
      );
      final a = make().run();
      await pumpEventQueue();
      await make().run(); // the rebuilt provider's instance: does nothing
      expect(asked, 1);
      gate.complete();
      await a;
      expect(r.remover.removed, ['s1']);
      // and the lock is free again afterwards
      await make().run();
    });
  });

  group('a recording belongs to the live that wrote it', () {
    test('an older unregistered web session is never registered with the current live',
        () async {
      final recs = MemoryRecordingsStore();
      for (final (session, index) in [('old', 1), ('old', 2), ('now', 1)]) {
        await recs.appendPart(
          sessionId: session,
          index: index,
          mime: 'video/mp4',
          label: 'k1',
          chunk: Object(),
          size: 100,
        );
        await recs.finishSegment(session, index);
      }
      final c = RecordingCleanup(
        store: r.store,
        now: r.clock.call,
        verify: (ids) async => const [],
        remover: WebRecordingRemover(recs),
        settings: () async => const CleanupSettings(),
        jobs: () async => const [],
        recordingNow: () async => false,
      );
      await c.register(
        sessionId: 'now',
        kuliahId: 'k1',
        durationSec: 600,
        youtubeSeconds: 600,
        liveVideoId: 'live1',
      );
      final rec = (await c.records())['now']!;
      expect(rec.names, ['now-1']);
      expect((await c.records()).containsKey('old'), isFalse);
    });

    test('Android: lives 1 and 2 of one day keep their own names; live 2 never owns live 1',
        () async {
      // live 1 was never registered (the app was killed); live 2 is
      final files = SessionFiles(r.store);
      await files.save('s2', ['MAXCOM-2026-11-06-1140-siaran-01.mp4']);
      final c = RecordingCleanup(
        store: r.store,
        now: r.clock.call,
        verify: (ids) async => [for (final id in ids) _ok(id, 1800)],
        remover: _NamedRemover(files, {
          'MAXCOM-2026-11-06-1015-siaran-01.mp4': 111,
          'MAXCOM-2026-11-06-1140-siaran-01.mp4': 222,
        }),
        settings: () async => const CleanupSettings(keepDays: 0),
        jobs: () async => const [],
        recordingNow: () async => false,
      );
      await c.register(
        sessionId: 's2',
        kuliahId: null,
        durationSec: 1800,
        youtubeSeconds: 1800,
        liveVideoId: 'live2',
      );
      final rec = (await c.records())['s2']!;
      expect(rec.names, ['MAXCOM-2026-11-06-1140-siaran-01.mp4']);
      expect(rec.bytes, 222);
      await c.run();
      final removedNames = _NamedRemover.removedNames;
      expect(removedNames, ['MAXCOM-2026-11-06-1140-siaran-01.mp4']);
    });
  });

  test('the record holds no address and no token', () async {
    r.settings = const CleanupSettings(keepDays: 0);
    await r.record('s1', youtubeSeconds: 1800, liveVideoId: 'live1');
    await r.cleanup.run();
    final doc = await r.store.getDoc(Collections.cleanup, 's1');
    final text = doc.toString();
    expect(text.contains('content://'), isFalse);
    expect(text.contains('file://'), isFalse);
    expect(text.contains('http'), isFalse);
  });
}
