// The wired / USB microphone messages (21 Nov 2026): the microphone the live
// could not use, and the 4-pole (TRRS) hint. Text checks and goldens in BM, EN and AR.

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:surau_app/app/app_lang.dart' show AppLang;
import 'package:surau_app/features/labels_cam.dart';
import 'package:surau_app/features/live/live_source.dart';
import 'package:surau_app/features/live/live_source_widgets.dart';
import 'package:surau_app/features/live/publisher.dart' show VideoSourceKind;

import '../../golden_sizes.dart';

final _src = LiveSourceState(loaded: true, mix: defaultMix(VideoSourceKind.phone));

List<AudioNotice> _notices(AppLang lang, {String? unavailable, bool trrs = false}) => buildAudioNotices(
  source: _src,
  ctx: AudioContext(dev: 'phone', live: true, lang: lang, micUnavailable: unavailable, trrsHint: trrs),
);

void main() {
  test('the unavailable-microphone message says the device microphone is used (the same wording as the other mic labels) (BM, EN, AR)', () {
    expect(liveMicUnavailable(AppLang.ms, 'Headset Mic'), 'Mikrofon Headset Mic tidak dapat digunakan; siaran menggunakan mikrofon peranti.');
    expect(liveMicUnavailable(AppLang.en, 'Headset Mic'), contains('device microphone'));
    expect(liveMicUnavailable(AppLang.ar, 'Headset Mic'), contains('Headset Mic'));
    expect(liveMicUnavailable(AppLang.ar, 'Headset Mic'), contains(liveMicBuiltinName(AppLang.ar).substring(8)));
    expect(liveMicUnavailable(AppLang.ms, 'X'), contains('mikrofon peranti'));
    expect(liveMicBuiltinName(AppLang.ms).toLowerCase(), contains('mikrofon peranti'));
    expect(liveMicTrrsHint(AppLang.ms), contains('4-kutub (TRRS)'));
  });

  test('the notices appear for a refused microphone and for headphones without a microphone', () {
    final a = _notices(AppLang.ms, unavailable: 'Headset Mic');
    expect(a.single.kind, 'bad');
    expect(a.single.body, liveMicUnavailable(AppLang.ms, 'Headset Mic'));
    final b = _notices(AppLang.ms, trrs: true);
    expect(b.single.body, liveMicTrrsHint(AppLang.ms));
    expect(_notices(AppLang.ms), isEmpty);
    // a refusal wins over the hint (one message at a time)
    expect(_notices(AppLang.ms, unavailable: 'X', trrs: true).single.kind, 'bad');
  });

  for (final (name, lang, rtl) in [('bm', AppLang.ms, false), ('en', AppLang.en, false), ('ar', AppLang.ar, true)]) {
    testWidgets('golden: the microphone messages, $name', (tester) async {
      final w = Directionality(
        textDirection: rtl ? TextDirection.rtl : TextDirection.ltr,
        child: Material(
          child: Padding(
            padding: const EdgeInsets.all(16),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                for (final n in [..._notices(lang, unavailable: 'Headset Mic'), ..._notices(lang, trrs: true)]) AudioNoticeTile(notice: n),
              ],
            ),
          ),
        ),
      );
      await pumpAtSize(tester, w, GoldenSize.phone);
      await expectLater(find.byType(Column).first, matchesGoldenFile('live_mic_notice_$name.png'));
    });
  }
}
