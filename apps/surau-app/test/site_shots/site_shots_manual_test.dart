// Pictures for the user manual and the role guides (release 2026.11.15), made from the real app screens with neutral
// data (Surau Contoh, Ustaz Contoh, Kuliah Maghrib, box1-Surau Contoh, 10.0.0.x, a fake recovery code). Runs only when
// the environment flag SITE_SHOTS=1 is set; otherwise every test here is skipped and nothing is written.
//
//   SITE_SHOTS=1 flutter test test/site_shots/site_shots_manual_test.dart --concurrency=1
//
// Output folder: SITE_SHOTS_OUT, default build/site_shots/manual, one PNG per
// picture and language: SHOT-<chapter>-<name>-<bm|en|ar>.png (412 x 915 logical px at ratio 2 unless a screen needs
// more height). No golden of the app is touched: a comparator writes the PNG instead of comparing it.

import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart' show ProviderContainer, UncontrolledProviderScope;
import 'package:surau_app/main.dart' show SurauApp;
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:surau_app/app/app_lang.dart';
import 'package:surau_app/app/deps.dart';
import 'package:surau_app/app/providers.dart';
import 'package:surau_app/features/link/link_controller.dart';
import 'package:surau_app/features/unlink/unlink_controller.dart';
import 'package:surau_app/features/live/live_source_widgets.dart' show FoldSection;
import 'package:surau_app/features/live/fake_publisher.dart';
import 'package:surau_app/features/live/live_screen.dart';
import 'package:surau_app/l10n/s_lookup.dart' show sFor;
import 'package:surau_app/features/live/live_source.dart';
import 'package:surau_app/features/live/publisher.dart';
import 'package:surau_app/features/shell/live_camera_gateway.dart';
import 'package:surau_app/features/upload/join_providers.dart';
import 'package:surau_app/upload/recording_join.dart';

import '../features/fakes.dart';
import '../features/link/link_screens_test.dart' as linkt show openLink, questionsStatus;
import '../features/link/move_flow_test.dart' as movet show Rig;
import '../features/link/move_screen_test.dart' as movescr show host;
import '../features/shell/harness.dart';
import '../features/unlink/unlink_fixtures.dart' as ufx;
import '../golden_sizes.dart';
import '../screens/finance_a_harness.dart';
import '../screens/recovery_test.dart' as rec show Rig;
import '../support/box_qr_fixture.dart' show completedBody;

final bool _on = Platform.environment['SITE_SHOTS'] == '1';
final String _out = Platform.environment['SITE_SHOTS_OUT'] ?? 'build/site_shots/manual';

const _langs = <(String, AppLang)>[('bm', AppLang.ms), ('en', AppLang.en), ('ar', AppLang.ar)];
const _phone = Size(412, 915);

/// A golden comparator that writes the rendered PNG into [_out] instead of comparing it with a stored file.
class _WriteToSite extends GoldenFileComparator {
  @override
  Future<bool> compare(Uint8List imageBytes, Uri golden) async {
    final f = File('$_out/${golden.pathSegments.last}');
    f.parent.createSync(recursive: true);
    f.writeAsBytesSync(imageBytes);
    return true;
  }

  @override
  Future<void> update(Uri golden, Uint8List imageBytes) => compare(imageBytes, golden).then((_) {});
}

Finder k(String key) => find.byKey(ValueKey(key));

/// The neutral names the manual shows instead of the fixtures' hall names.
const _names = <String, String>{
  'Dewan Utama': 'box1-Surau Contoh',
  'Ruang Muslimat': 'box2-Surau Contoh',
  'Hajjah Aminah': 'Admin Contoh',
  'Aminah': 'Admin Contoh',
  'Zainab': 'Ahli Contoh 1',
  'Hasan': 'Ahli Contoh 2',
  'Khalid': 'Ahli Contoh 3',
  'Mariam': 'Ahli Contoh 4',
  'Yusuf': 'Ahli Contoh 5',
};

Object? _rn(Object? v) {
  if (v is String) {
    var s = v;
    _names.forEach((a, b) => s = s.replaceAll(a, b));
    return s;
  }
  if (v is Map) return {for (final e in v.entries) e.key: _rn(e.value)};
  if (v is List) return [for (final e in v) _rn(e)];
  return v;
}

Map<String, Object?> _rnm(Map<String, Object?> m) => (_rn(m) as Map).cast<String, Object?>();

Future<void> _size(WidgetTester t, Size logical) async {
  t.view.physicalSize = logical * goldenPixelRatio;
  t.view.devicePixelRatio = goldenPixelRatio;
  addTearDown(t.view.resetPhysicalSize);
  addTearDown(t.view.resetDevicePixelRatio);
  await settle(t);
}

Future<void> _snap(WidgetTester t, Widget app, String name, String code) async {
  await t.pump(const Duration(milliseconds: 400));
  await expectLater(find.byWidget(app), matchesGoldenFile('$name-$code.png'));
}

/// Scrolls the live list so that [f] is near the top.
Future<void> _top(WidgetTester t, Finder f, {double alignment = 0.02}) async {
  for (var i = 0; i < 60 && f.evaluate().isEmpty; i++) {
    await t.drag(find.byType(ListView).first, const Offset(0, -300));
    await t.pump();
  }
  await Scrollable.ensureVisible(t.element(f), alignment: alignment);
  await t.pumpAndSettle();
}

// ---- the live page with the external camera (the fixtures of screens/live_source_test.dart) ----

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

PublisherState _ready({PublisherAudio? audio, CameraStatus? camera}) =>
    PublisherState(phase: PublisherPhase.ready, video: VideoSourceKind.external, camera: camera, audio: audio);

AudioRow _row(String id, int vol, {double level = 0.5, String state = 'ok', String? align, bool on = true}) =>
    AudioRow(id: id, enabled: on, volume: vol, level: level, state: state, alignState: align);

Future<ShellHarness> _openLive(
  WidgetTester tester,
  AppLang lang, {
  required LiveAudioMix mix,
  required PublisherState initial,
  Map<String, Object?>? control,
  bool boxInput = true,
  bool pulled = false,
}) async {
  final pub = FakePublisher(initial: initial);
  final store = _MemStore(VideoSourceKind.external, mix);
  final h = await pumpShell(
    tester,
    roles: const ['live'],
    overrides: [
      appLangStoreProvider.overrideWithValue(MemoryAppLangStore(lang)),
      livePublisherProvider.overrideWithValue(pub),
      // a box-pulled live needs the real controller (it reads the box status); the older shots use a fixed one
      if (!pulled) liveBoxProvider.overrideWith(() => LiveBoxNotifier(_signedIn)),
      liveDeviceKindProvider.overrideWithValue('phone'),
      liveSourceStoreProvider.overrideWithValue(store),
    ],
  );
  tester.view.physicalSize = const Size(412, 3600) * goldenPixelRatio;
  addTearDown(tester.view.resetPhysicalSize);
  h.settings['liveCamera'] = {
    'enabled': true,
    'name': 'Kamera Mimbar',
    'transport': 'auto',
    'avOffsetMs': {'deviceMic': 600, 'boxInput': 0},
  };
  h.handlers['GET /api/live/camera'] = (r) async => jsonResponse(200, {
    'configured': true,
    'url': 'rtsp://10.0.0.50:554/stream1',
    'hasPassword': false,
    'control': ?control,
    'lastTest': {
      'code': 'ok',
      'ok': true,
      'hasAudio': true,
      'codecs': ['H264', 'MPEG-4 Audio'],
    },
  });
  h.handlers['GET /api/live/camera/source'] = (r) async => jsonResponse(200, {'url': 'rtsp://siaran:contoh@10.0.0.50:554/stream1'});
  h.handlers['GET /api/live/audio-inputs'] = (r) async => jsonResponse(
    200,
    boxInput
        ? {'available': true, 'devices': <Object>[], 'selected': null}
        : {'available': false, 'devices': <Object>[], 'selected': null, 'reason': 'Tiada input audio pada MAXCOM ini'},
  );
  h.handlers['POST /api/live/camera/control'] = (r) async => jsonResponse(200, {'sent': true, 'confirmed': true});
  h.handlers['POST /api/live/audio'] = (r) async => jsonResponse(200, {'ok': true});
  h.handlers['GET /api/live/status'] = (r) async => jsonResponse(200, pulled ? _idleStatus : _noSession);
  h.container.invalidate(settingsProvider);
  h.router.go('/live');
  await settle(tester);
  return h;
}

const _noSession = {
  'session': null,
  'warnings': <Object>[],
  'ingest': {'ready': false},
  'relay': {'state': 'off'},
  'youtube': {'signedIn': true, 'state': 'none'},
};

/// The status of a box with no live, as a new box (it can switch the TV screens, so `canToggleKiosk`) answers it.
const _idleStatus = {..._noSession, 'canToggleKiosk': true};

/// The status of a box-pulled live started by [by] 24 minutes before the harness clock (copied from
/// screens/live_rectify_test.dart `_session`, with neutral names).
Map<String, Object?> _pulledSession({
  bool mine = true,
  String by = 'Admin Contoh (Telefon Contoh)',
  List<String> warnings = const [],
  List<Object> audio = const [],
  int? quiet,
}) => {
  'session': {
    'id': 's1',
    'startedBy': by,
    'mine': mine,
    'videoPath': 'box',
    'boxPulled': true,
    'startedBoxPulled': true,
    'source': 'android',
    'startedAt': fixedNow().subtract(const Duration(minutes: 24)).toIso8601String(),
    'outputs': {'kiosk': true, 'youtube': true},
  },
  'video': 'external',
  'warnings': warnings,
  'ingest': {'ready': true, 'cameraKbps': 3100},
  'relay': {'state': 'off'},
  'youtube': {'signedIn': true, 'state': 'live', 'health': 'good'},
  'canToggleKiosk': true,
  'controllerQuietSeconds': ?quiet,
  'viewers': [
    {'tvId': 'tv1', 'name': 'TV Contoh 1', 'state': 'playing'},
    {'tvId': 'tv2', 'name': 'TV Contoh 2', 'state': 'playing'},
  ],
  'audio': {'sources': audio},
};

/// The box microphone (locked, so the sync block reads Automatic with a value) and the camera sound at 0.
List<Object> _boxAudio({String state = 'locked', int delay = 2150}) => [
  {'id': 'boxInput', 'enabled': true, 'volume': 100, 'state': 'ok', 'align': {'state': state, 'delayMs': delay}, 'level': -18},
  {'id': 'camera', 'enabled': true, 'volume': 0, 'state': 'ok', 'level': -40},
];

/// Picks "Video taken by: MAXCOM Kiosk Box" on the start screen.
Future<void> _pickBoxPath(WidgetTester t, AppLang lang) async {
  await reveal(t, k('video-path-choice'));
  await t.tap(find.descendant(of: k('video-path-choice'), matching: find.text(sFor(lang).liveVideoPathBox)));
  await settle(t);
}

/// Starts the box-pulled live from the phone that is on the start screen; the box then answers with [status].
Future<void> _startPulled(WidgetTester t, ShellHarness h, Map<String, Object?> Function() status) async {
  var started = false;
  h.handlers['POST /api/live/start'] = (r) async {
    started = true;
    return jsonResponse(200, {
      'session': {'id': 's1'},
      'ingest': {
        'srt': {'host': '10.0.0.2', 'port': 8890, 'streamId': 'x', 'passphrase': 'y'},
      },
    });
  };
  h.handlers['GET /api/live/status'] = (r) async => jsonResponse(200, started ? status() : _idleStatus);
  await reveal(t, k('live-start'));
  await t.tap(k('live-start'));
  await settle(t);
  await (h.container.read(liveBoxProvider.notifier) as LiveController).pollOnce();
  await settle(t);
}

/// Scrolls the live list to its end, so the notes of the start screen that name the camera maker are out of view.
Future<void> _bottom(WidgetTester t) async {
  for (var i = 0; i < 12; i++) {
    await t.drag(find.byType(ListView).first, const Offset(0, -600));
    await t.pump();
  }
  await t.pumpAndSettle();
}

Future<void> _openSection(WidgetTester tester, String key) async {
  final head = k('live-section-$key-head');
  await reveal(tester, head);
  await tester.ensureVisible(head);
  final fold = find.ancestor(of: k('live-section-$key'), matching: find.byType(FoldSection));
  if (tester.widget<FoldSection>(fold).open) return;
  await tester.tap(head);
  await settle(tester);
}

// ---- the broadcast-on-YouTube sheet (screens/live_youtube_later_test.dart) ----

class _Rec extends LiveBoxNotifier {
  _Rec(super.initial);

  @override
  Future<void> startYoutubeLater({String? title, String? privacy}) async {}
}

// ---- a joined recording on an iPad (the browser saves the file by a link) ----

class _FakeJoin implements WebRecordingJoin {
  @override
  Future<JoinOutcome> upload({required String liveId, required String sessionId}) async =>
      const JoinOutcome.joined(name: 'Kuliah-Maghrib-2026-11-24.mp4', bytes: 1395864371, pieces: 2);

  @override
  Future<JoinSave> saveJoined({required String liveId, required String sessionId}) async => JoinSave.handedOver;

  @override
  Future<void> confirmSaved({required String liveId, required String sessionId}) async {}

  @override
  dynamic noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}

/// The deps of [d] on the browser (the iPad web app): the same fake box, platform `ios-web`.
AppDeps _asIpad(AppDeps d) => AppDeps(
  boxStore: d.boxStore,
  surauInfoStore: d.surauInfoStore,
  key: d.key,
  trust: d.trust,
  biometric: d.biometric,
  clientFor: d.clientFor,
  enrolledClient: d.enrolledClient,
  platform: 'ios-web',
  cameraAvailable: d.cameraAvailable,
  initialBox: d.initialBox,
  initialSurau: d.initialSurau,
  appLangStore: d.appLangStore,
  cacheStore: d.cacheStore,
  boxLeaf: d.boxLeaf,
  probeClient: d.probeClient,
  discovery: d.discovery,
  routes: d.routes,
  scannerBuilder: d.scannerBuilder,
  localStoreBuilder: d.localStoreBuilder,
  uploadRunnerBuilder: d.uploadRunnerBuilder,
  healthPollInterval: d.healthPollInterval,
  openUrl: d.openUrl,
  now: d.now,
  toLocal: d.toLocal,
);

// ---- the TVs and Boxes tab (features/screens/screens_backup_test.dart) ----

Map<String, Object?> _boxesBody({Object? backup, Object? kept, bool follower = false}) => {
  'self': {
    'boxId': 'a1a1a1a1a1a1a1a1',
    'name': 'box1-Surau Contoh',
    'keyFp': 'a1a1a1a1a1a1a1a1',
    'version': '2026.11.15',
    'mode': 'main',
    'master': null,
    'backup': backup,
    'kept': kept,
    'freeBytes': 9000000000,
  },
  'boxes': [
    if (follower)
      {
        'id': 'dev-b2',
        'boxId': 'b2b2b2b2b2b2b2b2',
        'keyFp': 'b2b2b2b2b2b2b2b2',
        'name': 'box2-Surau Contoh',
        'version': '2026.11.15',
        'linkedAt': '2026-11-02T01:45:00.000Z',
        'linkId': 'l' * 32,
        'lastSeenAt': '2026-11-24T09:58:00.000Z',
        'removedAt': null,
      },
  ],
};

void main() {
  late GoldenFileComparator saved;

  setUp(() {
    saved = goldenFileComparator;
    if (_on) goldenFileComparator = _WriteToSite();
  });
  tearDown(() => goldenFileComparator = saved);

  for (final (code, lang) in _langs) {
    // 8.1 the Live page: Video source card and Audio card (the folded cards are open), for a box-pulled setup on a new box
    testWidgets('SHOT-08-video-source, $code', skip: !_on, (tester) async {
      final h = await _openLive(
        tester,
        lang,
        pulled: true,
        mix: _mix(cam: 0, box: true),
        initial: _ready(),
      );
      await _pickBoxPath(tester, lang);
      await _openSection(tester, 'video');
      await _openSection(tester, 'audio');
      await _size(tester, const Size(412, 1180));
      await _top(tester, k('live-section-video'), alignment: 0.0);
      await _snap(tester, h.app, 'SHOT-08-video-source', code);
    });

    // 8.2 the camera control card, open
    testWidgets('SHOT-08-camera-control, $code', skip: !_on, (tester) async {
      final h = await _openLive(
        tester,
        lang,
        mix: _mix(cam: 40, mic: true),
        initial: _ready(audio: PublisherAudio(rows: [_row('camera', 40, level: 0.4), _row('deviceMic', 100, level: 0.7, align: 'locked')], mixed: 0.6)),
        control: {
          'enabled': true,
          'protocol': 'http',
          'profile': {'preset': 2, 'focus': 'continuous', 'tracking': 'human', 'exposureEv': 0.7},
          'applyOnLive': false,
        },
      );
      await _size(tester, _phone);
      await reveal(tester, k('camera-control-row'));
      if (k('camera-control-brighter').evaluate().isEmpty) {
        await tester.tap(k('camera-control-toggle'));
        await settle(tester);
      }
      expect(k('camera-control-brighter'), findsOneWidget);
      await _top(tester, k('camera-control-row'), alignment: 0.04);
      await _snap(tester, h.app, 'SHOT-08-camera-control', code);
    });

    // 8.3 the Audio card with two sources, a retake of the older picture SHOT-08-audio-sources
    testWidgets('SHOT-08-audio-sources, $code', skip: !_on, (tester) async {
      final h = await _openLive(
        tester,
        lang,
        mix: _mix(cam: 40, mic: true),
        initial: _ready(audio: PublisherAudio(rows: [_row('camera', 40, level: 0.4), _row('deviceMic', 100, level: 0.7, align: 'locked')], mixed: 0.6)),
      );
      await _openSection(tester, 'audio');
      await _size(tester, _phone);
      await _top(tester, k('live-section-audio'), alignment: 0.0);
      await _snap(tester, h.app, 'SHOT-08-audio-sources', code);
    });

    // 8.3 the Audio card for a box-pulled setup on a new box: MAXCOM microphone (main) at 100, camera sound at 0
    testWidgets('SHOT-08-audio-rows, $code', skip: !_on, (tester) async {
      final h = await _openLive(
        tester,
        lang,
        pulled: true,
        mix: _mix(cam: 0, box: true),
        initial: _ready(),
      );
      await _pickBoxPath(tester, lang);
      await _openSection(tester, 'audio');
      await _size(tester, const Size(412, 1100));
      await _top(tester, k('live-section-audio'), alignment: 0.0);
      await _snap(tester, h.app, 'SHOT-08-audio-rows', code);
    });

    // 8.1 the start screen of a box-pulled live with the "Broadcast destinations" sheet open
    testWidgets('SHOT-08-destinations, $code', skip: !_on, (tester) async {
      final h = await _openLive(tester, lang, pulled: true, mix: _mix(cam: 0, box: true), initial: _ready());
      await _pickBoxPath(tester, lang);
      await _size(tester, _phone);
      await _bottom(tester);
      await tester.tap(k('live-destinations'));
      await settle(tester);
      expect(k('live-dest-sheet'), findsOneWidget);
      await _snap(tester, h.app, 'SHOT-08-destinations', code);
    });

    // 8.1 the same start screen, sheet closed: the three chips and the start button
    testWidgets('SHOT-08-destinations-chips, $code', skip: !_on, (tester) async {
      final h = await _openLive(tester, lang, pulled: true, mix: _mix(cam: 0, box: true), initial: _ready());
      await _pickBoxPath(tester, lang);
      await _size(tester, _phone);
      expect(k('live-dest-sheet'), findsNothing);
      await _bottom(tester);
      expect(k('live-destinations').hitTestable(), findsOneWidget);
      await _snap(tester, h.app, 'SHOT-08-destinations-chips', code);
    });

    // 8.1 the control card of a box-pulled live that this phone started
    testWidgets('SHOT-08-control-card, $code', skip: !_on, (tester) async {
      final h = await _openLive(tester, lang, pulled: true, mix: _mix(cam: 0, box: true), initial: _ready());
      await _pickBoxPath(tester, lang);
      await _startPulled(tester, h, () => _pulledSession(audio: _boxAudio()));
      expect(k('live-control-card'), findsOneWidget);
      await _size(tester, _phone);
      await _top(tester, k('live-control-card'), alignment: 0.02);
      await _snap(tester, h.app, 'SHOT-08-control-card', code);
      h.container.dispose();
    });

    // 8.3 the Audio part during a box-pulled live: the sound and picture sync block in Automatic
    testWidgets('SHOT-08-box-sound, $code', skip: !_on, (tester) async {
      final h = await _openLive(tester, lang, pulled: true, mix: _mix(cam: 0, box: true), initial: _ready());
      await _pickBoxPath(tester, lang);
      await _startPulled(tester, h, () => _pulledSession(audio: _boxAudio()));
      await reveal(tester, k('live-box-sync'));
      expect(k('live-box-sync-manual'), findsOneWidget);
      await _size(tester, const Size(412, 1040));
      await _top(tester, k('live-sources'), alignment: 0.0);
      await _snap(tester, h.app, 'SHOT-08-box-sound', code);
      h.container.dispose();
    });

    // 8.3 the sync block in Manual adjustment (350 ms)
    testWidgets('SHOT-08-box-sync-manual, $code', skip: !_on, (tester) async {
      final h = await _openLive(tester, lang, pulled: true, mix: _mix(cam: 0, box: true), initial: _ready());
      await _pickBoxPath(tester, lang);
      await _startPulled(tester, h, () => _pulledSession(audio: _boxAudio()));
      await reveal(tester, k('live-box-sync'));
      await tester.tap(k('live-box-sync-manual'));
      await settle(tester);
      // the automatic value is +150 ms and each step is 50 ms: four steps make +350 ms
      for (var i = 0; i < 4; i++) {
        await tester.tap(k('live-box-sync-plus'));
        await tester.pump(const Duration(milliseconds: 400));
      }
      await settle(tester);
      expect(k('live-box-sync-auto'), findsOneWidget);
      expect(tester.widget<Text>(k('live-box-sync-value')).data, '+350 ms');
      await _size(tester, _phone);
      await _top(tester, k('live-box-sync'), alignment: 0.1);
      await _snap(tester, h.app, 'SHOT-08-box-sync-manual', code);
      h.container.dispose();
    });

    // 8.1 another phone with live control: no device is in control, Stop, and who started the live
    testWidgets('SHOT-08-controller-quiet, $code', skip: !_on, (tester) async {
      final h = await _openLive(tester, lang, pulled: true, mix: _mix(cam: 0, box: true), initial: _ready());
      h.handlers['GET /api/live/status'] = (r) async =>
          jsonResponse(200, _pulledSession(mine: false, warnings: const ['controller_quiet'], quiet: 720, audio: _boxAudio()));
      await (h.container.read(liveBoxProvider.notifier) as LiveController).pollOnce();
      await settle(tester);
      expect(k('live-controller-quiet'), findsOneWidget);
      await _size(tester, _phone);
      await _top(tester, k('live-controller-quiet'), alignment: 0.02);
      await _snap(tester, h.app, 'SHOT-08-controller-quiet', code);
      h.container.dispose();
    });

    // 8.1 "Broadcast on YouTube" during a live
    testWidgets('SHOT-08-youtube-later, $code', skip: !_on, (tester) async {
      final pub = FakePublisher(
        initial: const PublisherState(phase: PublisherPhase.live, outputs: PublisherOutputs(kiosk: OutputState.up), durationSec: 612),
      );
      final h = await pumpShell(
        tester,
        roles: const ['live'],
        overrides: [
          appLangStoreProvider.overrideWithValue(MemoryAppLangStore(lang)),
          livePublisherProvider.overrideWithValue(pub),
          liveBoxProvider.overrideWith(
            () => _Rec(const LiveBoxStatus(sessionId: 's1', boxReachable: true, sessionYoutube: false, youtube: YoutubeAccount.signedIn('Surau Contoh'))),
          ),
        ],
      );
      h.settings['liveYoutube'] = {'privacy': 'unlisted'};
      h.handlers['GET /api/live/status'] = (r) async => jsonResponse(200, {
        'session': {'id': 's1', 'mine': true},
        'warnings': <Object>[],
        'ingest': {'ready': true},
        'relay': {'state': 'off'},
        'youtube': {'signedIn': true, 'state': 'none'},
      });
      tester.view.physicalSize = const Size(412, 3600) * goldenPixelRatio;
      addTearDown(tester.view.resetPhysicalSize);
      h.container.invalidate(settingsProvider);
      h.router.go('/live');
      await settle(tester);
      await reveal(tester, k('live-youtube-later'));
      await tester.tap(k('live-youtube-later'));
      await settle(tester);
      await tester.enterText(k('live-youtube-later-title'), 'Kuliah Maghrib');
      await tester.pump();
      await _size(tester, _phone);
      await _snap(tester, h.app, 'SHOT-08-youtube-later', code);
    });

    // 8.7 the iPad web app: Save the recording, then "Is the recording saved in Files/Downloads?"
    testWidgets('SHOT-08-ipad-save, $code', skip: !_on, (tester) async {
      final pub = FakePublisher()..recordingSessionId = 'web-1';
      final h = ShellHarness(
        roles: const ['live'],
        overrides: [
          appLangStoreProvider.overrideWithValue(MemoryAppLangStore(lang)),
          livePublisherProvider.overrideWithValue(pub),
          liveDeviceKindProvider.overrideWithValue('ipad'),
          webRecordingJoinProvider.overrideWithValue(_FakeJoin()),
          liveBoxProvider.overrideWith(
            () => LiveBoxNotifier(const LiveBoxStatus(sessionId: 's1', boxReachable: true, youtube: YoutubeAccount.signedIn('Surau Contoh'))),
          ),
        ],
      );
      h.unlock();
      h.handlers['GET /api/live/status'] = (r) async => jsonResponse(200, {
        'session': {'id': 's1', 'mine': true},
        'warnings': <Object>[],
        'ingest': {'ready': true},
        'relay': {'state': 'off'},
        'youtube': {'signedIn': true, 'state': 'none'},
      });
      h.handlers['POST /api/live/stop'] = (r) async => jsonResponse(200, {'ok': true});
      // the browser build: only the screen's own reads of the platform see ios-web
      final ipad = UncontrolledProviderScope(
        container: ProviderContainer(parent: h.container, overrides: [appDepsProvider.overrideWithValue(_asIpad(h.deps))]),
        child: const SurauApp(),
      );
      await pumpAtSize(tester, ipad, GoldenSize.phone);
      h.router.go('/live');
      for (var i = 0; i < 12; i++) {
        await tester.pump(const Duration(milliseconds: 300));
      }
      pub.emit(
        const PublisherState(
          phase: PublisherPhase.live,
          outputs: PublisherOutputs(kiosk: OutputState.up),
          recording: RecordingState(on: true, segments: 2, bytes: 1395864371),
          stats: StreamStats(bitrateKbps: 2450, fps: 30, rttMs: 18),
          durationSec: 1421,
        ),
      );
      await settle(tester);
      await tester.tap(k('live-stop'));
      await settle(tester);
      await tester.tap(k('live-stop-confirm'));
      await tester.pump(const Duration(milliseconds: 600));
      await settle(tester);
      expect(k('live-summary'), findsOneWidget);
      await tester.tap(find.widgetWithIcon(FilledButton, Icons.download_rounded));
      await settle(tester);
      expect(k('rec-saved-ask'), findsOneWidget);
      await _snap(tester, ipad, 'SHOT-08-ipad-save', code);
    });

    // 10.9 TVs and Boxes: a main Box and a follower Box
    testWidgets('SHOT-10-tvs-boxes, $code', skip: !_on, (tester) async {
      final h = await pumpShell(
        tester,
        roles: const ['admin'],
        overrides: [
          appLangStoreProvider.overrideWithValue(MemoryAppLangStore(lang)),
          livePublisherProvider.overrideWithValue(FakePublisher()),
          appLockProvider.overrideWithValue(false),
          linkPollEveryProvider.overrideWithValue(const Duration(hours: 1)),
        ],
      );
      h.devices = [];
      h.handlers['GET /api/boxes'] = (r) async => jsonResponse(200, _boxesBody(follower: true));
      h.router.go('/screens');
      await settle(tester);
      await _size(tester, _phone);
      await _snap(tester, h.app, 'SHOT-10-tvs-boxes', code);
    });

    // 10.9 the link flow: the three questions and Agree
    testWidgets('SHOT-10-link-questions, $code', skip: !_on, (tester) async {
      final (h, _) = await linkt.openLink(tester, _rnm(linkt.questionsStatus()), lang: lang);
      h.handlers['GET /api/boxes'] = (r) async => jsonResponse(200, _boxesBody());
      await _size(tester, _phone);
      await _snap(tester, h.app, 'SHOT-10-link-questions-a', code);
      for (var i = 0; i < 40; i++) {
        await tester.drag(find.byType(ListView).first, const Offset(0, -400));
        await tester.pump();
      }
      await settle(tester);
      await _snap(tester, h.app, 'SHOT-10-link-questions-b', code);
    });

    // 10.10 the unlink page with the three choices
    testWidgets('SHOT-10-unlink, $code', skip: !_on, (tester) async {
      final status = _rnm(ufx.unlinkStatusJson(session: ufx.sessionJson(follower: ufx.followerBack())));
      final h = await _openUnlink(tester, lang, status, route: '/screens/unlink?device=dev-b2&name=box2-Surau%20Contoh');
      await _size(tester, const Size(412, 1000));
      await _snap(tester, h.app, 'SHOT-10-unlink', code);
    });

    // 10.10 old data after the link was cut
    testWidgets('SHOT-10-old-data, $code', skip: !_on, (tester) async {
      final status = _rnm(ufx.unlinkStatusJson(last: ufx.lastJson(), kept: [ufx.keptJson()]));
      final h = await _openUnlink(tester, lang, status, route: '/screens/unlink');
      await _size(tester, _phone);
      await _snap(tester, h.app, 'SHOT-10-old-data', code);
    });

    // 10.11 "Connect now?" on a phone that was moved
    testWidgets('SHOT-10-connect-now, $code', skip: !_on, (tester) async {
      late final movet.Rig rig;
      rig = movet.Rig(
        // the fixture's own answers, with the neutral box names
        old: (r) async {
          final a = await rig.happyOld(r);
          return http.Response(jsonEncode(_rn(jsonDecode(a.body))), a.statusCode, headers: a.headers);
        },
      );
      final ask = movescr.host(lang, rig);
      await _size(tester, _phone);
      await tester.pumpWidget(ask);
      await tester.pumpAndSettle();
      expect(find.byKey(const ValueKey('move-connect')), findsOneWidget);
      await _snap(tester, ask, 'SHOT-10-connect-now', code);
    });

    // 10.12 "Your recovery code": a fake sample code only
    testWidgets('SHOT-10-recovery-code, $code', skip: !_on, (tester) async {
      final r = rec.Rig(body: {...completedBody, 'recoveryCode': 'ABCD-EFGH-JKLM-NPQR'});
      await _size(tester, _phone);
      final app = _recoveryApp(lang, r.screen());
      await tester.pumpWidget(app);
      await tester.pumpAndSettle();
      await _tap(tester, 'recovery-found-continue');
      await tester.enterText(find.byKey(const ValueKey('recovery-code-field')), 'wxyz 2345 6789 abcd');
      await tester.enterText(find.byKey(const ValueKey('recovery-admin')), 'Admin Contoh');
      await tester.enterText(find.byKey(const ValueKey('recovery-pin')), '482916');
      await tester.enterText(find.byKey(const ValueKey('recovery-pin-again')), '482916');
      await _tap(tester, 'recovery-submit');
      expect(find.text('ABCD-EFGH-JKLM-NPQR'), findsOneWidget);
      await _snap(tester, app, 'SHOT-10-recovery-code', code);
    });

    // role guide (AJK): the Finance page of a committee phone
    testWidgets('SHOT-ajk-finance-view, $code', skip: !_on, (tester) async {
      final f = await FinA.create();
      addTearDown(f.dispose);
      // neutral names for the people the seed data shows
      await f.entry({
        'id': 'e2',
        'kind': 'out',
        'entryDate': '2026-11-03',
        'fundId': 'f1',
        'perihalId': 'out-pc',
        'amountSen': 15000,
        'method': 'tunai',
        'kuliahId': 'k1',
        'penceramahId': 'p1',
        'penceramahName': 'Ustaz Contoh',
        'refNo': 'B-0071',
        'editedAt': '2026-11-03T12:31:00.000Z',
      });
      await f.entry({
        'id': 'e3',
        'kind': 'out',
        'entryDate': '2026-10-31',
        'fundId': 'f1',
        'perihalId': 'out-pc',
        'amountSen': 15000,
        'method': 'tunai',
        'kuliahId': 'k0',
        'penceramahId': 'p3',
        'penceramahName': 'Ustaz Contoh',
        'refNo': 'B-0070',
        'editedAt': '2026-10-31T12:31:00.000Z',
      });
      final h = await pumpFinance(tester, f, roles: const ['ajk']);
      await h.container.read(appLangProvider.notifier).set(lang);
      await settle(tester);
      expect(k('fin-view-only'), findsOneWidget);
      await _size(tester, _phone);
      await _snap(tester, h.app, 'SHOT-ajk-finance-view', code);
    });
  }
}

Widget _recoveryApp(AppLang lang, Widget screen) {
  final m = screen as MaterialApp;
  return MaterialApp(
    key: UniqueKey(),
    debugShowCheckedModeBanner: false,
    theme: m.theme,
    locale: lang.locale,
    localizationsDelegates: m.localizationsDelegates,
    supportedLocales: m.supportedLocales,
    home: m.home,
  );
}

Future<void> _tap(WidgetTester t, String key) async {
  final f = find.byKey(ValueKey(key));
  await t.ensureVisible(f);
  await t.pumpAndSettle();
  await t.tap(f);
  await t.pumpAndSettle();
}

Future<ShellHarness> _openUnlink(WidgetTester tester, AppLang lang, Map<String, Object?> status, {required String route}) async {
  final h = await pumpShell(
    tester,
    roles: const ['admin'],
    overrides: [
      appLangStoreProvider.overrideWithValue(MemoryAppLangStore(lang)),
      livePublisherProvider.overrideWithValue(FakePublisher()),
      appLockProvider.overrideWithValue(false),
      linkPollEveryProvider.overrideWithValue(const Duration(hours: 1)),
      unlinkPollEveryProvider.overrideWithValue(const Duration(hours: 1)),
    ],
  );
  h.handlers['GET /api/boxes'] = (r) async => jsonResponse(200, _rnm(_boxesBody(follower: true)));
  h.handlers['GET /api/unlink/status'] = (r) async => jsonResponse(200, status);
  h.router.go(route);
  await settle(tester);
  return h;
}
