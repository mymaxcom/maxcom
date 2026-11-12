// A room that is planned but not yet furnished: its title, what it will
// do and for whom, and the way back. Later tasks and plans replace each
// one with the real screen; until then navigation, gating and the goldens
// are exercised against pages that look intentional.

import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';

import '../../app/router.dart';
import '../../app/shell.dart';
import '../../app/theme.dart';
import '../../l10n/generated/s.dart';

class ComingScreen extends StatelessWidget {
  const ComingScreen({
    super.key,
    required this.title,
    required this.icon,
    required this.description,
    this.plan,
    this.detail,
  });

  final String title;
  final IconData icon;

  /// One sentence: what this page will do.
  final String description;

  /// `Plan 5` and the like, for the operator; null for pages of this plan.
  final String? plan;

  /// A path parameter (feature key, content kind) shown under the icon.
  final String? detail;

  @override
  Widget build(BuildContext context) {
    final s = S.of(context);
    final text = Theme.of(context).textTheme;
    return ShellPage(
      title: title,
      body: SurauTheme.page(
        children: [
          const SizedBox(height: 28),
          Center(
            child: ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: 440),
              child: Column(
                children: [
                  Container(
                    width: 80,
                    height: 80,
                    decoration: const BoxDecoration(
                      color: SurauColors.tealSoft,
                      shape: BoxShape.circle,
                    ),
                    child: Icon(icon, size: 36, color: SurauColors.teal),
                  ),
                  if (detail != null) ...[
                    const SizedBox(height: 12),
                    Text(
                      detail!,
                      textAlign: TextAlign.center,
                      style: text.labelMedium!.copyWith(color: SurauColors.teal),
                    ),
                  ],
                  const SizedBox(height: 20),
                  Text(
                    description,
                    textAlign: TextAlign.center,
                    style: text.bodyLarge,
                  ),
                  const SizedBox(height: 12),
                  Text(
                    s.comingBody,
                    textAlign: TextAlign.center,
                    style: text.bodyMedium!.copyWith(color: SurauColors.muted),
                  ),
                  if (plan != null) ...[
                    const SizedBox(height: 8),
                    Text(
                      s.comingPlanned(plan!),
                      textAlign: TextAlign.center,
                      style: text.bodySmall,
                    ),
                  ],
                  const SizedBox(height: 28),
                  OutlinedButton.icon(
                    onPressed: () => context.go(AppRoutes.dashboard),
                    icon: const Icon(Icons.home_outlined),
                    label: Text(s.backHome),
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
