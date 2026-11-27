// The two notices of 2026.11.15 build 5 as the Live tab draws them: the silent MAXCOM microphone (danger, three
// hints and the camera sound button) and the busy live server (the suggestion to switch one TV to its normal display).
// Goldens in BM at phone size.

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:surau_app/app/app_lang.dart' show AppLang;
import 'package:surau_app/app/theme.dart';
import 'package:surau_app/features/live/live_widgets.dart';
import 'package:surau_app/l10n/s_lookup.dart' show sFor;

import '../../golden_sizes.dart';

Widget _frame(Widget child) => Directionality(
  textDirection: TextDirection.ltr,
  child: Theme(
    data: SurauTheme.light(),
    child: Material(
      color: SurauColors.paper,
      child: Align(
        alignment: Alignment.topCenter,
        child: RepaintBoundary(
          key: const ValueKey('shot'),
          child: Padding(padding: const EdgeInsets.all(16), child: IntrinsicHeight(child: child)),
        ),
      ),
    ),
  ),
);

void main() {
  final s = sFor(AppLang.ms);

  testWidgets('golden: the silent MAXCOM microphone notice with the camera sound button', (tester) async {
    final w = _frame(
      LiveNotice(
        key: const ValueKey('n'),
        icon: Icons.mic_off_rounded,
        title: s.liveMicSilentTitle,
        body:
            '${s.liveMicSilentBody(3)}\n• ${s.liveMicSilentTip1}\n• ${s.liveMicSilentTip2}\n• ${s.liveMicSilentTip3}',
        danger: true,
        action: FilledButton.icon(
          style: FilledButton.styleFrom(minimumSize: const Size(48, 48)),
          onPressed: () {},
          icon: const Icon(Icons.videocam_rounded),
          label: Text(s.liveMicSilentUseCamera),
        ),
      ),
    );
    await pumpAtSize(tester, w, GoldenSize.phone);
    await expectLater(find.byKey(const ValueKey('shot')), matchesGoldenFile('live_b5_mic_silent_notice_bm.png'));
  });

  testWidgets('golden: the busy live server notice with its two buttons', (tester) async {
    final w = _frame(
      LiveNotice(
        key: const ValueKey('n'),
        icon: Icons.speed_rounded,
        title: s.liveBusyTitle('Dewan Utama', 94),
        body: s.liveBusyBody,
        action: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            FilledButton.icon(
              style: FilledButton.styleFrom(minimumSize: const Size(48, 48)),
              onPressed: () {},
              icon: const Icon(Icons.tv_off_rounded),
              label: Text(s.liveBusyAction, textAlign: TextAlign.center),
            ),
            const SizedBox(height: 4),
            TextButton(style: TextButton.styleFrom(minimumSize: const Size(48, 48)), onPressed: () {}, child: Text(s.liveBusyLater)),
          ],
        ),
      ),
    );
    await pumpAtSize(tester, w, GoldenSize.phone);
    await expectLater(find.byKey(const ValueKey('shot')), matchesGoldenFile('live_b5_busy_notice_bm.png'));
  });
}
