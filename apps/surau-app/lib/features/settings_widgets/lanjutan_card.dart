// The MAXCOM system values on a surau feature's page: a `Lanjutan` label with
// the Pentadbir MAXCOM badge over a gold-edged card. Drawn only for holders
// of `system:read`; the box refuses a change to these without `system:write`.

import 'package:flutter/material.dart';

import '../../app/theme.dart';
import '../../l10n/generated/s.dart';

/// The gold edge of Lanjutan cards and the Lanjutan group.
const Color lanjutanEdge = Color(0xFFE9D6A6);

/// The role's name on a soft gold chip, with the shield.
class PentadbirMaxcomBadge extends StatelessWidget {
  const PentadbirMaxcomBadge({super.key});

  @override
  Widget build(BuildContext context) {
    final s = S.of(context);
    final text = Theme.of(context).textTheme;
    return Container(
      padding: const EdgeInsets.fromLTRB(7, 3, 9, 3),
      decoration: BoxDecoration(
        color: SurauColors.goldSoft,
        borderRadius: BorderRadius.circular(999),
        border: Border.all(color: const Color(0xFFE3C27F)),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          const Icon(Icons.verified_user_rounded, size: 14, color: SurauColors.ink),
          const SizedBox(width: 5),
          Text(
            s.roleSuperadmin,
            style: text.labelSmall!.copyWith(color: SurauColors.ink, fontWeight: FontWeight.w700),
          ),
        ],
      ),
    );
  }
}

class LanjutanCard extends StatelessWidget {
  const LanjutanCard({
    super.key,
    required this.children,
    this.dimmed = false,
    this.dimNote,
  });

  final List<Widget> children;

  /// The values are kept but not used: drawn faint and not tappable.
  final bool dimmed;
  final String? dimNote;

  @override
  Widget build(BuildContext context) {
    final s = S.of(context);
    final text = Theme.of(context).textTheme;
    final rows = Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        for (var i = 0; i < children.length; i++) ...[
          if (i > 0) const Divider(),
          children[i],
        ],
      ],
    );
    return Column(
      key: const ValueKey('lanjutan-card'),
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Padding(
          padding: const EdgeInsets.fromLTRB(4, 0, 4, 8),
          child: Row(
            children: [
              Text(s.settingsLanjutan, style: text.titleSmall!.copyWith(color: SurauColors.muted)),
              const SizedBox(width: 10),
              const PentadbirMaxcomBadge(),
            ],
          ),
        ),
        Card(
          shape: RoundedRectangleBorder(
            borderRadius: BorderRadius.circular(SurauTheme.radiusCard),
            side: const BorderSide(color: lanjutanEdge),
          ),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              if (dimmed) IgnorePointer(child: Opacity(opacity: 0.45, child: rows)) else rows,
              if (dimmed && dimNote != null)
                Padding(
                  key: const ValueKey('lanjutan-dim-note'),
                  padding: const EdgeInsets.fromLTRB(20, 0, 20, 14),
                  child: Text(dimNote!, style: text.bodySmall),
                ),
            ],
          ),
        ),
      ],
    );
  }
}
