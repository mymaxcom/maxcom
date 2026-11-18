// A text for a screen nobody can interact with: BM at the given size, the
// English and Arabic lines under it at 0.7x in a muted tone. The Arabic
// line is right to left whatever the app language is.

import 'package:flutter/material.dart';

import '../../app/theme.dart';

class TrilingualText extends StatelessWidget {
  const TrilingualText({
    super.key,
    required this.ms,
    required this.en,
    required this.ar,
    this.style,
  });

  final String ms;
  final String en;
  final String ar;
  final TextStyle? style;

  @override
  Widget build(BuildContext context) {
    final base = style ?? Theme.of(context).textTheme.titleMedium ?? const TextStyle();
    final size = base.fontSize ?? 16;
    final small = base.copyWith(
      fontSize: size * 0.7,
      fontWeight: FontWeight.w400,
      color: (base.color ?? Theme.of(context).colorScheme.onSurface).withValues(alpha: 0.7),
    );
    return Column(
      mainAxisSize: MainAxisSize.min,
      crossAxisAlignment: CrossAxisAlignment.center,
      children: [
        Text(ms, style: base, textAlign: TextAlign.center, textDirection: TextDirection.ltr),
        const SizedBox(height: 4),
        Text(en, style: small, textAlign: TextAlign.center, textDirection: TextDirection.ltr),
        const SizedBox(height: 2),
        Text(ar, style: small, textAlign: TextAlign.center, textDirection: TextDirection.rtl),
      ],
    );
  }
}

/// The spinner with a [TrilingualText] under it, on the kiosk's gold and
/// white: the content of a full-screen wait (the caller supplies the glass
/// ground). No theme, localisation or Material ancestor is needed, so it
/// also serves the very first frame before the app is built.
class TrilingualWait extends StatelessWidget {
  const TrilingualWait({super.key, required this.ms, required this.en, required this.ar});

  final String ms;
  final String en;
  final String ar;

  @override
  Widget build(BuildContext context) {
    return Column(
      mainAxisSize: MainAxisSize.min,
      children: [
        const SizedBox(
          width: 28,
          height: 28,
          child: CircularProgressIndicator(color: SurauColors.gold, strokeWidth: 3),
        ),
        const SizedBox(height: 20),
        TrilingualText(
          ms: ms,
          en: en,
          ar: ar,
          style: const TextStyle(
            color: Colors.white,
            fontSize: 20,
            fontFamily: SurauTheme.fontFamily,
            fontFamilyFallback: SurauTheme.fontFamilyFallback,
            decoration: TextDecoration.none,
          ),
        ),
      ],
    );
  }
}
