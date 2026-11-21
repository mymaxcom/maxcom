// Video "Main selepas zikir solat" (2026.11.14, W22 item 5): the chooser in the video editor, what it saves
// (the shared contract's `afterPrayer`), that a box without the `videoAfterPrayer` feature is not offered it, and
// goldens in BM, EN and AR.

import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:surau_app/app/app_lang.dart';
import 'package:surau_app/content/kinds.dart';
import 'package:surau_app/features/live/fake_publisher.dart';
import 'package:surau_app/features/live/live_screen.dart' show livePublisherProvider;

import '../features/shell/harness.dart';
import '../golden_sizes.dart';
import 'content_video_test.dart' show FakeVideoServices;
import 'package:surau_app/content/video_services.dart' show videoServicesProvider;

Finder get _chooser => find.byKey(const ValueKey('field-afterPrayer'));
Finder get _save => find.byKey(const ValueKey('content-save'));

Future<ShellHarness> _open(
  WidgetTester tester,
  String path, {
  Map<String, Object?>? health,
  AppLang lang = AppLang.ms,
  void Function(ShellHarness h)? prepare,
}) async {
  final h = await pumpShell(
    tester,
    roles: const ['admin'],
    health: health,
    overrides: [videoServicesProvider.overrideWithValue(FakeVideoServices()), livePublisherProvider.overrideWithValue(FakePublisher())],
  );
  prepare?.call(h);
  if (lang != AppLang.ms) await h.container.read(appLangProvider.notifier).set(lang);
  h.router.go(path);
  await settle(tester);
  await pumpAtSize(tester, h.app, GoldenSize.phone);
  return h;
}

/// A new YouTube video with a link and a title, ready to save.
Future<void> _fillYoutube(WidgetTester tester) async {
  await tester.tap(find.widgetWithText(ChoiceChip, 'YouTube'));
  await settle(tester);
  await tester.enterText(find.byKey(const ValueKey('field-youtubeLink')), 'dQw4w9WgXcQ');
  await settle(tester);
}

Map<String, dynamic> _putBody(ShellHarness h) =>
    jsonDecode(h.box.seen.firstWhere((r) => r.method == 'PUT' && r.url.path.startsWith('/api/content/video/')).body)
        as Map<String, dynamic>;

void main() {
  testWidgets('the chooser offers Tidak, Subuh, Zohor (Jumaat), Asar, Maghrib and Isyak, Tidak chosen at first', (tester) async {
    await _open(tester, '/content/video/new');
    await _fillYoutube(tester);
    await reveal(tester, _chooser);
    expect(find.text('Main selepas zikir solat'), findsOneWidget);
    for (final label in ['Tidak', 'Subuh', 'Zohor (Jumaat pada hari Jumaat)', 'Asar', 'Maghrib', 'Isyak']) {
      expect(find.descendant(of: _chooser, matching: find.text(label)), findsOneWidget, reason: label);
    }
    expect(tester.widget<ChoiceChip>(find.widgetWithText(ChoiceChip, 'Tidak')).selected, isTrue);
  });

  for (final (label, key) in [
    ('Subuh', 'subuh'),
    ('Zohor (Jumaat pada hari Jumaat)', 'zohor'),
    ('Asar', 'asar'),
    ('Maghrib', 'maghrib'),
    ('Isyak', 'isyak'),
  ]) {
    testWidgets('choosing $label saves afterPrayer: $key', (tester) async {
      final h = await _open(tester, '/content/video/new');
      await _fillYoutube(tester);
      await reveal(tester, _chooser);
      await tester.tap(find.descendant(of: _chooser, matching: find.text(label)));
      await settle(tester);
      expect(tester.widget<ChoiceChip>(find.widgetWithText(ChoiceChip, label)).selected, isTrue);
      await reveal(tester, _save);
      expect(tester.widget<FilledButton>(_save).onPressed, isNotNull);
      await tester.tap(_save);
      await settle(tester);
      expect(_putBody(h)['afterPrayer'], key);
    });
  }

  testWidgets('Tidak (the default) sends no afterPrayer at all: the video stays in the normal rotation', (tester) async {
    final h = await _open(tester, '/content/video/new');
    await _fillYoutube(tester);
    await reveal(tester, _save);
    await tester.tap(_save);
    await settle(tester);
    expect(_putBody(h).containsKey('afterPrayer'), isFalse);
  });

  testWidgets('a saved video with afterPrayer opens with it chosen; choosing Tidak takes it away', (tester) async {
    final h = await _open(
      tester,
      '/content/video/vd2',
      prepare: (h) => h.content['video']![1]['afterPrayer'] = 'asar',
    );
    await reveal(tester, _chooser);
    expect(tester.widget<ChoiceChip>(find.widgetWithText(ChoiceChip, 'Asar')).selected, isTrue);
    await tester.tap(find.descendant(of: _chooser, matching: find.text('Tidak')));
    await settle(tester);
    await reveal(tester, _save);
    await tester.tap(_save);
    await settle(tester);
    expect(_putBody(h).containsKey('afterPrayer'), isFalse);
  });

  testWidgets('a saved afterPrayer is sent back unchanged when it is not touched', (tester) async {
    final h = await _open(
      tester,
      '/content/video/vd2',
      prepare: (h) => h.content['video']![1]['afterPrayer'] = 'isyak',
    );
    await reveal(tester, _save);
    await tester.tap(_save);
    await settle(tester);
    expect(_putBody(h)['afterPrayer'], 'isyak');
  });

  testWidgets('a box without the videoAfterPrayer feature is not offered the option and is never sent the field', (tester) async {
    final health = {...healthyJson, 'features': ['video', 'posterStretch', 'tvLangAr']};
    final h = await _open(tester, '/content/video/new', health: health);
    await _fillYoutube(tester);
    await reveal(tester, find.byKey(const ValueKey('field-order')));
    expect(_chooser, findsNothing);
    expect(find.text('Main selepas zikir solat'), findsNothing);
    await reveal(tester, _save);
    await tester.tap(_save);
    await settle(tester);
    expect(_putBody(h).containsKey('afterPrayer'), isFalse);
  });

  group('the shared contract on the phone', () {
    test('an unknown value is refused; every prayer is allowed for every source', () {
      Map<String, dynamic> item(String source, Object? after) => {
        'title': 'Video',
        'source': source,
        if (source == 'upload') 'assetId': 'ab' * 32,
        if (source != 'upload') 'youtubeId': 'dQw4w9WgXcQ',
        if (source == 'rakaman') 'startSec': 10,
        'durationSec': 120,
        'days': ['umum'],
        'order': 1,
        'afterPrayer': ?after,
      };
      for (final source in ['upload', 'youtube', 'rakaman']) {
        for (final p in videoAfterPrayers) {
          expect(validateContent('video', item(source, p)).errors, isEmpty, reason: '$source $p');
        }
        expect(validateContent('video', item(source, null)).errors, isEmpty, reason: '$source none');
        for (final bad in ['dhuha', 'Subuh', '', 5]) {
          expect(validateContent('video', item(source, bad)).errors, isNotEmpty, reason: '$source $bad');
        }
      }
    });
  });

  group('goldens', () {
    for (final (name, lang, label) in [
      ('bm', AppLang.ms, 'Main selepas zikir solat'),
      ('en', AppLang.en, 'Play after the post-prayer zikir'),
      ('ar', AppLang.ar, 'التشغيل بعد ذكر الصلاة'),
    ]) {
      testWidgets('the video editor with the zikir option, $name', (tester) async {
        final h = await _open(
          tester,
          '/content/video/vd2',
          lang: lang,
          prepare: (h) => h.content['video']![1]['afterPrayer'] = 'maghrib',
        );
        await reveal(tester, _chooser);
        await tester.ensureVisible(_chooser);
        await settle(tester);
        expect(find.text(label), findsOneWidget);
        await expectLater(find.byWidget(h.app), matchesGoldenFile('video_after_prayer_$name.png'));
      });
    }
  });
}
