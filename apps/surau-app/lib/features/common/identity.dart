// The place and the person, on the kiosk's glass: the surau's name in
// gold, "Assalamualaikum, <name>", their roles in plain words and, when
// enrolling, who invited them and until when. The same block opens the
// enrolment review and the daily unlock, so the two feel like one door.

import 'package:flutter/material.dart';

import '../../app/theme.dart';

class SurauIdentity extends StatelessWidget {
  const SurauIdentity({
    super.key,
    required this.surauName,
    required this.greeting,
    this.roles,
    this.note,
    this.centered = true,
    this.logo,
    this.showName = true,
  });

  /// The surau or masjid, or the product name when unknown.
  final String surauName;

  /// The surau's logo above the name (a [LogoImage] or [SurauLogo]); the
  /// block is unchanged without one.
  final Widget? logo;

  /// False when the logo already carries the name: with a logo the name
  /// text is left out (never without one).
  final bool showName;

  /// "Assalamualaikum, Ustaz Ali" (or a step title on the unlock screen).
  final String greeting;

  /// "Pentadbir dan Media"; hidden when empty.
  final String? roles;

  /// "Dijemput oleh ... Jemputan sah hingga ..."; hidden when empty.
  final String? note;
  final bool centered;

  @override
  Widget build(BuildContext context) {
    final text = Theme.of(context).textTheme;
    final align = centered ? TextAlign.center : TextAlign.start;
    final soft = Colors.white.withValues(alpha: 0.74);
    return Column(
      crossAxisAlignment: centered
          ? CrossAxisAlignment.center
          : CrossAxisAlignment.start,
      children: [
        if (logo != null) ...[
          logo!,
          const SizedBox(height: 12),
        ],
        if (logo == null || showName) ...[
          Text(
            surauName,
            textAlign: align,
            style: text.titleMedium!.copyWith(
              color: SurauColors.gold,
              letterSpacing: 0.2,
            ),
          ),
          const SizedBox(height: 6),
        ],
        Text(
          greeting,
          textAlign: align,
          style: text.headlineSmall!.copyWith(color: Colors.white),
        ),
        if (roles != null && roles!.isNotEmpty) ...[
          const SizedBox(height: 4),
          Text(
            roles!,
            textAlign: align,
            style: text.bodyLarge!.copyWith(color: soft),
          ),
        ],
        if (note != null && note!.isNotEmpty) ...[
          const SizedBox(height: 10),
          Text(
            note!,
            textAlign: align,
            style: text.bodyMedium!.copyWith(color: soft),
          ),
        ],
      ],
    );
  }
}
