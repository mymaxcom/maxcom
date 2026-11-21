// "Main sekarang" on a Video item (2026.11.14, W25 item 1): the button in the list and the editor, offered only
// for a box that lists `videoPlayNow` and only on the box's own network (no cloud relay for content actions),
// the refusals in plain words, and goldens in BM, EN and AR.

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:surau_app/app/app_lang.dart';
import 'package:surau_app/app/providers.dart' show isCloudGatewayProvider;
import 'package:surau_app/content/video_services.dart' show videoServicesProvider;
import 'package:surau_app/features/live/fake_publisher.dart';
import 'package:surau_app/features/live/live_screen.dart' show livePublisherProvider;

import '../features/fakes.dart' show jsonResponse;
import '../features/shell/harness.dart';
import '../golden_sizes.dart';
import 'content_video_test.dart' show FakeVideoServices;

const _path = '/api/content/video/vd2/play-now';
Finder get _editorButton => find.byKey(const ValueKey('video-play-now'));
Finder get _rowButton => find.byKey(const ValueKey('play-now-vd2'));

Map<String, Object?> get _withPlayNow => {
  ...healthyJson,
  'features': ['video', 'posterStretch', 'tvLangAr', 'videoAfterPrayer', 'videoPlayNow'],
};

Future<ShellHarness> _open(
  WidgetTester tester,
  String path, {
  Map<String, Object?>? health,
  AppLang lang = AppLang.ms,
  bool cloud = false,
  void Function(ShellHarness h)? prepare,
}) async {
  final h = await pumpShell(
    tester,
    roles: const ['admin'],
    health: health ?? _withPlayNow,
    overrides: [
      videoServicesProvider.overrideWithValue(FakeVideoServices()),
      livePublisherProvider.overrideWithValue(FakePublisher()),
      if (cloud) isCloudGatewayProvider.overrideWithValue(true),
    ],
  );
  prepare?.call(h);
  if (lang != AppLang.ms) await h.container.read(appLangProvider.notifier).set(lang);
  h.router.go(path);
  await settle(tester);
  await pumpAtSize(tester, h.app, GoldenSize.phone);
  return h;
}

void main() {
  testWidgets('the editor of a saved video has the button; pressing it posts play-now and says it plays', (tester) async {
    final h = await _open(tester, '/content/video/vd2', prepare: (h) => h.handlers['POST $_path'] = (r) async => jsonResponse(200, {'startsAt': '2026-11-21T10:00:00Z'}));
    await reveal(tester, _editorButton);
    expect(find.text('Main sekarang'), findsOneWidget);
    await tester.tap(_editorButton);
    await settle(tester);
    expect(h.box.seen.where((r) => r.method == 'POST' && r.url.path == _path), hasLength(1));
    expect(find.text('Video dimainkan di skrin TV sekarang.'), findsOneWidget);
  });

  testWidgets('the list row has a play button for each video', (tester) async {
    final h = await _open(tester, '/content/video', prepare: (h) => h.handlers['POST $_path'] = (r) async => jsonResponse(200, {'startsAt': 'x'}));
    expect(_rowButton, findsOneWidget);
    await tester.tap(_rowButton);
    await settle(tester);
    expect(h.box.seen.any((r) => r.method == 'POST' && r.url.path == _path), isTrue);
  });

  testWidgets('a prayer phase and a live on the TV are refused in plain words', (tester) async {
    await _open(
      tester,
      '/content/video/vd2',
      prepare: (h) => h.handlers['POST $_path'] = (r) async => jsonResponse(409, {'errors': ['x'], 'code': 'prayer_phase'}),
    );
    await reveal(tester, _editorButton);
    await tester.tap(_editorButton);
    await settle(tester);
    expect(find.text('Tidak boleh dimainkan semasa waktu solat.'), findsOneWidget);
  });

  testWidgets('a live on the TV: its own sentence', (tester) async {
    await _open(
      tester,
      '/content/video/vd2',
      prepare: (h) => h.handlers['POST $_path'] = (r) async => jsonResponse(409, {'errors': ['x'], 'code': 'live_running'}),
    );
    await reveal(tester, _editorButton);
    await tester.tap(_editorButton);
    await settle(tester);
    expect(find.text('Siaran langsung sedang berjalan di skrin TV.'), findsOneWidget);
  });

  testWidgets('a box without videoPlayNow is not offered the button', (tester) async {
    await _open(tester, '/content/video/vd2', health: {...healthyJson}); // features of 2026.11.13
    expect(_editorButton, findsNothing);
    expect(find.byIcon(Icons.play_circle_outline_rounded), findsNothing);
  });

  testWidgets('through the cloud there is no button even if the cloud lists the feature', (tester) async {
    await _open(tester, '/content/video/vd2', cloud: true);
    expect(_editorButton, findsNothing);
  });

  testWidgets('a new, unsaved video has no play button', (tester) async {
    await _open(tester, '/content/video/new');
    expect(_editorButton, findsNothing);
  });

  group('goldens', () {
    for (final (name, lang, label) in [
      ('bm', AppLang.ms, 'Main sekarang'),
      ('en', AppLang.en, 'Play now'),
      ('ar', AppLang.ar, 'تشغيل الآن'),
    ]) {
      testWidgets('the video editor with the play now button, $name', (tester) async {
        final h = await _open(tester, '/content/video/vd2', lang: lang);
        await reveal(tester, _editorButton);
        await tester.ensureVisible(_editorButton);
        await settle(tester);
        expect(find.text(label), findsOneWidget);
        await expectLater(find.byWidget(h.app), matchesGoldenFile('video_play_now_$name.png'));
      });
    }

    testWidgets('the video list with the play now button', (tester) async {
      final h = await _open(tester, '/content/video');
      expect(_rowButton, findsOneWidget);
      await expectLater(find.byWidget(h.app), matchesGoldenFile('video_play_now_list_bm.png'));
    });
  });
}
