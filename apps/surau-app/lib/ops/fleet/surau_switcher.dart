// Plan 14 Task 14: choosing the surau a Pentadbir MAXCOM works in. The app-bar button shows only for an ops session
// of the cloud that sees every surau (never on a box, never for a surau user); the page lists every surau and makes
// the pick. The pick is not remembered after the app closes. Ops build only.

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../app/providers.dart';
import '../../app/shell.dart';
import '../../app/theme.dart';
import '../../l10n/generated/s.dart';
import 'fleet_models.dart';
import 'fleet_providers.dart';
import 'fleet_screen.dart' show cloudErrorText;
import 'fleet_texts.dart';
import 'fleet_widgets.dart';
import 'fleet_routes.dart';

class SurauSwitcherButton extends ConsumerWidget {
  const SurauSwitcherButton({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    if (!ref.watch(switcherVisibleProvider)) return const SizedBox.shrink();
    return IconButton(
      key: const ValueKey('surau-switcher'),
      tooltip: FleetT.of(context).switcherTooltip,
      icon: const Icon(Icons.swap_horiz_rounded, color: SurauColors.gold),
      onPressed: () {
        retryOpsContext(ref);
        context.go(OpsRoutes.switcher);
      },
    );
  }
}

class SurauSwitcherScreen extends ConsumerStatefulWidget {
  const SurauSwitcherScreen({super.key});

  @override
  ConsumerState<SurauSwitcherScreen> createState() => _SurauSwitcherScreenState();
}

class _SurauSwitcherScreenState extends ConsumerState<SurauSwitcherScreen> {
  String _query = '';

  @override
  Widget build(BuildContext context) {
    final t = FleetT.of(context);
    final s = S.of(context);
    final text = Theme.of(context).textTheme;
    final now = ref.watch(appDepsProvider).now();
    final acting = ref.watch(actingSurauProvider);
    final async = ref.watch(fleetSurausProvider);
    final all = async.value;
    final q = _query.trim().toLowerCase();
    final shown = all == null
        ? const <FleetSurau>[]
        : [
            for (final x in sortFleet(all, now))
              if (q.isEmpty || x.name.toLowerCase().contains(q) || x.id.toLowerCase().contains(q)) x,
          ];
    return ShellPage(
      title: t.switcherTitle,
      body: ListView(
        padding: SurauTheme.pagePadding,
        children: [
          TextField(
            key: const ValueKey('switcher-search'),
            decoration: InputDecoration(prefixIcon: const Icon(Icons.search_rounded), hintText: t.searchHint),
            onChanged: (v) => setState(() => _query = v),
          ),
          const SizedBox(height: 12),
          Card(
            child: ListTile(
              key: const ValueKey('switcher-none'),
              leading: const Icon(Icons.list_alt_rounded),
              title: Text(t.switcherNone),
              selected: acting == null,
              onTap: () {
                ref.read(actingSurauProvider.notifier).clear();
                context.go(OpsRoutes.armada);
              },
            ),
          ),
          const SizedBox(height: 8),
          if (all == null)
            async.hasError
                ? FleetError(
                    message: cloudErrorText(s, async.error!),
                    onRetry: () => ref.invalidate(fleetSurausProvider),
                  )
                : const Padding(padding: EdgeInsets.symmetric(vertical: 24), child: LinearProgressIndicator(minHeight: 2))
          else
            for (final x in shown)
              Card(
                child: ListTile(
                  key: ValueKey('switcher-${x.id}'),
                  title: Text(x.name),
                  subtitle: Text(lastSwitcherLine(t, x, now), style: text.bodySmall!.copyWith(color: SurauColors.muted)),
                  trailing: SurauStateChip(x.stateAt(now)),
                  selected: acting?.id == x.id,
                  onTap: () {
                    ref
                        .read(actingSurauProvider.notifier)
                        .choose(
                          ActingSurau(id: x.id, name: x.name, suspended: x.stateAt(now) == SurauState.suspended),
                        );
                    context.go('/');
                  },
                ),
              ),
          const SizedBox(height: 12),
          Text(t.switcherNote, style: text.bodySmall!.copyWith(color: SurauColors.muted)),
        ],
      ),
    );
  }
}

String lastSwitcherLine(FleetT t, FleetSurau x, DateTime now) =>
    '${t.boxCount(x.liveBoxes.length)}${x.stateAt(now) == SurauState.suspended ? ', ${t.switcherSuspendedNote}' : ''}';
