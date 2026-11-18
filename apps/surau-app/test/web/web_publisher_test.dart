@TestOn('browser')
library;

import 'dart:async';
import 'dart:js_interop';

import 'package:flutter_test/flutter_test.dart';
import 'package:surau_app/features/live/android_publisher.dart'
    show PublisherException;
import 'package:surau_app/features/live/publisher.dart';
import 'package:surau_app/features/shell/live_camera_gateway.dart'
    show AudioSourceMix, LiveAudioMix;
import 'package:surau_app/features/live/recordings_store.dart';
import 'package:surau_app/features/live/web_publisher_web.dart';
import 'package:web/web.dart' as web;

// ---- fakes ----

class FakeCapture implements CaptureStream {
  final endedC = StreamController<void>.broadcast();
  bool stopped = false;
  bool audioOn = true;
  bool _ended = false;

  @override
  JSObject? get native => null;
  @override
  Stream<void> get ended => endedC.stream;
  @override
  bool get hasEnded => _ended;
  @override
  void setAudioEnabled(bool enabled) => audioOn = enabled;
  @override
  void stop() => stopped = true;

  void end() {
    _ended = true;
    endedC.add(null);
  }
}

class FakePeer implements PeerLink {
  FakePeer({this.h264 = true});
  final bool h264;
  final statesC = StreamController<String>.broadcast();
  bool closed = false;
  String? answer;
  int? bitrate;

  @override
  Stream<String> get connectionStates => statesC.stream;

  @override
  Future<OfferResult> createOffer(
    CaptureStream s, {
    required int maxBitrateBps,
  }) async {
    bitrate = maxBitrateBps;
    return OfferResult('v=0 offer', h264First: h264);
  }

  @override
  Future<void> applyAnswer(String sdp) async => answer = sdp;
  @override
  Future<PeerStats> stats() async =>
      const PeerStats(bitrateKbps: 2000, fps: 30, rttMs: 12, lost: 1);
  @override
  Future<void> replaceTracks(CaptureStream s) async {}
  @override
  void close() => closed = true;

  void emit(String s) => statesC.add(s);
}

class FakeRecorder implements SegmentRecorder {
  FakeRecorder(this.id, {this.silent = false});
  final int id;

  /// Delivers no chunk (a browser that accepts a received stream and then
  /// records nothing).
  final bool silent;
  bool started = false;
  bool stopped = false;
  void Function(Object, int)? _chunk;

  @override
  String get mime => 'video/mp4';

  @override
  void start(
    void Function(Object chunk, int size) onChunk,
    void Function(String code) onError,
  ) {
    started = true;
    _chunk = onChunk;
    if (!silent) onChunk('chunk-$id-a', 10);
  }

  @override
  Future<void> stop() async {
    stopped = true;
    _chunk?.call('chunk-$id-z', 5);
  }
}

class FakePage implements PageEnv {
  final visC = StreamController<bool>.broadcast();
  bool isVisible = true;
  int wakeRequests = 0;
  int wakeReleases = 0;

  @override
  bool get visible => isVisible;
  @override
  Stream<bool> get visibility => visC.stream;
  @override
  Future<WakeHandle?> requestWakeLock() async {
    wakeRequests++;
    return _Wake(this);
  }

  @override
  void dispose() {}

  void setVisible(bool v) {
    isVisible = v;
    visC.add(v);
  }
}

class _Wake implements WakeHandle {
  _Wake(this.page);
  final FakePage page;
  @override
  Future<void> release() async => page.wakeReleases++;
}

class FakeReceiver implements ReceiverLink {
  final statesC = StreamController<String>.broadcast();
  bool closed = false;
  String? answer;

  @override
  Future<String> createOffer() async => 'v=0 whep offer';
  @override
  Future<void> applyAnswer(String sdp) async => answer = sdp;
  @override
  Stream<String> get connectionStates => statesC.stream;
  @override
  JSObject? get stream => null;
  @override
  void close() => closed = true;

  void emit(String s) => statesC.add(s);
}

LiveAudioMix mixOf({
  int camera = 100,
  bool mic = false,
  int micVolume = 100,
  bool cameraOn = true,
}) => LiveAudioMix(
  camera: AudioSourceMix(enabled: cameraOn, volume: camera),
  deviceMic: AudioSourceMix(enabled: mic, volume: micVolume),
  boxInput: const AudioSourceMix(enabled: false, volume: 100),
);

class Rig {
  Rig({
    int segmentMinutes = 15,
    int? free,
    Uri? box,
    bool portrait = false,
    bool canRecordReceived = true,
    Duration recordWatchdog = const Duration(seconds: 12),
  }) : store = MemoryRecordingsStore() {
    page = FakePage();
    publisher = WebPublisher(
      tokenProvider: () async => 'tok-123',
      box: box ?? Uri.parse('https://box.test:8443'),
      segmentMinutes: segmentMinutes,
      maxBitrateKbps: 2500,
      portraitProvider: () => portrait,
      getUserMedia: (c) async {
        constraints.add(c);
        if (failMedia) throw StateError('denied');
        final cap = FakeCapture();
        captures.add(cap);
        return cap;
      },
      peerFactory: () {
        final p = FakePeer();
        peers.add(p);
        return p;
      },
      recorderFactory: (s) {
        final r = FakeRecorder(recorders.length, silent: silentRecorder);
        recorders.add(r);
        return r;
      },
      fetch: (r) async {
        requests.add(r);
        final h = postHandler;
        if (r.method == 'POST' && r.path == WebPublisher.whepPath) {
          return WhipReply(201, 'v=0 whep answer', location: whepLocation);
        }
        if (r.method == 'POST') {
          if (h != null) return h(r);
          return WhipReply(201, 'v=0 answer', location: location);
        }
        return const WhipReply(200, '');
      },
      store: store,
      freeBytes: () async => free ?? 10 * 1000 * 1000 * 1000,
      page: page,
      receiverFactory: () {
        final r = FakeReceiver();
        receivers.add(r);
        return r;
      },
      audioSender: (m, {video, avOffsetMs}) async {
        if (audioError != null) throw audioError!;
        audioCalls.add(m);
        audioVideos.add(video);
        audioOffsets.add(avOffsetMs);
      },
      offsetSaver: (id, ms) async => savedOffsets.add((id, ms)),
      canRecordReceived: () => canRecordReceived,
      recordWatchdog: recordWatchdog,
    );
  }

  final receivers = <FakeReceiver>[];
  final audioCalls = <LiveAudioMix>[];
  final audioVideos = <String?>[];
  final audioOffsets = <int?>[];
  final savedOffsets = <(String, int)>[];
  Object? audioError;
  bool failMedia = false;
  bool silentRecorder = false;
  String? whepLocation = '/api/live/preview/whep/prev-1';

  final MemoryRecordingsStore store;
  late final FakePage page;
  late final WebPublisher publisher;
  final constraints = <Map<String, Object?>>[];
  final captures = <FakeCapture>[];
  final peers = <FakePeer>[];
  final recorders = <FakeRecorder>[];
  final requests = <WhipRequest>[];
  String? location = '/api/live/whip/sess-1';
  WhipReply Function(WhipRequest r)? postHandler;

  List<WhipRequest> get posts =>
      requests.where((r) => r.method == 'POST').toList();
  List<WhipRequest> get deletes =>
      requests.where((r) => r.method == 'DELETE').toList();

  static const targets = PublisherTargets(
    outputs: LiveOutputs(kiosk: true, youtube: false),
    kuliahId: 'k-2026-11-05',
    ingestUrl: '/api/live/whip',
  );

  Future<void> goLive() async {
    await publisher.prepare(const PublisherConfig());
    await publisher.start(targets);
  }

  /// An external-camera live; [mic] puts the iPad microphone in the mix.
  Future<void> goLiveExternal({LiveAudioMix? mix}) async {
    await publisher.prepareExternal(const PublisherConfig(), mix: mix);
    await publisher.start(targets);
  }

  List<WhipRequest> get whipPosts =>
      posts.where((r) => r.path == WebPublisher.whipPath).toList();
  List<WhipRequest> get whepPosts =>
      posts.where((r) => r.path == WebPublisher.whepPath).toList();
}

void main() {
  group('prepare', () {
    testWidgets('asks for 1280x720 with the PA microphone left raw', (t) async {
      final rig = Rig();
      await rig.publisher.prepare(const PublisherConfig());
      expect(rig.publisher.current.phase, PublisherPhase.ready);
      final c = rig.constraints.single;
      final v = c['video']! as Map;
      expect(v['width'], 1280);
      expect(v['height'], 720);
      expect(v['frameRate'], 30);
      expect(v['facingMode'], 'environment');
      final a = c['audio']! as Map;
      expect(a['echoCancellation'], false);
      expect(a['noiseSuppression'], false);
      expect(a['autoGainControl'], false);
    });

    testWidgets('portrait asks for a 16:9 1280x720 track', (t) async {
      final rig = Rig();
      await rig.publisher.prepare(const PublisherConfig(portrait: true));
      final v = rig.constraints.single['video']! as Map;
      expect(v['width'], 1280);
      expect(v['height'], 720);
      expect(v['aspectRatio'], closeTo(16 / 9, 1e-9));
      expect(v['resizeMode'], 'crop-and-scale');
      expect(rig.publisher.current.portrait, true);
    });

    testWidgets('landscape asks for the same 1280x720 16:9 track', (t) async {
      final rig = Rig();
      await rig.publisher.prepare(const PublisherConfig(portrait: false));
      final v = rig.constraints.single['video']! as Map;
      expect(v['width'], 1280);
      expect(v['height'], 720);
      expect(v['aspectRatio'], closeTo(16 / 9, 1e-9));
      expect(rig.publisher.current.portrait, false);
    });

    testWidgets('prepare reads the window when the config is silent', (
      t,
    ) async {
      final rig = Rig(portrait: true);
      await rig.publisher.prepare(const PublisherConfig());
      expect(rig.publisher.current.portrait, true);
    });

    test('the canvas crop is the centred 16:9 band of a portrait frame', () {
      final r = coverRect(720, 1280, 1280, 720);
      expect(r[0], 0);
      expect(r[2], 720);
      expect(r[3], closeTo(405, 1e-9));
      expect(r[1], closeTo((1280 - 405) / 2, 1e-9));
      expect(coverRect(1280, 720, 1280, 720), [0, 0, 1280, 720]);
      final w = coverRect(2000, 720, 1280, 720);
      expect(w[2] / w[3], closeTo(16 / 9, 1e-9));
      expect(isSixteenNine(1280, 720), true);
      expect(isSixteenNine(720, 1280), false);
    });

    testWidgets('a refused camera leaves an error state, not an exception', (
      t,
    ) async {
      final p = WebPublisher(
        getUserMedia: (_) async => throw StateError('NotAllowedError'),
        peerFactory: () => FakePeer(),
        store: MemoryRecordingsStore(),
        page: FakePage(),
      );
      await p.prepare(const PublisherConfig());
      expect(p.current.phase, PublisherPhase.error);
    });
  });

  group('WHIP', () {
    testWidgets('posts the offer with the Bearer header, applies the answer, '
        'keeps Location for the DELETE at stop', (t) async {
      final rig = Rig();
      await rig.goLive();
      final post = rig.posts.single;
      expect(post.path, '/api/live/whip');
      expect(post.headers['Content-Type'], 'application/sdp');
      expect(post.headers['Authorization'], 'Bearer tok-123');
      expect(post.body, 'v=0 offer');
      expect(rig.peers.single.answer, 'v=0 answer');
      expect(rig.peers.single.bitrate, 2500 * 1000);
      expect(rig.publisher.current.phase, PublisherPhase.live);

      rig.peers.single.emit('connected');
      await t.pump();
      expect(rig.publisher.current.outputs.kiosk!.phase, OutputPhase.up);

      await rig.publisher.stop();
      expect(rig.deletes.single.path, '/api/live/whip/sess-1');
      expect(rig.deletes.single.headers['Authorization'], 'Bearer tok-123');
      expect(rig.peers.single.closed, isTrue);
      expect(rig.publisher.current.phase, PublisherPhase.stopped);
    });

    testWidgets('only the box WHIP path is accepted as a target', (t) async {
      final rig = Rig();
      await rig.publisher.prepare(const PublisherConfig());
      for (final bad in [
        'https://evil.test/api/live/whip',
        '/api/live/start',
        '/api/live/whip?x=1',
        'https://box.test:8443/other',
      ]) {
        await expectLater(
          rig.publisher.start(
            PublisherTargets(outputs: const LiveOutputs(), ingestUrl: bad),
          ),
          throwsA(isA<PublisherException>()),
          reason: bad,
        );
      }
      expect(rig.requests, isEmpty);
      // The box's own absolute URL is fine.
      await rig.publisher.start(
        const PublisherTargets(
          outputs: LiveOutputs(),
          ingestUrl: 'https://box.test:8443/api/live/whip',
        ),
      );
      expect(rig.posts.single.path, '/api/live/whip');
      await rig.publisher.stop();
    });

    testWidgets('a Location off the box or off the whip path is never used', (
      t,
    ) async {
      final rig = Rig()..location = 'https://evil.test/api/live/whip/x';
      await rig.goLive();
      await rig.publisher.stop();
      expect(rig.deletes, isEmpty);

      final rig2 = Rig()..location = '/api/users/1';
      await rig2.goLive();
      await rig2.publisher.stop();
      expect(rig2.deletes, isEmpty);
    });

    testWidgets('a failed connection: DELETE, a new POST after 2 s, then 4 s', (
      t,
    ) async {
      final rig = Rig();
      await rig.goLive();
      rig.peers[0].emit('connected');
      await t.pump();

      rig.peers[0].emit('failed');
      await t.pump();
      expect(rig.deletes, hasLength(1));
      expect(rig.peers[0].closed, isTrue);
      final o = rig.publisher.current.outputs.kiosk!;
      expect(o.phase, OutputPhase.retrying);
      expect(o.retryInSec, 2);

      await t.pump(const Duration(seconds: 1));
      expect(rig.posts, hasLength(1));
      expect(rig.publisher.current.outputs.kiosk!.retryInSec, 1);
      await t.pump(const Duration(seconds: 1));
      expect(rig.posts, hasLength(2));

      // The new connection never reaches `connected` and fails: 4 s.
      rig.peers[1].emit('failed');
      await t.pump();
      expect(rig.publisher.current.outputs.kiosk!.retryInSec, 4);
      await t.pump(const Duration(seconds: 3));
      expect(rig.posts, hasLength(2));
      await t.pump(const Duration(seconds: 1));
      expect(rig.posts, hasLength(3));

      // Reaching `connected` resets the backoff to 2 s.
      rig.peers[2].emit('connected');
      await t.pump();
      rig.peers[2].emit('failed');
      await t.pump();
      expect(rig.publisher.current.outputs.kiosk!.retryInSec, 2);

      await rig.publisher.stop();
    });

    testWidgets('disconnected for 3 s reconnects, a quick recovery does not', (
      t,
    ) async {
      final rig = Rig();
      await rig.goLive();
      rig.peers[0].emit('connected');
      rig.peers[0].emit('disconnected');
      await t.pump(const Duration(seconds: 2));
      rig.peers[0].emit('connected');
      await t.pump(const Duration(seconds: 5));
      expect(rig.posts, hasLength(1));

      rig.peers[0].emit('disconnected');
      await t.pump(const Duration(seconds: 3));
      expect(rig.deletes, hasLength(1));
      await t.pump(const Duration(seconds: 2));
      expect(rig.posts, hasLength(2));
      await rig.publisher.stop();
    });

    testWidgets('a refused POST retries, and a 401 says so by code only', (
      t,
    ) async {
      final rig = Rig()..postHandler = (r) => const WhipReply(401, 'no');
      await rig.goLive();
      final o = rig.publisher.current.outputs.kiosk!;
      expect(o.phase, OutputPhase.retrying);
      expect(o.message, 'session_refused');
      expect(rig.publisher.current.phase, PublisherPhase.live);
      await rig.publisher.stop();
    });

    testWidgets('no H.264 offered is reported, the leg still goes out', (
      t,
    ) async {
      final rig = Rig();
      // Replace the factory result through a second rig with h264 false.
      final p = WebPublisher(
        tokenProvider: () async => 't',
        box: Uri.parse('https://box.test'),
        getUserMedia: (_) async => FakeCapture(),
        peerFactory: () => FakePeer(h264: false),
        recorderFactory: (s) => FakeRecorder(0),
        fetch: (r) async => const WhipReply(201, 'a', location: null),
        store: MemoryRecordingsStore(),
        freeBytes: () async => null,
        page: FakePage(),
      );
      await p.prepare(const PublisherConfig());
      await p.start(Rig.targets);
      expect(p.h264Missing, isTrue);
      expect(rig.publisher.h264Missing, isFalse);
      await p.stop();
    });
  });

  group('recorder', () {
    testWidgets('segments by stop and restart; the store holds index 0 and 1', (
      t,
    ) async {
      final rig = Rig(segmentMinutes: 1);
      await rig.goLive();
      final sid = rig.publisher.sessionId!;
      expect(rig.recorders, hasLength(1));
      expect(rig.publisher.current.recording.segments, 1);

      await t.pump(const Duration(minutes: 1));
      expect(rig.recorders, hasLength(2));
      expect(rig.recorders[0].stopped, isTrue);
      expect((await rig.store.forSession(sid)).map((e) => e.index), [0]);
      expect(rig.publisher.current.recording.segments, 2);

      await rig.publisher.stop();
      final segs = await rig.store.forSession(sid);
      expect(segs.map((e) => e.index), [0, 1]);
      expect(segs.every((e) => e.mime == 'video/mp4'), isTrue);
      expect(segs.first.bytes, 15);
      expect(rig.recorders[1].stopped, isTrue);
    });

    testWidgets('a thrown WHIP POST does not stop the recorder', (t) async {
      final rig = Rig()..postHandler = (r) => throw StateError('network down');
      await rig.goLive();
      expect(rig.publisher.current.outputs.kiosk!.phase, OutputPhase.retrying);
      expect(rig.recorders.single.started, isTrue);
      expect(rig.recorders.single.stopped, isFalse);
      await t.pump(const Duration(seconds: 30));
      expect(rig.recorders.single.stopped, isFalse);
      await rig.publisher.stop();
      expect(
        await rig.store.forSession(rig.publisher.sessionId!),
        hasLength(1),
      );
    });

    testWidgets('recording off records nothing and says so', (t) async {
      final rig = Rig();
      await rig.publisher.prepare(const PublisherConfig(recording: false));
      await rig.publisher.start(Rig.targets);
      expect(rig.recorders, isEmpty);
      expect(rig.publisher.current.recording.on, isFalse);
      await rig.publisher.stop();
    });

    testWidgets('under 300 MB free: no recording, with the reason', (t) async {
      final rig = Rig(free: 100 * 1000 * 1000);
      await rig.goLive();
      expect(rig.recorders, isEmpty);
      expect(rig.publisher.current.recording.lastError, 'storage_low');
      expect(rig.publisher.current.warnings, contains(Warning.lowStorage));
      // The broadcast itself goes on.
      expect(rig.posts, hasLength(1));
      await rig.publisher.stop();
    });

    testWidgets('under 1.5 GB free: warns and still records', (t) async {
      final rig = Rig(free: 1000 * 1000 * 1000);
      await rig.goLive();
      expect(rig.recorders, hasLength(1));
      expect(rig.publisher.current.warnings, contains(Warning.lowStorage));
      await rig.publisher.stop();
    });
  });

  group('wake lock and the page', () {
    testWidgets('wake lock while live, again when the page returns, '
        'a warning while hidden', (t) async {
      final rig = Rig();
      await rig.goLive();
      await t.pump();
      expect(rig.page.wakeRequests, 1);

      rig.page.setVisible(false);
      await t.pump();
      expect(rig.publisher.current.warnings, contains(Warning.screenLockRisk));

      rig.page.setVisible(true);
      await t.pump();
      expect(rig.page.wakeRequests, 2);
      expect(
        rig.publisher.current.warnings,
        isNot(contains(Warning.screenLockRisk)),
      );

      await rig.publisher.stop();
      expect(rig.page.wakeReleases, greaterThanOrEqualTo(2));
    });

    testWidgets('the iPad ending the camera: kiosk down with the message, '
        'back on the page it recovers', (t) async {
      final rig = Rig();
      await rig.goLive();
      rig.peers[0].emit('connected');
      await t.pump();

      rig.page.isVisible = false;
      rig.captures[0].end();
      await t.pump();
      final o = rig.publisher.current.outputs.kiosk!;
      expect(o.phase, OutputPhase.down);
      expect(o.message, 'Kamera dihentikan oleh iPad. Buka semula skrin ini.');
      expect(rig.peers[0].closed, isTrue);
      expect(rig.deletes, hasLength(1));
      expect(rig.publisher.current.warnings, contains(Warning.screenLockRisk));

      rig.page.setVisible(true);
      await t.pump();
      expect(rig.captures, hasLength(2));
      expect(rig.posts, hasLength(2));
      expect(rig.recorders, hasLength(2));
      expect(
        (await rig.store.forSession(rig.publisher.sessionId!))
            .map((e) => e.index),
        [0],
      );
      await rig.publisher.stop();
    });
  });

  group('controls', () {
    testWidgets('mute switches the audio track and the state', (t) async {
      final rig = Rig();
      await rig.publisher.prepare(const PublisherConfig());
      rig.publisher.setMuted(true);
      expect(rig.captures.single.audioOn, isFalse);
      expect(rig.publisher.current.muted, isTrue);
    });

    testWidgets(
      'switchCamera asks for the other camera and stops the old one',
      (t) async {
        final rig = Rig();
        await rig.publisher.prepare(const PublisherConfig());
        await rig.publisher.switchCamera();
        expect((rig.constraints[1]['video']! as Map)['facingMode'], 'user');
        expect(rig.captures[0].stopped, isTrue);
        expect(rig.publisher.current.frontCamera, isTrue);
      },
    );

    testWidgets('stop releases the camera', (t) async {
      final rig = Rig();
      await rig.goLive();
      await rig.publisher.stop();
      expect(rig.captures.single.stopped, isTrue);
    });

    testWidgets('start before prepare is refused', (t) async {
      final rig = Rig();
      await expectLater(
        rig.publisher.start(Rig.targets),
        throwsA(isA<PublisherException>()),
      );
    });
  });

  group('external camera (the box pulls it)', () {
    testWidgets('controller only: nothing is captured or published, the '
        'preview is a WHEP receive, the wake lock is held', (t) async {
      final rig = Rig();
      await rig.goLiveExternal();
      await t.pump();
      expect(rig.constraints, isEmpty);
      expect(rig.captures, isEmpty);
      expect(rig.whipPosts, isEmpty);
      expect(rig.peers, isEmpty);
      final p = rig.whepPosts.single;
      expect(p.headers['Content-Type'], 'application/sdp');
      expect(p.headers['Authorization'], 'Bearer tok-123');
      expect(p.body, 'v=0 whep offer');
      expect(rig.receivers.single.answer, 'v=0 whep answer');
      expect(rig.page.wakeRequests, 1);
      expect(rig.publisher.current.phase, PublisherPhase.live);
      expect(rig.publisher.current.outputs.kiosk!.phase, OutputPhase.up);
      expect(rig.publisher.externalState.mic, ExternalMic.off);
      expect(rig.publisher.externalState.previewSound, isTrue);

      rig.receivers.single.emit('connected');
      await t.pump();
      expect(rig.publisher.externalState.preview, ExternalPreview.playing);

      await rig.publisher.stop();
      expect(rig.receivers.single.closed, isTrue);
      expect(rig.deletes.single.path, '/api/live/preview/whep/prev-1');
      expect(rig.publisher.externalState.active, isFalse);
    });

    testWidgets('the iPad microphone alone is published by WHIP: audio-only '
        'capture, no camera prompt, preview starts muted', (t) async {
      final rig = Rig();
      await rig.goLiveExternal(mix: mixOf(mic: true));
      await t.pump();
      final c = rig.constraints.single;
      expect(c.containsKey('video'), isFalse);
      expect((c['audio']! as Map)['echoCancellation'], false);
      expect(rig.whipPosts, hasLength(1));
      expect(rig.whepPosts, hasLength(1));
      expect(rig.publisher.externalState.previewSound, isFalse);
      expect(rig.publisher.current.outputs.kiosk!.phase, OutputPhase.connecting);
      rig.peers.single.emit('connected');
      await t.pump();
      expect(rig.publisher.externalState.mic, ExternalMic.ok);
      expect(rig.publisher.current.outputs.kiosk!.phase, OutputPhase.up);
      expect(rig.publisher.h264Missing, isFalse);
      await rig.publisher.stop();
      expect(rig.captures.single.stopped, isTrue);
    });

    testWidgets('a WHEP Location off the WHEP path is never used', (t) async {
      final rig = Rig()..whepLocation = '/api/live/whip/x';
      await rig.goLiveExternal();
      await rig.publisher.stop();
      expect(rig.deletes, isEmpty);
    });

    testWidgets('a lost preview reconnects with backoff and a new recorder '
        'segment follows the new stream', (t) async {
      final rig = Rig();
      await rig.goLiveExternal();
      rig.receivers[0].emit('connected');
      await t.pump();
      expect(rig.recorders, hasLength(1));

      rig.receivers[0].emit('failed');
      await t.pump();
      expect(rig.receivers[0].closed, isTrue);
      expect(rig.publisher.externalState.preview, ExternalPreview.retrying);
      expect(rig.deletes.single.path, '/api/live/preview/whep/prev-1');

      await t.pump(const Duration(seconds: 2));
      expect(rig.receivers, hasLength(2));
      expect(rig.whepPosts, hasLength(2));
      rig.receivers[1].emit('connected');
      await t.pump();
      expect(rig.recorders, hasLength(2));
      expect(rig.recorders[0].stopped, isTrue);
      final sid = rig.publisher.sessionId!;
      expect(
        (await rig.store.forSession(sid)).map((e) => e.index),
        [0],
      );
      await rig.publisher.stop();
      expect(
        (await rig.store.forSession(sid)).map((e) => e.index),
        [0, 1],
      );
    });

    testWidgets('the received stream is recorded into the existing store',
        (t) async {
      final rig = Rig();
      await rig.goLiveExternal();
      rig.receivers.single.emit('connected');
      await t.pump();
      expect(rig.recorders.single.started, isTrue);
      expect(rig.publisher.externalState.recording, ExternalRecording.running);
      expect(rig.publisher.current.recording.on, isTrue);
      await rig.publisher.stop();
      final segs =
          await rig.store.forSession(rig.publisher.sessionId!);
      expect(segs.single.bytes, 15);
    });

    testWidgets('a browser that cannot record a received stream: nothing is '
        'recorded and the plan message is shown', (t) async {
      final rig = Rig(canRecordReceived: false);
      await rig.goLiveExternal();
      rig.receivers.single.emit('connected');
      await t.pump();
      expect(rig.recorders, isEmpty);
      final e = rig.publisher.externalState;
      expect(e.recording, ExternalRecording.unavailable);
      expect(
        e.notice,
        'Rakaman tidak dibuat apabila iPad mengawal Kamera luaran. Salinan '
        'siaran ada di YouTube.',
      );
      await rig.publisher.stop();
    });

    testWidgets('a recorder that delivers no data is judged unable to '
        'record the received stream', (t) async {
      final rig = Rig(recordWatchdog: const Duration(seconds: 3))
        ..silentRecorder = true;
      await rig.goLiveExternal();
      rig.receivers.single.emit('connected');
      await t.pump();
      expect(rig.publisher.externalState.recording, ExternalRecording.off);
      await t.pump(const Duration(seconds: 3));
      expect(rig.recorders.single.stopped, isTrue);
      expect(
        rig.publisher.externalState.recording,
        ExternalRecording.unavailable,
      );
      expect(rig.publisher.externalState.notice, externalRecordingFallback());
      await rig.publisher.stop();
    });

    testWidgets('a volume change goes to the box as the whole mix; a fast '
        'run sends only the latest', (t) async {
      final rig = Rig();
      await rig.goLiveExternal();
      final a = rig.publisher.setExternalMix(mixOf(camera: 80));
      final b = rig.publisher.setExternalMix(mixOf(camera: 60));
      final c = rig.publisher.setExternalMix(mixOf(camera: 40));
      await Future.wait([a, b, c]);
      expect(rig.audioCalls, hasLength(1));
      expect(rig.audioCalls.single.camera.volume, 40);
      expect(rig.whipPosts, isEmpty);
    });

    testWidgets('a change the box refuses throws and leaves the mix '
        'alone', (t) async {
      final rig = Rig();
      await rig.goLiveExternal();
      rig.audioError = StateError('refused');
      await expectLater(
        rig.publisher.setExternalMix(mixOf(mic: true)),
        throwsStateError,
      );
      expect(rig.publisher.externalMix.deviceMic.enabled, isFalse);
      expect(rig.constraints, isEmpty);
      await rig.publisher.stop();
    });

    testWidgets('adding the iPad microphone: the box is told first, then '
        'the microphone is published; removing it stops the WHIP',
        (t) async {
      final rig = Rig();
      await rig.goLiveExternal();
      await rig.publisher.setExternalMix(mixOf(mic: true));
      await t.pump();
      expect(rig.audioCalls.single.deviceMic.enabled, isTrue);
      expect(rig.constraints.single.containsKey('video'), isFalse);
      expect(rig.whipPosts, hasLength(1));
      expect(rig.publisher.externalState.previewSound, isFalse);
      rig.peers.single.emit('connected');
      await t.pump();
      expect(rig.publisher.externalState.mic, ExternalMic.ok);

      await rig.publisher.setExternalMix(mixOf());
      expect(rig.audioCalls, hasLength(2));
      expect(rig.peers.single.closed, isTrue);
      expect(rig.captures.single.stopped, isTrue);
      expect(
        rig.deletes.where((r) => r.path == '/api/live/whip/sess-1'),
        hasLength(1),
      );
      expect(rig.publisher.externalState.mic, ExternalMic.off);
      await rig.publisher.stop();
    });

    testWidgets('microphone permission refused: the live goes on with the '
        'camera audio and the box is told', (t) async {
      final rig = Rig()..failMedia = true;
      await rig.goLiveExternal(mix: mixOf(mic: true));
      await t.pump();
      expect(rig.whipPosts, isEmpty);
      expect(rig.audioCalls.single.deviceMic.enabled, isFalse);
      expect(rig.publisher.externalMix.deviceMic.enabled, isFalse);
      expect(rig.publisher.externalState.notice, externalMicRefusedMessage());
      expect(rig.publisher.current.phase, PublisherPhase.live);
      await rig.publisher.stop();
    });

    testWidgets('microphone lost (Safari hidden): the live goes on with the '
        'camera audio, the microphone comes back when the page does',
        (t) async {
      final rig = Rig();
      await rig.goLiveExternal(mix: mixOf(camera: 40, mic: true));
      rig.peers[0].emit('connected');
      await t.pump();

      rig.page.isVisible = false;
      rig.captures[0].end();
      await t.pump();
      var e = rig.publisher.externalState;
      expect(e.mic, ExternalMic.lost);
      expect(
        e.notice,
        'Mikrofon iPad terputus. Siaran diteruskan dengan audio kamera.',
      );
      expect(e.noticeHint, externalMicLostHint());
      expect(rig.peers[0].closed, isTrue);
      expect(rig.publisher.current.phase, PublisherPhase.live);
      expect(rig.publisher.current.warnings, contains(Warning.screenLockRisk));
      // The preview and its recording are not touched by the loss.
      expect(rig.receivers.single.closed, isFalse);

      rig.page.setVisible(true);
      await t.pump();
      expect(rig.captures, hasLength(2));
      expect(rig.whipPosts, hasLength(2));
      rig.peers[1].emit('connected');
      await t.pump();
      e = rig.publisher.externalState;
      expect(e.mic, ExternalMic.ok);
      expect(e.notice, isNull);
      await rig.publisher.stop();
    });

    testWidgets('microphone lost with the camera at volume 0: no sound '
        'message', (t) async {
      final rig = Rig();
      await rig.goLiveExternal(mix: mixOf(camera: 0, mic: true));
      rig.page.isVisible = false;
      rig.captures[0].end();
      await t.pump();
      expect(
        rig.publisher.externalState.notice,
        'Mikrofon iPad terputus. Siaran diteruskan tanpa bunyi.',
      );
      await rig.publisher.stop();
    });

    testWidgets('the box status feeds the alignment rows; "failed" with the '
        'camera audible offers the microphone alone', (t) async {
      final rig = Rig();
      await rig.goLiveExternal(mix: mixOf(camera: 40, mic: true));
      rig.publisher.applyBoxStatus({
        'warnings': ['audio_align_failed'],
        'audio': {
          'sources': [
            {'id': 'camera', 'enabled': true, 'volume': 40, 'state': 'ok'},
            {
              'id': 'deviceMic',
              'enabled': true,
              'volume': 100,
              'state': 'ok',
              'align': {'state': 'failed', 'delayMs': 600},
            },
          ],
        },
      });
      var e = rig.publisher.externalState;
      expect(e.source('camera')!.volume, 40);
      expect(e.source('deviceMic')!.alignState, 'failed');
      expect(e.canUseMicOnly, isTrue);
      expect(e.notice, startsWith('Penyelarasan automatik belum berjaya, jadi'));

      await rig.publisher.useMicOnly();
      expect(rig.audioCalls.last.camera.volume, 0);
      expect(rig.audioCalls.last.deviceMic.enabled, isTrue);
      e = rig.publisher.externalState;
      expect(e.canUseMicOnly, isFalse);
      expect(
        e.notice,
        'Penyelarasan automatik belum berjaya. Bunyi mungkin tidak selari '
        'dengan gambar.',
      );
      await rig.publisher.stop();
    });

    testWidgets('a box that reports the microphone lost shows the message '
        'even before this device notices', (t) async {
      final rig = Rig();
      await rig.goLiveExternal(mix: mixOf(mic: true));
      rig.publisher.applyBoxStatus({
        'audio': {
          'sources': [
            {'id': 'deviceMic', 'enabled': true, 'volume': 100, 'state': 'lost'},
          ],
        },
      });
      expect(rig.publisher.externalState.notice, contains('terputus'));
      await rig.publisher.stop();
    });

    testWidgets('switch to the iPad camera: camera and microphone go to the '
        'box, the microphone-only leg ends; back restores it', (t) async {
      final rig = Rig();
      await rig.goLiveExternal(mix: mixOf(mic: true));
      rig.peers[0].emit('connected');
      await t.pump();

      expect(await rig.publisher.switchToIpadCamera(), isTrue);
      // the box is asked first (it authorises the new path), then the leg is made
      expect(rig.audioVideos.last, 'phone');
      expect((rig.constraints[1]['video']! as Map)['width'], 1280);
      expect(rig.captures[0].stopped, isTrue);
      expect(rig.peers[0].closed, isTrue);
      expect(rig.whipPosts, hasLength(2));
      expect(rig.publisher.externalState.video, ExternalVideo.ipadCamera);
      rig.peers[1].emit('connected');
      await t.pump();
      expect(rig.publisher.externalState.mic, ExternalMic.ok);
      // The recording keeps following the box's stream.
      expect(rig.recorders.length, lessThanOrEqualTo(1));

      expect(await rig.publisher.switchToExternalCamera(), isTrue);
      expect(rig.audioVideos.last, 'external');
      expect(rig.captures[1].stopped, isTrue);
      expect(rig.constraints[2].containsKey('video'), isFalse);
      expect(rig.whipPosts, hasLength(3));
      expect(rig.publisher.externalState.video, ExternalVideo.external);
      await rig.publisher.stop();
    });

    testWidgets('switch to the iPad camera when the camera cannot be opened: '
        'nothing changes', (t) async {
      final rig = Rig();
      await rig.goLiveExternal(mix: mixOf(mic: true));
      rig.failMedia = true;
      expect(await rig.publisher.switchToIpadCamera(), isFalse);
      expect(rig.captures[0].stopped, isFalse);
      expect(rig.publisher.externalState.video, ExternalVideo.external);
      await rig.publisher.stop();
    });

    testWidgets('the box refusing the switch to the iPad camera: the camera '
        'just opened is released and nothing changes', (t) async {
      final rig = Rig();
      await rig.goLiveExternal(mix: mixOf(mic: true));
      rig.audioError = const PublisherException('audio_unsupported');
      expect(await rig.publisher.switchToIpadCamera(), isFalse);
      expect(rig.captures[0].stopped, isFalse);
      expect(rig.publisher.externalState.video, ExternalVideo.external);
      await rig.publisher.stop();
    });

    testWidgets('during a live a tried offset goes to the box with the mix, '
        'once per value', (t) async {
      final rig = Rig();
      await rig.goLiveExternal(mix: mixOf(mic: true));
      final before = rig.audioOffsets.length;
      rig.publisher.setFallbackOffset(350);
      await t.pump();
      expect(rig.audioOffsets.length, before + 1);
      expect(rig.audioOffsets.last, 350);
      rig.publisher.setFallbackOffset(350);
      await t.pump();
      expect(rig.audioOffsets.length, before + 1); // unchanged value: not sent again
      await rig.publisher.stop();
    });

    testWidgets('the fallback offset is tried against the preview, clamped '
        'to 0..2000 in steps of 50, and saved on request', (t) async {
      final rig = Rig();
      await rig.publisher.prepareExternal(
        const PublisherConfig(),
        cameraHasAudio: false,
        fallbackOffsetMs: 400,
      );
      expect(rig.publisher.externalState.fallbackOffsetMs, 400);
      rig.publisher.setFallbackOffset(1234);
      expect(rig.publisher.externalState.fallbackOffsetMs, 1250);
      rig.publisher.setFallbackOffset(9999);
      expect(rig.publisher.externalState.fallbackOffsetMs, 2000);
      rig.publisher.setFallbackOffset(-5);
      expect(rig.publisher.externalState.fallbackOffsetMs, 0);
      rig.publisher.setFallbackOffset(700);
      await rig.publisher.saveFallbackOffset();
      expect(rig.savedOffsets.single, ('deviceMic', 700));
      expect(
        rig.publisher.externalState.notice,
        "Kamera ini tiada audio. Tekan 'Tambah audio' untuk memilih "
        'mikrofon, atau siaran tiada bunyi.',
      );
    });

    testWidgets('the ordinary camera live is untouched: its start still '
        'needs prepare, and records its own capture', (t) async {
      final rig = Rig();
      await rig.goLive();
      expect(rig.publisher.externalState.active, isFalse);
      expect(rig.whepPosts, isEmpty);
      expect(rig.recorders, hasLength(1));
      await rig.publisher.stop();
    });
  });

  group('H.264 preference', () {
    test(
      'profile 42e01f with packetization-mode 1 first, H.264 before VP8',
      () {
        final caps = [
          (mime: 'video/VP8', fmtp: ''),
          (mime: 'video/VP9', fmtp: 'profile-id=0'),
          (
            mime: 'video/H264',
            fmtp: 'level-asymmetry-allowed=1;packetization-mode=0;profile-level-id=42e01f',
          ),
          (
            mime: 'video/H264',
            fmtp: 'level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=640c1f',
          ),
          (
            mime: 'video/H264',
            fmtp: 'level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f',
          ),
          (mime: 'video/rtx', fmtp: 'apt=96'),
        ];
        final o = codecOrder(caps);
        expect(o.hasH264, isTrue);
        expect(o.indexes, [4, 3, 2, 0, 1, 5]);
      },
    );

    test('no H.264 keeps the browser order and says so', () {
      final o = codecOrder([
        (mime: 'video/VP8', fmtp: ''),
        (mime: 'video/VP9', fmtp: ''),
      ]);
      expect(o.hasH264, isFalse);
      expect(o.indexes, [0, 1]);
    });

    test('a real offer lists H.264 first in the video m-line when the '
        'browser has it', () async {
      final canvas =
          web.document.createElement('canvas') as web.HTMLCanvasElement
            ..width = 320
            ..height = 180;
      canvas.getContext('2d');
      final stream = canvas.captureStream(5);
      final link = RtcPeerLink();
      addTearDown(link.close);
      final offer = await link.createOffer(
        BrowserCapture(stream),
        maxBitrateBps: 2500000,
      );
      final sdp = offer.sdp;
      final m = RegExp(r'm=video \d+ [^ ]+ (\d+)').firstMatch(sdp);
      expect(m, isNotNull);
      final firstPt = m!.group(1)!;
      final rtp = RegExp('a=rtpmap:$firstPt ([A-Za-z0-9]+)/')
          .firstMatch(sdp)
          ?.group(1);
      final hasH264 = sdp.contains('H264/90000');
      if (hasH264) {
        expect(rtp, 'H264');
        expect(offer.h264First, isTrue);
      } else {
        expect(offer.h264First, isFalse);
      }
      expect(sdp, contains('a=sendonly'));
    });
  });
}
