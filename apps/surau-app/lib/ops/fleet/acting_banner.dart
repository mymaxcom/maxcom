// Plan 14 Task 14: the gold band on every screen while a Pentadbir MAXCOM works in a surau
// ("Anda melihat sebagai MAXCOM: <surau>"), with Tukar and Keluar. Ops build only.

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../app/theme.dart';
import 'fleet_providers.dart';
import 'fleet_routes.dart';
import 'fleet_texts.dart';

class ActingBanner extends ConsumerWidget {
  const ActingBanner({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final acting = ref.watch(actingSurauProvider);
    if (acting == null) return const SizedBox.shrink();
    final t = FleetT.of(context);
    final text = Theme.of(context).textTheme;
    return Material(
      key: const ValueKey('acting-banner'),
      color: SurauColors.gold,
      child: SafeArea(
        bottom: false,
        child: Padding(
          padding: const EdgeInsetsDirectional.fromSTEB(16, 4, 4, 4),
          child: Row(
            children: [
              const Icon(Icons.swap_horiz_rounded, size: 20, color: SurauColors.ink),
              const SizedBox(width: 8),
              Expanded(
                child: Text(
                  t.bannerText(acting.name),
                  maxLines: 2,
                  overflow: TextOverflow.ellipsis,
                  style: text.labelLarge!.copyWith(color: SurauColors.ink),
                ),
              ),
              TextButton(
                key: const ValueKey('acting-change'),
                onPressed: () => context.go(OpsRoutes.switcher),
                child: Text(t.bannerChange),
              ),
              TextButton(
                key: const ValueKey('acting-exit'),
                onPressed: () {
                  ref.read(actingSurauProvider.notifier).clear();
                  context.go(OpsRoutes.armada);
                },
                child: Text(t.bannerExit),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

/// [child] under the banner while a surau is chosen, else [child] alone. The page below has its own status bar
/// padding, so the banner (which takes it) removes it from there.
class ActingFrame extends ConsumerWidget {
  const ActingFrame({super.key, required this.child});

  final Widget child;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    if (ref.watch(actingSurauProvider) == null) return child;
    return Column(
      children: [
        const ActingBanner(),
        Expanded(child: MediaQuery.removePadding(context: context, removeTop: true, child: child)),
      ],
    );
  }
}
