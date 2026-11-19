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
import 'package:surau_app/features/live/mic_watch.dart';
import 'package:surau_app/features/live/publisher.dart';
import 'package:surau_app/features/shell/live_camera_gateway.dart';
import 'package:surau_app/box/wire.dart';

import 'package:surau_app/app/app_lang.dart' show AppLang;
import 'package:surau_app/features/labels_cam.dart';

import '../features/fakes.dart';
import '../features/shell/harness.dart';
import '../golden_sizes.dart';

const _signedIn = LiveBoxStatus(youtube: YoutubeAccount.signedIn('Surau Contoh'));

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

class _T {
  _T(this.h, this.pub, this.store);

  final ShellHarness h;
  final FakePublisher pub;
  final _MemStore store;
  final List<Map<String, dynamic>> starts = [];
  final List<Map<String, dynamic>> audioPosts = [];

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
}) async {
  final pub = FakePublisher(initial: initial);
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
        : {'available': false, 'devices': <Object>[], 'selected': null, 'reason': 'Tiada input audio pada kotak ini'},
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
  await tester.tap(head);
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
      expect(k('audio-volume-deviceMic'), findsNothing, reason: 'today\'s mute only, no slider (M3)');
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
      await _open(tester, mix: _mix(cam: 40, mic: true), initial: _ready(audio: _audio()));
      await _openAll(tester);
      expect(k('audio-row-camera'), findsOneWidget);
      expect(k('audio-row-deviceMic'), findsOneWidget);
      expect(k('audio-volume-camera'), findsOneWidget);
      expect(k('audio-remove-camera'), findsNothing);
      expect(k('audio-remove-deviceMic'), findsOneWidget);
      expect(find.text('Audio kamera luaran'), findsOneWidget);
      expect(find.textContaining('Mikrofon kamera biasanya jauh dan bising'), findsOneWidget);
      expect(find.text('40%'), findsOneWidget);
    });

    testWidgets('moving a slider sets the volume in steps of 5, remembers it and tells the engine', (tester) async {
      final t = await _open(tester, mix: _mix(cam: 40, mic: true), initial: _ready(audio: _audio()));
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
      expect(find.text('Tiada input audio pada kotak ini'), findsOneWidget);
      expect(k('add-audio-button-boxInput'), findsNothing);
      await tester.tap(k('add-audio-button-deviceMic'));
      await settle(tester);
      expect(t.source.mix.deviceMic.enabled, isTrue);
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

    testWidgets('the folded summary names the sources and the alignment (01)', (tester) async {
      await _open(tester, mix: _mix(cam: 40, mic: true), initial: _ready(audio: _audio()));
      expect(find.text('Audio kamera + Mikrofon telefon, selaras'), findsOneWidget);
    });
  });

  group('alignment (4.3a, 4.7)', () {
    testWidgets('searching: the microphone is held out and the chip says so (28)', (tester) async {
      await _open(tester, mix: _mix(cam: 40, mic: true), initial: _ready(audio: _audio(align: 'searching')));
      await _openAll(tester);
      expect(find.descendant(of: k('audio-chip-deviceMic'), matching: find.text('Sedang diselaraskan')), findsOneWidget);
      expect(find.text('Belum dicampur sehingga selaras'), findsOneWidget);
    });

    testWidgets('locked: Selaras (17)', (tester) async {
      await _open(tester, mix: _mix(cam: 40, mic: true), initial: _ready(audio: _audio()));
      await _openAll(tester);
      expect(find.descendant(of: k('audio-chip-deviceMic'), matching: find.text('Selaras')), findsOneWidget);
    });

    testWidgets('failed after the wait: Belum selaras and Guna Mikrofon telefon sahaja sets the camera to 0 (29)', (tester) async {
      final t = await _open(tester, mix: _mix(cam: 40, mic: true), initial: _ready(audio: _audio(align: 'failed')));
      await _openAll(tester);
      expect(find.descendant(of: k('audio-chip-deviceMic'), matching: find.text('Belum selaras')), findsOneWidget);
      expect(find.textContaining('Penyelarasan automatik belum berjaya, jadi Mikrofon telefon belum dicampur'), findsOneWidget);
      await reveal(tester, k('audio-use-only'));
      expect(find.text('Guna Mikrofon telefon sahaja'), findsOneWidget);
      await tester.tap(k('audio-use-only'));
      await settle(tester);
      expect(t.source.mix.camera.volume, 0);
      expect(t.pub.mixes.last.camera.volume, 0);
    });

    testWidgets('failed with the camera at 0: the short message and no action', (tester) async {
      await _open(tester, mix: _mix(cam: 0, mic: true), initial: _ready(audio: _audio(cam: 0, align: 'failed')));
      await _openAll(tester);
      expect(find.text('Penyelarasan automatik belum berjaya. Bunyi mungkin tidak selari dengan gambar.'), findsOneWidget);
      expect(k('audio-use-only'), findsNothing);
    });

    testWidgets('before an iPad or Mic-in live the chip reads Diselaraskan bila siaran bermula (M4)', (tester) async {
      await _open(tester, device: 'ipad', mix: _mix(cam: 40, mic: true, box: true));
      await _openAll(tester);
      expect(
        find.descendant(of: k('audio-chip-deviceMic'), matching: find.text('Diselaraskan bila siaran bermula')),
        findsOneWidget,
      );
      expect(
        find.descendant(of: k('audio-chip-boxInput'), matching: find.text('Diselaraskan bila siaran bermula')),
        findsOneWidget,
      );
    });

    testWidgets('an iPad live shows the 1 hingga 2 saat lewat note (M5)', (tester) async {
      await _open(tester, device: 'ipad', mix: _mix(cam: 40));
      expect(find.textContaining('1 hingga 2 saat lewat'), findsOneWidget);
    });
  });

  group('a camera with no audio (30)', () {
    testWidgets('the camera row is greyed; Imbangan masa audio and Uji tepukan show for live:settings', (tester) async {
      final t = await _open(tester, hasAudio: false, mix: _mix(mic: true), initial: _ready());
      await _openAll(tester);
      expect(find.text('Kamera ini tiada audio'), findsOneWidget);
      expect(k('audio-volume-camera'), findsNothing);
      expect(find.text('Imbangan masa audio'), findsOneWidget);
      expect(k('audio-clap'), findsOneWidget);
      expect(find.textContaining('Mikrofon telefon digunakan bersendirian'), findsOneWidget);
      await reveal(tester, k('audio-offset-plus'));
      await tester.tap(k('audio-offset-plus'));
      await settle(tester);
      expect(t.source.offsets[idDeviceMic], 50);
      expect(t.pub.avOffsets.last, 50);
    });

    testWidgets('with nothing added the screen says the live has no sound', (tester) async {
      await _open(tester, hasAudio: false, mix: _mix(), initial: _ready());
      await _openAll(tester);
      expect(find.textContaining('Tekan Tambah audio untuk memilih mikrofon'), findsOneWidget);
      expect(k('audio-clap'), findsNothing, reason: 'no added source, nothing to align');
    });

    testWidgets('Uji tepukan records, replays and saves the offset through the engine', (tester) async {
      final t = await _open(tester, hasAudio: false, mix: _mix(mic: true), initial: _ready());
      await _openAll(tester);
      await reveal(tester, k('audio-clap'));
      await tester.tap(k('audio-clap'));
      await settle(tester);
      expect(k('clap-sheet'), findsOneWidget);
      await tester.tap(k('clap-record'));
      await tester.pump();
      expect(t.pub.clapCalls, contains('capture'));
      t.pub.emit(t.pub.current.copyWith(clap: ClapPhase.capturing));
      await tester.pump();
      t.pub.emit(t.pub.current.copyWith(clap: ClapPhase.ready));
      await tester.pump();
      expect(t.pub.clapCalls.any((c) => c.startsWith('replay')), isTrue);
      t.pub.emit(t.pub.current.copyWith(clap: ClapPhase.replaying));
      await settle(tester);
      await tester.tap(k('clap-plus'));
      await tester.pump();
      expect(t.pub.clapCalls.last, 'offset:50');
      var saved = false;
      t.h.handlers['PUT /api/settings/liveCamera'] = (r) async {
        saved = (jsonDecode(r.body) as Map)['avOffsetMs'] != null;
        return jsonResponse(200, t.h.settings);
      };
      await tester.tap(k('clap-save'));
      await settle(tester);
      expect(saved, isTrue);
      expect(t.pub.avOffsets.last, 50);
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
      final t = await _open(tester, mix: _mix(cam: 40, mic: true));
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
      expect(find.text('Kembali. Dicampur semula bila selaras'), findsOneWidget);
    });

    testWidgets('after 10 minutes the engine ends the live: the normal stop and the message', (tester) async {
      final t = await _open(tester, mix: _mix(cam: 40, mic: true), realController: true);
      t.pub.emit(_live(audio: _audio()));
      await settle(tester);
      t.pub.emit(_live(audio: _audio()).copyWith(endReason: endedCameraLost));
      await settle(tester);
      expect(t.pub.stops, 1);
      expect(find.text('Siaran dihentikan kerana kamera terputus lebih 10 minit.'), findsOneWidget);
    });
  });

  group('the start request', () {
    testWidgets('the external camera and the mix travel with POST /api/live/start', (tester) async {
      final t = await _open(tester, mix: _mix(cam: 40, mic: true), realController: true);
      await tester.tap(k('live-start'));
      await settle(tester);
      expect(t.starts, hasLength(1));
      expect(t.starts.single['video'], 'external');
      expect((t.starts.single['audio'] as Map)['camera'], {'enabled': true, 'volume': 40});
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
}
