// The one step that makes a scanned QR trustworthy: the phone shows the box's key fingerprint, large, and the person
// compares it with the code under the QR on the TV. A QR copied from paper, a picture or a message names a box the
// TV in front of the person does not show, so the PIN and the recovery code are asked only after this step.

import 'package:flutter/material.dart';

import '../../app/theme.dart';
import '../../l10n/generated/s.dart';

class FingerprintCompare extends StatelessWidget {
  const FingerprintCompare({
    super.key,
    required this.fingerprint,
    required this.keyPrefix,
    required this.onSame,
    required this.onDifferent,
  });

  /// The grouped fingerprint (`4F2A 9C1E 77B0 D3A1`).
  final String fingerprint;

  /// `setup-found` or `recovery-found`: the keys are `<prefix>-fp`, `<prefix>-continue` and `<prefix>-cancel`.
  final String keyPrefix;
  final VoidCallback onSame;
  final VoidCallback onDifferent;

  @override
  Widget build(BuildContext context) {
    final s = S.of(context);
    final text = Theme.of(context).textTheme;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Container(
          padding: const EdgeInsets.symmetric(vertical: 22, horizontal: 12),
          decoration: BoxDecoration(
            color: SurauColors.tealSoft.withValues(alpha: 0.55),
            borderRadius: BorderRadius.circular(SurauTheme.radiusControl),
          ),
          child: Column(
            children: [
              Text(s.setupFingerprintLabel, style: text.bodySmall!.copyWith(color: SurauColors.muted)),
              const SizedBox(height: 6),
              Text(
                fingerprint,
                key: ValueKey('$keyPrefix-fp'),
                textAlign: TextAlign.center,
                style: text.headlineSmall!.copyWith(
                  letterSpacing: 2,
                  fontWeight: FontWeight.w700,
                  fontFeatures: const [FontFeature.tabularFigures()],
                ),
              ),
            ],
          ),
        ),
        const SizedBox(height: 12),
        Text(s.fingerprintCompare, key: ValueKey('$keyPrefix-compare'), style: text.titleSmall),
        const SizedBox(height: 18),
        FilledButton(key: ValueKey('$keyPrefix-continue'), onPressed: onSame, child: Text(s.fingerprintSame)),
        const SizedBox(height: 8),
        OutlinedButton(key: ValueKey('$keyPrefix-cancel'), onPressed: onDifferent, child: Text(s.fingerprintDifferent)),
      ],
    );
  }
}
