// FX2b F4 + F28: the "Siarkan ke YouTube" offer of a running live opens a sheet (title prefilled, privacy never wider
// than the surau setting) and only its confirm calls the box. The bare camera-release call of the switch is checked too.

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/misc.dart' show Override;
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:surau_app/app/providers.dart';
import 'package:surau_app/features/live/fake_publisher.dart';
import 'package:surau_app/features/live/live_controller.dart';
import 'package:surau_app/features/live/live_source.dart';
import 'package:surau_app/features/shell/live_camera_gateway.dart' show LiveAudioMix;
import 'package:surau_app/features/live/live_widgets.dart';
import 'package:surau_app/features/live/publisher.dart';

import '../features/fakes.dart';
import '../features/shell/harness.dart';

Finder k(String key) => find.byKey(ValueKey(key));

class _Rec extends LiveBoxNotifier {
  _Rec(super.initial);

  final List<(String?, String?)> calls = [];

  @override
  Future<void> startYoutubeLater({String? title, String? privacy}) async => calls.add((title, privacy));
}

const _running = LiveBoxStatus(
  sessionId: 's1',
  boxReachable: true,
  sessionYoutube: false,
  youtube: YoutubeAccount.signedIn('Surau Contoh'),
);

Future<(ShellHarness, _Rec)> _open(
  WidgetTester tester, {
  Map<String, Object?>? liveYoutube,
  LiveBoxStatus status = _running,
  PublisherState initial = const PublisherState(phase: PublisherPhase.live, outputs: PublisherOutputs(kiosk: OutputState.up)),
}) async {
  final pub = FakePublisher(initial: initial);
  final rec = _Rec(status);
  final List<Override> overrides = [
    livePublisherProvider.overrideWithValue(pub),
    liveBoxProvider.overrideWith(() => rec),
  ];
  final h = await pumpShell(tester, roles: const ['live'], overrides: overrides);
  if (liveYoutube != null) h.settings['liveYoutube'] = liveYoutube;
  h.handlers['GET /api/live/status'] = (r) async => jsonResponse(200, {
    'session': {'id': 's1', 'mine': true},
    'warnings': <Object>[],
    'ingest': {'ready': true},
    'relay': {'state': 'off'},
    'youtube': {'signedIn': true, 'state': 'none'},
  });
  tester.view.physicalSize = const Size(412, 3600) * 2.625;
  addTearDown(tester.view.resetPhysicalSize);
  h.container.invalidate(settingsProvider);
  h.router.go('/live');
  await settle(tester);
  return (h, rec);
}

class _ExternalStore implements LiveSourceStore {
  @override
  Future<({VideoSourceKind video, LiveAudioMix mix, Map<String, int> offsets})?> read() async =>
      (video: VideoSourceKind.external, mix: defaultMix(VideoSourceKind.external), offsets: const {idDeviceMic: 0, idBoxInput: 0});

  @override
  Future<void> write(VideoSourceKind v, LiveAudioMix m) async {}
}

void main() {
  testWidgets('F4: tapping the offer opens the sheet; nothing is sent until the confirm', (tester) async {
    final (h, rec) = await _open(tester, liveYoutube: {'privacy': 'unlisted'});
    await reveal(tester, k('live-youtube-later'));
    await tester.tap(k('live-youtube-later'));
    await settle(tester);
    expect(k('live-youtube-later-sheet'), findsOneWidget);
    expect(rec.calls, isEmpty, reason: 'the tap alone never publishes');
    // the surau setting is unlisted: public is not offered
    expect(k('live-youtube-later-privacy-public'), findsNothing);
    expect(k('live-youtube-later-privacy-private'), findsOneWidget);
    expect(k('live-youtube-later-privacy-unlisted'), findsOneWidget);
    await tester.enterText(k('live-youtube-later-title'), 'Kuliah Maghrib');
    await tester.tap(k('live-youtube-later-privacy-private'));
    await settle(tester);
    await tester.tap(k('live-youtube-later-confirm'));
    await settle(tester);
    expect(rec.calls, [('Kuliah Maghrib', 'private')]);
    h.container.dispose();
  });

  testWidgets('F4: cancelling the sheet sends nothing', (tester) async {
    final (h, rec) = await _open(tester);
    await reveal(tester, k('live-youtube-later'));
    await tester.tap(k('live-youtube-later'));
    await settle(tester);
    await tester.tap(k('live-youtube-later-cancel'));
    await settle(tester);
    expect(rec.calls, isEmpty);
    expect(k('live-youtube-later-sheet'), findsNothing);
    h.container.dispose();
  });

  group('build 5: the gate of the button', () {
    const pulled = LiveBoxStatus(
      sessionId: 's1',
      controlOnly: true,
      videoPath: 'box',
      sessionBoxPulled: true,
      sessionYoutube: false,
      boxReachable: true,
    );
    const idle = PublisherState.initial;

    bool? enabled(WidgetTester tester) => tester.widget<OutlinedButton>(k('live-youtube-later')).onPressed != null;

    testWidgets('an Android controller of a box-pulled live with the account unknown gets an enabled button', (tester) async {
      final (h, _) = await _open(tester, status: pulled.copyWith(youtube: const YoutubeAccount.unknown()), initial: idle);
      await reveal(tester, k('live-youtube-later'));
      expect(enabled(tester), isTrue);
      expect(k('live-youtube-later-why'), findsNothing);
      h.container.dispose();
    });

    testWidgets('signed out: the button is drawn disabled with the reason line', (tester) async {
      final (h, _) = await _open(tester, status: pulled, initial: idle);
      await reveal(tester, k('live-youtube-later'));
      expect(enabled(tester), isFalse);
      expect(tester.widget<Text>(k('live-youtube-later-why')).data, 'YouTube belum disambungkan pada MAXCOM.');
      h.container.dispose();
    });

    testWidgets('the box cannot be reached: the reason says so', (tester) async {
      final (h, _) = await _open(
        tester,
        status: pulled.copyWith(youtube: const YoutubeAccount.signedIn('Surau Contoh'), boxReachable: false),
        initial: idle,
      );
      await reveal(tester, k('live-youtube-later'));
      expect(enabled(tester), isFalse);
      expect(tester.widget<Text>(k('live-youtube-later-why')).data, 'MAXCOM tidak dapat dihubungi.');
      h.container.dispose();
    });

    testWidgets("another device's live shows the starter line and a disabled button", (tester) async {
      final (h, _) = await _open(
        tester,
        status: const LiveBoxStatus(
          youtube: YoutubeAccount.signedIn('Surau Contoh'),
          sessionYoutube: false,
          otherLive: OtherLive(sessionId: 's9', starter: 'Haji Kamal', video: 'external', videoPath: 'box', boxPulled: true),
        ),
        initial: idle,
      );
      await reveal(tester, k('live-youtube-later'));
      expect(enabled(tester), isFalse);
      expect(tester.widget<Text>(k('live-youtube-later-why')).data, 'Hanya peranti yang memulakan siaran boleh menambah YouTube.');
      h.container.dispose();
    });

    testWidgets('a held own box-pulled session (no control-only flag) gets an enabled button', (tester) async {
      final (h, _) = await _open(
        tester,
        status: pulled.copyWith(controlOnly: false, youtube: const YoutubeAccount.signedIn('Surau Contoh')),
        initial: idle,
      );
      await reveal(tester, k('live-youtube-later'));
      expect(enabled(tester), isTrue);
      h.container.dispose();
    });

    testWidgets('YouTube already on: no button', (tester) async {
      final (h, _) = await _open(
        tester,
        status: pulled.copyWith(sessionYoutube: true, youtube: const YoutubeAccount.signedIn('Surau Contoh')),
        initial: idle,
      );
      expect(k('live-youtube-later'), findsNothing);
      h.container.dispose();
    });
  });

  test('F4: the privacy choices are never wider than the surau setting', () {
    expect(youtubePrivacyUpTo('private'), ['private']);
    expect(youtubePrivacyUpTo('unlisted'), ['private', 'unlisted']);
    expect(youtubePrivacyUpTo('public'), ['private', 'unlisted', 'public']);
    expect(youtubePrivacyUpTo('bogus'), ['private', 'unlisted']);
  });

  testWidgets('F28: switching a live from the camera this phone pulled to the phone camera tells the box (release call)', (tester) async {
    final pub = FakePublisher(
      initial: const PublisherState(
        phase: PublisherPhase.live,
        video: VideoSourceKind.external,
        outputs: PublisherOutputs(kiosk: OutputState.up),
      ),
    );
    final h = await pumpShell(
      tester,
      roles: const ['live'],
      overrides: [
        livePublisherProvider.overrideWithValue(pub),
        liveBoxProvider.overrideWith(() => _Rec(_running)),
        liveSourceStoreProvider.overrideWithValue(_ExternalStore()),
      ],
    );
    h.settings['liveCamera'] = {
      'enabled': true,
      'name': 'Kamera Mimbar',
      'transport': 'auto',
      'avOffsetMs': {'deviceMic': 0, 'boxInput': 0},
    };
    h.handlers['GET /api/live/camera'] = (r) async => jsonResponse(200, {
      'configured': true,
      'url': 'rtsp://10.168.50.50:554/stream1',
      'hasPassword': false,
      'lastTest': {'code': 'ok', 'ok': true, 'hasAudio': true, 'codecs': ['H264']},
    });
    h.handlers['GET /api/live/camera/source'] = (r) async => jsonResponse(200, {'url': 'rtsp://10.168.50.50:554/stream1'});
    h.container.invalidate(settingsProvider);
    h.handlers['POST /api/live/camera/release'] = (r) async => http.Response('', 204);
    h.handlers['GET /api/live/status'] = (r) async => jsonResponse(200, {
      'session': {'id': 's1', 'mine': true},
      'warnings': <Object>[],
      'ingest': {'ready': true},
      'relay': {'state': 'off'},
      'youtube': {'signedIn': true, 'state': 'none'},
    });
    h.router.go('/live');
    await settle(tester);
    final source = h.container.read(liveSourceProvider.notifier);
    expect(h.container.read(liveSourceProvider).video, VideoSourceKind.external);
    await source.selectVideo(VideoSourceKind.phone);
    await settle(tester);
    expect(pub.sourceSwitches, [VideoSourceKind.phone]);
    final rel = h.box.seen.where((r) => r.method == 'POST' && r.url.path == '/api/live/camera/release').toList();
    expect(rel, hasLength(1));
    expect(rel.single.body, contains('s1'));
    h.container.dispose();
  });
}
