// C6 of the 2026.11.15 Siaran langsung revamp (B1, U8, U4, U6): the APP asks
// the MAXCOM box for the upload address (`upload/begin`) and confirms the
// video (`upload/done`); the Android worker only sends bytes to Google. The
// fake worker here speaks the shapes the native side froze: it starts with
// the job, answers `needs_begin` for a part with no address, ends a part as
// `uploaded` with its video id, and never talks to the box.

import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:surau_app/l10n/s_lookup.dart';
import 'package:surau_app/features/upload/upload_widgets.dart' show jobErrorWords, partStatus;
import 'package:surau_app/store/local_store.dart';
import 'package:surau_app/upload/upload_queue.dart';

class _Api implements UploadApi, UploadAbandon {
  final List<UploadBeginRequest> begins = [];
  final List<String> dones = [];
  final List<String> abandoned = [];

  /// Thrown by the next [begin] / [done] calls while set.
  Object? beginError;
  Object? doneError;
  Object? abandonError;
  int _n = 0;

  @override
  Future<UploadBegun> begin(UploadBeginRequest r) async {
    final e = beginError;
    if (e != null) throw e;
    begins.add(r);
    _n++;
    return UploadBegun(
      uploadId: 'up$_n',
      uploadUri: 'https://www.googleapis.com/upload/youtube/v3/videos?upload_id=secret$_n',
      expiresAt: DateTime.utc(2026, 11, 30),
      title: 't',
    );
  }

  @override
  Future<void> done(String uploadId, String videoId) async {
    final e = doneError;
    if (e != null) throw e;
    dones.add('$uploadId:$videoId');
  }

  @override
  Future<void> abandon(String uploadId) async {
    abandoned.add(uploadId);
    final e = abandonError;
    if (e != null) throw e;
  }

  @override
  Future<UploadQuotaInfo> quota() async => throw UnimplementedError();
}

/// The Android worker as the native lane froze it.
class _Worker implements UploadRunner {
  _Worker(this.segments);

  final List<UploadSegment> segments;
  final StreamController<UploadEvent> _events = StreamController.broadcast(sync: true);
  UploadNetwork net = UploadNetwork.wifi;

  /// Every job handed to the worker, as it was at that moment.
  final List<UploadJob> started = [];
  final List<UploadAuth> auths = [];
  final List<String> cancelled = [];
  final List<String> forgotten = [];

  @override
  bool get survivesRestart => true;

  @override
  Stream<UploadEvent> get events => _events.stream;

  void emit(UploadEvent e) => _events.add(e);

  @override
  Future<UploadNetwork> network() async => net;

  @override
  Future<List<UploadSegment>> segmentsFor(String sessionId, String? kuliahId) async => segments;

  @override
  Future<void> start(UploadJob job, UploadAuth auth) async {
    started.add(job);
    auths.add(auth);
  }

  @override
  Future<void> cancel(String jobId) async => cancelled.add(jobId);

  @override
  Future<void> forget(String jobId) async => forgotten.add(jobId);

  @override
  Future<void> dispose() async => _events.close();
}

Future<void> _settle() async {
  for (var i = 0; i < 10; i++) {
    await Future<void>.delayed(Duration.zero);
  }
}

void main() {
  late MemoryLocalStore store;
  late _Api api;
  late _Worker worker;
  late bool boxSession;
  late bool join;
  final clock = DateTime.utc(2026, 11, 23, 10);

  UploadQueue build() => UploadQueue(
    store: store,
    runner: worker,
    now: () => clock,
    wifiOnly: () => true,
    joinSegments: () => join,
    appBegins: true,
    auth: () async => boxSession ? UploadAuth(api: api, base: Uri.parse('https://10.168.1.20:8443'), token: 'tok') : null,
  );

  setUp(() async {
    store = MemoryLocalStore();
    await store.open('0123456789abcdef');
    api = _Api();
    worker = _Worker(const [UploadSegment('android:content://media/1', 1000)]);
    boxSession = true;
    join = false;
  });

  Future<UploadJob> only(UploadQueue q) async => (await q.jobs()).single;

  test('[B1] happy path: queue, begin by the app, the worker sends, uploaded, done by the app, forget (success)', () async {
    final q = build();
    final job = await q.enqueueFromSession('s1', 'c3', replaceLive: 'liveVid0001');
    await q.kick();
    await _settle();
    // the app asked the box; the request carries the live session and the replacement
    final r = api.begins.single;
    expect(r.bytes, 1000);
    expect(r.kuliahId, 'c3');
    expect(r.sessionId, 's1');
    expect(r.replaceLiveVideoId, 'liveVid0001');
    expect(r.toJson()['sessionId'], 's1');
    // the worker got the job WITH the Google address on the part to send
    final handed = worker.started.single.parts.single;
    expect(handed.uploadUri, contains('googleapis.com'));
    expect(handed.uploadId, 'up1');
    // progress, then YouTube has it
    worker.emit(UploadEvent(jobId: job.id, partIndex: 1, state: UploadPartState.uploading, offset: 400, total: 1000));
    await _settle();
    expect((await only(q)).parts.single.offset, 400);
    worker.emit(UploadEvent(jobId: job.id, partIndex: 1, state: UploadPartState.uploaded, videoId: 'vid00000001', uploadId: 'up1', total: 1000));
    await _settle();
    var now = await only(q);
    expect(now.parts.single.state, UploadPartState.uploaded, reason: 'awaiting confirmation');
    expect(now.parts.single.uploadUri, isNull, reason: 'the address is a secret: dropped once used');
    expect(partStatus(sBm, now.parts.single, UploadPolicy.run, quotaTime: null).$2, 'Menunggu pengesahan');
    // the app confirms with the box, then the worker's state is dropped
    await q.kick();
    await _settle();
    expect(api.dones, ['up1:vid00000001']);
    now = await only(q);
    expect(now.isDone, isTrue);
    expect(now.lastError, isNull);
    expect(worker.forgotten, [job.id]);
    await q.dispose();
  });

  test('the older worker shape (uploading, sent in full, video id) is the same hand-over', () async {
    final q = build();
    final job = await q.enqueueFromSession('s1', null);
    await q.kick();
    await _settle();
    worker.emit(UploadEvent(jobId: job.id, partIndex: 1, state: UploadPartState.uploading, offset: 1000, total: 1000, videoId: 'vid00000001', uploadId: 'up1'));
    await _settle();
    expect((await only(q)).parts.single.state, UploadPartState.uploaded);
    await q.kick();
    await _settle();
    expect(api.dones, ['up1:vid00000001']);
    expect((await only(q)).isDone, isTrue);
    await q.dispose();
  });

  test('[B1] begin_failed is SHOWN on the card, the part waits, and the next timed kick asks again', () async {
    final q = build();
    await q.enqueueFromSession('s1', null);
    api.beginError = StateError('the box did not answer');
    await q.kick();
    await _settle();
    var job = await only(q);
    expect(job.lastError, 'begin_failed');
    expect(job.parts.single.state, UploadPartState.queued, reason: 'it waits; nothing failed for good');
    expect(jobErrorWords(sBm, job), 'Tidak dapat menghubungi MAXCOM');
    expect(worker.started, isEmpty, reason: 'the worker is not started without an address');
    // a kick that only follows the list's own change does not hammer the box
    await q.kick(retryFailed: false);
    await _settle();
    expect(api.begins, isEmpty);
    // the box is back
    api.beginError = null;
    await q.kick();
    await _settle();
    job = await only(q);
    expect(api.begins, hasLength(1));
    expect(job.lastError, isNull);
    expect(worker.started, hasLength(1));
    await q.dispose();
  });

  test('every reason code of the worker is kept and worded: network, empty_file, runner_error', () async {
    final q = build();
    final job = await q.enqueueFromSession('s1', null);
    await q.kick();
    await _settle();
    worker.emit(UploadEvent(jobId: job.id, partIndex: 1, state: UploadPartState.queued, error: 'network'));
    await _settle();
    expect((await only(q)).lastError, 'network');
    expect(jobErrorWords(sBm, await only(q)), sBm.uploadWaitNetwork);
    worker.emit(UploadEvent(jobId: job.id, partIndex: 1, state: UploadPartState.uploading, offset: 10, total: 1000));
    await _settle();
    expect((await only(q)).lastError, isNull, reason: 'bytes are moving again');
    worker.emit(UploadEvent(jobId: job.id, partIndex: 1, state: UploadPartState.failed, error: 'empty_file'));
    await _settle();
    expect(jobErrorWords(sBm, await only(q)), 'Fail rakaman kosong');
    await q.retry(job.id);
    worker.emit(UploadEvent(jobId: job.id, partIndex: 1, state: UploadPartState.failed, error: 'runner_error'));
    await _settle();
    expect(jobErrorWords(sBm, await only(q)), isNotNull, reason: 'never silent');
    await q.dispose();
  });

  test('needs_begin from the worker (its address died): the app gets a new one and starts the job again', () async {
    final q = build();
    final job = await q.enqueueFromSession('s1', null);
    await q.kick();
    await _settle();
    expect(api.begins, hasLength(1));
    worker.emit(UploadEvent(jobId: job.id, partIndex: 1, state: UploadPartState.queued, error: 'needs_begin', clearSession: true));
    await _settle();
    var now = await only(q);
    expect(now.parts.single.uploadUri, isNull);
    expect(now.lastError, isNull, reason: 'an internal request, not a reason for the person');
    await q.kick();
    await _settle();
    now = await only(q);
    expect(api.begins, hasLength(2));
    expect(worker.started, hasLength(2));
    expect(worker.started.last.parts.single.uploadId, 'up2');
    await q.dispose();
  });

  test('[Q3] a dropped upload session tells the box its old upload is abandoned; a box that is away does not hold the job', () async {
    final q = build();
    final job = await q.enqueueFromSession('s1', null);
    await q.kick();
    await _settle();
    expect((await only(q)).parts.single.uploadId, 'up1');
    worker.emit(UploadEvent(jobId: job.id, partIndex: 1, state: UploadPartState.queued, error: 'needs_begin', clearSession: true));
    await _settle();
    expect(api.abandoned, ['up1'], reason: 'the old row would count against the cap of open uploads for days');
    expect((await only(q)).parts.single.uploadId, isNull);
    await q.kick();
    await _settle();
    expect((await only(q)).parts.single.uploadId, 'up2');

    // the box does not answer the abandon: the job goes on all the same
    api.abandonError = StateError('away');
    worker.emit(UploadEvent(jobId: job.id, partIndex: 1, state: UploadPartState.queued, error: 'needs_begin', clearSession: true));
    await _settle();
    expect(api.abandoned, ['up1', 'up2']);
    var now = await only(q);
    expect(now.lastError, isNull);
    await q.kick();
    await _settle();
    now = await only(q);
    expect(now.parts.single.uploadId, 'up3');
    expect(worker.started, hasLength(3));

    // a report that keeps the session abandons nothing
    worker.emit(UploadEvent(jobId: job.id, partIndex: 1, state: UploadPartState.uploading, offset: 10, total: 1000));
    await _settle();
    expect(api.abandoned, ['up1', 'up2']);
    await q.dispose();
  });

  test('joinSegments: the worker joins first, then asks; the app begins ONE upload for the joined file', () async {
    join = true;
    worker = _Worker(const [UploadSegment('android:content://media/1', 600), UploadSegment('android:content://media/2', 500)]);
    final q = build();
    final job = await q.enqueueFromSession('s1', null);
    await q.kick();
    await _settle();
    expect(api.begins, isEmpty, reason: 'nothing to begin before the join');
    expect(worker.started.single.parts.every((p) => p.uploadUri == null), isTrue);
    worker.emit(UploadEvent(jobId: job.id, partIndex: 1, state: UploadPartState.queued, joined: true, total: 1100, error: 'needs_begin'));
    await _settle();
    await q.kick();
    await _settle();
    final r = api.begins.single;
    expect(r.bytes, 1100);
    expect(r.part, isNull, reason: 'one file, one video');
    expect(worker.started.last.parts.single.source, 'android:joined');
    expect(worker.started.last.parts.single.uploadUri, isNotNull);
    await q.dispose();
  });

  test('the box away after the upload: the part waits as "Menunggu pengesahan" and is confirmed at the next contact', () async {
    final q = build();
    final job = await q.enqueueFromSession('s1', null);
    await q.kick();
    await _settle();
    worker.emit(UploadEvent(jobId: job.id, partIndex: 1, state: UploadPartState.uploaded, videoId: 'vid00000001', uploadId: 'up1', total: 1000));
    await _settle();
    api.doneError = StateError('away');
    await q.kick();
    await _settle();
    var now = await only(q);
    expect(now.parts.single.state, UploadPartState.uploaded);
    expect(now.lastError, 'done_failed');
    expect(jobErrorWords(sBm, now), 'Tidak dapat menghubungi MAXCOM');
    expect(worker.started, hasLength(1), reason: 'nothing is sent to YouTube again');
    api.doneError = null;
    await q.kick();
    await _settle();
    now = await only(q);
    expect(now.isDone, isTrue);
    expect(api.dones, ['up1:vid00000001']);
    await q.dispose();
  });

  test('[U6] the box refuses a second device for the same live: already_uploading is shown', () async {
    final q = build();
    await q.enqueueFromSession('s1', null);
    api.beginError = const UploadApiException('already_uploading');
    await q.kick();
    await _settle();
    final job = await only(q);
    expect(job.lastError, 'already_uploading');
    expect(job.parts.single.state, UploadPartState.failed);
    expect(jobErrorWords(sBm, job), 'Rakaman siaran ini sedang dimuat naik dari peranti lain.');
    expect(worker.started, isEmpty);
    await q.dispose();
  });

  test('the quota answer of begin is the app\'s to keep: the part waits until the reset', () async {
    final q = build();
    await q.enqueueFromSession('s1', null);
    final resets = clock.add(const Duration(hours: 5));
    api.beginError = UploadQuotaException(resets);
    await q.kick();
    await _settle();
    final job = await only(q);
    expect(job.parts.single.state, UploadPartState.quota);
    expect(job.quotaResetsAt, resets);
    expect(q.policy(job, UploadNetwork.wifi), UploadPolicy.waitQuota);
    await q.dispose();
  });

  test('[U4] removing a job with an open upload tells the box it is abandoned', () async {
    final q = build();
    final job = await q.enqueueFromSession('s1', null);
    await q.kick();
    await _settle();
    await q.remove(job.id);
    await _settle();
    expect(api.abandoned, ['up1']);
    expect(await q.jobs(), isEmpty);
    await q.dispose();
  });

  test('[U8] a running job is not started again by further kicks (a changed box address rebuilds nothing)', () async {
    final q = build();
    await q.enqueueFromSession('s1', null);
    await q.kick();
    await _settle();
    for (var i = 0; i < 3; i++) {
      await q.kick();
      await _settle();
    }
    expect(worker.started, hasLength(1));
    expect(api.begins, hasLength(1));
    expect(worker.cancelled, isEmpty);
    await q.dispose();
  });

  test('no session on the box: the job waits with no_box and the worker is not started', () async {
    boxSession = false;
    final q = build();
    await q.enqueueFromSession('s1', null);
    await q.kick();
    await _settle();
    expect((await only(q)).lastError, 'no_box');
    expect(worker.started, isEmpty);
    await q.dispose();
  });
}
