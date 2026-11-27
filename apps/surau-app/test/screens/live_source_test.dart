// The Live tab with the external camera and the audio mix (plan rev 4, task
// C2; mockups 01 to 08, 17 to 24 and 28 to 35): the "Sumber video" picker, the
// "Audio" card with a row, a "Kelantangan" slider and a meter per source, the
// alignment chip and the 4.7 messages, the fallback "Imbangan masa audio",
// the remembered mix, role gating, the emergency stop and the lost camera.
// One test per behaviour, then one golden per mockup state that is an app
// screen (see test/goldens/README.md).

import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:surau_app/app/providers.dart';
import 'package:surau_app/features/live/fake_publisher.dart';
import 'package:surau_app/features/live/live_screen.dart';
import 'package:flutter_riverpod/misc.dart' show Override;
import 'package:surau_app/features/live/live_source.dart';
import 'package:surau_app/features/live/live_source_widgets.dart' show FoldSection;
import 'package:surau_app/features/live/mic_watch.dart';
import 'package:surau_app/features/live/publisher.dart';
import 'package:surau_app/features/shell/live_camera_gateway.dart';
import 'package:surau_app/box/wire.dart';

import 'package:surau_app/app/app_lang.dart' show AppLang;
import 'package:surau_app/features/labels_cam.dart';

import '../features/fakes.dart';
import '../features/shell/harness.dart';
import '../golden_sizes.dart';

// a box with the build 4 controls (`canToggleKiosk`): the main box microphone and its sync block are for such a box
const _signedIn = LiveBoxStatus(youtube: YoutubeAccount.signedIn('Surau Contoh'), canToggleKiosk: true);

class _MemStore implements LiveSourceStore {
  _MemStore(this.video, this.mix);

  VideoSourceKind video;
  LiveAudioMix mix;

  @override
  Future<({VideoSourceKind video, LiveAudioMix mix, Map<String, int> offsets})?> read() async =>
      (video: video, mix: mix, offsets: const {idDeviceMic: 0, idBoxInput: 0});

  @override
  Future<void> write(VideoSourceKind v, LiveAudioMix m) async {
    video = v;
    mix = m;
  }
}

AudioSourceMix _m(bool on, [int v = 100]) => AudioSourceMix(enabled: on, volume: v);

LiveAudioMix _mix({int cam = 100, bool mic = false, int micVol = 100, bool box = false, int boxVol = 100}) =>
    LiveAudioMix(camera: _m(true, cam), deviceMic: _m(mic, micVol), boxInput: _m(box, boxVol));

LiveAudioMix get _phoneMix => defaultMix(VideoSourceKind.phone);

/// A microphone plugged in and in use (task W7), without the device watcher.
class _MicShown extends MicAutoNotifier {
  @override
  MicAutoState build() => const MicAutoState(mic: MicInfo(deviceId: 'usb-1', label: 'Rode Lavalier'));
}

class _PathStore implements LiveVideoPathStore {
  _PathStore([this.path]);

  String? path;

  @override
  Future<String?> read() async => path;

  @override
  Future<void> write(String p) async => path = p;
}

/// A publisher that can let its prepared camera go (as the Android one does).
class _ReleasingPub extends FakePublisher implements LivePreparedRelease {
  int releases = 0;

  @override
  Future<void> releasePrepared() async {
    releases += 1;
    emit(current.copyWith(phase: PublisherPhase.idle));
  }
}

class _T {
  _T(this.h, this.pub, this.store);

  final ShellHarness h;
  final FakePublisher pub;
  final _MemStore store;
  final List<Map<String, dynamic>> starts = [];
  final List<Map<String, dynamic>> audioPosts = [];
  final List<Map<String, dynamic>> controlPosts = [];

  LiveBoxNotifier get box => h.container.read(liveBoxProvider.notifier);
  LiveSourceState get source => h.container.read(liveSourceProvider);
}

Finder k(String key) => find.byKey(ValueKey(key));

/// Opens /live with the external camera "Kamera Mimbar" known to the box.
Future<_T> _open(
  WidgetTester tester, {
  List<String> roles = const ['live'],
  String device = 'phone',
  VideoSourceKind video = VideoSourceKind.external,
  LiveAudioMix? mix,
  bool cameraOn = true,
  bool? reachable = true,
  bool hasAudio = true,
  bool boxInput = true,
  LiveBoxStatus box = _signedIn,
  PublisherState initial = PublisherState.initial,
  bool realController = false,
  GoldenSize size = GoldenSize.phone,
  List<Override> extra = const [],
  FakePublisher? publisher,
  Map<String, Object?>? control,
  Map<String, Object?> controlAnswer = const {'sent': true, 'confirmed': true},
}) async {
  final pub = publisher ?? FakePublisher(initial: initial);
  final store = _MemStore(video, mix ?? (video == VideoSourceKind.external ? _mix() : _phoneMix));
  final h = await pumpShell(
    tester,
    roles: roles,
    size: size,
    overrides: [
      livePublisherProvider.overrideWithValue(pub),
      if (!realController) liveBoxProvider.overrideWith(() => LiveBoxNotifier(box)),
      liveDeviceKindProvider.overrideWithValue(device),
      liveSourceStoreProvider.overrideWithValue(store),
      ...extra,
    ],
  );
  final t = _T(h, pub, store);
  // tall, so the lazy list builds every section (the goldens set their own sizes)
  tester.view.physicalSize = const Size(412, 3600) * goldenPixelRatio;
  addTearDown(tester.view.resetPhysicalSize);
  h.settings['liveCamera'] = {
    'enabled': cameraOn,
    'name': 'Kamera Mimbar',
    'transport': 'auto',
    'avOffsetMs': {'deviceMic': 600, 'boxInput': 0},
  };
  h.handlers['GET /api/live/camera'] = (r) async => jsonResponse(200, {
    'configured': true,
    'url': 'rtsp://10.168.1.50:554/stream1',
    'hasPassword': false,
    'control': ?control,
    'lastTest': reachable == null
        ? null
        : {
            'code': reachable ? 'ok' : 'unreachable',
            'ok': reachable,
            'hasAudio': reachable ? hasAudio : null,
            'codecs': ['H264', if (hasAudio) 'MPEG-4 Audio'],
          },
  });
  if (reachable == true) {
    // hasAudio comes from the last test; an unreachable camera keeps what the screen knew
  }
  h.handlers['GET /api/live/camera/source'] = (r) async =>
      jsonResponse(200, {'url': 'rtsp://siaran:rahsia@10.168.1.50:554/stream1'});
  h.handlers['GET /api/live/audio-inputs'] = (r) async => jsonResponse(
    200,
    boxInput
        ? {'available': true, 'devices': <Object>[], 'selected': null}
        : {'available': false, 'devices': <Object>[], 'selected': null, 'reason': 'Tiada input audio pada MAXCOM ini'},
  );
  h.handlers['POST /api/live/start'] = (r) async {
    t.starts.add(jsonDecode(r.body) as Map<String, dynamic>);
    return jsonResponse(200, {
      'session': {'id': 's1'},
      'ingest': {
        'srt': {'host': '10.168.1.2', 'port': 8890, 'streamId': 'x', 'passphrase': 'y'},
      },
    });
  };
  h.handlers['POST /api/live/camera/control'] = (r) async {
    t.controlPosts.add(jsonDecode(r.body) as Map<String, dynamic>);
    return jsonResponse(200, controlAnswer);
  };
  h.handlers['POST /api/live/audio'] = (r) async {
    t.audioPosts.add(jsonDecode(r.body) as Map<String, dynamic>);
    return jsonResponse(200, {'ok': true});
  };
  h.handlers['GET /api/live/status'] = (r) async => jsonResponse(200, {
    'session': null,
    'warnings': <Object>[],
    'ingest': {'ready': false},
    'relay': {'state': 'off'},
    'youtube': {'signedIn': true, 'state': 'none'},
  });
  h.container.invalidate(settingsProvider);
  h.router.go('/live');
  await settle(tester);
  return t;
}

PublisherState _ready({PublisherAudio? audio, CameraStatus? camera}) =>
    PublisherState(phase: PublisherPhase.ready, video: VideoSourceKind.external, camera: camera, audio: audio);

AudioRow _row(String id, int vol, {double level = 0.5, String state = 'ok', String? align, bool on = true}) =>
    AudioRow(id: id, enabled: on, volume: vol, level: level, state: state, alignState: align);

PublisherAudio _audio({int cam = 40, int mic = 100, String align = 'locked', bool micRow = true}) => PublisherAudio(
  rows: [_row('camera', cam, level: 0.4), if (micRow) _row('deviceMic', mic, level: 0.7, align: align)],
  mixed: 0.6,
);

PublisherState _live({
  PublisherAudio? audio,
  CameraStatus camera = const CameraStatus(link: CameraLink.playing, hasAudio: true),
  VideoSourceKind video = VideoSourceKind.external,
}) => PublisherState(
  phase: PublisherPhase.live,
  outputs: const PublisherOutputs(kiosk: OutputState.up, youtube: OutputState.up),
  recording: const RecordingState(on: true, segments: 3, bytes: 1288490188),
  stats: const StreamStats(bitrateKbps: 4100, fps: 25, rttMs: 18),
  durationSec: 2537,
  video: video,
  camera: camera,
  audio: audio,
);

Future<void> _openSection(WidgetTester tester, String key) async {
  final head = k('live-section-$key-head');
  await reveal(tester, head);
  await tester.ensureVisible(head);
  // "Sumber video" is open by default before a live: a fold that is open already stays open
  final fold = find.ancestor(of: k('live-section-$key'), matching: find.byType(FoldSection));
  if (tester.widget<FoldSection>(fold).open) return;
  await tester.tap(head);
  await settle(tester);
}

/// A publisher whose source change or prepare for the external camera fails.
class _FailingPublisher extends FakePublisher {
  _FailingPublisher();

  bool failSwitch = false;
  bool failExternalPrepare = false;

  @override
  Future<void> setVideoSource(
    VideoSourceKind kind, {
    ExternalCameraSource? camera,
    LiveAudioMix? mix,
    int avOffsetMs = 0,
  }) async {
    if (failSwitch) throw StateError('no switch');
    return super.setVideoSource(kind, camera: camera, mix: mix, avOffsetMs: avOffsetMs);
  }

  @override
  Future<void> prepare(PublisherConfig c) async {
    if (failExternalPrepare && c.video == VideoSourceKind.external) throw StateError('no prepare');
    return super.prepare(c);
  }
}

/// The Kamera luaran form is a page of its own: the live page is gone while it is open.
Future<void> _leaveAndComeBack(WidgetTester tester, _T t, {required bool cameraOn}) async {
  t.h.router.go('/live/settings/liveCamera');
  await settle(tester);
  (t.h.settings['liveCamera'] as Map)['enabled'] = cameraOn;
  t.h.container.invalidate(settingsProvider);
  await settle(tester);
  t.h.router.go('/live');
  await settle(tester);
}

Future<void> _openAll(WidgetTester tester, [List<String> keys = const ['video', 'audio']]) async {
  for (final key in keys) {
    await _openSection(tester, key);
  }
}

Future<void> _setVolume(WidgetTester tester, String id, int v) async {
  final f = k('audio-volume-$id');
  await reveal(tester, f);
  tester.widget<Slider>(f).onChanged!(v.toDouble());
  await settle(tester);
}

LiveBoxStatus _liveBox({List<LiveAudioSourceDto> audio = const [], OtherLive? other}) =>
    _signedIn.copyWith(audio: audio, otherLive: other);

LiveAudioSourceDto _dto(String id, int vol, {String? align, String state = 'ok', double? level = -20, bool on = true}) =>
    LiveAudioSourceDto(id: id, enabled: on, volume: vol, state: state, alignState: align, level: level);

void main() {
  group('the picker and the remembered mix', () {
    testWidgets('the saved external camera and mix are restored and prepared', (tester) async {
      final t = await _open(tester, mix: _mix(cam: 40, mic: true));
      expect(t.source.video, VideoSourceKind.external);
      expect(t.source.mix.camera.volume, 40);
      expect(t.source.mix.deviceMic.enabled, isTrue);
      // the address was fetched for the engine only; it is not in the state
      final cfg = t.pub.prepared.last;
      expect(cfg.video, VideoSourceKind.external);
      expect(cfg.camera?.url, contains('10.168.1.50'));
      expect(t.source.toString(), isNot(contains('rahsia')));
    });

    testWidgets('first use is the phone camera with its microphone', (tester) async {
      final t = await _open(tester, video: VideoSourceKind.phone);
      await _openAll(tester);
      expect(t.source.video, VideoSourceKind.phone);
      expect(find.text('Mikrofon telefon ini'), findsOneWidget);
      expect(k('audio-mute'), findsOneWidget);
      // 2026.11.15 (P1): the phone microphone has a volume and a loudness lift of its own beside today's mute
      expect(k('audio-volume-deviceMic'), findsOneWidget);
      expect(k('audio-lift-deviceMic'), findsOneWidget);
    });

    testWidgets('the phone camera prepare carries the mix, so the phone microphone volume applies from the first second', (tester) async {
      final t = await _open(tester, video: VideoSourceKind.phone);
      await _openAll(tester);
      await _setVolume(tester, 'deviceMic', 40);
      await t.h.container.read(liveSourceProvider.notifier).prepare(recording: false, frontCamera: true);
      await settle(tester);
      expect(t.pub.prepared.last.video, VideoSourceKind.phone);
      expect(t.pub.prepared.last.mix, isNotNull);
      expect(t.pub.prepared.last.mix!.deviceMic.volume, 40);
    });

    testWidgets('choosing the camera prepares it and remembers the choice', (tester) async {
      final t = await _open(tester, video: VideoSourceKind.phone);
      await _openSection(tester, 'video');
      await tester.tap(k('video-pick-external'));
      await settle(tester);
      expect(t.store.video, VideoSourceKind.external);
      expect(t.pub.prepared.last.video, VideoSourceKind.external);
      expect(t.source.mix.camera.enabled, isTrue);
      expect(t.source.mix.deviceMic.enabled, isFalse, reason: 'the phone microphone is added, not default');
    });

    testWidgets('a camera switched off in Tetapan is not offered, with the reason', (tester) async {
      final t = await _open(tester, cameraOn: false);
      expect(t.source.video, VideoSourceKind.phone, reason: 'the saved choice falls back');
      await _openSection(tester, 'video');
      expect(k('video-pick-external'), findsNothing);
      expect(find.text('Kamera luaran dimatikan'), findsOneWidget);
      expect(k('video-open-camera'), findsOneWidget);
    });

    testWidgets('an unreachable camera stays selectable with the warning', (tester) async {
      final t = await _open(tester, reachable: false, mix: _mix(cam: 40, mic: true));
      await _openSection(tester, 'video');
      expect(find.textContaining('tidak dapat dihubungi sekarang'), findsOneWidget);
      await tester.tap(k('video-pick-phone'));
      await settle(tester);
      await tester.tap(k('video-pick-external'));
      await settle(tester);
      expect(t.source.video, VideoSourceKind.external);
    });
  });

  group('the Audio card', () {
    testWidgets('one row per source with Kelantangan and a meter; the camera row cannot be removed', (tester) async {
      await _open(tester, mix: _mix(cam: 40), initial: _ready(audio: _audio()));
      await _openAll(tester);
      expect(k('audio-row-camera'), findsOneWidget);
      expect(k('audio-volume-camera'), findsOneWidget);
      expect(k('audio-remove-camera'), findsNothing);
      expect(find.text('Audio kamera luaran'), findsOneWidget);
      expect(find.textContaining('Mikrofon kamera biasanya jauh dan bising'), findsOneWidget);
      expect(find.text('40%'), findsOneWidget);
    });

    testWidgets('a saved mix with two sources on opens as one: the microphone, and the camera row is off with its slider disabled', (tester) async {
      final t = await _open(tester, mix: _mix(cam: 40, mic: true), initial: _ready(audio: _audio()));
      await _openAll(tester);
      expect(t.source.mix.deviceMic.enabled, isTrue);
      expect(t.source.mix.camera.enabled, isFalse);
      expect(k('audio-row-deviceMic'), findsOneWidget);
      expect(k('audio-remove-deviceMic'), findsOneWidget);
      await reveal(tester, k('audio-volume-camera'));
      expect(tester.widget<Slider>(k('audio-volume-camera')).onChanged, isNull);
      expect(tester.widget<Slider>(k('audio-volume-deviceMic')).onChanged, isNotNull);
    });

    testWidgets('moving a slider sets the volume in steps of 5, remembers it and tells the engine', (tester) async {
      final t = await _open(tester, mix: _mix(cam: 40), initial: _ready(audio: _audio()));
      await _openAll(tester);
      await _setVolume(tester, 'camera', 62);
      expect(t.source.mix.camera.volume, 60);
      expect(t.store.mix.camera.volume, 60);
      expect(t.pub.mixes.last.camera.volume, 60);
    });

    testWidgets('Tambah audio lists the sources; Mic-in is greyed with its reason when the box has none', (tester) async {
      final t = await _open(tester, boxInput: false);
      await _openAll(tester);
      await tester.tap(k('audio-add'));
      await settle(tester);
      expect(find.text('Tambah audio'), findsWidgets);
      expect(find.text('Tiada input audio pada MAXCOM ini'), findsOneWidget);
      expect(k('add-audio-button-boxInput'), findsNothing);
      await tester.tap(k('add-audio-button-deviceMic'));
      await settle(tester);
      expect(t.source.mix.deviceMic.enabled, isTrue);
      // one sound only: adding the microphone turns the camera sound off
      expect(t.source.mix.camera.enabled, isFalse);
      expect(t.pub.mixes.last.camera.enabled, isFalse);
      expect(k('audio-row-deviceMic'), findsOneWidget);
    });

    testWidgets('an added row can be removed again', (tester) async {
      final t = await _open(tester, mix: _mix(mic: true), initial: _ready(audio: _audio()));
      await _openAll(tester);
      await tester.tap(k('audio-remove-deviceMic'));
      await settle(tester);
      expect(t.source.mix.deviceMic.enabled, isFalse);
      expect(k('audio-row-deviceMic'), findsNothing);
    });

    testWidgets('Mic-in with the phone camera has a slider; the phone microphone keeps today\'s mute (M3)', (tester) async {
      final t = await _open(
        tester,
        video: VideoSourceKind.phone,
        mix: LiveAudioMix(camera: _m(false), deviceMic: _m(true), boxInput: _m(true, 60)),
      );
      await _openAll(tester);
      expect(k('audio-mute'), findsOneWidget);
      expect(k('audio-volume-boxInput'), findsOneWidget);
      expect(find.text(liveAudioBoxInputInPhoneLive(AppLang.ms)), findsOneWidget);
      await tester.tap(k('audio-mute'));
      await settle(tester);
      expect(t.pub.current.muted, isTrue);
    });

    testWidgets('all volumes at 0 warn and do not block the start (31)', (tester) async {
      final t = await _open(tester, mix: _mix(cam: 0, mic: true, micVol: 0), initial: _ready(audio: _audio(cam: 0, mic: 0)));
      await _openAll(tester);
      expect(find.text('Semua sumber audio disenyapkan. Siaran tiada bunyi.'), findsOneWidget);
      await tester.tap(k('live-start'));
      await settle(tester);
      expect(t.pub.started, hasLength(1));
    });

    testWidgets('the folded summary names the one sound (01)', (tester) async {
      await _open(tester, mix: _mix(cam: 40, mic: true), initial: _ready(audio: _audio()));
      expect(find.text('Mikrofon telefon'), findsWidgets);
      expect(find.textContaining('selaras'), findsNothing);
    });
  });

  group('one sound: no mixing words, no alignment chip, no delay block', () {
    testWidgets('a microphone row shows no alignment chip and no mixing notice', (tester) async {
      await _open(tester, mix: _mix(cam: 40, mic: true), initial: _ready(audio: _audio(align: 'searching')));
      await _openAll(tester);
      expect(k('audio-chip-deviceMic'), findsNothing);
      expect(find.text('Sedang diselaraskan'), findsNothing);
      expect(find.text('Belum dicampur sehingga selaras'), findsNothing);
      expect(k('audio-use-only'), findsNothing);
    });

    testWidgets('no delay block anywhere in the card, in any live', (tester) async {
      await _open(tester, device: 'ipad', mix: _mix(cam: 40, mic: true, box: true));
      await _openAll(tester);
      expect(k('audio-offset-plus'), findsNothing);
      expect(k('audio-offset-value'), findsNothing);
      expect(k('audio-clap'), findsNothing);
      expect(find.text('Imbangan masa audio'), findsNothing);
      expect(find.text('Selaras bunyi dengan gambar'), findsNothing);
    });
  });

  group('a camera with no audio (30)', () {
    testWidgets('the camera row is greyed; no delay block is offered for the microphone', (tester) async {
      await _open(tester, hasAudio: false, mix: _mix(mic: true), initial: _ready());
      await _openAll(tester);
      expect(find.text('Kamera ini tiada audio'), findsOneWidget);
      expect(k('audio-volume-camera'), findsNothing);
      expect(find.text('Imbangan masa audio'), findsNothing);
      expect(k('audio-clap'), findsNothing);
      expect(k('audio-offset-plus'), findsNothing);
      expect(find.textContaining('Mikrofon telefon digunakan bersendirian'), findsOneWidget);
    });

    testWidgets('with nothing added the screen says the live has no sound', (tester) async {
      await _open(tester, hasAudio: false, mix: _mix(), initial: _ready());
      await _openAll(tester);
      expect(find.textContaining('Tekan Tambah audio untuk memilih mikrofon'), findsOneWidget);
      expect(k('audio-clap'), findsNothing, reason: 'no added source, nothing to align');
    });

  });

  group('during the live', () {
    testWidgets('the Audio card sits in the live screen with the meters and no folding (17)', (tester) async {
      final t = await _open(tester, mix: _mix(cam: 40, mic: true));
      t.pub.emit(_live(audio: _audio()));
      await settle(tester);
      t.h.container.read(liveFoldedProvider.notifier).set(false);
      await settle(tester);
      expect(k('live-sources'), findsOneWidget);
      expect(k('audio-volume-camera'), findsOneWidget);
      expect(k('live-mixed-level'), findsOneWidget);
      expect(find.text('Kamera Mimbar'), findsWidgets);
    });

    testWidgets('a volume change during the live goes to the engine without a restart', (tester) async {
      final t = await _open(tester, mix: _mix(cam: 40));
      t.pub.emit(_live(audio: _audio()));
      await settle(tester);
      t.h.container.read(liveFoldedProvider.notifier).set(false);
      await settle(tester);
      final before = t.pub.prepared.length;
      await _setVolume(tester, 'camera', 70);
      expect(t.pub.mixes.last.camera.volume, 70);
      expect(t.pub.prepared.length, before);
    });

    testWidgets('Tukar ke kamera telefon switches the source during the live (20)', (tester) async {
      final t = await _open(tester, mix: _mix(cam: 40, mic: true));
      t.pub.emit(_live(audio: _audio()));
      await settle(tester);
      t.h.container.read(liveFoldedProvider.notifier).set(false);
      await settle(tester);
      await reveal(tester, k('live-switch-phone'));
      await tester.tap(k('live-switch-phone'));
      await settle(tester);
      expect(t.pub.sourceSwitches, [VideoSourceKind.phone]);
      expect(t.source.video, VideoSourceKind.phone);
    });

    testWidgets('the camera reconnecting keeps the microphone and says so (19)', (tester) async {
      final t = await _open(tester, mix: _mix(cam: 40, mic: true));
      t.pub.emit(_live(audio: _audio(), camera: const CameraStatus(link: CameraLink.lost, lostSec: 12)));
      await settle(tester);
      t.h.container.read(liveFoldedProvider.notifier).set(false);
      await settle(tester);
      expect(k('live-camera-reconnecting'), findsOneWidget);
      expect(find.textContaining('gambar terakhir dengan bunyi Mikrofon telefon'), findsOneWidget);
    });

    testWidgets('the camera lost for minutes (20) and back again (32)', (tester) async {
      final t = await _open(tester, mix: _mix(cam: 40, mic: true));
      t.pub.emit(_live(audio: _audio(), camera: const CameraStatus(link: CameraLink.lost, lostSec: 120)));
      await settle(tester);
      t.h.container.read(liveFoldedProvider.notifier).set(false);
      await settle(tester);
      expect(k('live-camera-lost'), findsOneWidget);
      expect(find.textContaining('Siaran berhenti sendiri dalam 8 minit'), findsOneWidget);
      t.pub.emit(_live(audio: _audio(align: 'searching')));
      await settle(tester);
      expect(k('live-camera-back'), findsOneWidget);
    });

    testWidgets('after 10 minutes the engine ends the live: the normal stop and the message', (tester) async {
      final t = await _open(tester, mix: _mix(cam: 40, mic: true), realController: true);
      t.pub.emit(_live(audio: _audio()));
      await settle(tester);
      t.pub.emit(_live(audio: _audio()).copyWith(endReason: endedCameraLost));
      await settle(tester);
      expect(t.pub.stops, 1);
      expect(find.text('Siaran dihentikan kerana kamera luaran terputus'), findsOneWidget);
    });
  });

  group('Video diambil oleh (the phone by default, the box by choice)', () {
    testWidgets('the phone pulls by default; choosing MAXCOM Kiosk Box says clearly why Rakam is not offered', (tester) async {
      final t = await _open(tester, realController: true);
      expect(t.source.videoPath, 'device');
      expect(k('video-path-choice'), findsOneWidget);
      expect(find.text('Video diambil oleh'), findsOneWidget);
      expect(k('live-rec-no-box-pull'), findsNothing);
      await tester.tap(find.text('MAXCOM Kiosk Box'));
      await settle(tester);
      expect(t.source.videoPath, 'box');
      expect(find.text('Telefon hanya mengawal siaran. Rakaman pada telefon tidak tersedia.'), findsWidgets);
      // the start screen says why, in full: never silently hidden
      expect(
        find.text(
          'Rakam tidak ditawarkan kerana video diambil oleh MAXCOM Kiosk Box. Telefon ini tidak menerima gambar kamera, jadi tiada apa yang boleh dirakam pada telefon. Untuk merakam, pilih Video diambil oleh: Telefon ini.',
        ),
        findsOneWidget,
      );
      // the Rakam pill reads "not available", and the sheet repeats the reason
      await tester.tap(k('live-dest-recording'));
      await settle(tester);
      expect(find.text('Rakaman: Tidak tersedia'), findsOneWidget);
      t.h.container.dispose();
    });

    testWidgets('B11: choosing the box as the puller closes the camera this phone had prepared, and the live opens none', (tester) async {
      final pub = _ReleasingPub();
      final t = await _open(tester, realController: true, publisher: pub);
      // the page opened with this phone as the puller: its engine is prepared
      expect(pub.prepared, isNotEmpty);
      expect(pub.current.phase, PublisherPhase.ready);
      expect(pub.releases, 0);
      await tester.tap(find.text('MAXCOM Kiosk Box'));
      await settle(tester);
      expect(pub.releases, 1, reason: 'the prepared camera is let go');
      expect(pub.current.phase, PublisherPhase.idle);
      expect(k('live-box-pull-idle'), findsNothing, reason: 'no picture area at all');
      expect(k('live-no-video-note'), findsOneWidget);
      final preparedBefore = pub.prepared.length;
      t.h.handlers['GET /api/live/status'] = (r) async => jsonResponse(200, {
        'session': t.starts.isEmpty ? null : {'id': 's1', 'startedBy': 'Ustaz Ali', 'mine': true, 'videoPath': 'box', 'source': 'android'},
        'video': 'external',
        'warnings': <Object>[],
        'ingest': {'ready': t.starts.isNotEmpty},
        'relay': {'state': 'off'},
        'youtube': {'signedIn': true, 'state': 'none'},
      });
      await tester.tap(k('live-start'));
      await settle(tester);
      expect(t.starts.single['videoPath'], 'box');
      expect(k('live-control-only'), findsOneWidget);
      expect(pub.started, isEmpty);
      expect(pub.prepared.length, preparedBefore, reason: 'no camera is opened while this phone only controls');
      expect(pub.current.phase, PublisherPhase.idle);
      // back to this phone as the puller (after the live): the engine is prepared again
      t.h.container.dispose();
    });

    testWidgets('with the box pulling: start sends videoPath box, the phone starts no publisher and asks for no camera address', (tester) async {
      final t = await _open(tester, realController: true);
      await tester.tap(find.text('MAXCOM Kiosk Box'));
      await settle(tester);
      final preparedBefore = t.pub.prepared.length;
      t.h.box.seen.clear();
      // the box reports the session it is about to open, as this phone's own, pulled by the box
      t.h.handlers['GET /api/live/status'] = (r) async => jsonResponse(200, {
        'session': t.starts.isEmpty ? null : {'id': 's1', 'startedBy': 'Ustaz Ali', 'mine': true, 'videoPath': 'box', 'source': 'android'},
        'video': 'external',
        'warnings': <Object>[],
        'ingest': {'ready': t.starts.isNotEmpty},
        'relay': {'state': 'off'},
        'youtube': {'signedIn': true, 'state': 'none'},
      });
      await tester.tap(k('live-start'));
      await settle(tester);
      expect(t.starts.single['videoPath'], 'box');
      expect(t.starts.single['youtubeVia'], 'box');
      expect(t.pub.started, isEmpty, reason: 'the phone only controls');
      expect(t.pub.prepared.length, preparedBefore);
      expect(t.h.box.seen.where((r) => r.url.path == '/api/live/camera/source'), isEmpty, reason: 'no pull by the phone');
      // the live is on the screen from the box's status: Berhenti, the note, the shared picture
      expect(k('live-stop'), findsOneWidget);
      expect(k('live-control-only'), findsOneWidget);
      expect(k('live-shared-picture'), findsNothing, reason: 'the control card replaces the picture (build 4)');
      expect(k('live-control-card'), findsOneWidget);
      // the stop asks first (B12), then the summary says why nothing was recorded on the phone
      await tester.tap(k('live-stop'));
      await settle(tester);
      expect(k('live-stop-dialog'), findsOneWidget);
      await tester.tap(k('live-stop-confirm'));
      await tester.pump(const Duration(milliseconds: 300));
      await settle(tester);
      expect(t.pub.stops, 0);
      expect(k('live-rec-none-why'), findsOneWidget);
      expect(
        find.text(
          'Siaran ini tidak dirakam pada telefon kerana video diambil oleh MAXCOM Kiosk Box, bukan oleh telefon ini. Jika YouTube dipilih, salinan siaran ada di YouTube.',
        ),
        findsOneWidget,
      );
      t.h.container.dispose();
    });

    testWidgets('the choice is remembered on this device', (tester) async {
      final mem = _PathStore('box');
      final t = await _open(tester, realController: true, extra: [liveVideoPathStoreProvider.overrideWithValue(mem)]);
      expect(t.source.videoPath, 'box');
      await tester.tap(find.text('Telefon ini'));
      await settle(tester);
      expect(mem.path, 'device');
      t.h.container.dispose();
    });

    testWidgets('an iPad has no such choice (the box always pulls for a browser)', (tester) async {
      await _open(tester, device: 'ipad');
      expect(k('video-path-choice'), findsNothing);
    });
  });

  group('the camera in use flag', () {
    Map<String, Object?> busy({String via = 'device'}) => {
      'session': {'id': 's7', 'startedBy': 'Tablet Surau', 'mine': false, 'videoPath': via},
      'video': 'external',
      'warnings': <Object>[],
      'ingest': {'ready': true},
      'relay': {'state': 'off'},
      'youtube': {'signedIn': true, 'state': 'none'},
      'cameraUse': [
        {'cameraId': 'external', 'sessionId': 's7', 'via': via, 'by': {'name': 'Tablet Surau', 'mine': false}, 'since': '2026-11-23T12:00:00.000Z'},
      ],
    };

    testWidgets('another phone pulls the camera: the flag is shown, the picture is joined through the box, and NO second pull is opened', (tester) async {
      final t = await _open(tester, realController: true);
      t.h.handlers['GET /api/live/status'] = (r) async => jsonResponse(200, busy());
      t.h.box.seen.clear();
      final prepared = t.pub.prepared.length;
      await (t.box as LiveController).pollOnce();
      await settle(tester);
      expect(k('live-camera-in-use'), findsOneWidget);
      expect(find.textContaining('Kamera sedang digunakan oleh'), findsOneWidget);
      expect(find.textContaining('Tablet Surau'), findsWidgets);
      expect(find.text('Telefon ini memaparkan gambar yang sama melalui MAXCOM dan tidak menyambung terus ke kamera.'), findsOneWidget);
      expect(k('live-shared-picture'), findsOneWidget);
      expect(t.source.cameraInUse, isTrue);
      // a refresh of the source while the camera is busy prepares nothing and asks for no address
      await t.h.container.read(liveSourceProvider.notifier).prepare(recording: true, frontCamera: false);
      expect(t.pub.prepared.length, prepared);
      expect(t.h.box.seen.where((r) => r.url.path == '/api/live/camera/source'), isEmpty);
      t.h.container.dispose();
    });

    testWidgets('the box pulls it for another device: "oleh MAXCOM Kiosk Box"', (tester) async {
      final t = await _open(tester, realController: true);
      t.h.handlers['GET /api/live/status'] = (r) async => jsonResponse(200, busy(via: 'box'));
      await (t.box as LiveController).pollOnce();
      await settle(tester);
      expect(find.textContaining('Kamera sedang digunakan oleh MAXCOM Kiosk Box sejak'), findsOneWidget);
      t.h.container.dispose();
    });

    testWidgets('the box refuses the address (camera_in_use): no fallback to the phone camera, no second pull', (tester) async {
      final t = await _open(tester, realController: true);
      t.h.handlers['GET /api/live/camera/source'] = (r) async => jsonResponse(409, {'errors': ['x'], 'code': 'camera_in_use'});
      await t.h.container.read(liveSourceProvider.notifier).prepare(recording: true, frontCamera: false);
      await settle(tester);
      expect(t.source.video, VideoSourceKind.external, reason: 'the choice stays; the phone camera does not take over');
      expect(t.source.cameraRefused, isTrue);
      expect(t.source.cameraBusy, isTrue);
      t.h.container.dispose();
    });
  });

  group('the start request', () {
    testWidgets('the external camera and the mix travel with POST /api/live/start', (tester) async {
      final t = await _open(tester, mix: _mix(cam: 40, mic: true), realController: true);
      await tester.tap(k('live-start'));
      await settle(tester);
      expect(t.starts, hasLength(1));
      expect(t.starts.single['video'], 'external');
      // one sound only: the microphone is on, the camera sound is off (its volume is kept)
      expect((t.starts.single['audio'] as Map)['camera'], {'enabled': false, 'volume': 40});
      expect((t.starts.single['audio'] as Map)['deviceMic'], {'enabled': true, 'volume': 100});
      t.h.container.dispose(); // the open live's heartbeat ends with its controller
    });

    testWidgets('the phone camera alone starts exactly as today (no video or audio field)', (tester) async {
      final t = await _open(tester, video: VideoSourceKind.phone, realController: true);
      await tester.tap(k('live-start'));
      await settle(tester);
      expect(t.starts.single.containsKey('video'), isFalse);
      expect(t.starts.single.containsKey('audio'), isFalse);
      t.h.container.dispose();
    });
  });

  group('Lane X: Kawalan kamera', () {
    testWidgets('an older box that says nothing about control: no row', (tester) async {
      await _open(tester);
      expect(k('camera-control-row'), findsNothing);
    });

    testWidgets('the opt-in off: no row', (tester) async {
      await _open(tester, control: {'enabled': false, 'protocol': 'osc'});
      expect(k('camera-control-row'), findsNothing);
    });

    testWidgets('the opt-in on: a collapsed row; open, it shows Kecerahan, Kedudukan 1 2 3 Asal and Jejak automatik', (tester) async {
      await _open(tester, control: {'enabled': true, 'protocol': 'osc'});
      await reveal(tester, k('camera-control-row'));
      expect(find.text('Kawalan kamera'), findsOneWidget);
      expect(k('camera-control-darker'), findsNothing, reason: 'collapsed');
      await tester.tap(k('camera-control-toggle'));
      await settle(tester);
      expect(find.text('Kecerahan'), findsOneWidget);
      expect(find.text('Kedudukan'), findsOneWidget);
      for (final key in ['camera-control-preset-1', 'camera-control-preset-2', 'camera-control-preset-3', 'camera-control-home', 'camera-control-tracking']) {
        expect(k(key), findsOneWidget, reason: key);
      }
      expect(find.text('Asal'), findsOneWidget);
      expect(find.text('Jejak automatik'), findsOneWidget);
      expect(tester.widget<Text>(k('camera-control-ev')).data, '0.0');
    });

    testWidgets('each tap is one call to the box: brightness steps, a preset, Asal and the tracking switch', (tester) async {
      final t = await _open(tester, control: {'enabled': true, 'protocol': 'osc'});
      await reveal(tester, k('camera-control-row'));
      await tester.tap(k('camera-control-toggle'));
      await settle(tester);
      await tester.tap(k('camera-control-brighter'));
      await settle(tester);
      expect(t.controlPosts, [
        {'action': 'exposure', 'ev': 0.3},
      ]);
      expect(tester.widget<Text>(k('camera-control-ev')).data, '+0.3');
      expect(find.text('Kamera menjawab'), findsOneWidget);
      await tester.tap(k('camera-control-darker'));
      await settle(tester);
      await tester.tap(k('camera-control-darker'));
      await settle(tester);
      expect(t.controlPosts.last, {'action': 'exposure', 'ev': -0.3});
      expect(tester.widget<Text>(k('camera-control-ev')).data, '-0.3');
      await tester.tap(k('camera-control-preset-2'));
      await settle(tester);
      expect(t.controlPosts.last, {'action': 'preset', 'preset': 2});
      await tester.tap(k('camera-control-home'));
      await settle(tester);
      expect(t.controlPosts.last, {'action': 'resetPosition'});
      await tester.tap(k('camera-control-tracking'));
      await settle(tester);
      expect(t.controlPosts.last, {'action': 'aiTracking', 'on': true});
      expect(tester.widget<SwitchListTile>(k('camera-control-tracking')).value, isTrue);
      expect(t.controlPosts, hasLength(6));
    });

    testWidgets('a camera that stays silent: the row says it was sent and the shown value still moves', (tester) async {
      final t = await _open(tester, control: {'enabled': true, 'protocol': 'osc'}, controlAnswer: {'sent': true, 'confirmed': false});
      await reveal(tester, k('camera-control-row'));
      await tester.tap(k('camera-control-toggle'));
      await settle(tester);
      await tester.tap(k('camera-control-brighter'));
      await settle(tester);
      expect(find.text('Arahan dihantar ke kamera'), findsOneWidget);
      expect(tester.widget<Text>(k('camera-control-ev')).data, '+0.3');
      expect(t.controlPosts, hasLength(1));
    });

    testWidgets('a message that never left the box is told, and the value does not move', (tester) async {
      await _open(tester, control: {'enabled': true, 'protocol': 'osc'}, controlAnswer: {'sent': false, 'confirmed': false});
      await reveal(tester, k('camera-control-row'));
      await tester.tap(k('camera-control-toggle'));
      await settle(tester);
      await tester.tap(k('camera-control-brighter'));
      await settle(tester);
      expect(find.text('Arahan tidak sampai ke kamera'), findsOneWidget);
      expect(tester.widget<Text>(k('camera-control-ev')).data, '0.0');
    });

    testWidgets('the other method has no brightness command: Kecerahan is left out, the rest stays', (tester) async {
      await _open(tester, control: {'enabled': true, 'protocol': 'visca'});
      await reveal(tester, k('camera-control-row'));
      await tester.tap(k('camera-control-toggle'));
      await settle(tester);
      expect(find.text('Kecerahan'), findsNothing);
      expect(k('camera-control-brighter'), findsNothing);
      expect(k('camera-control-preset-1'), findsOneWidget);
    });

    testWidgets('Terapkan tetapan kamera: the main button is in the collapsed row and is one call; the row then shows the saved brightness and tracking', (tester) async {
      final t = await _open(
        tester,
        control: {
          'enabled': true,
          'protocol': 'http',
          'profile': {'preset': 2, 'focus': 'single', 'tracking': 'human', 'exposureEv': 1.0},
          'applyOnLive': false,
        },
      );
      await reveal(tester, k('camera-control-row'));
      expect(k('camera-control-darker'), findsNothing, reason: 'collapsed');
      expect(find.text('Terapkan tetapan kamera'), findsOneWidget);
      await tester.tap(k('camera-control-apply'));
      await settle(tester);
      expect(t.controlPosts, [
        {'action': 'applyProfile'},
      ]);
      expect(find.text('Kamera menjawab'), findsOneWidget);
      await tester.tap(k('camera-control-toggle'));
      await settle(tester);
      expect(tester.widget<Text>(k('camera-control-ev')).data, '+1.0');
      expect(tester.widget<SwitchListTile>(k('camera-control-tracking')).value, isTrue);
    });

    testWidgets('Terapkan tetapan kamera: a message that never left the box is told and the shown values do not move', (tester) async {
      await _open(
        tester,
        control: {'enabled': true, 'protocol': 'http', 'profile': {'preset': 1, 'focus': 'continuous', 'tracking': 'human', 'exposureEv': 2.0}},
        controlAnswer: {'sent': false, 'confirmed': false},
      );
      await reveal(tester, k('camera-control-row'));
      await tester.tap(k('camera-control-apply'));
      await settle(tester);
      expect(find.text('Arahan tidak sampai ke kamera'), findsOneWidget);
      await tester.tap(k('camera-control-toggle'));
      await settle(tester);
      expect(tester.widget<Text>(k('camera-control-ev')).data, '0.0');
    });

    testWidgets('the phone camera is the picture: no row for the external camera', (tester) async {
      await _open(tester, video: VideoSourceKind.phone, control: {'enabled': true, 'protocol': 'osc'});
      expect(k('camera-control-row'), findsNothing);
    });
  });

  group('who may see and do what', () {
    testWidgets('Siaran Langsung role: sources, YouTube sign-in and the settings section', (tester) async {
      await _open(tester);
      // "Tetapan siaran" is open when no live runs: the four forms and the YouTube account in the one card.
      expect(k('live-settings-liveCamera'), findsOneWidget);
      await reveal(tester, k('live-youtube-account'));
      expect(k('live-youtube-account'), findsOneWidget);
    });

    testWidgets('Media has no Siaran langsung menu and no route', (tester) async {
      final h = await pumpShell(tester, roles: const ['media']);
      expect(find.text('Siaran langsung'), findsNothing);
      h.router.go('/live');
      await settle(tester);
      expect(h.location, '/');
    });

    testWidgets('an AJK member sees no menu either', (tester) async {
      await pumpShell(tester, roles: const ['ajk']);
      expect(find.text('Siaran langsung'), findsNothing);
    });

    testWidgets('another device\'s live is read-only; the starter alone stops it (21)', (tester) async {
      final t = await _open(
        tester,
        box: _liveBox(
          audio: [_dto('camera', 40), _dto('deviceMic', 100, align: 'locked')],
          other: const OtherLive(sessionId: 's9', starter: 'Telefon Ustaz Ali', video: 'external'),
        ),
      );
      expect(find.text('Siaran sedang berjalan dari Telefon Ustaz Ali'), findsOneWidget);
      await reveal(tester, k('live-stop-disabled'));
      expect(tester.widget<FilledButton>(k('live-stop-disabled')).onPressed, isNull);
      expect(k('live-emergency-stop'), findsNothing, reason: 'not the Pentadbir');
      expect(tester.widget<Slider>(k('audio-volume-camera')).onChanged, isNull);
      expect(t.pub.started, isEmpty);
      expect(k('live-start'), findsNothing, reason: 'no second live can be started');
    });

    testWidgets('the Pentadbir has Henti kecemasan: it names the starter and the box is told (22)', (tester) async {
      final t = await _open(
        tester,
        roles: const ['admin'],
        realController: true,
      );
      var stopped = '';
      t.h.handlers['GET /api/live/status'] = (r) async => jsonResponse(200, {
        'session': {'id': 's9', 'startedBy': 'Telefon Ustaz Ali'},
        'video': 'external',
        'audio': {
          'sources': [
            {'id': 'camera', 'enabled': true, 'volume': 40, 'state': 'ok'},
          ],
        },
        'warnings': <Object>[],
        'ingest': {'ready': true},
        'relay': {'state': 'off'},
        'youtube': {'signedIn': true, 'state': 'none'},
      });
      t.h.handlers['POST /api/live/stop'] = (r) async {
        stopped = (jsonDecode(r.body) as Map)['sessionId'] as String;
        return jsonResponse(200, {'stopped': true});
      };
      await (t.h.container.read(liveBoxProvider.notifier) as LiveController).pollOnce();
      await settle(tester);
      await reveal(tester, k('live-emergency-stop'));
      await tester.tap(k('live-emergency-stop'));
      await settle(tester);
      expect(find.text('Hentikan siaran Telefon Ustaz Ali?'), findsOneWidget);
      await tester.tap(find.text('Henti kecemasan').last);
      await settle(tester);
      expect(stopped, 's9');
    });
  });

  group('the users screen', () {
    testWidgets('the Siaran Langsung role has a label and the Media hint shows while a Media user lacks it', (tester) async {
      final h = await pumpShell(tester, roles: const ['admin']);
      h.router.go('/users');
      await settle(tester);
      expect(find.text('Peranan Media tidak lagi boleh membuat siaran langsung. Beri peranan Siaran Langsung kepada pengguna yang perlu.'), findsOneWidget);
    });
  });

  group('build 6: one source on at a time', () {
    testWidgets('turning an off row on turns the others off in the one request', (tester) async {
      // the box microphone is the sound (a saved mix with two on opens as one); the camera row is off
      final t = await _open(tester, mix: _mix(cam: 60, box: true, boxVol: 80));
      await _openAll(tester);
      expect(t.source.mix.boxInput.enabled, isTrue);
      expect(t.source.mix.camera.enabled, isFalse);
      await reveal(tester, k('audio-rowmute-camera'));
      await tester.tap(k('audio-rowmute-camera'));
      await settle(tester);
      final m = t.pub.mixes.last;
      expect(m.camera.enabled, isTrue);
      expect(m.camera.volume, 60, reason: 'its last volume');
      expect(m.boxInput.enabled, isFalse);
      expect(m.deviceMic.enabled, isFalse);
    });

    testWidgets('picking B while A was on: both rows stay listed, A off and B on', (tester) async {
      final t = await _open(tester, mix: _mix(cam: 60, box: true, boxVol: 80));
      await _openAll(tester);
      expect(k('audio-row-boxInput'), findsOneWidget);
      await reveal(tester, k('audio-rowmute-camera'));
      await tester.tap(k('audio-rowmute-camera'));
      await settle(tester);
      expect(t.source.mix.camera.enabled, isTrue);
      expect(t.source.mix.boxInput.enabled, isFalse);
      expect(k('audio-row-camera'), findsOneWidget);
      expect(k('audio-row-boxInput'), findsOneWidget, reason: 'an off row does not disappear');
      await reveal(tester, k('audio-volume-boxInput'));
      expect(tester.widget<Slider>(k('audio-volume-boxInput')).onChanged, isNull);
      expect(tester.widget<Slider>(k('audio-volume-camera')).onChanged, isNotNull);
    });

    testWidgets('a status echo with the listed source disabled keeps its row; X removes it; the sheet brings it back on', (tester) async {
      final t = await _open(tester, mix: _mix(cam: 60, box: true, boxVol: 80));
      await _openAll(tester);
      await reveal(tester, k('audio-rowmute-camera'));
      await tester.tap(k('audio-rowmute-camera'));
      await settle(tester);
      // an echo from the box: only the camera is enabled
      t.h.container.read(liveBoxProvider.notifier);
      await t.h.container.read(liveSourceProvider.notifier).refresh();
      await settle(tester);
      expect(k('audio-row-boxInput'), findsOneWidget, reason: 'a reload of the source does not drop a listed row');
      await reveal(tester, k('audio-remove-boxInput'));
      await tester.tap(k('audio-remove-boxInput'));
      await settle(tester);
      expect(k('audio-row-boxInput'), findsNothing);
      expect(t.source.mix.camera.enabled, isTrue, reason: 'removing an off row leaves the sound as it was');
      await reveal(tester, k('audio-add'));
      await tester.tap(k('audio-add'));
      await settle(tester);
      await tester.tap(k('add-audio-button-boxInput'));
      await settle(tester);
      expect(k('audio-row-boxInput'), findsOneWidget);
      expect(t.source.mix.boxInput.enabled, isTrue);
      expect(t.source.mix.camera.enabled, isFalse);
      expect(k('audio-row-camera'), findsOneWidget, reason: 'the camera row stays as an off row');
    });

    testWidgets('an off row at volume 0 comes on at 100', (tester) async {
      final t = await _open(tester, mix: _mix(cam: 0, box: true, boxVol: 80));
      await _openAll(tester);
      await reveal(tester, k('audio-rowmute-camera'));
      await tester.tap(k('audio-rowmute-camera'));
      await settle(tester);
      expect(t.source.mix.camera.volume, 100);
      expect(t.source.mix.boxInput.enabled, isFalse);
    });

    testWidgets('Tambah audio turns the new source on and the others off', (tester) async {
      final t = await _open(tester, mix: _mix(cam: 50));
      await _openAll(tester);
      await tester.tap(k('audio-add'));
      await settle(tester);
      await tester.tap(k('add-audio-button-boxInput'));
      await settle(tester);
      final m = t.pub.mixes.isEmpty ? t.source.mix : t.pub.mixes.last;
      expect(m.boxInput.enabled, isTrue);
      expect(m.camera.enabled, isFalse);
      expect(m.deviceMic.enabled, isFalse);
      expect(t.source.mix.camera.volume, 50, reason: 'the volume of the row that went off is kept');
    });

    testWidgets('turning the only row on off is allowed: no sound, and the warning says so', (tester) async {
      final t = await _open(tester, mix: _mix(cam: 0, mic: true));
      await _openAll(tester);
      await tester.tap(k('audio-remove-deviceMic'));
      await settle(tester);
      expect(t.source.mix.deviceMic.enabled, isFalse);
      expect(t.source.mix.camera.enabled, isFalse, reason: 'removing never switches another source on by itself');
      expect(find.text('Semua sumber audio disenyapkan. Siaran tiada bunyi.'), findsOneWidget);
    });

    testWidgets('during a live a switch asks first: Batal changes nothing, Tukar sends one request', (tester) async {
      final t = await _open(tester, mix: _mix(cam: 60, box: true, boxVol: 80));
      t.pub.emit(_live(audio: _audio()));
      await settle(tester);
      t.h.container.read(liveFoldedProvider.notifier).set(false);
      await settle(tester);
      final before = t.pub.mixes.length;
      await reveal(tester, k('audio-rowmute-camera'));
      await tester.tap(k('audio-rowmute-camera'));
      await settle(tester);
      expect(find.text('Tukar bunyi? Siaran berhenti seketika (2 hingga 3 saat).'), findsOneWidget);
      await tester.tap(k('audio-switch-cancel'));
      await settle(tester);
      expect(t.pub.mixes.length, before);
      expect(t.source.mix.boxInput.enabled, isTrue);
      await tester.tap(k('audio-rowmute-camera'));
      await settle(tester);
      await tester.tap(k('audio-switch-do'));
      await settle(tester);
      expect(t.pub.mixes.length, before + 1);
      expect(t.pub.mixes.last.camera.enabled, isTrue);
      expect(t.pub.mixes.last.boxInput.enabled, isFalse);
    });

    testWidgets('before a live a switch asks nothing', (tester) async {
      final t = await _open(tester, mix: _mix(cam: 60, box: true, boxVol: 80));
      await _openAll(tester);
      await reveal(tester, k('audio-rowmute-camera'));
      await tester.tap(k('audio-rowmute-camera'));
      await settle(tester);
      expect(k('audio-switch-confirm'), findsNothing);
      expect(t.source.mix.camera.enabled, isTrue);
    });

    testWidgets('the card never offers a delay block and sends no avOffsetMs', (tester) async {
      final t = await _open(tester, mix: _mix(cam: 60, box: true, boxVol: 80));
      await _openAll(tester);
      expect(k('audio-offset-plus'), findsNothing);
      expect(k('audio-offset-minus'), findsNothing);
      expect(find.text('Selaras bunyi dengan gambar'), findsNothing);
      expect(t.audioPosts.where((p) => p.containsKey('avOffsetMs')), isEmpty);
    });
  });

  group('build 6 gate fixes: the box follows a switch, a refusal puts the mix back', () {
    Future<_T> liveWithBoxMic(WidgetTester tester, {bool refuse = false}) async {
      final t = await _open(tester, mix: _mix(cam: 60, box: true, boxVol: 80));
      if (refuse) {
        t.h.handlers['POST /api/live/audio'] = (r) async {
          t.audioPosts.add(jsonDecode(r.body) as Map<String, dynamic>);
          return jsonResponse(500, {'error': 'refused'});
        };
      }
      t.pub.emit(_live(audio: _audio()));
      await settle(tester);
      return t;
    }

    testWidgets('A1: turning the phone microphone on while the box microphone plays still reaches the box', (tester) async {
      final t = await liveWithBoxMic(tester);
      expect(t.source.mix.boxInput.enabled, isTrue);
      final before = t.audioPosts.length;
      await t.h.container.read(liveSourceProvider.notifier).add(idDeviceMic);
      await settle(tester);
      expect(t.audioPosts.length, before + 1, reason: 'the box is told, or it keeps playing its own microphone');
      final audio = t.audioPosts.last['audio'] as Map<String, dynamic>;
      expect((audio['deviceMic'] as Map)['enabled'], isTrue);
      expect((audio['boxInput'] as Map)['enabled'], isFalse);
      expect(t.source.mix.deviceMic.enabled, isTrue);
    });

    testWidgets('A1: a live that never had the box microphone sends nothing to the box', (tester) async {
      final t = await _open(tester, mix: _mix(cam: 60, mic: true));
      t.pub.emit(_live(audio: _audio()));
      await settle(tester);
      final before = t.audioPosts.length;
      await t.h.container.read(liveSourceProvider.notifier).setVolume(idCamera, 30);
      await settle(tester);
      expect(t.audioPosts.length, before);
    });

    testWidgets('A2: add() refused by the box puts the mix back, tells the person and restores the engine', (tester) async {
      final t = await liveWithBoxMic(tester, refuse: true);
      final original = t.source.mix;
      await t.h.container.read(liveSourceProvider.notifier).add(idDeviceMic);
      await settle(tester);
      expect(t.source.mix.deviceMic.enabled, isFalse);
      expect(t.source.mix.boxInput.enabled, isTrue);
      expect(t.source.mix.boxInput.volume, original.boxInput.volume);
      expect(t.source.error, liveSourceSwitchFailed(AppLang.ms));
      expect(t.pub.mixes.last.boxInput.enabled, isTrue, reason: 'the phone engine is back on the box microphone');
      expect(t.pub.mixes.last.deviceMic.enabled, isFalse);
    });

    testWidgets('A2: setVolume() refused by the box puts the volume back', (tester) async {
      final t = await liveWithBoxMic(tester, refuse: true);
      await t.h.container.read(liveSourceProvider.notifier).setVolume(idBoxInput, 40);
      await settle(tester);
      expect(t.source.mix.boxInput.volume, 80);
      expect(t.source.error, liveSourceSwitchFailed(AppLang.ms));
      expect(t.pub.mixes.last.boxInput.volume, 80);
    });

    testWidgets('A2: useOnly() refused by the box puts the mix back', (tester) async {
      final t = await liveWithBoxMic(tester, refuse: true);
      await t.h.container.read(liveSourceProvider.notifier).useOnly(idCamera);
      await settle(tester);
      expect(t.source.mix.camera.enabled, isFalse);
      expect(t.source.mix.boxInput.enabled, isTrue);
      expect(t.source.error, liveSourceSwitchFailed(AppLang.ms));
      expect(t.pub.mixes.last.boxInput.enabled, isTrue);
    });
  });

  group('goldens', () {
    /// The three sizes; the list is scrolled so that [focus] (a section or the live card) is at the top.
    Future<void> g(WidgetTester tester, _T t, String name, {String? focus}) async {
      for (final size in GoldenSize.values) {
        await pumpAtSize(tester, t.h.app, size);
        if (focus != null) {
          final f = k(focus);
          for (var i = 0; i < 40 && f.evaluate().isEmpty; i++) {
            await tester.drag(find.byType(ListView).first, const Offset(0, -300));
            await tester.pump();
          }
          if (f.evaluate().isNotEmpty) {
            await Scrollable.ensureVisible(tester.element(f), alignment: 0.02);
            await tester.pumpAndSettle();
          }
        }
        await expectLater(
          find.byWidget(t.h.app),
          matchesGoldenFile('${name}_${size.name}.png'),
          reason: 'golden $name at ${size.name}',
        );
      }
    }

    testWidgets('live_mic_external (W7)', (tester) async {
      final t = await _open(
        tester,
        mix: _mix(cam: 40, mic: true),
        initial: _ready(audio: _audio()),
        extra: [micAutoProvider.overrideWith(_MicShown.new)],
      );
      await _openAll(tester);
      expect(find.text('Rode Lavalier'), findsWidgets);
      await g(tester, t, 'live_mic_external', focus: 'live-section-audio');
    });

    testWidgets('live_src_folded (01)', (tester) async {
      final t = await _open(tester, mix: _mix(cam: 40, mic: true), initial: _ready(audio: _audio()));
      await g(tester, t, 'live_src_folded');
    });

    testWidgets('live_src_open (02)', (tester) async {
      final t = await _open(tester, mix: _mix(cam: 40, mic: true), initial: _ready(audio: _audio()));
      await _openAll(tester, const ['video', 'audio', 'out', 'set']);
      await g(tester, t, 'live_src_open', focus: 'live-section-video');
    });

    testWidgets('live_src_unreachable (03)', (tester) async {
      final t = await _open(tester, reachable: false, mix: _mix(cam: 40, mic: true), initial: _ready(audio: _audio(align: 'searching')));
      await _openAll(tester);
      await g(tester, t, 'live_src_unreachable', focus: 'live-section-video');
    });

    testWidgets('live_src_cam_off (04)', (tester) async {
      final t = await _open(tester, cameraOn: false, video: VideoSourceKind.phone);
      await _openAll(tester);
      await g(tester, t, 'live_src_cam_off', focus: 'live-section-video');
    });

    testWidgets('live_src_add_sheet (05)', (tester) async {
      final t = await _open(tester, boxInput: false, video: VideoSourceKind.external, mix: _mix(cam: 40));
      await _openAll(tester);
      await tester.tap(k('audio-add'));
      await settle(tester);
      await g(tester, t, 'live_src_add_sheet');
    });

    testWidgets('live_src_box_input (06)', (tester) async {
      final t = await _open(tester, mix: _mix(cam: 60, box: true));
      await _openAll(tester);
      await g(tester, t, 'live_src_box_input', focus: 'live-section-audio');
    });

    testWidgets('live_align_searching (28)', (tester) async {
      final t = await _open(tester, mix: _mix(cam: 40, mic: true), initial: _ready(audio: _audio(align: 'searching')));
      await _openAll(tester);
      await g(tester, t, 'live_align_searching', focus: 'live-section-audio');
    });

    testWidgets('live_align_failed (29)', (tester) async {
      final t = await _open(tester, mix: _mix(cam: 40, mic: true), initial: _ready(audio: _audio(align: 'failed')));
      await _openAll(tester);
      await g(tester, t, 'live_align_failed', focus: 'live-section-audio');
    });

    testWidgets('live_cam_no_audio (30)', (tester) async {
      final t = await _open(tester, hasAudio: false, mix: _mix(mic: true), initial: _ready());
      await _openAll(tester);
      await g(tester, t, 'live_cam_no_audio', focus: 'live-section-audio');
    });

    testWidgets('live_all_muted (31)', (tester) async {
      final t = await _open(tester, mix: _mix(cam: 0, mic: true, micVol: 0), initial: _ready(audio: _audio(cam: 0, mic: 0)));
      await _openAll(tester);
      await g(tester, t, 'live_all_muted', focus: 'live-section-audio');
    });

    testWidgets('live_phone_cam_box_input (34)', (tester) async {
      final t = await _open(
        tester,
        video: VideoSourceKind.phone,
        mix: LiveAudioMix(camera: _m(false), deviceMic: _m(true), boxInput: _m(true)),
      );
      await _openAll(tester);
      await g(tester, t, 'live_phone_cam_box_input', focus: 'live-section-audio');
    });

    Future<_T> running(WidgetTester tester, PublisherState s, {LiveAudioMix? mix, LiveBoxStatus? box}) async {
      final t = await _open(tester, mix: mix ?? _mix(cam: 40, mic: true), box: box ?? _signedIn);
      t.pub.emit(s);
      await settle(tester);
      t.h.container.read(liveFoldedProvider.notifier).set(false);
      await settle(tester);
      return t;
    }

    testWidgets('live_src_run_mix (17)', (tester) async {
      final t = await running(tester, _live(audio: _audio()));
      await g(tester, t, 'live_src_run_mix', focus: 'live-sources');
    });

    testWidgets('live_src_run_cam_only (18)', (tester) async {
      final t = await running(tester, _live(audio: _audio(micRow: false)), mix: _mix(cam: 100));
      await g(tester, t, 'live_src_run_cam_only', focus: 'live-sources');
    });

    testWidgets('live_src_run_reconnecting (19)', (tester) async {
      final t = await running(tester, _live(audio: _audio(), camera: const CameraStatus(link: CameraLink.lost, lostSec: 12)));
      await g(tester, t, 'live_src_run_reconnecting', focus: 'live-sources');
    });

    testWidgets('live_src_run_lost (20)', (tester) async {
      final t = await running(tester, _live(audio: _audio(), camera: const CameraStatus(link: CameraLink.lost, lostSec: 120)));
      await g(tester, t, 'live_src_run_lost', focus: 'live-sources');
    });

    testWidgets('live_src_run_back (32)', (tester) async {
      final t = await running(tester, _live(audio: _audio()));
      t.pub.emit(_live(audio: _audio(), camera: const CameraStatus(link: CameraLink.lost, lostSec: 30)));
      await settle(tester);
      t.pub.emit(_live(audio: _audio(align: 'searching')));
      await settle(tester);
      await g(tester, t, 'live_src_run_back', focus: 'live-sources');
    });

    testWidgets('live_src_run_other (21)', (tester) async {
      final t = await _open(
        tester,
        box: _liveBox(
          audio: [_dto('camera', 40), _dto('deviceMic', 100, align: 'locked')],
          other: const OtherLive(sessionId: 's9', starter: 'Telefon Ustaz Ali', video: 'external'),
        ),
      );
      await g(tester, t, 'live_src_run_other', focus: 'live-sources');
    });

    testWidgets('live_src_run_other_admin: Henti kecemasan for the Pentadbir', (tester) async {
      final t = await _open(
        tester,
        roles: const ['admin'],
        box: _liveBox(
          audio: [_dto('camera', 40), _dto('deviceMic', 100, align: 'locked')],
          other: const OtherLive(sessionId: 's9', starter: 'Telefon Ustaz Ali', video: 'external'),
        ),
      );
      await g(tester, t, 'live_src_run_other_admin', focus: 'live-sources');
    });

    testWidgets('live_src_stop_dialog (22)', (tester) async {
      final t = await running(tester, _live(audio: _audio()));
      t.h.container.read(liveFoldedProvider.notifier).set(true);
      await settle(tester);
      await tester.tap(k('live-stop'));
      await settle(tester);
      await g(tester, t, 'live_src_stop_dialog');
    });

    testWidgets('live_ipad_pre (23)', (tester) async {
      final t = await _open(tester, device: 'ipad', mix: _mix(cam: 40, mic: true));
      await _openAll(tester);
      await g(tester, t, 'live_ipad_pre', focus: 'live-section-video');
    });

    testWidgets('live_ipad_run (24)', (tester) async {
      final t = await running(
        tester,
        _live(camera: const CameraStatus(link: CameraLink.playing)).copyWith(),
        box: _liveBox(audio: [_dto('camera', 40), _dto('deviceMic', 100, align: 'locked')]),
      );
      await g(tester, t, 'live_ipad_run', focus: 'live-sources');
    });

    testWidgets('live_ipad_mic_lost (33)', (tester) async {
      final t = await running(
        tester,
        _live(),
        box: _liveBox(audio: [_dto('camera', 40), _dto('deviceMic', 100, align: 'searching', state: 'lost', level: null)]),
      );
      await g(tester, t, 'live_ipad_mic_lost', focus: 'live-sources');
    });

    testWidgets('live_ipad_cam_audio_only (35)', (tester) async {
      final t = await _open(tester, device: 'ipad', mix: _mix(cam: 100));
      await _openAll(tester);
      await g(tester, t, 'live_ipad_cam_audio_only', focus: 'live-section-video');
    });
  });

  group('one place to choose the source', () {
    testWidgets('Sumber video is open by default before a live', (tester) async {
      await _open(tester, video: VideoSourceKind.phone);
      expect(k('video-pick-phone'), findsOneWidget);
      expect(k('video-pick-external'), findsOneWidget);
    });

    testWidgets('the offer switched off while the page was away is current on return (and back on)', (tester) async {
      final t = await _open(tester, roles: const ['admin']);
      expect(t.source.video, VideoSourceKind.external);
      expect(find.descendant(of: k('live-settings-liveCamera'), matching: find.textContaining('Ditawarkan sebagai pilihan')), findsOneWidget);
      await _leaveAndComeBack(tester, t, cameraOn: false);
      expect(t.source.camera.enabled, isFalse);
      expect(t.source.video, VideoSourceKind.phone, reason: 'not offered: the phone camera');
      expect(find.descendant(of: k('live-settings-liveCamera'), matching: find.text('Tidak ditawarkan')), findsOneWidget);
      expect(k('video-pick-external'), findsNothing);
      expect(t.pub.prepared.last.video, VideoSourceKind.phone);
      await _leaveAndComeBack(tester, t, cameraOn: true);
      expect(t.source.camera.enabled, isTrue);
      expect(find.descendant(of: k('live-settings-liveCamera'), matching: find.textContaining('Ditawarkan sebagai pilihan')), findsOneWidget);
      expect(k('video-pick-external'), findsOneWidget);
    });

    testWidgets('a switch that fails before the live puts the screen and the saved choice back, with a notice', (tester) async {
      final pub = _FailingPublisher();
      final t = await _open(tester, video: VideoSourceKind.phone, publisher: pub);
      pub.failExternalPrepare = true;
      await t.h.container.read(liveSourceProvider.notifier).selectVideo(VideoSourceKind.external);
      await settle(tester);
      expect(t.source.video, VideoSourceKind.phone);
      expect(t.store.video, VideoSourceKind.phone);
      expect(find.text(liveSourceSwitchFailed(AppLang.ms)), findsOneWidget);
      expect(pub.prepared.last.video, VideoSourceKind.phone, reason: 'the engine is prepared on the source in use');
    });

    testWidgets('a switch that fails during the live puts the screen and the saved choice back, with a notice', (tester) async {
      final pub = _FailingPublisher();
      final t = await _open(tester, mix: _mix(cam: 40, mic: true), publisher: pub);
      pub.emit(_live(audio: _audio()));
      await settle(tester);
      t.h.container.read(liveFoldedProvider.notifier).set(false);
      await settle(tester);
      pub.failSwitch = true;
      await reveal(tester, k('live-switch-phone'));
      await tester.tap(k('live-switch-phone'));
      await settle(tester);
      expect(t.source.video, VideoSourceKind.external);
      expect(t.store.video, VideoSourceKind.external);
      expect(t.source.mix.camera.volume, 40);
      expect(find.text(liveSourceSwitchFailed(AppLang.ms)), findsOneWidget);
    });

    testWidgets('the camera address missing falls back to the phone for now; the saved choice stays external', (tester) async {
      final t = await _open(tester);
      final n = t.h.container.read(liveSourceProvider.notifier);
      t.h.handlers['GET /api/live/camera/source'] = (r) async => jsonResponse(200, {'url': ''});
      await n.prepare(recording: true, frontCamera: false);
      expect(t.source.video, VideoSourceKind.phone);
      expect(t.source.error, liveCameraSourceFailed(AppLang.ms));
      expect(t.store.video, VideoSourceKind.external, reason: 'one network hiccup does not change the surau default');

      // an unrelated settings change: no flip back to external, no new notice
      t.h.settings['liveCamera'] = {...(t.h.settings['liveCamera'] as Map), 'avOffsetMs': {'deviceMic': 300, 'boxInput': 0}};
      t.h.container.invalidate(settingsProvider);
      await n.refresh();
      expect(t.source.video, VideoSourceKind.phone);
      expect(t.store.video, VideoSourceKind.external);

      // the page is opened again: the saved external choice is tried again
      await n.reloadForPage();
      expect(t.source.video, VideoSourceKind.external);
      expect(t.store.video, VideoSourceKind.external);
    });

    testWidgets('choosing external again after a fallback, push fails: the saved choice stays external and the fallback stays', (tester) async {
      final pub = _FailingPublisher();
      final t = await _open(tester, publisher: pub);
      final n = t.h.container.read(liveSourceProvider.notifier);
      t.h.handlers['GET /api/live/camera/source'] = (r) async => jsonResponse(200, {'url': ''});
      await n.prepare(recording: true, frontCamera: false);
      expect(t.source.video, VideoSourceKind.phone);
      expect(t.store.video, VideoSourceKind.external);
      pub.failExternalPrepare = true;
      await n.selectVideo(VideoSourceKind.external);
      await settle(tester);
      expect(t.source.video, VideoSourceKind.phone);
      expect(t.store.video, VideoSourceKind.external, reason: 'the rollback must not write phone over the saved choice');
      expect(t.source.error, isNotNull, reason: 'the person is told');
      // the fallback is still active: an unrelated settings change does not flip it
      t.h.settings['liveCamera'] = {...(t.h.settings['liveCamera'] as Map), 'avOffsetMs': {'deviceMic': 300, 'boxInput': 0}};
      t.h.container.invalidate(settingsProvider);
      await n.refresh();
      expect(t.source.video, VideoSourceKind.phone);
      expect(t.store.video, VideoSourceKind.external);
    });

    testWidgets('the page reopened while the publisher is preparing does not flip the source of a fallback', (tester) async {
      {
        const phase = PublisherPhase.preparing;
        final pub = _FailingPublisher();
        final t = await _open(tester, publisher: pub);
        final n = t.h.container.read(liveSourceProvider.notifier);
        t.h.handlers['GET /api/live/camera/source'] = (r) async => jsonResponse(200, {'url': ''});
        await n.prepare(recording: true, frontCamera: false);
        expect(t.source.video, VideoSourceKind.phone);
        pub.emit(PublisherState(phase: phase, video: VideoSourceKind.phone));
        await tester.pump(const Duration(milliseconds: 100));
        t.h.router.go('/live/settings/liveCamera');
        await tester.pump(const Duration(milliseconds: 500));
        t.h.router.go('/live');
        await tester.pump(const Duration(milliseconds: 500));
        await tester.pump(const Duration(milliseconds: 500));
        expect(t.source.video, VideoSourceKind.phone, reason: 'no reload in $phase');
        expect(t.store.video, VideoSourceKind.external);
      }
    });

    testWidgets('the page reopened while the publisher is in error does not flip the source of a fallback', (tester) async {
      {
        const phase = PublisherPhase.error;
        final pub = _FailingPublisher();
        final t = await _open(tester, publisher: pub);
        final n = t.h.container.read(liveSourceProvider.notifier);
        t.h.handlers['GET /api/live/camera/source'] = (r) async => jsonResponse(200, {'url': ''});
        await n.prepare(recording: true, frontCamera: false);
        expect(t.source.video, VideoSourceKind.phone);
        pub.emit(PublisherState(phase: phase, video: VideoSourceKind.phone));
        await tester.pump(const Duration(milliseconds: 100));
        t.h.router.go('/live/settings/liveCamera');
        await tester.pump(const Duration(milliseconds: 500));
        t.h.router.go('/live');
        await tester.pump(const Duration(milliseconds: 500));
        await tester.pump(const Duration(milliseconds: 500));
        expect(t.source.video, VideoSourceKind.phone, reason: 'no reload in $phase');
        expect(t.store.video, VideoSourceKind.external);
      }
    });

    testWidgets('the camera switched off after a fallback ends it and the settings decide', (tester) async {
      final t = await _open(tester);
      final n = t.h.container.read(liveSourceProvider.notifier);
      t.h.handlers['GET /api/live/camera/source'] = (r) async => jsonResponse(200, {'url': ''});
      await n.prepare(recording: true, frontCamera: false);
      expect(t.source.video, VideoSourceKind.phone);
      t.h.settings['liveCamera'] = {...(t.h.settings['liveCamera'] as Map), 'enabled': false};
      t.h.container.invalidate(settingsProvider);
      await n.refresh();
      expect(t.source.video, VideoSourceKind.phone);
      expect(t.store.video, VideoSourceKind.external, reason: 'still not saved over the choice');
    });

    testWidgets('Tukar ke kamera luaran comes back after the page is rebuilt mid-live', (tester) async {
      final t = await _open(tester, mix: _mix(cam: 40, mic: true));
      t.h.container.read(liveSourceProvider.notifier).liveStarting();
      t.pub.emit(_live(audio: _audio()));
      await settle(tester);
      t.h.container.read(liveFoldedProvider.notifier).set(false);
      await settle(tester);
      await reveal(tester, k('live-switch-phone'));
      await tester.tap(k('live-switch-phone'));
      await settle(tester);
      expect(t.source.video, VideoSourceKind.phone);
      expect(k('live-switch-external'), findsOneWidget);
      // leave the page and come back: the screen state is new, the live is the same
      t.h.router.go('/live/settings/liveCamera');
      await settle(tester);
      t.h.router.go('/live');
      await settle(tester);
      t.h.container.read(liveFoldedProvider.notifier).set(false);
      await settle(tester);
      await reveal(tester, k('live-switch-external'));
      expect(k('live-switch-external'), findsOneWidget);
    });
  });
}
