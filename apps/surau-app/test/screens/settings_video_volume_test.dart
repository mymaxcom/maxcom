// Video settings: the volume slider ("Kelantangan video") is drawn in the three
// languages, saves like the other volume sliders, and is left alone when the
// box does not send the setting (an older box).

import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:surau_app/app/app_lang.dart';
import 'package:surau_app/app/providers.dart';
import 'package:surau_app/features/registry.g.dart';
import 'package:surau_app/screens/settings_feature_screen.dart' show unsupportedByBox;

import '../features/shell/harness.dart';

Finder get save => find.widgetWithText(FilledButton, 'Simpan');
const _slider = ValueKey('setting-volume');

Future<ShellHarness> open(WidgetTester tester, {required bool boxSendsVolume}) async {
  final h = await pumpShell(tester, roles: const ['admin']);
  final videos = Map<String, Object?>.from(h.settings['videos'] as Map? ?? const {});
  if (boxSendsVolume) {
    videos['volume'] = 40;
  } else {
    videos.remove('volume');
  }
  h.settings['videos'] = videos;
  h.container.invalidate(settingsProvider);
  h.router.go('/settings/videos');
  await settle(tester);
  return h;
}

void main() {
  test('the registry gives the video feature a volume of 40, a 0 to 100 slider like the other volumes', () {
    final f = features.firstWhere((x) => x.key == 'videos');
    expect(f.defaults['volume'], 40);
    expect(fieldMetaTable['videos']?['volume'], fieldMetaTable['beeps']?['volume']);
  });

  test('unsupportedByBox names the newer settings a box left out', () {
    expect(unsupportedByBox('videos', const {'order': 11}), {'volume'});
    expect(unsupportedByBox('videos', const {'order': 11, 'volume': 40}), isEmpty);
    expect(unsupportedByBox('beeps', const {}), isEmpty);
  });

  testWidgets('the slider shows the box value with its label and help, in ms, en and ar', (tester) async {
    final h = await open(tester, boxSendsVolume: true);
    expect(find.text('Kelantangan video'), findsOneWidget);
    expect(find.text("Untuk video yang suisnya 'Bunyi' dihidupkan."), findsOneWidget);
    expect(find.text('40%'), findsOneWidget);

    await h.container.read(appLangProvider.notifier).set(AppLang.en);
    await settle(tester);
    expect(find.text('Video volume'), findsOneWidget);
    expect(find.text("For videos whose 'Sound' switch is on."), findsOneWidget);

    await h.container.read(appLangProvider.notifier).set(AppLang.ar);
    await settle(tester);
    expect(find.text('مستوى صوت الفيديو'), findsOneWidget);
  });

  testWidgets('moving the slider saves only volume', (tester) async {
    final h = await open(tester, boxSendsVolume: true);
    await reveal(tester, find.byKey(_slider));
    tester.widget<Slider>(find.byKey(_slider)).onChanged!(65);
    await settle(tester);
    expect(find.text('65%'), findsOneWidget);
    await reveal(tester, save);
    await tester.tap(save);
    await settle(tester);
    final put = h.box.byPath('/api/settings/videos')!;
    expect(put.method, 'PUT');
    expect(jsonDecode(put.body), {'volume': 65});
  });

  testWidgets('a box that does not send the volume gets no slider and no volume in a reset', (tester) async {
    final h = await open(tester, boxSendsVolume: false);
    expect(find.byKey(_slider), findsNothing);
    expect(find.text('Kelantangan video'), findsNothing);

    await reveal(tester, find.text('Set semula kepada lalai'));
    await tester.tap(find.text('Set semula kepada lalai'));
    await settle(tester);
    await tester.tap(find.widgetWithText(FilledButton, 'Set semula kepada lalai'));
    await settle(tester);
    final put = h.box.byPath('/api/settings/videos')!;
    expect((jsonDecode(put.body) as Map).containsKey('volume'), isFalse);
  });
}
