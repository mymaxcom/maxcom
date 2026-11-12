// Plan 6 Task 11: the YouTube catch-up screen and the Live tab hooks, over
// the real UploadQueue with a fake runner (no HTTP, no WorkManager) and a
// recordings store that fails the test if anything deletes from it.
//
// Goldens (three sizes each): upload_list, upload_running, upload_wait_wifi,
// upload_quota, upload_done, upload_empty, live_ended_catchup.

import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:surau_app/app/providers.dart';
import 'package:surau_app/features/live/fake_publisher.dart';
import 'package:surau_app/features/live/live_screen.dart';
import 'package:surau_app/features/live/publisher.dart';
import 'package:surau_app/features/live/recordings_store.dart';
import 'package:surau_app/features/shell/menu.dart';
import 'package:surau_app/features/shell/permissions.dart';
import 'package:surau_app/features/upload/upload_widgets.dart';
import 'package:surau_app/l10n/generated/s_ms.dart';
import 'package:surau_app/store/local_store.dart';
import 'package:surau_app/upload/upload_queue.dart';

import '../features/shell/harness.dart';
import '../golden_sizes.dart';

/// A recordings store that records any delete or move.
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
  _FakeApi(this.quotaInfo);

  UploadQuotaInfo? quotaInfo;

  @override
  Future<UploadBegun> begin(UploadBeginRequest r) async =>
      throw UnimplementedError();

  @override
  Future<void> done(String uploadId, String videoId) async {}

  @override
  Future<UploadQuotaInfo> quota() async {
    final q = quotaInfo;
    if (q == null) throw const UploadApiException('cloud_unreachable');
    return q;
  }
}

/// Segments per session as the test sets them; starting a job reports its
/// first open part as uploading from its offset, like a real runner would.
class _FakeRunner implements UploadRunner {
  final StreamController<UploadEvent> _events = StreamController.broadcast(
    sync: true,
  );
  final Map<String, List<int>> sessions = {};
  UploadNetwork net = UploadNetwork.wifi;
  final List<String> started = [];
  final List<String> cancelled = [];

  void emit(UploadEvent e) => _events.add(e);

  @override
  bool get survivesRestart => true;

  @override
  Stream<UploadEvent> get events => _events.stream;

  @override
  Future<UploadNetwork> network() async => net;

  @override
  Future<List<UploadSegment>> segmentsFor(
    String sessionId,
    String? kuliahId,
  ) async => [
    for (final (i, b) in (sessions[sessionId] ?? const <int>[]).indexed)
      UploadSegment('android:content://media/$sessionId/${i + 1}', b),
  ];

  @override
  Future<void> start(UploadJob job, UploadAuth auth) async {
    started.add(job.id);
    final open = job.parts.where((p) => !p.isDone).toList();
    if (open.isEmpty) return;
    emit(
      UploadEvent(
        jobId: job.id,
        partIndex: open.first.index,
        state: UploadPartState.uploading,
        offset: open.first.offset,
      ),
    );
  }

  @override
  Future<void> cancel(String jobId) async => cancelled.add(jobId);

  // Task 10 may ask for this on the runner (ForgetfulUploadRunner).
  // ignore: annotate_overrides
  Future<void> forget(String jobId) async {}

  @override
  Future<void> dispose() async => _events.close();
}

const _mb = 1024 * 1024;

/// 16:00 Malaysian time on the harness's day is 08:00 UTC the next day
/// (the Pacific midnight after the harness's 22:30).
final DateTime _resets = DateTime.utc(2026, 11, 5, 8);

class _Up {
  _Up(this.h, this.queue, this.runner, this.recordings, this.api);

  final ShellHarness h;
  final UploadQueue queue;
  final _FakeRunner runner;
  final _SpyRecordings recordings;
  final _FakeApi api;

  Future<UploadJob> job() async => (await queue.jobs()).single;
}

Future<_Up> _open(
  WidgetTester tester, {
  List<String> roles = const ['media'],
  bool catchUp = true,
  UploadNetwork net = UploadNetwork.wifi,
  Future<void> Function(UploadQueue q, _FakeRunner r)? seed,
  bool quota = true,
  LiveBoxStatus box = const LiveBoxStatus(
    youtube: YoutubeAccount.signedIn('Surau D\'Waqaf'),
  ),
  String go = '/upload',
}) async {
  final runner = _FakeRunner()..net = net;
  final recordings = _SpyRecordings();
  final api = _FakeApi(
    quota
        ? UploadQuotaInfo(uploadsToday: 3, uploadLimit: 100, resetsAt: _resets)
        : null,
  );
  final store = MemoryLocalStore();
  final queue = UploadQueue(
    store: store,
    runner: runner,
    now: () => DateTime.utc(2026, 11, 4, 14, 30),
    wifiOnly: () => true,
    auth: () async => UploadAuth(
      api: api,
      base: Uri.parse('https://cloud.example'),
      token: 'tok',
    ),
  );
  await store.open('0123456789abcdef');
  await queue.load();
  if (seed != null) await seed(queue, runner);
  final h = await pumpShell(
    tester,
    roles: roles,
    features: {'youtubeCatchUp': catchUp},
    overrides: [
      livePublisherProvider.overrideWithValue(FakePublisher()),
      liveBoxProvider.overrideWith(() => LiveBoxNotifier(box)),
      recordingsStoreProvider.overrideWithValue(recordings),
      catchUpQueueProvider.overrideWithValue(queue),
    ],
  );
  h.router.go(go);
  await settle(tester);
  await settle(tester);
  return _Up(h, queue, runner, recordings, api);
}

/// A kuliah of 4 segments, the second one 35% of the way.
Future<void> _running(UploadQueue q, _FakeRunner r) async {
  r.sessions['s-isyak'] = [400 * _mb, 400 * _mb, 400 * _mb, 120 * _mb];
  final j = await q.enqueueFromSession('s-isyak', 'c3');
  r.emit(
    UploadEvent(
      jobId: j.id,
      partIndex: 1,
      state: UploadPartState.done,
      offset: 400 * _mb,
      videoId: 'vid1',
    ),
  );
  r.emit(
    UploadEvent(
      jobId: j.id,
      partIndex: 2,
      state: UploadPartState.uploading,
      offset: 140 * _mb,
    ),
  );
  // the fake runner delivers its events synchronously
}

Future<void> _waitWifi(UploadQueue q, _FakeRunner r) async {
  r.sessions['s-subuh'] = [610 * _mb, 238 * _mb];
  await q.enqueueFromSession('s-subuh', 'c2');
}

Future<void> _quota(UploadQueue q, _FakeRunner r) async {
  r.sessions['s-isyak'] = [400 * _mb, 300 * _mb];
  final j = await q.enqueueFromSession('s-isyak', 'c3');
  r.emit(
    UploadEvent(
      jobId: j.id,
      partIndex: 1,
      state: UploadPartState.done,
      offset: 400 * _mb,
      videoId: 'vid1',
    ),
  );
  r.emit(
    UploadEvent(
      jobId: j.id,
      partIndex: 2,
      state: UploadPartState.quota,
      resetsAt: _resets,
    ),
  );
  // the fake runner delivers its events synchronously
}

Future<void> _done(UploadQueue q, _FakeRunner r) async {
  r.sessions['s-isyak'] = [1310 * _mb];
  final j = await q.enqueueFromSession('s-isyak', 'c3', replaceLive: 'live9');
  r.emit(
    UploadEvent(
      jobId: j.id,
      partIndex: 1,
      state: UploadPartState.done,
      offset: 1310 * _mb,
      videoId: 'Xy12ab',
    ),
  );
  // the fake runner delivers its events synchronously
}

/// Three jobs at once: one sending, one waiting for Wi-Fi with the
/// replace-live chip, one done without a kuliah.
Future<void> _list(UploadQueue q, _FakeRunner r) async {
  await _running(q, r);
  r.sessions['s-subuh'] = [610 * _mb, 238 * _mb];
  await q.enqueueFromSession('s-subuh', 'c2', replaceLive: 'live7');
  r.sessions['s-none'] = [96 * _mb];
  final j = await q.enqueueFromSession('s-none', null);
  r.emit(
    UploadEvent(
      jobId: j.id,
      partIndex: 1,
      state: UploadPartState.done,
      offset: 96 * _mb,
      videoId: 'Qq77',
    ),
  );
  // the fake runner delivers its events synchronously
}

PublisherState _live({int duration = 2843}) => PublisherState(
  phase: PublisherPhase.live,
  outputs: const PublisherOutputs(
    kiosk: OutputState.up,
    youtube: OutputState.up,
  ),
  recording: const RecordingState(on: true, segments: 4, bytes: 1395864371),
  stats: const StreamStats(bitrateKbps: 2450, fps: 30, rttMs: 18),
  durationSec: duration,
);

/// Opens the Live tab, runs a live whose YouTube leg got 25 of 47 minutes,
/// and stops it: the summary is on screen.
Future<_Up> _stopShortLive(WidgetTester tester, {bool catchUp = true}) async {
  final t = await _open(
    tester,
    catchUp: catchUp,
    go: '/live',
    box: const LiveBoxStatus(
      youtube: YoutubeAccount.signedIn('Surau D\'Waqaf'),
      sessionId: 'box-sess-7',
      youtubeSeconds: 1500,
      watchUrl: 'https://www.youtube.com/watch?v=abc123',
    ),
  );
  t.runner.sessions['box-sess-7'] = [400 * _mb, 400 * _mb, 300 * _mb];
  final pub = t.h.container.read(livePublisherProvider) as FakePublisher;
  pub.emit(_live());
  await settle(tester);
  await tester.tap(find.byKey(const ValueKey('live-stop')));
  await settle(tester);
  await tester.tap(find.text('Hentikan'));
  await settle(tester);
  return t;
}

Finder get _mobileSwitch => find.descendant(
  of: find.byKey(const ValueKey('upload-allow-mobile')),
  matching: find.byType(Switch),
);

void main() {
  group('screen', () {
    testWidgets('a running job shows the part and its percentage', (
      tester,
    ) async {
      await _open(tester, seed: _running);
      expect(find.text('Muat naik YouTube'), findsWidgets);
      expect(find.text('Bahagian 2 daripada 4: 35%'), findsOneWidget);
      expect(find.text('Kuliah Isyak'), findsOneWidget);
      expect(find.text('3 daripada 100 muat naik hari ini'), findsOneWidget);
      await reveal(tester, find.text('Muat naik berjalan di latar belakang.'));
      expect(
        find.text('Muat naik berjalan di latar belakang.'),
        findsOneWidget,
      );
      expect(find.text('Jeda'), findsOneWidget);
    });

    testWidgets('the quota line is hidden when the cloud cannot be reached', (
      tester,
    ) async {
      await _open(tester, seed: _running, quota: false);
      expect(find.textContaining('muat naik hari ini'), findsNothing);
      expect(find.text('Bahagian 2 daripada 4: 35%'), findsOneWidget);
    });

    testWidgets(
      'a wait_wifi part shows Menunggu Wi-Fi and the toggle runs it',
      (tester) async {
        final t = await _open(
          tester,
          seed: _waitWifi,
          net: UploadNetwork.cellular,
        );
        expect(find.text('Menunggu Wi-Fi'), findsWidgets);
        expect(find.text('Fail ini 848 MB'), findsOneWidget);
        expect(t.runner.started, isEmpty);
        await tester.tap(_mobileSwitch);
        await settle(tester);
        await settle(tester);
        expect((await t.job()).allowMobile, isTrue);
        expect(t.runner.started, hasLength(1), reason: 'the queue ran it');
        expect(find.text('Menunggu Wi-Fi'), findsNothing);
        expect(find.text('Bahagian 1 daripada 2: 0%'), findsOneWidget);
      },
    );

    testWidgets('no network at all says Menunggu rangkaian', (tester) async {
      await _open(tester, seed: _waitWifi, net: UploadNetwork.none);
      expect(find.text('Menunggu rangkaian'), findsWidgets);
    });

    testWidgets('quota shows the message with the reset time in MYT', (
      tester,
    ) async {
      await _open(tester, seed: _quota);
      expect(
        find.text(
          'Had muat naik YouTube untuk hari ini telah dicapai. '
          'Cuba lagi selepas 16:00',
        ),
        findsOneWidget,
      );
      expect(find.text('Had kuota: cuba lagi selepas 16:00'), findsOneWidget);
      expect(find.text('Cuba lagi'), findsOneWidget);
    });

    testWidgets('pause and resume go to the queue', (tester) async {
      final t = await _open(tester, seed: _running);
      await tester.tap(find.text('Jeda'));
      await settle(tester);
      expect((await t.job()).isPaused, isTrue);
      expect(find.text('Dijeda'), findsWidgets);
      await tester.tap(find.text('Sambung'));
      await settle(tester);
      expect((await t.job()).isPaused, isFalse);
    });

    testWidgets('a done job links to YouTube and shows the replace note', (
      tester,
    ) async {
      final t = await _open(tester, seed: _done);
      expect(find.text('Selesai'), findsWidgets);
      expect(find.text('Gantikan siaran yang terputus'), findsOneWidget);
      expect(
        find.text(
          'Siaran asal akan dijadikan peribadi selepas muat naik selesai',
        ),
        findsOneWidget,
      );
      await tester.tap(find.text('Lihat di YouTube'));
      await settle(tester);
      expect(
        t.h.opener.opened.single.toString(),
        'https://www.youtube.com/watch?v=Xy12ab',
      );
      expect(find.text('Jeda'), findsNothing);
      expect(find.byKey(const ValueKey('upload-allow-mobile')), findsNothing);
    });

    testWidgets('Buang daripada senarai asks first and never touches the '
        'recordings', (tester) async {
      final t = await _open(tester, seed: _waitWifi);
      await reveal(tester, find.text('Buang daripada senarai'));
      await tester.tap(find.text('Buang daripada senarai'));
      await settle(tester);
      expect(
        find.text('Rakaman kekal di peranti. Buang tugasan ini?'),
        findsOneWidget,
      );
      await tester.tap(find.text('Batal'));
      await settle(tester);
      expect(await t.queue.jobs(), hasLength(1));

      await tester.tap(find.text('Buang daripada senarai'));
      await settle(tester);
      await tester.tap(find.text('Buang'));
      await settle(tester);
      expect(await t.queue.jobs(), isEmpty);
      expect(t.recordings.calls, isEmpty);
      expect(find.text('Tiada muat naik'), findsOneWidget);
    });

    testWidgets('no jobs: the empty state', (tester) async {
      await _open(tester);
      expect(find.text('Tiada muat naik'), findsOneWidget);
    });

    testWidgets('no upload URI or token is ever on the screen', (tester) async {
      await _open(
        tester,
        seed: (q, r) async {
          await _running(q, r);
          final j = (await q.jobs()).single;
          r.emit(
            UploadEvent(
              jobId: j.id,
              partIndex: 2,
              state: UploadPartState.uploading,
              offset: 150 * _mb,
              uploadId: 'up2',
              uploadUri: 'https://upload.example/secret-session',
            ),
          );
          // the fake runner delivers its events synchronously
        },
      );
      expect(find.textContaining('upload.example'), findsNothing);
      expect(find.textContaining('tok'), findsNothing);
      expect(find.textContaining('up2'), findsNothing);
    });
  });

  group('menu and route', () {
    test('media and admins get Muat naik YouTube under Live; AJK never', () {
      final s = SMs();
      final on = FeatureFlags.defaults.copyWith({'youtubeCatchUp': true});
      List<String> labels(Set<String> roles, FeatureFlags f) =>
          menuFor(roles, f).map((i) => i.label(s)).toList();
      final media = labels({'media'}, on);
      expect(
        media.indexOf('Muat naik YouTube'),
        media.indexOf('Siaran langsung') + 1,
      );
      expect(labels({'admin'}, on), contains('Muat naik YouTube'));
      expect(labels({'ajk'}, on), isNot(contains('Muat naik YouTube')));
      expect(labels({'treasurer'}, on), isNot(contains('Muat naik YouTube')));
      final off = FeatureFlags.defaults.copyWith({'youtubeCatchUp': false});
      expect(labels({'media'}, off), isNot(contains('Muat naik YouTube')));
      expect(routeAllowed('/upload', {'ajk'}, on), isFalse);
      expect(routeAllowed('/upload', {'media'}, on), isTrue);
      expect(routeAllowed('/upload', {'media'}, off), isFalse);
    });

    testWidgets('an AJK sent to /upload goes home with the notice', (
      tester,
    ) async {
      final t = await _open(tester, roles: const ['ajk']);
      expect(t.h.location, '/');
      expect(find.text('Tiada kebenaran untuk tindakan ini'), findsOneWidget);
      expect(find.text('Muat naik YouTube'), findsNothing);
    });

    testWidgets('the running-jobs count for the menu badge', (tester) async {
      final t = await _open(tester, seed: _list);
      expect(
        t.h.container.read(catchUpActiveCountProvider),
        2,
        reason: 'the running and the waiting job; the done one is not counted',
      );
    });
  });

  group('Live tab', () {
    testWidgets('a short YouTube leg offers the upload; ask shows the sheet', (
      tester,
    ) async {
      final t = await _stopShortLive(tester);
      expect(find.text('Siaran tamat'), findsOneWidget);
      expect(find.text('Muat naik rakaman penuh ke YouTube'), findsOneWidget);
      await tester.tap(find.text('Muat naik rakaman penuh ke YouTube'));
      await settle(tester);
      expect(find.text('Gantikan siaran yang terputus'), findsOneWidget);
      expect(find.text('Simpan kedua-duanya'), findsOneWidget);
      await tester.tap(find.text('Gantikan siaran yang terputus'));
      await settle(tester);
      await settle(tester);
      final job = await t.job();
      expect(job.sessionId, 'box-sess-7');
      expect(job.kuliahId, isNull, reason: 'no kuliah today in the fixture');
      expect(job.replaceLiveVideoId, 'abc123');
      expect(job.parts, hasLength(3));
      expect(t.h.location, '/upload');
      expect(find.text('Gantikan siaran yang terputus'), findsOneWidget);
    });

    testWidgets('Simpan kedua-duanya keeps the live video', (tester) async {
      final t = await _stopShortLive(tester);
      await tester.tap(find.text('Muat naik rakaman penuh ke YouTube'));
      await settle(tester);
      await tester.tap(find.text('Simpan kedua-duanya'));
      await settle(tester);
      await settle(tester);
      expect((await t.job()).replaceLiveVideoId, isNull);
      expect(t.h.location, '/upload');
    });

    testWidgets('replaceGappyLive always skips the sheet', (tester) async {
      final t = await _open(
        tester,
        go: '/live',
        box: const LiveBoxStatus(
          youtube: YoutubeAccount.signedIn('Surau D\'Waqaf'),
          sessionId: 'box-sess-7',
          youtubeSeconds: 1500,
          watchUrl: 'https://www.youtube.com/watch?v=abc123',
        ),
      );
      t.h.settings['youtubeCatchUp'] = {
        'enabled': true,
        'replaceGappyLive': 'always',
      };
      t.h.container.invalidate(settingsProvider);
      await settle(tester);
      t.runner.sessions['box-sess-7'] = [400 * _mb];
      final pub = t.h.container.read(livePublisherProvider) as FakePublisher;
      pub.emit(_live());
      await settle(tester);
      await tester.tap(find.byKey(const ValueKey('live-stop')));
      await settle(tester);
      await tester.tap(find.text('Hentikan'));
      await settle(tester);
      await tester.tap(find.text('Muat naik rakaman penuh ke YouTube'));
      await settle(tester);
      await settle(tester);
      expect(find.text('Simpan kedua-duanya'), findsNothing);
      expect((await t.job()).replaceLiveVideoId, 'abc123');
    });

    testWidgets('youtubeCatchUp off: no upload button', (tester) async {
      await _stopShortLive(tester, catchUp: false);
      expect(find.text('Siaran tamat'), findsOneWidget);
      expect(find.text('Muat naik rakaman penuh ke YouTube'), findsNothing);
    });

    testWidgets('the cloud-unreachable warning has its banner', (tester) async {
      await _open(
        tester,
        go: '/live',
        box: const LiveBoxStatus(
          youtube: YoutubeAccount.signedIn('Surau D\'Waqaf'),
          warnings: {'cloud_unreachable'},
        ),
      );
      expect(find.text('YouTube: awan tidak dapat dihubungi'), findsOneWidget);
    });

    testWidgets('the pending-recordings banner gains Muat naik', (
      tester,
    ) async {
      final t = await _open(
        tester,
        go: '/live',
        box: const LiveBoxStatus(
          youtube: YoutubeAccount.signedIn('Surau D\'Waqaf'),
          recordingsPending: 2,
        ),
      );
      // the web recorder's own session id, files waiting to be saved
      for (final i in [1, 2]) {
        await t.recordings.appendPart(
          sessionId: 'sweb1',
          index: i,
          mime: 'video/mp4',
          label: 'c3',
          chunk: Object(),
          size: 300 * _mb,
        );
        await t.recordings.finishSegment('sweb1', i);
      }
      t.runner.sessions['sweb1'] = [300 * _mb, 300 * _mb];
      expect(find.text('Rakaman belum disimpan'), findsOneWidget);
      await tester.tap(find.byKey(const ValueKey('live-pending-upload')));
      await settle(tester);
      await settle(tester);
      final job = await t.job();
      expect(job.sessionId, 'sweb1');
      expect(job.kuliahId, 'c3');
      expect(t.h.location, '/upload');
      expect(t.recordings.calls, isEmpty);
    });
  });

  group('goldens', () {
    testWidgets('upload_list', (tester) async {
      final t = await _open(tester, seed: _list, net: UploadNetwork.cellular);
      await expectGoldens(tester, t.h.app, 'upload_list');
    });

    testWidgets('upload_running', (tester) async {
      final t = await _open(tester, seed: _running);
      await expectGoldens(tester, t.h.app, 'upload_running');
    });

    testWidgets('upload_wait_wifi', (tester) async {
      final t = await _open(
        tester,
        seed: _waitWifi,
        net: UploadNetwork.cellular,
      );
      await expectGoldens(tester, t.h.app, 'upload_wait_wifi');
    });

    testWidgets('upload_quota', (tester) async {
      final t = await _open(tester, seed: _quota);
      await expectGoldens(tester, t.h.app, 'upload_quota');
    });

    testWidgets('upload_done', (tester) async {
      final t = await _open(tester, seed: _done);
      await expectGoldens(tester, t.h.app, 'upload_done');
    });

    testWidgets('upload_empty', (tester) async {
      final t = await _open(tester);
      await expectGoldens(tester, t.h.app, 'upload_empty');
    });

    testWidgets('live_ended_catchup', (tester) async {
      final t = await _stopShortLive(tester);
      await expectGoldens(tester, t.h.app, 'live_ended_catchup');
    });
  });
}
