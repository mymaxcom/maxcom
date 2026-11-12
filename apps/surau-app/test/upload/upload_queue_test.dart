import 'dart:async';
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:surau_app/features/live/recordings_store.dart';
import 'package:surau_app/store/local_store.dart';
import 'package:surau_app/upload/upload_queue.dart';

/// A recordings store that fails the test if anything deletes from it.
class _SpyRecordings extends MemoryRecordingsStore {
  final List<String> calls = [];

  @override
  Future<void> delete(String id) {
    calls.add('delete:$id');
    return super.delete(id);
  }

  @override
  Future<void> markSaved(String id) {
    calls.add('markSaved:$id');
    return super.markSaved(id);
  }
}

class _FakeApi implements UploadApi {
  @override
  Future<UploadBegun> begin(UploadBeginRequest r) async =>
      throw UnimplementedError();
  @override
  Future<void> done(String uploadId, String videoId) async {}
  @override
  Future<UploadQuotaInfo> quota() async =>
      throw UnimplementedError();
}

class _FakeRunner implements UploadRunner {
  _FakeRunner(this.recordings);

  final RecordingsStore recordings;
  final StreamController<UploadEvent> _events = StreamController.broadcast();
  UploadNetwork net = UploadNetwork.wifi;
  final List<String> started = [];
  final List<String> cancelled = [];
  final List<bool> replaced = [];

  @override
  bool get survivesRestart => false;

  @override
  Stream<UploadEvent> get events => _events.stream;

  void emit(UploadEvent e) => _events.add(e);

  @override
  Future<UploadNetwork> network() async => net;

  @override
  Future<List<UploadSegment>> segmentsFor(
    String sessionId,
    String? kuliahId,
  ) => segmentsFromRecordings(recordings, sessionId);

  @override
  Future<void> start(UploadJob job, UploadAuth auth) async {
    started.add(job.id);
  }

  @override
  Future<void> cancel(String jobId) async => cancelled.add(jobId);

  final List<String> forgotten = [];

  @override
  Future<void> forget(String jobId) async => forgotten.add(jobId);

  @override
  Future<void> dispose() async => _events.close();
}

Future<void> _seed(
  MemoryRecordingsStore s,
  String session,
  int index,
  int bytes,
) async {
  await s.appendPart(
    sessionId: session,
    index: index,
    mime: 'video/mp4',
    label: 'k1',
    chunk: Object(),
    size: bytes,
  );
  await s.finishSegment(session, index);
}

void main() {
  late DateTime clock;
  late _SpyRecordings rec;
  late _FakeRunner runner;
  late MemoryLocalStore store;
  late bool wifiOnly;

  UploadQueue build() => UploadQueue(
    store: store,
    runner: runner,
    now: () => clock,
    wifiOnly: () => wifiOnly,
    auth: () async => UploadAuth(
      api: _FakeApi(),
      base: Uri.parse('https://cloud.example'),
      token: 'tok',
    ),
  );

  setUp(() async {
    clock = DateTime.utc(2026, 11, 6, 10);
    rec = _SpyRecordings();
    runner = _FakeRunner(rec);
    store = MemoryLocalStore();
    await store.open('0123456789abcdef');
    wifiOnly = true;
    await _seed(rec, 'sess1', 1, 1000);
    await _seed(rec, 'sess1', 2, 2000);
    await _seed(rec, 'sess1', 3, 3000);
  });

  test('a 3-segment web session makes a job of 3 parts in order', () async {
    final q = build();
    await q.load();
    final job = await q.enqueueFromSession('sess1', 'k1');
    expect(job.parts.map((p) => p.index), [1, 2, 3]);
    expect(job.parts.map((p) => p.bytes), [1000, 2000, 3000]);
    expect(job.parts.map((p) => p.source), [
      'web:sess1-1',
      'web:sess1-2',
      'web:sess1-3',
    ]);
    expect(job.parts.every((p) => p.state == UploadPartState.queued), isTrue);
    expect(job.kuliahId, 'k1');
    expect(job.joined, isFalse);
    expect(job.allowMobile, isFalse);
    expect(job.replaceLiveVideoId, isNull);
    expect(RegExp(r'^[0-9A-HJKMNP-TV-Z]{26}$').hasMatch(job.id), isTrue);
    expect((await q.jobs()).single.id, job.id);
  });

  test('a session with no recordings is refused', () async {
    final q = build();
    await q.load();
    expect(
      () => q.enqueueFromSession('nothing', null),
      throwsA(isA<NoRecordings>()),
    );
  });

  test('replaceLive is kept on the job', () async {
    final q = build();
    await q.load();
    final job = await q.enqueueFromSession('sess1', 'k1', replaceLive: 'live9');
    expect(job.replaceLiveVideoId, 'live9');
  });

  test('policy waits for Wi-Fi on cellular until mobile data is allowed', () async {
    final q = build();
    await q.load();
    final job = await q.enqueueFromSession('sess1', 'k1');
    expect(q.policy(job, UploadNetwork.cellular), UploadPolicy.waitWifi);
    expect(q.policy(job, UploadNetwork.wifi), UploadPolicy.run);
    expect(q.policy(job, UploadNetwork.none), UploadPolicy.waitNetwork);
    await q.allowMobileData(job.id, true);
    final again = (await q.jobs()).single;
    expect(again.allowMobile, isTrue);
    expect(q.policy(again, UploadNetwork.cellular), UploadPolicy.run);
    expect(q.policy(again, UploadNetwork.none), UploadPolicy.waitNetwork);
  });

  test('wifiOnly off lets cellular run', () async {
    wifiOnly = false;
    final q = build();
    await q.load();
    final job = await q.enqueueFromSession('sess1', 'k1');
    expect(q.policy(job, UploadNetwork.cellular), UploadPolicy.run);
  });

  test('an unknown network (browser) runs', () async {
    final q = build();
    await q.load();
    final job = await q.enqueueFromSession('sess1', 'k1');
    expect(q.policy(job, UploadNetwork.unknown), UploadPolicy.run);
  });

  test('quota waits until resetsAt and runs after', () async {
    final q = build();
    await q.load();
    final job = await q.enqueueFromSession('sess1', 'k1');
    final resets = clock.add(const Duration(hours: 5));
    runner.emit(
      UploadEvent(
        jobId: job.id,
        partIndex: 1,
        state: UploadPartState.quota,
        resetsAt: resets,
      ),
    );
    await pumpEventQueue();
    final j = (await q.jobs()).single;
    expect(j.parts.first.state, UploadPartState.quota);
    expect(j.quotaResetsAt, resets);
    expect(q.policy(j, UploadNetwork.wifi), UploadPolicy.waitQuota);
    clock = resets.add(const Duration(minutes: 1));
    expect(q.policy(j, UploadNetwork.wifi), UploadPolicy.run);
  });

  test('kick starts a job on Wi-Fi, holds it on cellular, starts it once allowed', () async {
    final q = build();
    await q.load();
    final job = await q.enqueueFromSession('sess1', 'k1');
    runner.net = UploadNetwork.cellular;
    await q.kick();
    expect(runner.started, isEmpty);
    await q.allowMobileData(job.id, true);
    await q.kick();
    expect(runner.started, [job.id]);
    await q.kick();
    expect(runner.started, [job.id], reason: 'already running');
  });

  test('kick cancels a running job when Wi-Fi goes away', () async {
    final q = build();
    await q.load();
    final job = await q.enqueueFromSession('sess1', 'k1');
    await q.kick();
    expect(runner.started, [job.id]);
    runner.net = UploadNetwork.cellular;
    await q.kick();
    expect(runner.cancelled, [job.id]);
    runner.net = UploadNetwork.wifi;
    await q.kick();
    expect(runner.started, [job.id, job.id]);
  });

  test('after the quota reset a kick puts the quota part back to queued and runs it', () async {
    final q = build();
    await q.load();
    final job = await q.enqueueFromSession('sess1', 'k1');
    final resets = clock.add(const Duration(hours: 5));
    runner.emit(
      UploadEvent(
        jobId: job.id,
        partIndex: 2,
        state: UploadPartState.quota,
        resetsAt: resets,
      ),
    );
    await pumpEventQueue();
    await q.kick();
    expect(runner.started, isEmpty);
    clock = resets.add(const Duration(seconds: 1));
    await q.kick();
    expect(runner.started, [job.id]);
    final j = (await q.jobs()).single;
    expect(j.parts[1].state, UploadPartState.queued);
    expect(j.quotaResetsAt, isNull);
  });

  test('remove drops the job and never touches the recordings store', () async {
    final q = build();
    await q.load();
    final job = await q.enqueueFromSession('sess1', 'k1');
    await q.remove(job.id);
    expect(await q.jobs(), isEmpty);
    expect(runner.cancelled, [job.id]);
    expect(rec.calls, isEmpty);
    expect((await rec.forSession('sess1')), hasLength(3));
    expect(runner.forgotten, [job.id], reason: 'the runner drops its own state');
  });

  test('events update offsets and the job survives a reopen with them', () async {
    var q = build();
    await q.load();
    final job = await q.enqueueFromSession('sess1', 'k1');
    runner.emit(
      UploadEvent(
        jobId: job.id,
        partIndex: 1,
        state: UploadPartState.done,
        offset: 1000,
        videoId: 'v1',
      ),
    );
    runner.emit(
      UploadEvent(
        jobId: job.id,
        partIndex: 2,
        state: UploadPartState.uploading,
        offset: 8388608,
        uploadId: 'up2',
        uploadUri: 'https://upload.example/s/2',
      ),
    );
    await pumpEventQueue();
    await q.dispose();

    q = build();
    await q.load();
    final j = (await q.jobs()).single;
    expect(j.parts[0].state, UploadPartState.done);
    expect(j.parts[0].videoId, 'v1');
    // The runner of this fake does not survive a restart: the part is queued
    // again but keeps its session and offset to resume from.
    expect(j.parts[1].state, UploadPartState.queued);
    expect(j.parts[1].offset, 8388608);
    expect(j.parts[1].uploadId, 'up2');
    expect(j.parts[1].uploadUri, 'https://upload.example/s/2');
    expect(j.parts[2].state, UploadPartState.queued);
  });

  test('when every part is done the upload URIs are dropped from the store', () async {
    final q = build();
    await q.load();
    final job = await q.enqueueFromSession('sess1', 'k1');
    for (final i in [1, 2, 3]) {
      runner.emit(
        UploadEvent(
          jobId: job.id,
          partIndex: i,
          state: UploadPartState.uploading,
          offset: 10,
          uploadId: 'up$i',
          uploadUri: 'https://upload.example/s/$i',
        ),
      );
      runner.emit(
        UploadEvent(
          jobId: job.id,
          partIndex: i,
          state: UploadPartState.done,
          offset: 1000 * i,
          videoId: 'v$i',
        ),
      );
    }
    await pumpEventQueue();
    final raw = (await store.list(Collections.uploads)).single.toString();
    expect(raw, isNot(contains('upload.example')));
    final j = (await q.jobs()).single;
    expect(j.isDone, isTrue);
    expect(j.parts.map((p) => p.videoId), ['v1', 'v2', 'v3']);
    expect(runner.forgotten, [job.id], reason: 'finished: the runner forgets');
  });

  test('pause cancels the run and parks the parts, resume queues them', () async {
    final q = build();
    await q.load();
    final job = await q.enqueueFromSession('sess1', 'k1');
    await q.kick();
    await q.pause(job.id);
    expect(runner.cancelled, [job.id]);
    var j = (await q.jobs()).single;
    expect(j.parts.every((p) => p.state == UploadPartState.paused), isTrue);
    await q.kick();
    expect(runner.started, [job.id], reason: 'a paused job does not start');
    await q.resume(job.id);
    j = (await q.jobs()).single;
    expect(j.parts.every((p) => p.state == UploadPartState.queued), isTrue);
    await q.kick();
    expect(runner.started, [job.id, job.id]);
  });

  test('retry puts a failed part back to queued and clears the error', () async {
    final q = build();
    await q.load();
    final job = await q.enqueueFromSession('sess1', 'k1');
    runner.emit(
      UploadEvent(
        jobId: job.id,
        partIndex: 3,
        state: UploadPartState.failed,
        error: 'youtube_reauthorise',
      ),
    );
    await pumpEventQueue();
    var j = (await q.jobs()).single;
    expect(j.parts[2].state, UploadPartState.failed);
    expect(j.lastError, 'youtube_reauthorise');
    await q.retry(job.id);
    j = (await q.jobs()).single;
    expect(j.parts[2].state, UploadPartState.queued);
    expect(j.lastError, isNull);
  });

  test('a joined event collapses the job into one part (Android)', () async {
    final q = build();
    await q.load();
    final job = await q.enqueueFromSession('sess1', 'k1');
    runner.emit(
      UploadEvent(
        jobId: job.id,
        partIndex: 1,
        state: UploadPartState.queued,
        joined: true,
        total: 6000,
      ),
    );
    await pumpEventQueue();
    final j = (await q.jobs()).single;
    expect(j.joined, isTrue);
    expect(j.parts, hasLength(1));
    expect(j.parts.single.bytes, 6000);
    expect(j.parts.single.source, 'android:joined');
  });

  test('after the join the job keeps the original segments, and reopens with them',
      () async {
    final q = build();
    await q.load();
    final job = await q.enqueueFromSession('sess1', 'k1');
    // before the join the parts are the segments: nothing extra is sent to the worker
    expect(job.toJson().containsKey('segments'), isFalse);
    final before = [for (final p in job.parts) (p.source, p.bytes)];
    runner.emit(
      UploadEvent(
        jobId: job.id,
        partIndex: 1,
        state: UploadPartState.queued,
        joined: true,
        total: 6000,
      ),
    );
    await pumpEventQueue();
    var j = (await q.jobs()).single;
    expect(j.parts.single.source, 'android:joined');
    expect([for (final s in j.segments) (s.source, s.bytes)], before);
    expect(j.toJson()['segments'], hasLength(3));
    // a second joined event does not replace them with the single joined part
    runner.emit(
      UploadEvent(
        jobId: job.id,
        partIndex: 1,
        state: UploadPartState.queued,
        joined: true,
        total: 6000,
      ),
    );
    await pumpEventQueue();
    j = (await q.jobs()).single;
    expect(j.segments, hasLength(3));
    // reopened from the store
    final again = build();
    j = (await again.jobs()).single;
    expect([for (final s in j.segments) (s.source, s.bytes)], before);
    expect(j.parts.single.source, 'android:joined');
  });

  test('a stopped run does not undo a pause', () async {
    final q = build();
    await q.load();
    final job = await q.enqueueFromSession('sess1', 'k1');
    await q.pause(job.id);
    runner.emit(
      UploadEvent(
        jobId: job.id,
        partIndex: 1,
        state: UploadPartState.queued,
        offset: 4096,
      ),
    );
    await pumpEventQueue();
    final j = (await q.jobs()).single;
    expect(j.parts.first.state, UploadPartState.paused);
    expect(j.parts.first.offset, 4096);
  });

  test('a job with no cloud session waits with no_cloud and starts later', () async {
    var hasCloud = false;
    final q = UploadQueue(
      store: store,
      runner: runner,
      now: () => clock,
      wifiOnly: () => wifiOnly,
      auth: () async => hasCloud
          ? UploadAuth(
              api: _FakeApi(),
              base: Uri.parse('https://cloud.example'),
              token: 'tok',
            )
          : null,
    );
    await q.load();
    final job = await q.enqueueFromSession('sess1', 'k1');
    await q.kick();
    expect(runner.started, isEmpty);
    expect((await q.jobs()).single.lastError, 'no_cloud');
    hasCloud = true;
    await q.kick();
    expect(runner.started, [job.id]);
    expect((await q.jobs()).single.lastError, isNull);
  });

  test('the job JSON never prints the upload URI in toString', () async {
    final q = build();
    await q.load();
    final job = await q.enqueueFromSession('sess1', 'k1');
    final p = job.parts.first.copyWith(uploadUri: 'https://secret.example/x');
    expect(p.toString(), isNot(contains('secret.example')));
  });

  test('segmentsFromRecordings lists files by index', () async {
    final l = await segmentsFromRecordings(rec, 'sess1');
    expect(l.map((s) => s.bytes), [1000, 2000, 3000]);
    expect(rec.calls, isEmpty);
    expect(Uint8List(0), isEmpty); // keep the import honest
  });
}
