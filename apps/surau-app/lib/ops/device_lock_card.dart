// Plan 14 Task 25: the Pentadbir MAXCOM's own lock card on the `Kunci aplikasi`
// settings page, the always-on lock row on `This device` and the banner on the
// finance home. Ops build only: each is reached through `if (kOpsBuild)`.

import 'package:flutter/material.dart';

import '../app/theme.dart';
import '../l10n/generated/s.dart';
import '../features/finance/finance_widgets.dart';
import '../screens/widgets/pieces.dart';
import 'lanjutan_card.dart';

/// The Pentadbir MAXCOM's own lock on the `Kunci aplikasi` page: always on,
/// whatever the surau's switch says.
class DeviceLockCard extends StatelessWidget {
  const DeviceLockCard({super.key});

  @override
  Widget build(BuildContext context) {
    final s = S.of(context);
    final text = Theme.of(context).textTheme;
    return Padding(
      key: const ValueKey('superadmin-device-lock'),
      padding: const EdgeInsets.only(top: 22),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(4, 0, 4, 8),
            child: Row(
              children: [
                Text(s.settingsDeviceLockSection, style: text.titleSmall!.copyWith(color: SurauColors.muted)),
                const SizedBox(width: 10),
                const PentadbirMaxcomBadge(),
              ],
            ),
          ),
          Card(
            child: Padding(
              padding: const EdgeInsets.fromLTRB(20, 14, 20, 14),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  Row(
                    children: [
                      const Icon(Icons.lock_rounded, size: 26, color: SurauColors.teal),
                      const SizedBox(width: 12),
                      Expanded(
                        child: Text(
                          s.settingsDeviceLockTitle,
                          style: text.bodyLarge!.copyWith(fontWeight: FontWeight.w600),
                        ),
                      ),
                      StateChip(
                        label: s.featureLocked,
                        background: SurauColors.goldSoft,
                        foreground: SurauColors.ink,
                      ),
                    ],
                  ),
                  const SizedBox(height: 12),
                  Container(
                    padding: const EdgeInsets.fromLTRB(14, 12, 14, 12),
                    decoration: BoxDecoration(
                      color: SurauColors.goldSoft,
                      borderRadius: BorderRadius.circular(SurauTheme.radiusControl),
                    ),
                    child: Text(s.settingsDeviceLockBody, style: text.bodyMedium!.copyWith(color: SurauColors.ink)),
                  ),
                ],
              ),
            ),
          ),
        ],
      ),
    );
  }
}

/// The always-on lock row on the `This device` page.
class DeviceLockAlwaysRow extends StatelessWidget {
  const DeviceLockAlwaysRow({super.key});

  @override
  Widget build(BuildContext context) {
    final s = S.of(context);
    return ListTile(
      key: const ValueKey('this-device-lock-always'),
      leading: const Icon(Icons.shield_outlined),
      title: Text(s.deviceLockAlwaysOn),
      subtitle: Text(s.featureLocked),
    );
  }
}

/// The gold banner at the top of the finance home.
class FinanceSuperBanner extends StatelessWidget {
  const FinanceSuperBanner({super.key});

  @override
  Widget build(BuildContext context) {
    final s = S.of(context);
    return Column(
      children: [
        FinInfoBox(
          key: const Key('fin-super-banner'),
          text: s.finSuperBanner,
          icon: Icons.shield_outlined,
          tone: FinTone.gold,
        ),
        const SizedBox(height: 12),
      ],
    );
  }
}
