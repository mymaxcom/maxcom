// "Muat naik rakaman terdahulu" (U1) and the replacement offered from the
// box's own record of the live (D2), against a fake box that answers
// `GET /api/live/sessions/recent` in the frozen shape and a fake worker.

import 'dart:async';

import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:surau_app/app/deps.dart';
import 'package:surau_app/app/providers.dart';
import 'package:surau_app/box/wire.dart';
import 'package:surau_app/features/common/surau_info.dart';
import 'package:surau_app/features/enrol/enrol_flow.dart';
import 'package:surau_app/features/shell/box_gateway.dart';
import 'package:surau_app/features/shell/read_cache.dart';
import 'package:surau_app/features/upload/cleanup_providers.dart';
import 'package:surau_app/features/upload/earlier_recordings.dart';
import 'package:surau_app/features/upload/upload_widgets.dart';
import 'package:surau_app/store/local_store.dart';
import 'package:surau_app/upload/session_files.dart';
import 'package:surau_app/upload/upload_queue.dart';

import '../features/fakes.dart';

class _Api implements UploadApi {
  @override
  Future<UploadBegun> begin(UploadBeginRequest r) async => throw UnimplementedError();
  @override
  Future<void> done(String uploadId, String videoId) async {}
  @override
  Future<UploadQuotaInfo> quota() async => throw UnimplementedError();
}

class _Worker implements UploadRunner {
  final Map<String, List<int>> onPhone = {};
  final StreamController<UploadEvent> _events = StreamController.broadcast();

  @override
  bool get survivesRestart => true;
  @override
  Stream<UploadEvent> get events => _events.stream;
  @override
  Future<UploadNetwork> network() async => UploadNetwork.wifi;
  @override
  Future<List<UploadSegment>> segmentsFor(String sessionId, String? kuliahId) async => [
    for (final (i, b) in (onPhone[sessionId] ?? const <int>[]).indexed) UploadSegment('android:content://m/$sessionId/$i', b),
  ];
  @override
  Future<void> start(UploadJob job, UploadAuth auth) async {}
  @override
  Future<void> cancel(String jobId) async {}
  @override
  Future<void> forget(String jobId) async {}
  @override
  Future<void> dispose() async => _events.close();
}

class _Reach implements ReachSink {
  BoxReach _r = BoxReach.unknown;
  @override
  BoxReach get reach => _r;
  @override
  void markUp(DateTime at) => _r = _r.up(at);
  @override
  void markDown(DateTime at) => _r = _r.failed(at);
}

Map<String, Object?> _row(String id, {int gap = 0, List<String> broadcasts = const [], String? stopped = '2026-11-22T13:00:00.000Z', String started = '2026-11-22T12:00:00.000Z'}) => {
  'id': id,
  'startedBy': 'Tablet Surau',
  'kuliahId': 'c3',
  'outputs': {'kiosk': true, 'youtube': broadcasts.isNotEmpty},
  'startedAt': started,
  'stoppedAt': stopped,
  'reason': stopped == null ? null : 'stopped',
  'broadcastIds': broadcasts,
  'gaps': [
    if (gap > 0) {'from': '2026-11-22T12:10:00.000Z', 'to': '2026-11-22T12:15:00.000Z', 'kind': 'youtube', 'broadcastId': broadcasts.isEmpty ? null : broadcasts.last},
  ],
  'gapSeconds': gap,
  'mine': false,
};

void main() {
  late MemoryLocalStore store;
  late _Worker worker;
  late UploadQueue queue;
  late List<Map<String, Object?>>? recent;
  late ProviderContainer c;

  Future<void> open({String platform = 'android'}) async {
    store = MemoryLocalStore();
    await store.open('0123456789abcdef');
    worker = _Worker();
    queue = UploadQueue(
      store: store,
      runner: worker,
      now: fixedNow,
      auth: () async => UploadAuth(api: _Api(), base: Uri.parse('https://box.test:8443'), token: 't'),
    );
    final box = FakeBox((r) async {
      if (r.url.path == '/api/live/sessions/recent') {
        return recent == null ? jsonResponse(404, {'errors': ['tiada']}) : jsonResponse(200, {'sessions': recent});
      }
      return jsonResponse(404, {'errors': ['tiada']});
    });
    final enrolled = fixtureBox(roles: ['media']);
    c = ProviderContainer(
      overrides: [
        appDepsProvider.overrideWithValue(
          AppDeps(
            boxStore: MemoryEnrolledBoxStore()..save(enrolled),
            surauInfoStore: MemorySurauInfoStore(SurauInfo.fromJson(fixtureInfoJson)),
            key: FakeDeviceKey(present: true),
            trust: FakeTrust(),
            biometric: FakeBiometricPin(),
            clientFor: (u) => box.client(u),
            enrolledClient: (b) async => box.client(b.box),
            platform: platform,
            cameraAvailable: false,
            healthPollInterval: null,
            now: fixedNow,
            initialBox: enrolled,
          ),
        ),
        gatewayProvider.overrideWithValue(
          BoxGateway(
            client: box.client(Uri.parse('https://box.test:8443')),
            token: 't',
            cache: ReadCache(),
            reach: _Reach(),
            now: fixedNow,
            onSessionExpired: () {},
          ),
        ),
        sessionFilesProvider.overrideWithValue(SessionFiles(store)),
        catchUpQueueProvider.overrideWithValue(queue),
      ],
    );
    addTearDown(() {
      c.dispose();
      // not awaited: the jobs stream of the disposed container may still be closing
      unawaited(queue.dispose());
    });
  }

  Future<void> recorded(String session, List<int> bytes) async {
    await SessionFiles(store).save(session, [
      for (var i = 0; i < bytes.length; i++) 'MAXCOM-2026-11-22-2045-c3-${(i + 1).toString().padLeft(2, '0')}.mp4',
    ]);
    worker.onPhone[session] = bytes;
  }

  setUp(() => recent = null);

  test('[U1] a recording whose stop sheet was dismissed is still offered: it is listed, then queued (success)', () async {
    await open();
    await recorded('s1', [400, 300]);
    c.listen(earlierRecordingsProvider, (_, _) {});
    final list = await c.read(earlierRecordingsProvider.future);
    expect(list.single.sessionId, 's1');
    expect(list.single.bytes, 700);
    expect(list.single.files, 2);
    final job = await queue.enqueueFromSession(list.single.sessionId, list.single.kuliahId);
    expect(job.parts, hasLength(2));
    // once queued it is no longer "earlier"
    for (var i = 0; i < 10; i++) {
      await Future<void>.delayed(Duration.zero);
    }
    expect(c.read(catchUpJobsProvider).value, hasLength(1));
    for (var i = 0; i < 10; i++) {
      await Future<void>.delayed(Duration.zero);
    }
    expect(c.read(earlierRecordingsProvider).value, isEmpty);
  });

  test('a session whose files are gone from the phone is not offered; nor is a live still running', () async {
    await open();
    await recorded('gone', [100]);
    worker.onPhone.remove('gone');
    await recorded('running', [100]);
    recent = [_row('running', stopped: null)];
    expect(await c.read(earlierRecordingsProvider.future), isEmpty);
  });

  test('the web has no such list (the browser\'s own banner covers it)', () async {
    await open(platform: 'web');
    await recorded('s1', [100]);
    expect(await c.read(earlierRecordingsProvider.future), isEmpty);
  });

  test('[D2] a second phone holding the recording learns the gap and the broadcast from the box\'s record', () async {
    await open();
    await recorded('s1', [400]);
    recent = [_row('s1', gap: 300, broadcasts: ['liveVid0001'])];
    final rec = (await c.read(earlierRecordingsProvider.future)).single;
    expect(rec.gappy, isTrue);
    expect(rec.gapMinutes, 5);
    expect(rec.liveVideoId, 'liveVid0001');
    expect(rec.kuliahId, 'c3');
    // ask: the person decides, with the minutes in the question
    expect(replaceDecision(rec, 'ask'), (replace: 'liveVid0001', ask: true));
    // always: replaced without a question; never: not replaced
    expect(replaceDecision(rec, 'always'), (replace: 'liveVid0001', ask: false));
    expect(replaceDecision(rec, 'never'), (replace: null, ask: false));
    final job = await queue.enqueueFromSession(rec.sessionId, rec.kuliahId, replaceLive: replaceDecision(rec, 'always').replace);
    expect(job.replaceLiveVideoId, 'liveVid0001');
  });

  test('[D2] "always" acts only when the box-recorded gap passes the threshold; no broadcast means nothing to replace', () async {
    await open();
    await recorded('short', [400]);
    await recorded('tvonly', [400]);
    recent = [
      _row('short', gap: 20, broadcasts: ['liveVid0002']),
      _row('tvonly', gap: 600),
    ];
    final list = await c.read(earlierRecordingsProvider.future);
    final short = list.firstWhere((r) => r.sessionId == 'short');
    final tvOnly = list.firstWhere((r) => r.sessionId == 'tvonly');
    expect(short.gappy, isFalse);
    expect(replaceDecision(short, 'always'), (replace: null, ask: false));
    expect(replaceDecision(short, 'ask'), (replace: null, ask: false));
    expect(tvOnly.gappy, isFalse);
    expect(replaceDecision(tvOnly, 'always').replace, isNull);
  });

  test('an older box (no sessions route): the recording is still offered, without a replacement', () async {
    await open();
    await recorded('s1', [400]);
    recent = null;
    final rec = (await c.read(earlierRecordingsProvider.future)).single;
    expect(rec.live, isNull);
    expect(replaceDecision(rec, 'always').replace, isNull);
  });

  test('the sessions route is read in its frozen shape; rows that are not sessions are dropped', () {
    final rows = LiveSessionSummaryDto.listFrom({
      'sessions': [
        _row('s1', gap: 300, broadcasts: ['a', 'b']),
        {'nope': true},
        'x',
      ],
    });
    expect(rows.single.id, 's1');
    expect(rows.single.lastBroadcastId, 'b');
    expect(rows.single.gaps.single.kind, 'youtube');
    expect(rows.single.gapSeconds, 300);
    expect(rows.single.youtube, isTrue);
    expect(rows.single.stoppedAt, DateTime.utc(2026, 11, 22, 13));
  });
}
