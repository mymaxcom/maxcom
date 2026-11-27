// Pictures for the public landing page, made from the real app code with
// neutral data (Surau Contoh, Ustaz Contoh). Runs only when the environment
// flag SITE_SHOTS=1 is set; otherwise every test here is skipped, so a normal
// `flutter test` neither runs nor changes anything.
//
//   SITE_SHOTS=1 flutter test test/site_shots/site_shots_test.dart
//
// Output folder: SITE_SHOTS_OUT, default
// build/site_shots/site (created when missing; set SITE_SHOTS_OUT to write elsewhere).
//
// 1. live-running-<ms|en|ar>.png: the running Live screen of the golden
//    live_running_phone.png (390 logical px wide, device pixel ratio 2, 960 high so all three destinations show).
// 2. wa-share-image-<lang>.png: the picture the live notice sheet makes for
//    WhatsApp (the box's frame of the live under the words), and
//    wa-share-card-<lang>.png: the kuliah card made when the box has no frame.
//    wa-share-text-<lang>.txt: the shared text.
//    live-boxpull-<lang>.png: the control card of a running live the MAXCOM Kiosk Box pulls (no video picture), and
//    destinations-<lang>.png: the "Broadcast destinations" sheet open on the start screen of that setup.
// 3. wa-share-qr-<lang>.png: the full-screen QR page "Hantar dari telefon".

import 'dart:io';
import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:image/image.dart' as img;
import 'package:surau_app/app/app_lang.dart';
import 'package:surau_app/app/providers.dart';
import 'package:surau_app/features/live/fake_publisher.dart';
import 'package:surau_app/features/live/live_source.dart';
import 'package:surau_app/features/shell/live_camera_gateway.dart';
import 'package:surau_app/features/live/live_notice.dart';
import 'package:surau_app/features/live/live_notice_card.dart';
import 'package:surau_app/features/live/live_notice_share.dart';
import 'package:surau_app/features/live/live_screen.dart';
import 'package:surau_app/features/live/publisher.dart';
import 'package:surau_app/l10n/generated/s.dart';
import 'package:surau_app/l10n/s_lookup.dart' show sFor;

import '../features/fakes.dart' show fixedNow, jsonResponse;
import '../features/shell/harness.dart';
import '../golden_sizes.dart' show goldenPixelRatio;

final bool _on = Platform.environment['SITE_SHOTS'] == '1';
final String _out = Platform.environment['SITE_SHOTS_OUT'] ?? 'build/site_shots/site';

const _videoId = 'contoh-live';
const _langs = <(String, AppLang)>[('ms', AppLang.ms), ('en', AppLang.en), ('ar', AppLang.ar)];

/// A golden comparator that writes the rendered PNG into [_out] instead of
/// comparing it with a stored file, so no golden of the app is touched.
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

PublisherState _running() => const PublisherState(
  phase: PublisherPhase.live,
  outputs: PublisherOutputs(kiosk: OutputState.up, youtube: OutputState.up),
  recording: RecordingState(on: true, segments: 2, bytes: 1395864371),
  stats: StreamStats(bitrateKbps: 2450, fps: 30, rttMs: 18),
  warnings: {},
  durationSec: 1421,
);

/// The Maghrib kuliah of today with neutral names (the fixture has the Isyak one cancelled).
void _neutralKuliah(ShellHarness h) {
  final p = h.content['penceramah']!;
  p[0] = {...p[0], 'name': 'Ustaz Contoh'};
  final k = h.content['kuliah']!;
  final i = k.indexWhere((x) => x['id'] == 'c3');
  k[i] = {
    ...k[i],
    'slot': 'maghrib',
    'time': '19:15',
    'label': 'Kuliah Maghrib',
    'penceramahId': 'p1',
    'status': 'aktif',
    'kitabId': 'k1',
    'topic': 'Sabar ketika diuji',
  };
}

/// A neutral still of a live: a dark hall with a lit arch. No real place.
Uint8List _neutralStill() {
  const w = 1280, h = 720;
  final im = img.Image(width: w, height: h);
  for (var y = 0; y < h; y++) {
    final t = y / h;
    final c = img.ColorRgb8((20 + 30 * t).round(), (62 + 40 * t).round(), (56 + 30 * t).round());
    for (var x = 0; x < w; x++) {
      im.setPixel(x, y, c);
    }
  }
  img.fillCircle(im, x: w ~/ 2, y: 330, radius: 190, color: img.ColorRgb8(234, 214, 160));
  img.fillRect(im, x1: w ~/ 2 - 190, y1: 330, x2: w ~/ 2 + 190, y2: h, color: img.ColorRgb8(234, 214, 160));
  img.fillCircle(im, x: w ~/ 2, y: 340, radius: 150, color: img.ColorRgb8(40, 96, 84));
  img.fillRect(im, x1: w ~/ 2 - 150, y1: 340, x2: w ~/ 2 + 150, y2: h, color: img.ColorRgb8(40, 96, 84));
  img.fillRect(im, x1: 0, y1: 600, x2: w, y2: h, color: img.ColorRgb8(30, 52, 48));
  return Uint8List.fromList(img.encodeJpg(im, quality: 88));
}

/// A neutral speaker picture: a plain head and shoulders.
Uint8List _neutralPhoto() {
  final im = img.Image(width: 400, height: 400);
  img.fill(im, color: img.ColorRgb8(196, 214, 208));
  img.fillCircle(im, x: 200, y: 160, radius: 80, color: img.ColorRgb8(122, 150, 142));
  img.fillCircle(im, x: 200, y: 400, radius: 150, color: img.ColorRgb8(122, 150, 142));
  return Uint8List.fromList(img.encodePng(im));
}

/// A neutral logo: a ring and a dot, no text.
Uint8List _neutralLogo() {
  final im = img.Image(width: 200, height: 200, numChannels: 4);
  img.fillCircle(im, x: 100, y: 100, radius: 96, color: img.ColorRgb8(6, 48, 43));
  img.fillCircle(im, x: 100, y: 100, radius: 70, color: img.ColorRgb8(240, 201, 122));
  img.fillCircle(im, x: 100, y: 100, radius: 52, color: img.ColorRgb8(6, 48, 43));
  img.fillCircle(im, x: 100, y: 100, radius: 20, color: img.ColorRgb8(240, 201, 122));
  return Uint8List.fromList(img.encodePng(im));
}

void _writePng(String name, Uint8List jpegOrPng) {
  final im = img.decodeImage(jpegOrPng)!;
  File('$_out/$name').writeAsBytesSync(img.encodePng(im));
}

const _idle = {
  'session': null,
  'warnings': <Object>[],
  'ingest': {'ready': false},
  'relay': {'state': 'off'},
  'youtube': {'signedIn': true, 'state': 'none'},
  'canToggleKiosk': true,
};

/// The status of a live the box pulls, started by this phone 24 minutes before the harness clock.
Map<String, Object?> _pulled() => {
  'session': {
    'id': 's1',
    'startedBy': 'Admin Contoh (Telefon Contoh)',
    'mine': true,
    'videoPath': 'box',
    'boxPulled': true,
    'startedBoxPulled': true,
    'source': 'android',
    'startedAt': fixedNow().subtract(const Duration(minutes: 24)).toIso8601String(),
    'outputs': {'kiosk': true, 'youtube': true},
  },
  'video': 'external',
  'warnings': <Object>[],
  'ingest': {'ready': true, 'cameraKbps': 3100},
  'relay': {'state': 'off'},
  'youtube': {'signedIn': true, 'state': 'live', 'health': 'good'},
  'canToggleKiosk': true,
  'viewers': [
    {'tvId': 'tv1', 'name': 'TV Contoh 1', 'state': 'playing'},
    {'tvId': 'tv2', 'name': 'TV Contoh 2', 'state': 'playing'},
  ],
  'audio': {
    'sources': [
      {'id': 'boxInput', 'enabled': true, 'volume': 100, 'state': 'ok', 'align': {'state': 'locked', 'delayMs': 2150}, 'level': -18},
      {'id': 'camera', 'enabled': true, 'volume': 0, 'state': 'ok', 'level': -40},
    ],
  },
};

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

/// The start screen of the box-pulled setup (video taken by the MAXCOM Kiosk Box) on a new box, 390 x 960 logical px.
/// With [running] the live is started from this phone and the control card shows.
Future<ShellHarness> _boxPull(WidgetTester tester, AppLang lang, {required bool running}) async {
  final store = _MemStore(
    VideoSourceKind.external,
    const LiveAudioMix(
      camera: AudioSourceMix(enabled: true, volume: 0),
      deviceMic: AudioSourceMix(enabled: false, volume: 100),
      boxInput: AudioSourceMix(enabled: true, volume: 100),
    ),
  );
  final h = await pumpShell(
    tester,
    roles: const ['live'],
    overrides: [
      appLangStoreProvider.overrideWithValue(MemoryAppLangStore(lang)),
      livePublisherProvider.overrideWithValue(FakePublisher()),
      liveDeviceKindProvider.overrideWithValue('phone'),
      liveSourceStoreProvider.overrideWithValue(store),
    ],
  );
  tester.view.physicalSize = const Size(390, 3600) * goldenPixelRatio;
  tester.view.devicePixelRatio = goldenPixelRatio;
  addTearDown(tester.view.resetPhysicalSize);
  addTearDown(tester.view.resetDevicePixelRatio);
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
    'lastTest': {
      'code': 'ok',
      'ok': true,
      'hasAudio': true,
      'codecs': ['H264', 'MPEG-4 Audio'],
    },
  });
  h.handlers['GET /api/live/camera/source'] = (r) async => jsonResponse(200, {'url': 'rtsp://siaran:contoh@10.0.0.50:554/stream1'});
  h.handlers['GET /api/live/audio-inputs'] = (r) async => jsonResponse(200, {'available': true, 'devices': <Object>[], 'selected': null});
  h.handlers['POST /api/live/audio'] = (r) async => jsonResponse(200, {'ok': true});
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
  h.handlers['GET /api/live/status'] = (r) async => jsonResponse(200, started ? _pulled() : _idle);
  h.container.invalidate(settingsProvider);
  h.router.go('/live');
  await settle(tester);
  await reveal(tester, find.byKey(const ValueKey('video-path-choice')));
  await tester.tap(find.descendant(of: find.byKey(const ValueKey('video-path-choice')), matching: find.text(sFor(lang).liveVideoPathBox)));
  await settle(tester);
  if (running) {
    await reveal(tester, find.byKey(const ValueKey('live-start')));
    await tester.tap(find.byKey(const ValueKey('live-start')));
    await settle(tester);
    await (h.container.read(liveBoxProvider.notifier) as LiveController).pollOnce();
    await settle(tester);
  }
  return h;
}

void main() {
  late GoldenFileComparator saved;

  setUp(() {
    saved = goldenFileComparator;
    if (_on) goldenFileComparator = _WriteToSite();
  });
  tearDown(() => goldenFileComparator = saved);

  for (final (code, lang) in _langs) {
    testWidgets('live running screen, $code', skip: !_on, (tester) async {
      final pub = FakePublisher();
      final h = await pumpShell(
        tester,
        roles: const ['live'],
        overrides: [
          livePublisherProvider.overrideWithValue(pub),
          liveBoxProvider.overrideWith(() => LiveBoxNotifier(const LiveBoxStatus(youtube: YoutubeAccount.signedIn('Surau Contoh')))),
        ],
      );
      _neutralKuliah(h);
      h.router.go('/live');
      await settle(tester);
      await h.container.read(appLangProvider.notifier).set(lang);
      pub.emit(_running());
      await settle(tester);
      h.container.read(liveFoldedProvider.notifier).set(false);
      // taller than the 844 px golden so the third destination (Rakaman) is in view
      tester.view.physicalSize = const Size(390, 960) * goldenPixelRatio;
      tester.view.devicePixelRatio = goldenPixelRatio;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);
      await settle(tester);
      await expectLater(find.byWidget(h.app), matchesGoldenFile('live-running-$code.png'));
    });

    // the control card of a live the box pulls (no video picture): sized like the picture above
    testWidgets('live box-pull control card, $code', skip: !_on, (tester) async {
      final h = await _boxPull(tester, lang, running: true);
      expect(find.byKey(const ValueKey('live-control-card')), findsOneWidget);
      tester.view.physicalSize = const Size(390, 960) * goldenPixelRatio;
      await settle(tester);
      await Scrollable.ensureVisible(tester.element(find.byKey(const ValueKey('live-control-card'))), alignment: 0.0);
      await tester.pumpAndSettle();
      await expectLater(find.byWidget(h.app), matchesGoldenFile('live-boxpull-$code.png'));
      h.container.dispose();
    });

    // the "Broadcast destinations" sheet on the start screen of that setup
    testWidgets('broadcast destinations sheet, $code', skip: !_on, (tester) async {
      final h = await _boxPull(tester, lang, running: false);
      tester.view.physicalSize = const Size(390, 960) * goldenPixelRatio;
      await settle(tester);
      // the end of the list: the notes that name the camera maker are out of view
      for (var i = 0; i < 12; i++) {
        await tester.drag(find.byType(ListView).first, const Offset(0, -600));
        await tester.pump();
      }
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const ValueKey('live-destinations')));
      await settle(tester);
      expect(find.byKey(const ValueKey('live-dest-sheet')), findsOneWidget);
      await expectLater(find.byWidget(h.app), matchesGoldenFile('destinations-$code.png'));
    });

    testWidgets('WhatsApp share picture and text, $code', skip: !_on, (tester) async {
      await tester.runAsync(() async {
      Directory(_out).createSync(recursive: true);
      final s = sFor(lang);
      final input = LiveNoticeInput(
        videoId: _videoId,
        slot: 'maghrib',
        start: DateTime(2026, 11, 24, 19, 15),
        speaker: 'Ustaz Contoh',
        topic: 'Sabar ketika diuji',
        surau: 'Surau Contoh',
      );
      final text = liveNoticeText(input, lang, DateTime(2026, 11, 24, 19, 0))!;
      File('$_out/wa-share-text-$code.txt').writeAsStringSync(text);
      final fields = liveCardFields(
        badge: s.liveNoticeCardBadge,
        surau: 'Surau Contoh',
        slot: liveSlotName('maghrib', lang),
        title: 'Sabar ketika diuji',
        speaker: 'Ustaz Contoh',
        time: '19:15',
      );
      // renderLiveCard encodes on another isolate, so it needs real async time.
      final withStill = await renderLiveCard(fields: fields, background: _neutralStill(), logo: _neutralLogo(), rtl: lang == AppLang.ar);
      final card = await renderLiveCard(fields: fields, photo: _neutralPhoto(), logo: _neutralLogo(), rtl: lang == AppLang.ar);
      _writePng('wa-share-image-$code.png', withStill);
      _writePng('wa-share-card-$code.png', card);
      });
    });

    testWidgets('QR page "send from this phone", $code', skip: !_on, (tester) async {
      final s = sFor(lang);
      tester.view.physicalSize = const Size(390, 844) * goldenPixelRatio;
      tester.view.devicePixelRatio = goldenPixelRatio;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);
      final text = liveNoticeText(
        LiveNoticeInput(videoId: _videoId, slot: 'maghrib', speaker: 'Ustaz Contoh', topic: 'Sabar ketika diuji', surau: 'Surau Contoh'),
        lang,
        DateTime(2026, 11, 24, 19, 0),
      )!;
      final app = MaterialApp(
        debugShowCheckedModeBanner: false,
        locale: lang.locale,
        supportedLocales: S.supportedLocales,
        localizationsDelegates: S.localizationsDelegates,
        theme: ThemeData(useMaterial3: true, fontFamily: 'PlusJakartaSans', fontFamilyFallback: const ['NotoNaskhArabic']),
        home: LiveNoticeQrPage(data: liveNoticeQrUrl(text, link: liveWatchLink(_videoId), title: 'Kuliah Maghrib'), title: 'Kuliah Maghrib'),
      );
      await tester.pumpWidget(app);
      await tester.pumpAndSettle();
      expect(find.text(s.liveNoticeFromPhone), findsOneWidget);
      await expectLater(find.byWidget(app), matchesGoldenFile('wa-share-qr-$code.png'));
    });
  }
}
