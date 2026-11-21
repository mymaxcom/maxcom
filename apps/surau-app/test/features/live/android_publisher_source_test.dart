// AndroidPublisher and the external camera (task K2): what it sends the native
// plugin for a camera source and the audio mix, how the plugin's audio, camera,
// ended and clap events become state, and that the camera address (it may hold
// the login) goes to the plugin only for the external camera and never into a
// state, a message or an error.

import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:surau_app/features/live/android_publisher.dart';
import 'package:surau_app/features/live/publisher.dart';
import 'package:surau_app/features/shell/live_camera_gateway.dart';

const _url = 'rtsp://admin:S3cretCam@10.168.1.20:554/stream1';
const _secret = 'S3cretCam';

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
    replies = {
      'prepare': {'ok': true, 'cameras': <String>[]},
    };
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
    pub = AndroidPublisher();
  });

  tearDown(() async {
    await pub.dispose();
    messenger.setMockMethodCallHandler(AndroidPublisher.methodChannel, null);
    messenger.setMockStreamHandler(AndroidPublisher.eventChannel, null);
  });

  Future<void> pump() => Future<void>.delayed(Duration.zero);

  Future<void> event(Map<String, Object?> e) async {
    sink!.success(e);
    await pump();
  }

  const cam = ExternalCameraSource(url: _url, transport: 'udp');

  const mix = LiveAudioMix(
    camera: AudioSourceMix(enabled: true, volume: 40),
    deviceMic: AudioSourceMix(enabled: true, volume: 100),
    boxInput: AudioSourceMix(enabled: false, volume: 100),
  );

  Map<String, Object?> args(MethodCall c) =>
      Map<String, Object?>.from(c.arguments as Map);

  test(
    'prepare with the external camera sends source, mix and offset',
    () async {
      await pub.prepare(
        const PublisherConfig(
          video: VideoSourceKind.external,
          camera: cam,
          mix: mix,
          avOffsetMs: 650,
        ),
      );
      final a = args(calls.single);
      final source = Map<String, Object?>.from(a['source'] as Map);
      expect(source['kind'], 'external');
      expect(source['url'], _url);
      expect(source['transport'], 'udp');
      expect(a['avOffsetMs'], 650);
      final m = Map<String, Object?>.from(a['mix'] as Map);
      expect((m['camera'] as Map)['volume'], 40);
      expect((m['deviceMic'] as Map)['enabled'], true);
      expect((m['boxInput'] as Map)['enabled'], false);
      expect(pub.current.phase, PublisherPhase.ready);
      expect(pub.current.video, VideoSourceKind.external);
    },
  );

  test('prepare with the phone camera sends no address', () async {
    await pub.prepare(
      const PublisherConfig(camera: cam),
    ); // a stray camera is ignored
    final source = Map<String, Object?>.from(
      args(calls.single)['source'] as Map,
    );
    expect(source['kind'], 'phone');
    expect(source.containsKey('url'), isFalse);
    expect(calls.single.arguments.toString().contains(_secret), isFalse);
    expect(pub.current.video, VideoSourceKind.phone);
    expect(args(calls.single)['mix'], isNull); // the plugin picks the default
  });

  test(
    'the external camera without an address ends in error and calls nothing',
    () async {
      await pub.prepare(const PublisherConfig(video: VideoSourceKind.external));
      expect(pub.current.phase, PublisherPhase.error);
      expect(calls, isEmpty);
    },
  );

  test(
    'the address never shows in a state, a message or its own text',
    () async {
      expect(cam.toString().contains(_secret), isFalse);
      expect(cam.toString(), contains('10.168.1.20'));
      expect(
        ExternalCameraSource.mask('rtsp://10.168.1.20/s'),
        'rtsp://10.168.1.20/s',
      );
      await pub.prepare(
        const PublisherConfig(video: VideoSourceKind.external, camera: cam),
      );
      expect(pub.current.toString().contains(_secret), isFalse);
      expect(pub.toString().contains(_secret), isFalse);
    },
  );

  test('a refusal carries a reason code, never the address', () async {
    await pub.prepare(const PublisherConfig());
    replies['setSource'] = PlatformException(
      code: 'switch_failed',
      message: _url,
    );
    await expectLater(
      pub.setVideoSource(VideoSourceKind.external, camera: cam),
      throwsA(
        isA<PublisherException>().having(
          (e) => e.code,
          'code',
          'switch_failed',
        ),
      ),
    );
    // a code that is not a plain reason code is replaced
    replies['setSource'] = PlatformException(code: _url);
    try {
      await pub.setVideoSource(VideoSourceKind.external, camera: cam);
      fail('should throw');
    } on PublisherException catch (e) {
      expect(e.code, 'error');
      expect(e.toString().contains(_secret), isFalse);
    }
    // the state stays on the phone camera after a refusal
    expect(pub.current.video, VideoSourceKind.phone);
  });

  test('switching to the external camera needs its address', () async {
    await pub.prepare(const PublisherConfig());
    calls.clear();
    await expectLater(
      pub.setVideoSource(VideoSourceKind.external),
      throwsA(
        isA<PublisherException>().having(
          (e) => e.code,
          'code',
          'camera_source_missing',
        ),
      ),
    );
    expect(calls, isEmpty);
  });

  test('switch to the phone camera mid live and back', () async {
    await pub.prepare(
      const PublisherConfig(
        video: VideoSourceKind.external,
        camera: cam,
        mix: mix,
      ),
    );
    await event({
      'type': 'audio',
      'sources': [
        {
          'id': 'camera',
          'enabled': true,
          'volume': 40,
          'level': 0.2,
          'state': 'ok',
        },
      ],
      'mixed': 0.3,
      'camera': {'link': 'playing', 'hasAudio': true, 'lostSec': 0},
    });
    expect(pub.current.audio, isNotNull);
    calls.clear();

    await pub.setVideoSource(VideoSourceKind.phone, mix: mix);
    expect(calls.single.method, 'setSource');
    final s1 = Map<String, Object?>.from(args(calls.single)['source'] as Map);
    expect(s1['kind'], 'phone');
    expect(s1.containsKey('url'), isFalse);
    expect(pub.current.video, VideoSourceKind.phone);
    expect(pub.current.audio, isNull);
    expect(pub.current.camera, isNull);

    calls.clear();
    await pub.setVideoSource(VideoSourceKind.external, camera: cam, mix: mix);
    final s2 = Map<String, Object?>.from(args(calls.single)['source'] as Map);
    expect(s2['kind'], 'external');
    expect(s2['url'], _url);
    expect(pub.current.video, VideoSourceKind.external);
  });

  test(
    'volumes and the microphone change during the live through setMix',
    () async {
      await pub.prepare(
        const PublisherConfig(video: VideoSourceKind.external, camera: cam),
      );
      calls.clear();
      await pub.setAudioMix(mix);
      expect(calls.single.method, 'setMix');
      final a = args(calls.single);
      expect((a['source'] as Map)['kind'], 'external');
      expect(((a['mix'] as Map)['camera'] as Map)['volume'], 40);
      expect(((a['mix'] as Map)['deviceMic'] as Map)['enabled'], true);
      // no address in a mix call
      expect(calls.single.arguments.toString().contains('rtsp'), isFalse);
    },
  );

  test('"Mic-in only": the mix with every phone-side volume at 0 is passed on as it is', () async {
    await pub.prepare(
      const PublisherConfig(video: VideoSourceKind.external, camera: cam),
    );
    calls.clear();
    await pub.setAudioMix(
      const LiveAudioMix(
        camera: AudioSourceMix(enabled: true, volume: 0),
        deviceMic: AudioSourceMix(enabled: false, volume: 100),
        boxInput: AudioSourceMix(enabled: true, volume: 100),
      ),
    );
    // the engine lifts the reference to 100 itself; the screen's own values stay what the user set
    final m = Map<String, Object?>.from(args(calls.single)['mix'] as Map);
    expect((m['camera'] as Map)['volume'], 0);
    expect((m['boxInput'] as Map)['enabled'], true);
  });

  test(
    'an audio event becomes rows, meters, alignment and the camera link',
    () async {
      await pub.prepare(
        const PublisherConfig(video: VideoSourceKind.external, camera: cam),
      );
      await event({
        'type': 'audio',
        'mixed': 0.61,
        'micFailed': false,
        'sources': [
          {
            'id': 'camera',
            'enabled': true,
            'volume': 40,
            'level': 0.33,
            'state': 'ok',
          },
          {
            'id': 'deviceMic',
            'enabled': true,
            'volume': 100,
            'level': 0.5,
            'state': 'silent',
            'align': {
              'state': 'searching',
              'delayMs': 1000,
              'residualMs': null,
            },
          },
        ],
        'camera': {
          'link': 'playing',
          'hasAudio': true,
          'lostSec': 0,
          'transport': 'tcp',
          'width': 1440,
          'height': 1080,
        },
      });
      final audio = pub.current.audio!;
      expect(audio.mixed, 0.61);
      expect(audio.rows.length, 2);
      final c = audio.row('camera')!;
      expect(c.level, 0.33);
      expect(c.alignState, isNull);
      final m = audio.row('deviceMic')!;
      expect(m.state, 'silent');
      expect(m.alignState, 'searching');
      expect(m.delayMs, 1000);
      expect(m.residualMs, isNull);
      final cs = pub.current.camera!;
      expect(cs.link, CameraLink.playing);
      expect(cs.hasAudio, isTrue);
      expect(cs.transport, 'tcp');
      expect(cs.width, 1440);

      // a lock arrives
      await event({
        'type': 'audio',
        'mixed': 0.4,
        'sources': [
          {
            'id': 'deviceMic',
            'enabled': true,
            'volume': 100,
            'level': 0.2,
            'state': 'ok',
            'align': {'state': 'locked', 'delayMs': 640, 'residualMs': 4.3},
          },
        ],
        'camera': {'link': 'lost', 'hasAudio': true, 'lostSec': 125},
      });
      expect(pub.current.audio!.row('deviceMic')!.alignState, 'locked');
      expect(pub.current.audio!.row('deviceMic')!.residualMs, 4.3);
      expect(pub.current.camera!.isLost, isTrue);
      expect(pub.current.camera!.lostSec, 125);
    },
  );

  test('a camera with no audio track and an unknown format', () async {
    await pub.prepare(
      const PublisherConfig(video: VideoSourceKind.external, camera: cam),
    );
    await event({
      'type': 'audio',
      'sources': <Object?>[],
      'camera': {'link': 'connecting', 'hasAudio': null, 'lostSec': 0},
    });
    expect(pub.current.camera!.hasAudio, isNull);
    await event({
      'type': 'audio',
      'sources': <Object?>[],
      'camera': {'link': 'playing', 'hasAudio': false, 'lostSec': 0},
    });
    expect(pub.current.camera!.hasAudio, isFalse);
  });

  test('odd audio parts are dropped or defaulted, never thrown', () async {
    await pub.prepare(
      const PublisherConfig(video: VideoSourceKind.external, camera: cam),
    );
    await event({
      'type': 'audio',
      'mixed': 9.0, // clamped
      'sources': [
        'junk',
        {'volume': 5}, // no id
        {
          'id': 'camera',
          'enabled': true,
          'volume': 40,
          'level': -3,
          'state': 'weird',
          'align': {'state': 'not-a-state'},
        },
      ],
      'camera': {'link': 'nonsense', 'transport': 'http://x'},
    });
    final a = pub.current.audio!;
    expect(a.mixed, 1.0);
    expect(a.rows.length, 1);
    expect(a.rows.single.level, 0.0);
    expect(a.rows.single.state, 'ok');
    expect(a.rows.single.alignState, isNull);
    expect(pub.current.camera!.link, CameraLink.idle);
    expect(pub.current.camera!.transport, isNull);
  });

  test('the engine ending a lost-camera live is reported and cleared by the next prepare', () async {
    await pub.prepare(
      const PublisherConfig(video: VideoSourceKind.external, camera: cam),
    );
    await event({'type': 'ended', 'reason': 'camera_lost'});
    expect(pub.current.endReason, endedCameraLost);
    await event({'type': 'phase', 'value': 'stopped'});
    expect(pub.current.phase, PublisherPhase.stopped);
    expect(pub.current.endReason, endedCameraLost);
    // text that is not a reason code is not taken
    await event({'type': 'ended', 'reason': _url});
    expect(pub.current.endReason, 'error');
    await pub.prepare(const PublisherConfig());
    expect(pub.current.endReason, isNull);
  });

  test('the clap test is forwarded and its phases follow the plugin', () async {
    await pub.prepare(
      const PublisherConfig(video: VideoSourceKind.external, camera: cam),
    );
    calls.clear();
    await pub.clapCapture();
    await event({'type': 'clap', 'state': 'capturing'});
    expect(pub.current.clap, ClapPhase.capturing);
    await event({'type': 'clap', 'state': 'ready'});
    expect(pub.current.clap, ClapPhase.ready);
    await pub.clapReplay(650);
    await event({'type': 'clap', 'state': 'replaying'});
    await pub.clapOffset(700);
    await pub.setAvOffset(700);
    await pub.clapStop();
    await event({'type': 'clap', 'state': 'idle'});
    expect(calls.map((c) => c.method).toList(), [
      'clapCapture',
      'clapReplay',
      'clapOffset',
      'setAvOffset',
      'clapStop',
    ]);
    expect(calls[1].arguments, 650);
    expect(calls[2].arguments, 700);
    expect(calls[3].arguments, 700);
    expect(pub.current.clap, ClapPhase.idle);
  });

  test('a clap refusal is a reason code', () async {
    await pub.prepare(
      const PublisherConfig(video: VideoSourceKind.external, camera: cam),
    );
    replies['clapCapture'] = PlatformException(code: 'camera_has_audio');
    await expectLater(
      pub.clapCapture(),
      throwsA(
        isA<PublisherException>().having(
          (e) => e.code,
          'code',
          'camera_has_audio',
        ),
      ),
    );
  });

  test(
    'start still sends the same arguments with an external camera',
    () async {
      await pub.prepare(
        const PublisherConfig(video: VideoSourceKind.external, camera: cam),
      );
      await pub.start(
        const PublisherTargets(
          outputs: LiveOutputs(kiosk: true, youtube: false),
          ingestUrl: 'srt://10.168.1.10:8890?streamid=publish:surau-in:u:pw',
        ),
      );
      final a = args(calls.last);
      expect(
        (a['srt'] as Map)['streamId'],
        'publish:surau-in:u:pw',
      ); // Mic-in ingest path comes from the box
      expect(
        a.containsKey('source'),
        isFalse,
      ); // the address is not repeated at start
      expect(calls.last.arguments.toString().contains(_secret), isFalse);
    },
  );

  test('setMicrophone sends the chosen microphone id to the engine', () async {
    expect(await pub.setMicrophone('3:Headset Mic'), isTrue);
    expect(calls.last.method, 'setMic');
    expect(args(calls.last)['id'], '3:Headset Mic');
    expect(await pub.setMicrophone(null), isTrue);
    expect(args(calls.last)['id'], isNull);
  });

  test('micRouted shows the device the system really routed, and a refusal by name', () async {
    await event({'type': 'micRouted', 'id': '3:Headset Mic', 'name': 'Headset Mic', 'kind': 'external', 'unavailable': null});
    expect(pub.current.micRoute?.name, 'Headset Mic');
    expect(pub.current.micRoute?.kind, 'external');
    expect(pub.current.micUnavailable, isNull);
    await event({'type': 'micRouted', 'id': '15:', 'name': '', 'kind': 'builtin', 'unavailable': 'Headset Mic'});
    expect(pub.current.micRoute?.kind, 'builtin');
    expect(pub.current.micUnavailable, 'Headset Mic');
    await event({'type': 'micRouted', 'id': '15:', 'name': '', 'kind': 'builtin', 'unavailable': null});
    expect(pub.current.micUnavailable, isNull);
  });
}
