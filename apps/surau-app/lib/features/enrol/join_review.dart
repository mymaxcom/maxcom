// "Sertai Surau X?": what the person sees before any join is sent. The surau,
// who invited them and until when, and which box it is: its name, id and the
// fingerprint to compare with the Pentadbir's screen. The fingerprint comes from
// the box itself over HTTPS (`GET /api/box/info`), not from the invitation.

import 'package:flutter/material.dart';

import '../../app/theme.dart';
import '../../l10n/generated/s.dart';

class JoinReview extends StatelessWidget {
  const JoinReview({
    super.key,
    required this.surau,
    required this.greetingName,
    required this.validUntil,
    this.invitedBy,
    this.boxName,
    this.boxIdGroups,
    this.fingerprintGroups,
  });

  final String surau;
  final String greetingName;

  /// Already in words ("10:45 malam").
  final String validUntil;
  final String? invitedBy;
  final String? boxName;
  final String? boxIdGroups;

  /// Null while the box has not answered yet.
  final String? fingerprintGroups;

  @override
  Widget build(BuildContext context) {
    final s = S.of(context);
    final text = Theme.of(context).textTheme;
    return Card(
      key: const ValueKey('join-review'),
      child: Padding(
        padding: const EdgeInsets.fromLTRB(20, 18, 20, 18),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(s.joinTitle(surau), style: text.titleLarge),
            const SizedBox(height: 6),
            Text(s.joinGreeting(greetingName), style: text.bodyLarge),
            if (invitedBy != null) Text(s.joinInvitedBy(invitedBy!), style: text.bodyMedium!.copyWith(color: SurauColors.muted)),
            Text(s.joinValidUntil(validUntil), style: text.bodyMedium!.copyWith(color: SurauColors.muted)),
            if (boxName != null || fingerprintGroups != null) ...[
              const Divider(height: 28),
              if (boxName != null) Text(boxName!, style: text.titleSmall),
              if (boxIdGroups != null)
                Text(
                  '${s.setupIdLabel} $boxIdGroups',
                  key: const ValueKey('join-review-id'),
                  style: text.bodyMedium!.copyWith(color: SurauColors.muted),
                ),
              if (fingerprintGroups != null) ...[
                const SizedBox(height: 8),
                Text(
                  fingerprintGroups!,
                  key: const ValueKey('join-review-fp'),
                  style: text.titleMedium!.copyWith(letterSpacing: 1.5, fontFeatures: const [FontFeature.tabularFigures()]),
                ),
                const SizedBox(height: 2),
                Text(s.joinBoxFingerprintHint, style: text.bodySmall!.copyWith(color: SurauColors.muted)),
              ],
            ],
          ],
        ),
      ),
    );
  }
}
