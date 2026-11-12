// AndroidPublisher against a mocked MethodChannel and EventChannel: what it
// sends to the native plugin, how events become PublisherState, and that a
// stream key or passphrase never reaches a state or its text.

import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:surau_app/features/live/android_publisher.dart';
import 'package:surau_app/features/live/publisher.dart';

const _key = 'abcd-efgh-ijkl-mnop-qrst';
const _pass = 'S3cretPassphrase99';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  final messenger =
      TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger;

  late List<MethodCall> calls;
  late Map<String, Object?> replies;
  MockStreamHandlerEventSink? sink;
  late AndroidPublisher pub;

  setUp(() {
    calls = [];
    replies = {};
    sink = null;
    messenger.setMockMethodCallHandler(AndroidPublisher.methodChannel, (
      call,
    ) async {
      calls.add(call);
      final r = replies[call.method];
      if (r is PlatformException) throw r;
      return r;
    });
    messenger.setMockStreamHandler(
      AndroidPublisher.eventChannel,
      MockStreamHandler.inline(
        onListen: (args, events) => sink = events,
        onCancel: (args) => sink = null,
      ),
    );
    pub = AndroidPublisher(segmentMinutes: 15, videoBitrateKbps: 2500);
  });

  tearDown(() async {
    await pub.dispose();
    messenger.setMockMethodCallHandler(AndroidPublisher.methodChannel, null);
    messenger.setMockStreamHandler(AndroidPublisher.eventChannel, null);
  });

  Future<void> pump() => Future<void>.delayed(Duration.zero);

  PublisherTargets targets({bool youtube = true}) => PublisherTargets(
    outputs: LiveOutputs(kiosk: true, youtube: youtube),
    kuliahId: 'k-2026-11-05-maghrib',
    ingestUrl:
        'srt://10.168.1.10:8890?streamid=publish:surau:live-1:pw&passphrase=$_pass',
    youtubeUrl: youtube ? 'rtmps://a.rtmps.youtube.com:443/live2/$_key' : null,
  );

  test('prepare asks the plugin for 720p30 and maps the answer', () async {
    replies['prepare'] = {
      'ok': true,
      'cameras': ['back', 'front'],
    };
    await pub.prepare(const PublisherConfig());
    expect(calls.single.method, 'prepare');
    final a = calls.single.arguments as Map;
    expect(a['facing'], 'back');
    expect(a['width'], 1280);
    expect(a['height'], 720);
    expect(a['fps'], 30);
    expect(pub.current.phase, PublisherPhase.ready);
    expect(pub.current.recording.on, isTrue);
  });

  test('prepare with recording off marks the recorder off', () async {
    replies['prepare'] = {'ok': true, 'cameras': <String>[]};
    await pub.prepare(const PublisherConfig(recording: false));
    expect(pub.current.recording.on, isFalse);
  });

  test('a refused permission becomes an error state', () async {
    replies['prepare'] = PlatformException(code: 'permission_denied');
    await pub.prepare(const PublisherConfig());
    expect(pub.current.phase, PublisherPhase.error);
  });

  test(
    'start sends the SRT target, the RTMPS URL and the record settings',
    () async {
      replies['prepare'] = {'ok': true, 'cameras': <String>[]};
      await pub.prepare(const PublisherConfig());
      await pub.start(targets());
      final c = calls.last;
      expect(c.method, 'start');
      final a = Map<String, Object?>.from(c.arguments as Map);
      final srt = Map<String, Object?>.from(a['srt'] as Map);
      expect(srt['host'], '10.168.1.10');
      expect(srt['port'], 8890);
      expect(srt['streamId'], 'publish:surau:live-1:pw');
      expect(srt['passphrase'], _pass);
      final rtmps = Map<String, Object?>.from(a['rtmps'] as Map);
      expect(rtmps['url'], 'rtmps://a.rtmps.youtube.com:443/live2/$_key');
      final rec = Map<String, Object?>.from(a['record'] as Map);
      expect(rec['segmentMinutes'], 15);
      expect(rec['dir'], 'Movies/MAXCOM');
      expect(rec['prefix'], 'k-2026-11-05-maghrib');
      final video = Map<String, Object?>.from(a['video'] as Map);
      expect(video['bitrateKbps'], 2500);
      expect(video['gopSeconds'], 2);
      final audio = Map<String, Object?>.from(a['audio'] as Map);
      expect(audio['bitrateKbps'], 128);
      expect(audio['sampleRate'], 48000);
      expect(audio['stereo'], false);
      expect(pub.current.phase, PublisherPhase.starting);
    },
  );

  test('a bare stream key is turned into the YouTube RTMPS URL', () async {
    await pub.start(
      PublisherTargets(
        outputs: const LiveOutputs(kiosk: true, youtube: true),
        ingestUrl: 'srt://10.0.0.2:8890?streamid=publish%3Asurau',
        youtubeUrl: _key,
      ),
    );
    final a = Map<String, Object?>.from(calls.last.arguments as Map);
    expect(
      (a['rtmps'] as Map)['url'],
      'rtmps://a.rtmps.youtube.com:443/live2/$_key',
    );
    expect((a['srt'] as Map)['passphrase'], isNull);
  });

  test(
    'YouTube off sends no RTMPS target; recording off sends no record',
    () async {
      replies['prepare'] = {'ok': true, 'cameras': <String>[]};
      await pub.prepare(const PublisherConfig(recording: false));
      await pub.start(targets(youtube: false));
      final a = Map<String, Object?>.from(calls.last.arguments as Map);
      expect(a['rtmps'], isNull);
      expect(a['record'], isNull);
      expect(a['srt'], isNotNull);
    },
  );

  test('stop, switchCamera and setMuted reach the plugin', () async {
    await pub.stop();
    expect(calls.last.method, 'stop');
    expect(pub.current.phase, PublisherPhase.stopping);
    await pub.switchCamera();
    expect(calls.last.method, 'switchCamera');
    expect(pub.current.frontCamera, isTrue);
    pub.setMuted(true);
    await pump();
    expect(calls.last.method, 'setMuted');
    expect(calls.last.arguments, true);
    expect(pub.current.muted, isTrue);
  });

  test('events map to PublisherState', () async {
    final seen = <PublisherState>[];
    pub.states.listen(seen.add);
    await pump();
    expect(sink, isNotNull, reason: 'the event channel is listened to');

    sink!.success({'type': 'phase', 'value': 'live'});
    sink!.success({'type': 'output', 'name': 'kiosk', 'state': 'up'});
    sink!.success({
      'type': 'output',
      'name': 'youtube',
      'state': 'retrying',
      'retryInSec': 4,
      'message': 'connect_failed',
    });
    sink!.success({
      'type': 'stats',
      'bitrateKbps': 2400,
      'fps': 29,
      'dropped': 3,
      'durationSec': 61,
    });
    sink!.success({
      'type': 'recording',
      'segments': 2,
      'bytes': 1048576,
      'lastError': 'storage_low',
    });
    sink!.success({'type': 'warning', 'kind': 'lowBattery'});
    sink!.success({'type': 'warning', 'kind': 'hot'});
    await pump();

    final s = pub.current;
    expect(s.phase, PublisherPhase.live);
    expect(s.outputs.kiosk!.phase, OutputPhase.up);
    expect(s.outputs.youtube!.phase, OutputPhase.retrying);
    expect(s.outputs.youtube!.retryInSec, 4);
    expect(s.outputs.youtube!.message, 'connect_failed');
    expect(s.stats.bitrateKbps, 2400);
    expect(s.stats.fps, 29);
    expect(s.stats.dropped, 3);
    expect(s.durationSec, 61);
    expect(s.recording.segments, 2);
    expect(s.recording.bytes, 1048576);
    expect(s.recording.lastError, 'storage_low');
    expect(s.warnings, {Warning.lowBattery, Warning.hot});
    expect(seen, isNotEmpty);

    sink!.success({'type': 'warning', 'kind': 'hot', 'active': false});
    await pump();
    expect(pub.current.warnings, {Warning.lowBattery});
  });

  test('unknown or malformed events are ignored', () async {
    pub.states.listen((_) {});
    await pump();
    final before = pub.current;
    sink!.success({'type': 'nope'});
    sink!.success('not a map');
    sink!.success({'type': 'output', 'name': 'ftp', 'state': 'up'});
    sink!.success({'type': 'phase', 'value': 'zzz'});
    sink!.success({'type': 'warning', 'kind': 'weird'});
    await pump();
    expect(pub.current.phase, before.phase);
    expect(pub.current.outputs.kiosk, isNull);
    expect(pub.current.warnings, isEmpty);
  });

  test('an engine message that is not a reason code is dropped', () async {
    pub.states.listen((_) {});
    await pump();
    sink!.success({
      'type': 'output',
      'name': 'youtube',
      'state': 'down',
      'message': 'failed rtmps://a.rtmps.youtube.com:443/live2/$_key',
    });
    await pump();
    expect(pub.current.outputs.youtube!.message, 'error');
  });

  test('the stream key and passphrase are in no state text', () async {
    pub.states.listen((_) {});
    await pump();
    await pub.start(targets());
    sink!.success({'type': 'phase', 'value': 'live'});
    sink!.success({
      'type': 'output',
      'name': 'youtube',
      'state': 'down',
      'message': 'rtmps://x/$_key?p=$_pass',
    });
    await pump();
    final s = pub.current;
    final text = [
      s.toString(),
      s.outputs.youtube!.message ?? '',
      s.recording.lastError ?? '',
      targets().toString(),
      pub.toString(),
    ].join(' ');
    expect(text, isNot(contains(_key)));
    expect(text, isNot(contains(_pass)));
  });

  test(
    'a start the plugin refuses is an error state and an exception',
    () async {
      replies['start'] = PlatformException(code: 'srt_failed');
      await expectLater(
        pub.start(targets()),
        throwsA(
          isA<PublisherException>().having((e) => e.code, 'code', 'srt_failed'),
        ),
      );
      expect(pub.current.phase, PublisherPhase.error);
    },
  );

  group('orientation: always 1280x720, portrait crops a 16:9 band', () {
    test('portrait prepare sends 1280x720 with portrait true', () async {
      replies['prepare'] = {'ok': true, 'cameras': <String>[]};
      await pub.prepare(const PublisherConfig(portrait: true));
      final a = calls.single.arguments as Map;
      expect(a['width'], 1280);
      expect(a['height'], 720);
      expect(a['portrait'], true);
      expect(pub.current.portrait, true);
    });

    test('landscape prepare sends 1280x720 with portrait false', () async {
      replies['prepare'] = {'ok': true, 'cameras': <String>[]};
      await pub.prepare(const PublisherConfig(portrait: false));
      final a = calls.single.arguments as Map;
      expect(a['width'], 1280);
      expect(a['height'], 720);
      expect(a['portrait'], false);
      expect(pub.current.portrait, false);
    });

    test('prepare reads the device when the config says nothing', () async {
      final p2 = AndroidPublisher(portraitProvider: () => true);
      replies['prepare'] = {'ok': true, 'cameras': <String>[]};
      await p2.prepare(const PublisherConfig());
      expect((calls.single.arguments as Map)['portrait'], true);
      await p2.dispose();
    });

    test('a turn after prepare is applied at start and mid live', () async {
      var portrait = false;
      final p2 = AndroidPublisher(portraitProvider: () => portrait);
      replies['prepare'] = {'ok': true, 'cameras': <String>[]};
      await p2.prepare(const PublisherConfig());
      portrait = true;
      await p2.start(targets());
      final turn = calls.where((c) => c.method == 'setPortrait').toList();
      expect(turn.single.arguments, true);
      expect(p2.current.portrait, true);
      calls.clear();
      portrait = false;
      p2.deviceTurned();
      await pump();
      expect(calls.single.method, 'setPortrait');
      expect(calls.single.arguments, false);
      expect(p2.current.portrait, false);
      // no change, no call
      calls.clear();
      p2.deviceTurned();
      await pump();
      expect(calls, isEmpty);
      await p2.dispose();
    });
  });
}
