// The box-pull rectification of the Live tab (2026.11.15 build 4): the control card instead of a picture, the new
// notices, the stop by another person, the box microphone sync and the Skrin / Rakam switches.

import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:surau_app/app/providers.dart';
import 'package:surau_app/box/wire.dart' show LiveAudioSourceDto, LiveStatusDto, LiveViewerDto;
import 'package:surau_app/features/common/bidi.dart' show bidiStrip;
import 'package:surau_app/features/live/fake_publisher.dart';
import 'package:surau_app/features/screens/screens_data.dart' show screensDataProvider;
import 'package:surau_app/features/live/live_destinations.dart';
import 'package:surau_app/features/live/live_screen.dart';
import 'package:flutter_riverpod/misc.dart' show Override;
import 'package:surau_app/features/live/live_source.dart';
import 'package:surau_app/features/live/live_source_widgets.dart' show BoxSyncBlock, BoxSyncMode, FoldSection;
import 'package:surau_app/features/live/live_widgets.dart' show outputStatus;
import 'package:surau_app/l10n/generated/s.dart';
import 'package:surau_app/features/live/publisher.dart';
import 'package:surau_app/features/shell/live_camera_gateway.dart';


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

/// The calls the microphone test group's fake box saw.
List<String> _posts = [];

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

class _RecPub extends FakePublisher implements LiveRecordingControl {
  _RecPub({super.initial});

  final List<bool> recordings = [];

  @override
  Future<void> setRecording(bool on) async {
    recordings.add(on);
    emit(current.copyWith(recording: RecordingState(on: on, segments: current.recording.segments, bytes: current.recording.bytes)));
  }
}

Map<String, Object?> _session({
  bool mine = true,
  String by = 'Haji Kamal (iPad Surau)',
  List<String> warnings = const [],
  Map<String, Object?> extra = const {},
  Map<String, Object?> ingest = const {'ready': true},
  List<Object> audio = const [],
  bool youtube = false,
  bool? kiosk,
  bool canToggle = true,
  bool withViewers = true,
  int? quiet,
  bool? boxPulled,
  bool? startedBoxPulled,
}) => {
  'session': {
    'id': 's1',
    'startedBy': by,
    'mine': mine,
    'videoPath': 'box',
    'boxPulled': ?boxPulled,
    'startedBoxPulled': ?startedBoxPulled,
    'source': 'android',
    'startedAt': '2026-11-25T19:31:00.000Z',
    'outputs': {'kiosk': ?kiosk, 'youtube': youtube},
  },
  'video': 'external',
  'warnings': warnings,
  'ingest': ingest,
  'relay': {'state': 'off'},
  'youtube': {'signedIn': true, 'state': 'none'},
  if (canToggle) 'canToggleKiosk': true,
  'controllerQuietSeconds': ?quiet,
  if (withViewers)
    'viewers': [
      {'tvId': 'tv1', 'name': 'TV Dewan Solat Utama', 'state': 'playing'},
      {'tvId': 'tv2', 'name': 'TV Serambi', 'state': 'playing'},
    ],
  'audio': {'sources': audio},
  ...extra,
};

const _idleStatus = {
  'session': null,
  'warnings': <Object>[],
  'ingest': {'ready': false},
  'relay': {'state': 'off'},
  'youtube': {'signedIn': true, 'state': 'none'},
  'canToggleKiosk': true,
};

/// Opens the Live tab as the phone that STARTED a box-pulled live (the box pulls the camera, the phone controls).
Future<_T> _control(
  WidgetTester tester,
  Map<String, Object?> Function() status, {
  List<String> roles = const ['live'],
  LiveAudioMix? mix,
}) async {
  final t = await _open(tester, realController: true, roles: roles, mix: mix);
  await tester.tap(find.text('MAXCOM Kiosk Box'));
  await settle(tester);
  t.h.handlers['GET /api/live/status'] = (r) async => jsonResponse(200, t.starts.isEmpty ? _idleStatus : status());
  await tester.tap(k('live-start'));
  await settle(tester);
  await (t.box as LiveController).pollOnce();
  await settle(tester);
  return t;
}

/// A text that holds [part], read without the invisible isolates around names.
Finder textHas(String part) => find.byWidgetPredicate((w) => w is Text && bidiStrip(w.data ?? '').contains(part));

void main() {
  group('a live the box pulls: the control card instead of a picture', () {
    testWidgets('the card replaces the picture; no still and no preview call is made', (tester) async {
      final t = await _control(tester, () => _session(ingest: {'ready': true, 'cameraKbps': 3100}));
      t.h.box.seen.clear();
      await (t.box as LiveController).pollOnce();
      await tester.pump(const Duration(seconds: 25));
      await settle(tester);
      expect(k('live-control-card'), findsOneWidget);
      expect(k('live-shared-picture'), findsNothing);
      expect(k('live-control-time'), findsOneWidget);
      expect(find.text('Bersambung, 3.1 Mbps'), findsOneWidget);
      expect(find.text('Video tidak dipaparkan pada peranti ini. Lihat pada TV atau YouTube.'), findsWidgets);
      expect(k('live-control-tv-count'), findsOneWidget);
      final paths = t.h.box.seen.map((r) => r.url.path).toSet();
      expect(paths.contains('/api/live/notice/frame.jpg'), isFalse);
      expect(paths.contains('/api/live/preview/whep'), isFalse);
      // the old three-row status card is merged into the control card
      expect(k('live-kiosk'), findsNothing);
      expect(k('live-recording'), findsNothing);
      t.h.container.dispose();
    });

    testWidgets('an old box (no new fields) still renders the card', (tester) async {
      final t = await _control(tester, () => _session(canToggle: false, withViewers: false));
      expect(k('live-control-card'), findsOneWidget);
      expect(find.text('Bersambung'), findsOneWidget);
      expect(k('live-controller-quiet'), findsNothing);
      t.h.container.dispose();
    });

    testWidgets('the start screen says there is no picture and the camera app must be closed', (tester) async {
      final t = await _open(tester, realController: true);
      await tester.tap(find.text('MAXCOM Kiosk Box'));
      await settle(tester);
      expect(k('live-no-video-note'), findsOneWidget);
      expect(find.text('Tutup aplikasi kamera (OBSBOT) semasa siaran.'), findsOneWidget);
      expect(find.text('Dua pembaca menjatuhkan gambar kepada 4 hingga 6 bingkai sesaat.'), findsOneWidget);
      expect(k('live-box-pull-idle'), findsNothing);
      // the phone's own camera: neither line
      await tester.tap(find.text('Telefon ini'));
      await settle(tester);
      expect(k('live-no-video-note'), findsNothing);
      t.h.container.dispose();
    });
  });

  group('the new notices', () {
    testWidgets('camera_slow, audio_source_lost and a camera that is gone', (tester) async {
      var warnings = <String>['camera_slow'];
      var audio = <Object>[];
      final t = await _control(tester, () => _session(warnings: warnings, audio: audio));
      expect(k('live-warn-camera-slow'), findsOneWidget);
      expect(find.text('Gambar kamera perlahan'), findsWidgets);
      warnings = ['audio_source_lost'];
      await (t.box as LiveController).pollOnce();
      await settle(tester);
      expect(k('live-warn-audio-lost'), findsOneWidget);
      expect(find.text('Mikrofon MAXCOM dihentikan sementara, bunyi kamera digunakan'), findsOneWidget);
      warnings = [];
      audio = [
        {'id': 'camera', 'enabled': true, 'volume': 0, 'state': 'lost'},
      ];
      await (t.box as LiveController).pollOnce();
      await settle(tester);
      expect(k('live-camera-gone'), findsOneWidget);
      expect(find.text('Kamera terputus, siaran diteruskan'), findsOneWidget);
      t.h.container.dispose();
    });

    testWidgets('controller_quiet says so and offers Stop, which asks first', (tester) async {
      final t = await _control(tester, () => _session(warnings: ['controller_quiet'], quiet: 720));
      expect(k('live-controller-quiet'), findsOneWidget);
      expect(find.text('Siaran masih berjalan, tiada peranti mengawal'), findsOneWidget);
      expect(textHas('sejak 12 minit'), findsOneWidget);
      await tester.ensureVisible(k('live-quiet-stop'));
      await tester.tap(k('live-quiet-stop'));
      await settle(tester);
      expect(k('live-stop-dialog'), findsOneWidget);
      t.h.container.dispose();
    });
  });

  group('stop by another person', () {
    testWidgets('a non-starter with live control sees the control card and a sheet naming the starter', (tester) async {
      final stops = <Map<String, dynamic>>[];
      final t = await _open(tester, realController: true);
      t.h.handlers['GET /api/live/status'] = (r) async => jsonResponse(200, _session(mine: false));
      t.h.handlers['POST /api/live/stop'] = (r) async {
        stops.add(jsonDecode(r.body) as Map<String, dynamic>);
        return jsonResponse(200, {'ok': true});
      };
      await (t.box as LiveController).pollOnce();
      await settle(tester);
      expect(k('live-control-card'), findsOneWidget);
      expect(k('live-shared-picture'), findsNothing);
      expect(textHas('Dimulakan oleh Haji Kamal dari iPad Surau'), findsOneWidget);
      await tester.tap(k('live-stop-other'));
      await settle(tester);
      expect(k('live-stop-other-sheet'), findsOneWidget);
      expect(textHas('Siaran ini dimulakan oleh Haji Kamal dari iPad Surau. Hentikan siaran?'), findsOneWidget);
      expect(textHas('Nama anda dan nama Haji Kamal dicatat dalam log perubahan.'), findsOneWidget);
      await tester.tap(k('live-stop-other-cancel'));
      await settle(tester);
      expect(stops, isEmpty);
      await tester.tap(k('live-stop-other'));
      await settle(tester);
      await tester.tap(k('live-stop-other-confirm'));
      await settle(tester);
      expect(stops.single['sessionId'], 's1');
      t.h.container.dispose();
    });
  });

  group('Skrin and Rakam in the destinations sheet', () {
    testWidgets('Skrin switches off before the start; all off blocks the start with the note', (tester) async {
      final t = await _open(tester, realController: true);
      t.h.handlers['GET /api/live/status'] = (r) async => jsonResponse(200, _idleStatus);
      await (t.box as LiveController).pollOnce();
      await settle(tester);
      await tester.tap(k('live-dest-kiosk'));
      await settle(tester);
      expect(k('live-dest-kiosk-switch'), findsOneWidget);
      await tester.tap(k('live-dest-kiosk-switch'));
      await settle(tester);
      expect(t.h.container.read(liveKioskChoiceProvider), isFalse);
      await tester.tap(k('live-dest-youtube-switch'));
      await settle(tester);
      await tester.tap(k('live-dest-recording-switch'));
      await settle(tester);
      expect(k('live-dest-pick-one-sheet'), findsOneWidget);
      await tester.tap(k('live-dest-close'));
      await settle(tester);
      expect(find.text('Pilih sekurang-kurangnya satu destinasi'), findsOneWidget);
      expect(t.h.container.read(liveKioskChoiceProvider), isFalse);
      t.h.container.dispose();
    });

    testWidgets('an old box keeps Skrin on and disabled with the update note', (tester) async {
      final t = await _open(tester, realController: true);
      await tester.tap(k('live-dest-kiosk'));
      await settle(tester);
      expect(tester.widget<Switch>(k('live-dest-kiosk-switch')).value, isTrue);
      expect(tester.widget<Switch>(k('live-dest-kiosk-switch')).onChanged, isNull);
      expect(find.text('Kemas kini MAXCOM Kiosk Box untuk pilihan ini'), findsOneWidget);
      t.h.container.dispose();
    });

    testWidgets('during a live the last destination cannot be turned off', (tester) async {
      final posts = <Map<String, dynamic>>[];
      final t = await _control(tester, () => _session(kiosk: true, youtube: false));
      t.h.handlers['POST /api/live/outputs'] = (r) async {
        posts.add(jsonDecode(r.body) as Map<String, dynamic>);
        return jsonResponse(200, {'ok': true});
      };
      await (t.box as LiveController).pollOnce();
      await settle(tester);
      await tester.tap(k('live-dest-kiosk'));
      await settle(tester);
      // Skrin is the only destination on (a phone that only controls cannot record): it cannot go
      expect(tester.widget<Switch>(k('live-dest-kiosk-switch')).onChanged, isNull);
      expect(find.text('Destinasi terakhir tidak boleh dimatikan semasa siaran'), findsOneWidget);
      expect(posts, isEmpty);
      t.h.container.dispose();
    });

    testWidgets('during a live with YouTube on, Skrin goes off through /api/live/outputs', (tester) async {
      final posts = <Map<String, dynamic>>[];
      var kiosk = true;
      final t = await _control(tester, () => _session(kiosk: kiosk, youtube: true));
      t.h.handlers['POST /api/live/outputs'] = (r) async {
        posts.add(jsonDecode(r.body) as Map<String, dynamic>);
        kiosk = (posts.last['kiosk'] as bool?) ?? kiosk;
        return jsonResponse(200, {'ok': true});
      };
      await (t.box as LiveController).pollOnce();
      await settle(tester);
      await tester.tap(k('live-dest-kiosk'));
      await settle(tester);
      await tester.tap(k('live-dest-kiosk-switch'));
      await settle(tester);
      expect(posts.single, {'sessionId': 's1', 'kiosk': false});
      expect(find.text('Dimatikan untuk siaran ini'), findsOneWidget);
      t.h.container.dispose();
    });
  });

  group('the iPad that started a box-pulled live', () {
    PublisherState ipadLive() => PublisherState(
      phase: PublisherPhase.live,
      outputs: const PublisherOutputs(kiosk: OutputState.up, youtube: OutputState.up),
      recording: const RecordingState(on: true, segments: 1, bytes: 432013312),
      durationSec: 125,
      video: VideoSourceKind.external,
    );

    testWidgets('shows the control card and the Merakam row, never the picture', (tester) async {
      final pub = _RecPub(initial: ipadLive());
      final t = await _open(
        tester,
        device: 'ipad',
        publisher: pub,
        initial: ipadLive(),
        box: const LiveBoxStatus(youtube: YoutubeAccount.signedIn('Surau Contoh'), canToggleKiosk: true),
      );
      expect(k('live-control-card'), findsOneWidget);
      expect(k('live-control-recording'), findsOneWidget);
      expect(find.text('Merakam di iPad ini'), findsOneWidget);
      expect(find.byType(FakeCameraPicture), findsNothing);
      expect(k('live-shared-picture'), findsNothing);
      // the received stream keeps being recorded: nothing here touches the recording or the preview
      expect(pub.recordings, isEmpty);
      t.h.container.dispose();
    });

    testWidgets('Rakam goes off and on during the live through the publisher', (tester) async {
      final pub = _RecPub(initial: ipadLive());
      final t = await _open(
        tester,
        device: 'ipad',
        publisher: pub,
        initial: ipadLive(),
        box: const LiveBoxStatus(youtube: YoutubeAccount.signedIn('Surau Contoh'), canToggleKiosk: true, sessionKiosk: true),
      );
      await tester.tap(k('live-dest-recording'));
      await settle(tester);
      expect(tester.widget<Switch>(k('live-dest-recording-switch')).onChanged, isNotNull);
      await tester.tap(k('live-dest-recording-switch'));
      await settle(tester);
      expect(pub.recordings, [false]);
      // now Skrin is the only destination on: it cannot go
      expect(tester.widget<Switch>(k('live-dest-kiosk-switch')).onChanged, isNull);
      await tester.tap(k('live-dest-recording-switch'));
      await settle(tester);
      expect(pub.recordings, [false, true]);
      t.h.container.dispose();
    });
  });

  group('the start request', () {
    testWidgets('carries the Skrin choice kept on this device', (tester) async {
      final t = await _open(tester, realController: true);
      t.h.handlers['GET /api/live/status'] = (r) async => jsonResponse(200, _idleStatus);
      await (t.box as LiveController).pollOnce();
      await settle(tester);
      await tester.tap(k('live-dest-kiosk'));
      await settle(tester);
      await tester.tap(k('live-dest-kiosk-switch'));
      await settle(tester);
      await tester.tap(k('live-dest-close'));
      await settle(tester);
      await tester.tap(k('live-start'));
      await settle(tester);
      final outputs = t.starts.single['outputs'] as Map;
      expect(outputs['kiosk'], isFalse);
      t.h.container.dispose();
    });
  });

  group('pre-merge audit: pure rules', () {
    test('the sync offset is the box delay minus its headroom, on one scale', () {
      expect(boxSyncOffsetOf(2150), 150);
      expect(boxSyncOffsetOf(1350), 0, reason: 'under the headroom: clamped to 0');
      expect(boxSyncOffsetOf(4500), 2000, reason: 'over: clamped to 2000');
      expect(boxSyncSeedOf(2170), 150, reason: 'rounded to a step of 50');
      expect(boxSyncSeedOf(2180), 200);
      // while the person steps here the remembered value wins; otherwise the box's value; without one, the remembered
      expect(boxSyncShown(localManual: true, alignState: 'manual', delayMs: 2300, remembered: 100), 100);
      expect(boxSyncShown(localManual: false, alignState: 'manual', delayMs: 2300, remembered: 100), 300);
      expect(boxSyncShown(localManual: false, alignState: 'locked', delayMs: 2150, remembered: 0), 150);
      expect(boxSyncShown(localManual: false, alignState: 'manual', delayMs: null, remembered: 250), 250);
    });

    test('a recording that stopped does not count as a destination', () {
      expect(const RecordingState(on: true).active, isTrue);
      expect(const RecordingState(on: true, lastError: 'store_failed').active, isTrue, reason: 'it is still running');
      for (final code in ['no_data', 'storage_low', 'stopped', 'no_recorder', 'recorder_unavailable']) {
        expect(RecordingState(on: true, lastError: code).active, isFalse, reason: code);
      }
      expect(const RecordingState().active, isFalse);
    });

    test('cameraKbps is read top level, with the old nested place as a fallback; boxPulled from the session', () {
      final top = LiveStatusDto.fromJson({
        'session': {'id': 's1', 'boxPulled': true},
        'cameraKbps': 2750,
        'ingest': {'ready': true},
      });
      expect(top.cameraKbps, 2750);
      expect(top.sessionBoxPulled, isTrue);
      final nested = LiveStatusDto.fromJson({
        'session': {'id': 's1', 'boxPulled': false},
        'ingest': {'ready': true, 'cameraKbps': 1900},
      });
      expect(nested.cameraKbps, 1900);
      expect(nested.sessionBoxPulled, isFalse);
      final old = LiveStatusDto.fromJson({
        'session': {'id': 's1', 'videoPath': 'box'},
      });
      expect(old.cameraKbps, isNull);
      expect(old.sessionBoxPulled, isNull);
      // the box's own word decides; a box that does not say is read from videoPath
      expect(const LiveBoxStatus(sessionId: 's1', videoPath: 'box', sessionBoxPulled: false).boxPulled, isFalse);
      expect(const LiveBoxStatus(sessionId: 's1', videoPath: 'device', sessionBoxPulled: true).boxPulled, isTrue);
      expect(const LiveBoxStatus(sessionId: 's1', videoPath: 'box').boxPulled, isTrue);
      expect(const LiveBoxStatus(videoPath: 'box', sessionBoxPulled: true).boxPulled, isFalse, reason: 'no session');
      expect(const OtherLive(sessionId: 's', starter: 'x', videoPath: 'box', boxPulled: false).pulledByBox, isFalse);
      expect(const OtherLive(sessionId: 's', starter: 'x', videoPath: 'box').pulledByBox, isTrue);
    });

    test('the watch link is opened only when it is a secure web address with a host', () {
      expect(watchUri('https://www.youtube.com/watch?v=abc')?.host, 'www.youtube.com');
      expect(watchUri('http://www.youtube.com/watch?v=abc'), isNull);
      expect(watchUri('javascript:alert(1)'), isNull);
      expect(watchUri('intent://x#Intent;end'), isNull);
      expect(watchUri('https://'), isNull);
      expect(watchUri(null), isNull);
    });

    testWidgets('a retrying leg shows a countdown only when it knows the time', (tester) async {
      late S s;
      await tester.pumpWidget(
        MaterialApp(
          locale: const Locale('ms'),
          localizationsDelegates: S.localizationsDelegates,
          supportedLocales: S.supportedLocales,
          home: Builder(
            builder: (c) {
              s = S.of(c);
              return const SizedBox();
            },
          ),
        ),
      );
      expect(outputStatus(s, const OutputState(OutputPhase.retrying), live: true).$2, 'Mencuba semula');
      expect(outputStatus(s, const OutputState(OutputPhase.retrying, retryInSec: 8), live: true).$2, 'Cuba lagi dalam 8 s');
    });

    test('the mic-lost reading follows the sources the box names', () {
      LiveBoxStatus st(List<LiveAudioSourceDto> a, {bool warn = true}) =>
          LiveBoxStatus(audio: a, warnings: warn ? const {audioSourceLost} : const {});
      LiveAudioSourceDto row(String id, String state, [int vol = 100]) =>
          LiveAudioSourceDto(id: id, enabled: true, volume: vol, state: state);
      // the box microphone is the lost one and the camera sound carries: benched
      expect(st([row('boxInput', 'lost'), row('camera', 'ok')]).boxMicBenched, isTrue);
      // the camera is at 0 (silent): nothing carries, the honest text
      final silent = st([row('boxInput', 'lost'), row('camera', 'silent', 0)]);
      expect(silent.boxMicBenched, isFalse);
      expect(silent.boxMicLostSilent, isTrue);
      // the iPad microphone is the lost one
      final dev = st([row('deviceMic', 'lost'), row('boxInput', 'ok'), row('camera', 'ok')]);
      expect(dev.boxMicBenched, isFalse);
      expect(dev.boxMicLostSilent, isFalse);
      expect(dev.deviceMicLost, isTrue);
      // a box that names no source rows keeps the benched reading of the warning
      expect(st(const []).boxMicBenched, isTrue);
    });
  });

  group('pre-merge audit: the box microphone sync scale and reset', () {
    LiveAudioMix boxMix() => _mix(cam: 0, box: true);

    List<Object> audio(String state, int? delay) => [
      {
        'id': 'boxInput',
        'enabled': true,
        'volume': 100,
        'state': 'ok',
        'align': {'state': state, 'delayMs': ?delay},
        'level': -20,
      },
      {'id': 'camera', 'enabled': true, 'volume': 0, 'state': 'silent'},
    ];
    testWidgets('the Rakam choice of one start does not carry to the next live', (tester) async {
      var ended = false;
      final t = await _control(tester, () => ended ? _idleStatus : _session());
      t.h.container.read(liveRecordingChoiceProvider.notifier).set(true);
      expect(t.h.container.read(liveRecordingChoiceProvider), isTrue);
      ended = true;
      await (t.box as LiveController).pollOnce();
      await settle(tester);
      expect(t.h.container.read(liveRecordingChoiceProvider), isNull);
      t.h.container.dispose();
    });

    testWidgets('an older box has no sync block (the stepper and Kembali ke automatik are for a new box)', (tester) async {
      final t = await _control(tester, () => _session(canToggle: false, audio: audio('locked', 2150)), mix: boxMix());
      expect(k('live-control-card'), findsOneWidget);
      expect(k('live-box-sync'), findsNothing);
      expect(k('live-box-sync-auto'), findsNothing);
      t.h.container.dispose();
    });

    testWidgets('the range line claims Disimpan only when the step is saved', (tester) async {
      Widget block(bool saved) => MaterialApp(
        locale: const Locale('ms'),
        localizationsDelegates: S.localizationsDelegates,
        supportedLocales: S.supportedLocales,
        home: Scaffold(
          body: BoxSyncBlock(
            mode: BoxSyncMode.manual,
            ms: 150,
            saved: saved,
            onManual: () {},
            onAuto: () {},
            onStep: (_) {},
          ),
        ),
      );
      await tester.pumpWidget(block(false));
      expect(find.text('0 hingga 2000 ms, langkah 50 ms.'), findsOneWidget);
      expect(find.textContaining('Disimpan'), findsNothing);
      await tester.pumpWidget(block(true));
      expect(find.textContaining('Disimpan untuk siaran seterusnya'), findsOneWidget);
    });
  });

  group('pre-merge audit: Skrin and Rakam calls', () {
    testWidgets('a Rakam only change sends the CURRENT Skrin too (the box requires it)', (tester) async {
      final posts = <Map<String, dynamic>>[];
      final t = await _control(tester, () => _session(kiosk: false, youtube: true));
      t.h.handlers['POST /api/live/outputs'] = (r) async {
        posts.add(jsonDecode(r.body) as Map<String, dynamic>);
        return jsonResponse(200, {'ok': true});
      };
      await (t.box as LiveController).pollOnce();
      await settle(tester);
      expect(await t.box.setOutputs(recording: true), isTrue);
      expect(posts.single, {'sessionId': 's1', 'kiosk': false, 'recording': true});
      posts.clear();
      expect(await t.box.setOutputs(kiosk: true), isTrue);
      expect(posts.single, {'sessionId': 's1', 'kiosk': true});
      t.h.container.dispose();
    });

    testWidgets('a recording that has stopped is not a destination: Skrin is the last one and cannot go', (tester) async {
      final pub = _RecPub(
        initial: PublisherState(
          phase: PublisherPhase.live,
          outputs: const PublisherOutputs(kiosk: OutputState.up),
          recording: const RecordingState(on: true, segments: 1, bytes: 1000, lastError: 'no_data'),
          durationSec: 125,
          video: VideoSourceKind.external,
        ),
      );
      final t = await _open(
        tester,
        device: 'ipad',
        publisher: pub,
        initial: pub.current,
        box: const LiveBoxStatus(
          youtube: YoutubeAccount.signedIn('Surau Contoh'),
          canToggleKiosk: true,
          sessionKiosk: true,
          sessionYoutube: false,
        ),
      );
      await tester.tap(k('live-dest-kiosk'));
      await settle(tester);
      expect(tester.widget<Switch>(k('live-dest-kiosk-switch')).onChanged, isNull);
      expect(find.text('Destinasi terakhir tidak boleh dimatikan semasa siaran'), findsWidgets);
      // the row of the stopped recording says what happened and that the file is kept
      expect(find.text('Dihentikan, fail setakat ini disimpan'), findsOneWidget);
      t.h.container.dispose();
    });

    testWidgets('the summary line says Skrin off, and the YouTube row says it cannot be turned off', (tester) async {
      final t = await _control(tester, () => _session(kiosk: false, youtube: true));
      expect(tester.widget<Text>(k('live-dest-summary')).data, 'Ke YouTube sahaja');
      await tester.tap(k('live-dest-kiosk'));
      await settle(tester);
      expect(find.text('Boleh dihidupkan semasa siaran, tidak boleh dimatikan'), findsOneWidget);
      t.h.container.dispose();
    });
  });

  group('pre-merge audit: resume sends the current Skrin and Rakam', () {
    testWidgets('the status of a record-only live is read: Skrin off, Rakam on', (tester) async {
      final t = await _open(tester, realController: true);
      t.h.handlers['GET /api/live/status'] = (r) async => jsonResponse(
        200,
        _session(
          kiosk: false,
          youtube: false,
          extra: {
            'session': {
              'id': 's1',
              'startedBy': 'Haji Kamal (iPad Surau)',
              'mine': true,
              'videoPath': 'box',
              'boxPulled': true,
              'source': 'android',
              'startedAt': '2026-11-25T19:31:00.000Z',
              'outputs': {'kiosk': false, 'youtube': false, 'recording': true},
            },
          },
        ),
      );
      await (t.box as LiveController).pollOnce();
      await settle(tester);
      expect(k('live-control-card'), findsOneWidget);
      expect(k('live-no-video-note'), findsNothing);
      final controller = t.box as LiveController;
      expect(controller.state.sessionKiosk, isFalse);
      expect(controller.state.sessionRecording, isTrue);
      t.h.container.dispose();
    });
  });

  group('pre-merge audit: who may stop, and which live has no picture here', () {
    testWidgets('a non-starter on an older box cannot stop (no Stop, the starter is named)', (tester) async {
      final t = await _open(tester, realController: true);
      t.h.handlers['GET /api/live/status'] = (r) async => jsonResponse(200, _session(mine: false, canToggle: false));
      await (t.box as LiveController).pollOnce();
      await settle(tester);
      expect(k('live-stop-other'), findsNothing);
      expect(k('live-stop-disabled'), findsOneWidget);
      expect(k('live-other-device'), findsOneWidget);
      t.h.container.dispose();
    });

    testWidgets('the Pentadbir keeps Stop on an older box (settings:write, as today)', (tester) async {
      final t = await _open(tester, realController: true, roles: const ['admin']);
      t.h.handlers['GET /api/live/status'] = (r) async => jsonResponse(200, _session(mine: false, canToggle: false));
      await (t.box as LiveController).pollOnce();
      await settle(tester);
      expect(k('live-stop-other'), findsOneWidget);
      t.h.container.dispose();
    });

    testWidgets('after a switch to the iPad own camera (boxPulled false) another device shows the normal device live', (tester) async {
      final t = await _open(tester, realController: true);
      t.h.handlers['GET /api/live/status'] = (r) async => jsonResponse(200, _session(mine: false, boxPulled: false));
      await (t.box as LiveController).pollOnce();
      await settle(tester);
      expect(k('live-control-card'), findsNothing);
      expect(k('live-stop-other'), findsNothing);
      expect(k('live-other-device'), findsOneWidget);
      t.h.container.dispose();
    });

    testWidgets('the leave reminder follows the box word', (tester) async {
      final t = await _control(tester, () => _session(boxPulled: false));
      expect((t.box as LiveController).leaveReminderBoxPulled, isFalse);
      t.h.container.dispose();
    });

    testWidgets('the leave reminder says MAXCOM carries on while the box pulls', (tester) async {
      final t = await _control(tester, () => _session(boxPulled: true));
      expect((t.box as LiveController).leaveReminderBoxPulled, isTrue);
      t.h.container.dispose();
    });

    testWidgets('another device live: the YouTube pill comes from the box status', (tester) async {
      final t = await _open(tester, realController: true);
      t.h.handlers['GET /api/live/status'] = (r) async => jsonResponse(
        200,
        _session(
          mine: false,
          youtube: true,
          extra: {
            'youtube': {'signedIn': true, 'state': 'live', 'health': 'good', 'channelTitle': 'Surau Contoh'},
            'session': {
              'id': 's1',
              'startedBy': 'Haji Kamal (iPad Surau)',
              'mine': false,
              'videoPath': 'box',
              'source': 'android',
              'startedAt': '2026-11-25T19:31:00.000Z',
              'youtubeVia': 'box',
              'outputs': {'kiosk': true, 'youtube': true},
            },
          },
        ),
      );
      await (t.box as LiveController).pollOnce();
      await settle(tester);
      expect(t.box.state.youtubeLeg?.phase, OutputPhase.up);
      expect(t.box.state.sessionYoutube, isTrue);
      t.h.container.dispose();
    });
  });

  group('pre-merge audit: camera and microphone notices', () {
    testWidgets('Kamera terputus follows the box camera signals, not ingest.ready', (tester) async {
      var warnings = <String>[];
      var ready = false;
      final t = await _control(tester, () => _session(warnings: warnings, ingest: {'ready': ready}));
      await tester.pump(const Duration(seconds: 40));
      await (t.box as LiveController).pollOnce();
      await settle(tester);
      expect(k('live-camera-gone'), findsNothing, reason: 'the TV path not ready is not the camera being gone');
      warnings = ['no_video_from_camera'];
      ready = true;
      await (t.box as LiveController).pollOnce();
      await settle(tester);
      expect(k('live-camera-gone'), findsOneWidget);
      t.h.container.dispose();
    });

    testWidgets('benched only when the box mic is the lost one and the camera sound carries; else an honest text', (tester) async {
      var audio = <Object>[
        {'id': 'boxInput', 'enabled': true, 'volume': 100, 'state': 'lost'},
        {'id': 'camera', 'enabled': true, 'volume': 100, 'state': 'ok'},
      ];
      final t = await _control(tester, () => _session(warnings: ['audio_source_lost'], audio: audio));
      expect(k('live-warn-audio-lost'), findsOneWidget);
      expect(k('live-warn-box-mic-lost'), findsNothing);
      // the camera sound at 0: nothing carries the live
      audio = [
        {'id': 'boxInput', 'enabled': true, 'volume': 100, 'state': 'lost'},
        {'id': 'camera', 'enabled': true, 'volume': 0, 'state': 'silent'},
      ];
      await (t.box as LiveController).pollOnce();
      await settle(tester);
      expect(k('live-warn-audio-lost'), findsNothing);
      expect(k('live-warn-box-mic-lost'), findsOneWidget);
      expect(find.text('Mikrofon MAXCOM tidak dikesan'), findsOneWidget);
      expect(find.text('Siaran mungkin senyap. Semak sambungan mikrofon pada MAXCOM.'), findsOneWidget);
      // the iPad microphone is the lost one
      audio = [
        {'id': 'deviceMic', 'enabled': true, 'volume': 100, 'state': 'lost'},
        {'id': 'boxInput', 'enabled': true, 'volume': 100, 'state': 'ok'},
        {'id': 'camera', 'enabled': true, 'volume': 0, 'state': 'silent'},
      ];
      await (t.box as LiveController).pollOnce();
      await settle(tester);
      expect(k('live-warn-audio-lost'), findsNothing);
      expect(k('live-warn-box-mic-lost'), findsNothing);
      expect(k('live-warn-device-mic-lost'), findsOneWidget);
      t.h.container.dispose();
    });

    testWidgets('the camera speed is read from the top level of the status', (tester) async {
      final t = await _control(tester, () => _session(extra: {'cameraKbps': 3100}));
      expect(find.text('Bersambung, 3.1 Mbps'), findsOneWidget);
      t.h.container.dispose();
    });

    testWidgets('the quiet text names the starting device', (tester) async {
      final t = await _control(tester, () => _session(warnings: ['controller_quiet'], quiet: 720));
      expect(textHas('Peranti yang memulakan siaran tidak dilihat sejak 12 minit'), findsOneWidget);
      t.h.container.dispose();
    });
  });

  group('pre-merge audit: an iPad found again after a reload', () {
    testWidgets('its own box-pulled live shows the control card at once while Sambung semula is offered', (tester) async {
      final t = await _open(
        tester,
        device: 'ipad',
        box: LiveBoxStatus(
          youtube: const YoutubeAccount.signedIn('Surau Contoh'),
          canToggleKiosk: true,
          sessionId: 's1',
          videoPath: 'box',
          sessionBoxPulled: true,
          resume: LiveResume.needed,
          startedAt: DateTime.utc(2026, 11, 25, 19, 31),
          sessionKiosk: true,
        ),
      );
      expect(k('live-control-card'), findsOneWidget);
      expect(k('live-mine-resume'), findsOneWidget);
      expect(k('live-no-video-note'), findsNothing);
      expect(k('live-start'), findsNothing);
      t.h.container.dispose();
    });
  });

  group('pre-merge audit: the box microphone default and the way back', () {
    testWidgets('an older box keeps today mix; a new box gets the box main once, and a mix the person set stays', (tester) async {
      final t = await _open(tester, realController: true);
      await tester.tap(find.text('MAXCOM Kiosk Box'));
      await settle(tester);
      // the box has not said it has the new controls: camera sound stays at 100, the box microphone is off
      expect(t.source.mix.boxInput.enabled, isFalse);
      expect(t.source.mix.camera.volume, 100);
      t.h.handlers['GET /api/live/status'] = (r) async => jsonResponse(200, _idleStatus);
      await (t.box as LiveController).pollOnce();
      await settle(tester);
      expect(t.source.mix.boxInput.enabled, isTrue, reason: 'a new box: the box microphone is the main sound');
      expect(t.source.mix.camera.volume, 0);
      // the person goes back to camera sound only: the plan rollback
      final notifier = t.h.container.read(liveSourceProvider.notifier);
      await notifier.setVolume(idCamera, 100);
      await notifier.remove(idBoxInput);
      expect(t.source.mix.boxInput.enabled, isFalse);
      // a refresh (the page reopened, the settings changed) never rewrites it
      await notifier.refresh();
      await settle(tester);
      expect(t.source.mix.boxInput.enabled, isFalse);
      expect(t.source.mix.camera.volume, 100);
      t.h.container.dispose();
    });

    testWidgets('the box microphone row can be removed in a box-pulled live', (tester) async {
      final t = await _open(tester, realController: true, mix: _mix(cam: 0, box: true));
      await tester.tap(find.text('MAXCOM Kiosk Box'));
      await settle(tester);
      t.h.handlers['GET /api/live/status'] = (r) async => jsonResponse(200, _idleStatus);
      await (t.box as LiveController).pollOnce();
      await settle(tester);
      final head = k('live-section-audio-head');
      await reveal(tester, head);
      final fold = find.ancestor(of: k('live-section-audio'), matching: find.byType(FoldSection));
      if (!tester.widget<FoldSection>(fold).open) {
        await tester.tap(head);
        await settle(tester);
      }
      await reveal(tester, k('audio-row-boxInput'));
      expect(k('audio-remove-boxInput'), findsOneWidget);
      t.h.container.dispose();
    });
  });

  group('build 5: TVs, busy suggestion and the silent box microphone', () {
    Map<String, Object?> viewersExtra(List<Map<String, String>> v) => {'viewers': v};

    testWidgets('the control card names one to three TVs showing the live and tells the TV on its normal display', (tester) async {
      final t = await _control(
        tester,
        () => _session(
          extra: viewersExtra([
            {'tvId': 'tv1', 'name': 'TV Dewan Solat Utama', 'state': 'playing'},
            {'tvId': 'self', 'name': 'TV Serambi', 'state': 'off'},
          ]),
        ),
      );
      expect(textHas('TV memaparkan siaran: 1 (TV Dewan Solat Utama)'), findsOneWidget);
      expect(textHas('TV Serambi: paparan biasa'), findsOneWidget);
      expect(k('live-control-tv-normal-self'), findsOneWidget);
      // the sheet: one line per TV and the hint
      await tester.tap(k('live-control-tvs'));
      await settle(tester);
      expect(k('live-viewers-sheet'), findsOneWidget);
      expect(find.descendant(of: k('live-viewers-sheet'), matching: find.text('memaparkan siaran')), findsOneWidget);
      expect(find.descendant(of: k('live-viewers-sheet'), matching: find.text('paparan biasa')), findsOneWidget);
      expect(find.text('Tukar dalam Tetapan siaran, Paparkan siaran langsung.'), findsOneWidget);
      t.h.container.dispose();
    });

    testWidgets('more than three TVs showing: the old title', (tester) async {
      final many = [for (var i = 1; i <= 4; i++) {'tvId': 'tv$i', 'name': 'TV $i', 'state': 'playing'}];
      final t = await _control(tester, () => _session(extra: viewersExtra(many)));
      expect(textHas('TV memaparkan siaran'), findsNothing);
      expect(textHas('TV memaparkan'), findsWidgets);
      t.h.container.dispose();
    });

    testWidgets('a box without the TV list: the old title and no extra lines', (tester) async {
      final t = await _control(tester, () => _session(withViewers: false));
      expect(textHas('TV memaparkan siaran'), findsNothing);
      expect(
        find.byWidgetPredicate((w) => w.key is ValueKey && (w.key! as ValueKey).value.toString().startsWith('live-control-tv-normal-')),
        findsNothing,
      );
      t.h.container.dispose();
    });

    testWidgets('build 6: box_mic_drops shows its notice in BM', (tester) async {
      final t = await _control(tester, () => _session(warnings: ['box_mic_drops']));
      expect(k('live-warn-box-mic-drops'), findsOneWidget);
      expect(find.text('Bunyi mikrofon MAXCOM terputus-putus'), findsOneWidget);
      expect(find.text('Periksa kabel mikrofon atau pilih bunyi kamera.'), findsOneWidget);
      t.h.container.dispose();
    });

    testWidgets('build 6: upload_behind shows the seconds, quality_lowered shows 480p, and they clear with the warning', (tester) async {
      var warn = true;
      final t = await _control(
        tester,
        () => _session(
          warnings: warn ? ['upload_behind', 'quality_lowered'] : const [],
          extra: {'relay': {'state': 'running', 'restarts': warn ? 2 : 0, 'behindSeconds': 9, 'quality': 'low'}},
        ),
      );
      expect(k('live-warn-upload-behind'), findsOneWidget);
      expect(find.text('Muat naik ke YouTube perlahan'), findsOneWidget);
      expect(find.text('Siaran lewat 9 saat. Siaran diteruskan.'), findsOneWidget);
      expect(k('live-warn-quality-lowered'), findsOneWidget);
      expect(find.text('Kualiti gambar diturunkan (480p)'), findsOneWidget);
      expect(find.text('Internet perlahan. Kualiti kembali sendiri apabila internet pulih.'), findsOneWidget);
      expect(find.text('Sambungan ke YouTube disambung semula 2 kali'), findsOneWidget);
      warn = false;
      await (t.box as LiveController).pollOnce();
      await settle(tester);
      expect(k('live-warn-upload-behind'), findsNothing);
      expect(k('live-warn-quality-lowered'), findsNothing);
      expect(k('live-relay-reconnects'), findsNothing);
      t.h.container.dispose();
    });

    testWidgets('build 6: a box of build 5 (none of the new fields) shows none of the notices', (tester) async {
      final t = await _control(tester, () => _session());
      expect(k('live-warn-box-mic-drops'), findsNothing);
      expect(k('live-warn-upload-behind'), findsNothing);
      expect(k('live-warn-quality-lowered'), findsNothing);
      expect(k('live-relay-reconnects'), findsNothing);
      t.h.container.dispose();
    });

    testWidgets('server_busy: the notice shows for a holder of live:settings, "Bukan sekarang" hides it', (tester) async {
      final t = await _control(tester, () => _session(warnings: ['server_busy'], extra: {'cpuPercent': 94}));
      expect(k('live-warn-server-busy'), findsOneWidget);
      expect(textHas('terlalu sibuk (CPU 94%)'), findsOneWidget);
      await tester.tap(k('live-busy-later'));
      await settle(tester);
      expect(k('live-warn-server-busy'), findsNothing);
      t.h.container.dispose();
    });

    testWidgets('server_busy: the action writes tv-show with self and false', (tester) async {
      final t = await _control(tester, () => _session(warnings: ['server_busy'], extra: {'cpuPercent': 94}));
      final calls = <Map<String, dynamic>>[];
      t.h.handlers['PUT /api/live/tv-show'] = (r) async {
        calls.add(jsonDecode(r.body) as Map<String, dynamic>);
        return jsonResponse(200, {'tvId': 'self', 'show': false});
      };
      await tester.tap(k('live-busy-off'));
      await settle(tester);
      expect(calls, [
        {'tvId': 'self', 'show': false},
      ]);
      expect(k('live-warn-server-busy'), findsNothing, reason: 'done for this live');
      t.h.container.dispose();
    });

    testWidgets('server_busy: nobody without live:settings is asked', (tester) async {
      final t = await _open(tester, realController: true, roles: const ['ajk']);
      t.h.handlers['GET /api/live/status'] = (r) async => jsonResponse(200, _session(mine: false, warnings: ['server_busy']));
      await (t.box as LiveController).pollOnce();
      await settle(tester);
      expect(k('live-warn-server-busy'), findsNothing);
      t.h.container.dispose();
    });

    Map<String, Object?> silent({int cameraVol = 0, String cameraState = 'silent'}) => _session(
      warnings: ['box_mic_silent'],
      audio: [
        {'id': 'boxInput', 'enabled': true, 'volume': 100, 'state': 'ok', 'level': -90, 'noSignalSeconds': 190},
        {'id': 'camera', 'enabled': true, 'volume': cameraVol, 'state': cameraState, 'level': -40},
      ],
    );

    testWidgets('box_mic_silent: the danger notice with the three hints and the button on the starting device', (tester) async {
      final t = await _control(tester, silent, mix: _mix(cam: 0, box: true));
      expect(k('live-warn-box-mic-silent'), findsOneWidget);
      expect(textHas('Tiada bunyi dari Mikrofon MAXCOM'), findsOneWidget);
      expect(textHas('sejak 3 minit'), findsOneWidget);
      expect(textHas('Semak kabel mikrofon pada lubang mic-in MAXCOM.'), findsOneWidget);
      expect(k('live-mic-use-camera'), findsOneWidget);
      // the row of the box microphone says since when
      expect(textHas('Ke udara, tiada bunyi sejak'), findsOneWidget);
      await tester.tap(k('live-mic-use-camera'));
      await settle(tester);
      expect(t.source.mix.camera.volume, 100, reason: 'the existing mix call with the camera at 100');
      expect(t.source.mix.boxInput.enabled, isFalse, reason: 'one sound only: the camera sound takes over from the silent microphone');
      expect(t.source.mix.camera.enabled, isTrue);
      expect(t.audioPosts, isNotEmpty);
      t.h.container.dispose();
    });

    testWidgets('a short pause (no box_mic_silent warning) shows no "tiada bunyi sejak" line', (tester) async {
      final t = await _control(
        tester,
        () => _session(
          audio: [
            {'id': 'boxInput', 'enabled': true, 'volume': 100, 'state': 'ok', 'level': -90, 'noSignalSeconds': 20},
            {'id': 'camera', 'enabled': true, 'volume': 0, 'state': 'silent', 'level': -40},
          ],
        ),
        mix: _mix(cam: 0, box: true),
      );
      expect(textHas('Ke udara, tiada bunyi sejak'), findsNothing);
      expect(k('live-warn-box-mic-silent'), findsNothing);
      t.h.container.dispose();
    });

    testWidgets('box_mic_silent: another device sees the notice without the button', (tester) async {
      final t = await _open(tester, realController: true);
      t.h.handlers['GET /api/live/status'] = (r) async => jsonResponse(
        200,
        {
          ..._session(mine: false, warnings: ['box_mic_silent'], boxPulled: true, startedBoxPulled: true),
          'audio': {
            'sources': [
              {'id': 'boxInput', 'enabled': true, 'volume': 100, 'state': 'ok', 'noSignalSeconds': 100},
              {'id': 'camera', 'enabled': true, 'volume': 0, 'state': 'silent'},
            ],
          },
        },
      );
      await (t.box as LiveController).pollOnce();
      await settle(tester);
      expect(k('live-warn-box-mic-silent'), findsOneWidget);
      expect(k('live-mic-use-camera'), findsNothing);
      t.h.container.dispose();
    });

    testWidgets('box_mic_silent while the camera sound carries: the plain notice, the row reads "Tiada bunyi"', (tester) async {
      final t = await _control(tester, () => silent(cameraVol: 100, cameraState: 'ok'), mix: _mix(cam: 100, box: true));
      expect(k('live-warn-box-mic-silent'), findsNothing);
      expect(k('live-warn-box-mic-covered'), findsOneWidget);
      expect(textHas('Bunyi kamera digunakan'), findsOneWidget);
      expect(tester.widget<Text>(k('live-control-source-sub-boxInput')).data, 'Tiada bunyi');
      t.h.container.dispose();
    });
  });

  group('build 5: Paparkan siaran langsung, the microphone test and the destinations summary', () {
    Map<String, Object?> boxesAnswer() => {
      'self': {'boxId': 'a1a1a1a1a1a1a1a1', 'name': 'Dewan Utama', 'version': '2026.11.15', 'mode': 'main', 'master': null},
      'boxes': [
        {
          'id': 'dev-b2',
          'boxId': 'b2b2b2b2b2b2b2b2',
          'name': 'Ruang Muslimat',
          'version': '2026.11.15',
          'linkedAt': '2026-11-02T01:45:00.000Z',
          'lastSeenAt': '2026-11-25T14:29:20.000Z',
          'removedAt': null,
        },
        {
          'id': 'dev-b3',
          'boxId': 'c3c3c3c3c3c3c3c3',
          'name': 'Foyer Lama',
          'version': '2026.11.13',
          'linkedAt': '2026-10-28T01:45:00.000Z',
          'lastSeenAt': '2026-11-04T14:05:00.000Z',
          'removedAt': '2026-11-05T01:00:00.000Z',
        },
      ],
    };

    Future<_T> tvShowOpen(WidgetTester tester, {List<String> roles = const ['live']}) async {
      final t = await _open(tester, roles: roles);
      t.h.handlers['GET /api/boxes'] = (r) async => jsonResponse(200, boxesAnswer());
      t.h.settings['tvProfiles'] = {
        'tvs': {
          'dev-b2': {
            'name': 'Muslimat',
            'live': {'show': false},
          },
        },
      };
      t.h.container.invalidate(settingsProvider);
      t.h.container.invalidate(screensDataProvider);
      await settle(tester);
      return t;
    }

    bool switchOn(WidgetTester tester, String id) => tester.widget<Switch>(k('live-tv-show-$id')).value;

    testWidgets('the card is the first item of Tetapan siaran: one row per box that is not removed, show from the profile', (tester) async {
      final t = await tvShowOpen(tester);
      expect(k('live-tv-show'), findsOneWidget);
      expect(k('live-tv-show-self'), findsOneWidget);
      expect(k('live-tv-show-dev-b2'), findsOneWidget);
      expect(k('live-tv-show-dev-b3'), findsNothing, reason: 'a removed box is not listed');
      expect(switchOn(tester, 'self'), isTrue);
      expect(switchOn(tester, 'dev-b2'), isFalse);
      expect(k('live-tv-show-server'), findsOneWidget);
      // above the camera row
      expect(tester.getTopLeft(k('live-tv-show')).dy, lessThan(tester.getTopLeft(k('live-settings-liveCamera')).dy));
      t.h.container.dispose();
    });

    testWidgets('a switch sends PUT /api/live/tv-show and reads the settings again', (tester) async {
      final t = await tvShowOpen(tester);
      final calls = <Map<String, dynamic>>[];
      t.h.handlers['PUT /api/live/tv-show'] = (r) async {
        calls.add(jsonDecode(r.body) as Map<String, dynamic>);
        return jsonResponse(200, {'tvId': 'self', 'show': false});
      };
      await tester.tap(k('live-tv-show-self'));
      await settle(tester);
      expect(calls, [
        {'tvId': 'self', 'show': false},
      ]);
      t.h.container.dispose();
    });

    testWidgets('a 404 (a box that has no such route) hides the card', (tester) async {
      final t = await tvShowOpen(tester);
      t.h.handlers['PUT /api/live/tv-show'] = (r) async => jsonResponse(404, {'errors': ['tiada']});
      await tester.tap(k('live-tv-show-self'));
      await settle(tester);
      expect(k('live-tv-show'), findsNothing);
      expect(k('live-settings-liveCamera'), findsOneWidget, reason: 'the rest of the block stays');
      t.h.container.dispose();
    });

    testWidgets('a box that is a follower shows no card', (tester) async {
      final t = await _open(tester, roles: const ['live']);
      t.h.handlers['GET /api/boxes'] = (r) async => jsonResponse(409, {
        'errors': ['x'],
        'code': 'follower',
        'detail': {'master': 'Dewan Utama'},
      });
      t.h.container.invalidate(screensDataProvider);
      await settle(tester);
      expect(k('live-tv-show'), findsNothing);
      t.h.container.dispose();
    });

    testWidgets('the list cannot be read: the single row self with the name the app has', (tester) async {
      final t = await _open(tester, roles: const ['live']);
      t.h.handlers['GET /api/boxes'] = (r) async => jsonResponse(403, {
        'errors': ['x'],
        'code': 'lan_only',
      });
      t.h.container.invalidate(screensDataProvider);
      await settle(tester);
      expect(k('live-tv-show-self'), findsOneWidget);
      expect(find.byWidgetPredicate((w) => w.key is ValueKey && (w.key! as ValueKey).value.toString().startsWith('live-tv-show-dev')), findsNothing);
      t.h.container.dispose();
    });

    Future<_T> pullStart(WidgetTester tester, {List<String> roles = const ['live'], Future<http.Response> Function(http.Request)? test}) async {
      final t = await _open(tester, roles: roles);
      final posts = <String>[];
      t.h.handlers['GET /api/live/audio-inputs'] = (r) async => jsonResponse(200, {
        'available': true,
        'selected': 'Mikrofon (Realtek)',
        'devices': [
          {'name': 'Mikrofon (Realtek)', 'usable': true},
          {'name': 'Kad bunyi USB', 'usable': true},
        ],
      });
      t.h.handlers['POST /api/live/audio-inputs/test'] =
          test ??
          (r) async {
            posts.add('test');
            return jsonResponse(200, {
              'testedAt': '2026-11-26T11:28:00.000Z',
              'seconds': 5,
              'results': [
                {'name': 'Mikrofon (Realtek)', 'selected': true, 'meanDb': -80.0, 'maxDb': -75.0, 'code': 'silent'},
                {'name': 'Kad bunyi USB', 'selected': false, 'meanDb': -30.0, 'maxDb': -12.0, 'code': 'ok'},
              ],
            });
          };
      t.h.handlers['PUT /api/live/audio-input'] = (r) async {
        posts.add('pick ${(jsonDecode(r.body) as Map)['deviceName']}');
        return jsonResponse(200, {'available': true, 'selected': 'Kad bunyi USB', 'devices': <Object>[]});
      };
      t.starts.clear();
      _posts = posts;
      await tester.tap(find.text('MAXCOM Kiosk Box'));
      await settle(tester);
      await t.h.container.read(liveSourceProvider.notifier).refresh();
      await settle(tester);
      final head = k('live-section-audio-head');
      await reveal(tester, head);
      final fold = find.ancestor(of: k('live-section-audio'), matching: find.byType(FoldSection));
      if (!tester.widget<FoldSection>(fold).open) {
        await tester.tap(head);
        await settle(tester);
      }
      return t;
    }

    testWidgets('the start screen of a box-pulled live tests every input once and shows the result', (tester) async {
      final t = await pullStart(tester);
      expect(k('box-mic-test'), findsOneWidget);
      expect(_posts.where((p) => p == 'test'), hasLength(1), reason: 'once, on the first build');
      expect(k('box-mic-test-row-0'), findsOneWidget);
      expect(k('box-mic-test-row-1'), findsOneWidget);
      expect(k('box-mic-test-silent'), findsOneWidget, reason: 'the chosen input tested silent');
      expect(textHas('Diuji: senyap'), findsOneWidget);
      expect(textHas('Diuji: ada bunyi'), findsOneWidget);
      // the button runs it again
      await tester.tap(k('box-mic-test-again'));
      await settle(tester);
      expect(_posts.where((p) => p == 'test'), hasLength(2));
      // a radio picks the device (live:settings)
      await tester.tap(k('box-mic-test-row-1'));
      await settle(tester);
      expect(_posts, contains('pick Kad bunyi USB'));
      expect(t.starts, isEmpty, reason: 'the test never starts the live');
      t.h.container.dispose();
    });

    testWidgets('a box without the test route (404): the card is not drawn', (tester) async {
      final t = await pullStart(tester, test: (r) async => jsonResponse(404, {'errors': ['tiada']}));
      expect(k('box-mic-test'), findsNothing);
      t.h.container.dispose();
    });

    testWidgets('the destinations summary of a box-pulled live: two lines, no recording words in the first', (tester) async {
      final t = await pullStart(tester);
      final first = tester.widget<Text>(k('live-out-summary')).data!;
      expect(first, isNot(contains('rakaman')));
      expect(first, startsWith('Skrin surau'));
      expect(textHas('Rakaman: Tidak tersedia, video diambil oleh MAXCOM Kiosk Box'), findsOneWidget);
      t.h.container.dispose();
    });

    testWidgets('the destinations summary with the phone camera: the recording is named, no second line', (tester) async {
      final t = await _open(tester, video: VideoSourceKind.phone, roles: const ['live']);
      final first = tester.widget<Text>(k('live-out-summary')).data!;
      expect(first, startsWith('Skrin surau'));
      expect(first, contains('rakaman di telefon ini'));
      expect(k('live-out-summary-norec'), findsNothing);
      t.h.container.dispose();
    });

    testWidgets('the destinations summary on an iPad says iPad', (tester) async {
      final t = await _open(tester, video: VideoSourceKind.phone, device: 'ipad', roles: const ['live']);
      expect(tester.widget<Text>(k('live-out-summary')).data, contains('rakaman di iPad ini'));
      t.h.container.dispose();
    });
  });

  group('goldens of the box-pull screens', () {
    Future<void> shoot(WidgetTester tester, _T t, String name, {Size size = const Size(412, 915)}) async {
      tester.view.physicalSize = size * goldenPixelRatio;
      await settle(tester);
      await expectLater(find.byWidget(t.h.app), matchesGoldenFile('$name.png'), reason: 'golden $name');
    }

    testWidgets('U1 the phone that started a box-pulled live', (tester) async {
      final t = await _control(
        tester,
        () => _session(
          ingest: {'ready': true, 'cameraKbps': 3100},
          audio: [
            {'id': 'boxInput', 'enabled': true, 'volume': 100, 'state': 'ok', 'align': {'state': 'locked', 'delayMs': 1350}, 'level': -18},
            {'id': 'camera', 'enabled': true, 'volume': 0, 'state': 'ok', 'level': -40},
          ],
        ),
      );
      await shoot(tester, t, 'live_rect_u1_control');
      t.h.container.dispose();
    });

    testWidgets('U5a another phone: no controller, with Stop; and the control card with who started it', (tester) async {
      final t = await _open(tester, realController: true);
      t.h.handlers['GET /api/live/status'] = (r) async => jsonResponse(200, _session(mine: false, warnings: ['controller_quiet'], quiet: 720));
      await (t.box as LiveController).pollOnce();
      await settle(tester);
      expect(k('live-controller-quiet'), findsOneWidget, reason: 'another device sees the quiet notice');
      expect(k('live-other-device'), findsNothing);
      await shoot(tester, t, 'live_rect_u5a_quiet');
      t.h.container.dispose();
    });

    testWidgets('U6 the stop sheet that names who started the live', (tester) async {
      final t = await _open(tester, realController: true);
      t.h.handlers['GET /api/live/status'] = (r) async => jsonResponse(200, _session(mine: false));
      await (t.box as LiveController).pollOnce();
      await settle(tester);
      await tester.tap(k('live-stop-other'));
      await shoot(tester, t, 'live_rect_u6_stop_other');
      t.h.container.dispose();
    });

    testWidgets('U3 the start screen with the box pulling', (tester) async {
      final t = await _open(tester, realController: true);
      await tester.tap(find.text('MAXCOM Kiosk Box'));
      await shoot(tester, t, 'live_rect_u3_start');
      t.h.container.dispose();
    });

    testWidgets('U2 the iPad: control card with the Merakam row', (tester) async {
      final pub = _RecPub(
        initial: PublisherState(
          phase: PublisherPhase.live,
          outputs: const PublisherOutputs(kiosk: OutputState.up, youtube: OutputState.up),
          recording: const RecordingState(on: true, segments: 1, bytes: 432013312),
          durationSec: 125,
          video: VideoSourceKind.external,
        ),
      );
      final t = await _open(
        tester,
        device: 'ipad',
        publisher: pub,
        initial: pub.current,
        box: LiveBoxStatus(
          youtube: const YoutubeAccount.signedIn('Surau Contoh'),
          canToggleKiosk: true,
          sessionKiosk: true,
          sessionYoutube: true,
          cameraKbps: 3100,
          viewers: const [LiveViewerDto(tvId: 'tv1', name: 'TV Dewan Solat Utama', state: 'playing')],
        ),
        size: GoldenSize.ipadMiniLandscape,
      );
      await shoot(tester, t, 'live_rect_u2_ipad', size: GoldenSize.ipadMiniLandscape.size);
      t.h.container.dispose();
    });
  });

  group('gate fixes: app part', () {
    test('the watch link opens only on YouTube hosts (A1)', () {
      expect(watchUri('https://www.youtube.com/watch?v=abc')?.host, 'www.youtube.com');
      expect(watchUri('https://youtube.com/live/abc')?.host, 'youtube.com');
      expect(watchUri('https://m.youtube.com/watch?v=abc')?.host, 'm.youtube.com');
      expect(watchUri('https://youtu.be/abc')?.host, 'youtu.be');
      expect(watchUri('https://evil.example/watch?v=abc'), isNull);
      expect(watchUri('https://www.youtube.com.evil.example/x'), isNull);
      expect(watchUri('https://youtube.evil.example/x'), isNull);
    });

    test('startedBoxPulled is read from the session and falls back to the box-pulled word (A7)', () {
      expect(LiveStatusDto.fromJson({'session': {'id': 's', 'startedBoxPulled': true}}).sessionStartedBoxPulled, isTrue);
      expect(LiveStatusDto.fromJson({'session': {'id': 's', 'startedBoxPulled': 'yes'}}).sessionStartedBoxPulled, isNull);
      expect(LiveStatusDto.fromJson({'session': {'id': 's'}}).sessionStartedBoxPulled, isNull);
      expect(const OtherLive(sessionId: 's', starter: 'x', boxPulled: false, startedBoxPulled: true).startedPulled, isTrue);
      expect(const OtherLive(sessionId: 's', starter: 'x', boxPulled: false).startedPulled, isFalse);
      expect(const OtherLive(sessionId: 's', starter: 'x', videoPath: 'box').startedPulled, isTrue);
    });

    testWidgets('after a switch to the iPad camera a non-starter still stops a live that started box-pulled (A7)', (tester) async {
      final t = await _open(tester, realController: true);
      t.h.handlers['GET /api/live/status'] = (r) async =>
          jsonResponse(200, _session(mine: false, boxPulled: false, startedBoxPulled: true));
      await (t.box as LiveController).pollOnce();
      await settle(tester);
      expect(k('live-stop-other'), findsOneWidget);
      expect(k('live-control-card'), findsNothing, reason: 'the card still follows boxPulled');
      t.h.container.dispose();
    });

    testWidgets('the quiet notice of another device follows startedBoxPulled (A7)', (tester) async {
      final t = await _open(tester, realController: true);
      t.h.handlers['GET /api/live/status'] = (r) async => jsonResponse(
        200,
        _session(mine: false, boxPulled: false, startedBoxPulled: true, warnings: const ['controller_quiet'], quiet: 700),
      );
      await (t.box as LiveController).pollOnce();
      await settle(tester);
      expect(k('live-controller-quiet'), findsOneWidget);
      expect(k('live-quiet-stop'), findsOneWidget);
      t.h.container.dispose();
    });

    testWidgets('kiosk_restored shows the notice and the Skrin state from the status (A6)', (tester) async {
      final t = await _control(tester, () => _session(kiosk: true, warnings: const ['kiosk_restored']));
      expect(k('live-kiosk-restored'), findsOneWidget);
      expect(find.text('YouTube tidak dapat disiarkan. Skrin surau dihidupkan semula supaya siaran tetap ke udara.'), findsOneWidget);
      expect((t.box as LiveController).state.sessionKiosk, isTrue);
      t.h.container.dispose();
    });

    testWidgets('no kiosk_restored notice without the warning (A6)', (tester) async {
      final t = await _control(tester, () => _session(kiosk: true));
      expect(k('live-kiosk-restored'), findsNothing);
      t.h.container.dispose();
    });

    testWidgets('Rakam: the box refuses, the local recording stays as it was (A2)', (tester) async {
      final pub = _RecPub(
        initial: PublisherState(
          phase: PublisherPhase.live,
          outputs: const PublisherOutputs(kiosk: OutputState.up, youtube: OutputState.up),
          recording: const RecordingState(on: true, segments: 1, bytes: 432013312),
          durationSec: 125,
          video: VideoSourceKind.external,
        ),
      );
      final asked = <bool?>[];
      var agree = false;
      final t = await _open(
        tester,
        device: 'ipad',
        publisher: pub,
        initial: pub.current,
        realController: true,
        extra: [
          liveBoxProvider.overrideWith(
            () => _AskingBox(
              const LiveBoxStatus(
                sessionId: 's1',
                youtube: YoutubeAccount.signedIn('Surau Contoh'),
                canToggleKiosk: true,
                sessionKiosk: true,
                sessionYoutube: true,
              ),
              (rec) {
                asked.add(rec);
                return agree;
              },
            ),
          ),
        ],
      );
      await tester.tap(k('live-dest-recording'));
      await settle(tester);
      await tester.tap(k('live-dest-recording-switch'));
      await settle(tester);
      expect(asked, [false]);
      expect(pub.recordings, isEmpty, reason: 'the box said no, the recording is not touched');
      agree = true;
      await tester.tap(k('live-dest-recording-switch'));
      await settle(tester);
      expect(asked, [false, false]);
      expect(pub.recordings, [false], reason: 'the box agreed');
      t.h.container.dispose();
    });

    testWidgets('the box-main default is decided only by a change made while the video path is the box (A4)', (tester) async {
      final marks = _MarkStore();
      final t = await _open(
        tester,
        mix: _mix(cam: 80),
        realController: true,
        extra: [liveBoxMainStoreProvider.overrideWithValue(marks)],
      );
      final src = t.h.container.read(liveSourceProvider.notifier);
      await src.setVideoPath(videoPathDevice);
      await settle(tester);
      expect(t.source.videoPath, videoPathDevice);
      await src.setVolume(idCamera, 60);
      await settle(tester);
      expect(marks.marked, isFalse, reason: 'a change made while the phone pulls decides nothing');
      await src.setVideoPath(videoPathBox);
      await settle(tester);
      await src.setVolume(idCamera, 40);
      await settle(tester);
      expect(marks.marked, isTrue, reason: 'a change made on the box path settles it');
      t.h.container.dispose();
    });
  });
}

/// A bare box holder whose Rakam question is answered by [answer] (the box agrees or refuses).
class _AskingBox extends LiveBoxNotifier {
  _AskingBox(super.initial, this.answer);

  final bool Function(bool? recording) answer;

  @override
  Future<bool> setOutputs({bool? kiosk, bool? recording}) async => answer(recording);
}

class _MarkStore implements LiveBoxMainStore {
  bool marked = false;

  @override
  Future<bool> read() async => false;

  @override
  Future<void> markDecided() async => marked = true;
}
