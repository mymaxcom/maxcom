// The mark of the Pentadbir MAXCOM: a shield icon in the phone app bar, the
// full "Pentadbir MAXCOM" badge on the iPad rail. Nothing is drawn for anyone
// else.

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../app/providers.dart';
import '../../app/theme.dart';
import '../../l10n/generated/s.dart';

class SuperadminBadge extends ConsumerWidget {
  const SuperadminBadge({super.key, this.wide = false, this.compact = false});

  /// The rail's badge with the role name; otherwise the app bar's icon.
  final bool wide;

  /// The narrow rail (iPad portrait): the shield over the name on two lines, so the name is never cut.
  final bool compact;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    if (!ref.watch(isSuperadminProvider)) return const SizedBox.shrink();
    final s = S.of(context);
    if (!wide) {
      return Tooltip(
        message: s.superadminBadgeTooltip,
        child: const Padding(
          key: ValueKey('superadmin-badge'),
          padding: EdgeInsets.symmetric(horizontal: 8),
          // Gold: teal vanishes on the dark glass of the app bar.
          child: Icon(Icons.shield_outlined, color: SurauColors.gold),
        ),
      );
    }
    final label = Theme.of(context).textTheme.labelMedium;
    return Padding(
      padding: const EdgeInsets.fromLTRB(12, 0, 12, 10),
      child: Container(
        key: const ValueKey('superadmin-badge'),
        padding: EdgeInsets.symmetric(horizontal: compact ? 6 : 10, vertical: 8),
        decoration: BoxDecoration(
          color: SurauColors.tealSoft,
          borderRadius: BorderRadius.circular(10),
        ),
        child: compact
            ? Column(
                mainAxisSize: MainAxisSize.min,
                children: [
                  const Icon(Icons.shield_outlined, size: 18, color: SurauColors.teal),
                  const SizedBox(height: 4),
                  Text(s.roleSuperadmin, textAlign: TextAlign.center, maxLines: 2, style: label),
                ],
              )
            : Row(
                mainAxisSize: MainAxisSize.min,
                children: [
                  const Icon(Icons.shield_outlined, size: 18, color: SurauColors.teal),
                  const SizedBox(width: 6),
                  Flexible(child: Text(s.roleSuperadmin, style: label, overflow: TextOverflow.ellipsis)),
                ],
              ),
      ),
    );
  }
}
