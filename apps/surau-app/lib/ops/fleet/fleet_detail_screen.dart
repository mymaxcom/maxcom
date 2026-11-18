// Plan 14 Task 14: the page of one surau: its state, storage and boxes, and "Lihat sebagai MAXCOM" (work in this
// surau). Task 15 adds the box actions (Batal kotak, Pulihkan kotak). Ops build only.

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../app/providers.dart';
import '../../app/shell.dart';
import '../../app/theme.dart';
import '../../l10n/generated/s.dart';
import '../../screens/widgets/pieces.dart' show RowsCard, SectionLabel;
import 'box_actions.dart';
import 'fleet_models.dart';
import 'fleet_providers.dart';
import 'fleet_routes.dart' show OpsRoutes;
import 'fleet_screen.dart' show cloudErrorText;
import 'fleet_texts.dart';
import 'fleet_widgets.dart';

class FleetDetailScreen extends ConsumerWidget {
  const FleetDetailScreen({super.key, required this.surauId});

  final String surauId;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final t = FleetT.of(context);
    final s = S.of(context);
    final text = Theme.of(context).textTheme;
    final now = ref.watch(appDepsProvider).now();
    final async = ref.watch(fleetSurausProvider);
    final all = async.value;
    final surau = all == null ? null : surauById(all, surauId);

    Widget body;
    if (surau == null) {
      body = all == null && !async.hasError
          ? const Padding(padding: EdgeInsets.symmetric(vertical: 24), child: LinearProgressIndicator(minHeight: 2))
          : FleetError(
              message: async.hasError ? cloudErrorText(s, async.error!) : t.armadaEmpty,
              onRetry: () => ref.invalidate(fleetSurausProvider),
            );
    } else {
      final state = surau.stateAt(now);
      body = Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Row(
            children: [
              Expanded(child: Text(surau.name, style: text.headlineSmall)),
              if (surau.empty) ...[
                EmptyChip(key: const ValueKey('detail-empty-chip')),
                const SizedBox(width: 6),
              ],
              SurauStateChip(state),
            ],
          ),
          const SizedBox(height: 4),
          Text(
            '${t.detailSurauId} ${surau.id}',
            key: const ValueKey('detail-surau-id'),
            style: text.bodySmall!.copyWith(color: SurauColors.muted),
          ),
          if (surau.suspendedReason != null) ...[
            const SizedBox(height: 8),
            Text('${t.suspendedBecause}: ${surau.suspendedReason}', style: text.bodyMedium),
          ],
          const SizedBox(height: 16),
          FilledButton.icon(
            key: const ValueKey('view-as-maxcom'),
            onPressed: () {
              ref
                  .read(actingSurauProvider.notifier)
                  .choose(ActingSurau(id: surau.id, name: surau.name, suspended: state == SurauState.suspended));
              context.go('/');
            },
            icon: const Icon(Icons.visibility_outlined),
            label: Text(t.viewAs),
          ),
          const SizedBox(height: 16),
          SectionLabel(t.detailStorage),
          Card(
            child: Padding(
              padding: const EdgeInsets.fromLTRB(16, 14, 16, 14),
              child: StorageBar(used: surau.storageUsedBytes, limit: surau.storageLimitBytes),
            ),
          ),
          const SizedBox(height: 16),
          SectionLabel(t.detailBoxes),
          if (surau.boxes.isEmpty)
            Text(t.detailNoBox, style: text.bodyMedium!.copyWith(color: SurauColors.muted))
          else
            RowsCard(
              children: [
                for (final b in surau.boxes) _BoxRow(box: b, now: now, canManage: fleetCanManage(ref.watch(rolesProvider))),
              ],
            ),
          if (surau.empty && fleetCanManage(ref.watch(rolesProvider))) ...[
            const SizedBox(height: 24),
            OutlinedButton.icon(
              key: const ValueKey('delete-empty-surau'),
              style: OutlinedButton.styleFrom(foregroundColor: SurauColors.danger),
              onPressed: () async {
                final done = await deleteEmptySurau(context, ref, surau);
                if (done && context.mounted) context.go(OpsRoutes.armada);
              },
              icon: const Icon(Icons.delete_outline),
              label: Text(t.deleteSurau),
            ),
          ],
        ],
      );
    }
    return ShellPage(
      title: surau?.name ?? t.armadaTitle,
      body: ListView(padding: SurauTheme.pagePadding, children: [body]),
    );
  }
}

class _BoxRow extends ConsumerWidget {
  const _BoxRow({required this.box, required this.now, required this.canManage});

  final FleetBox box;
  final DateTime now;
  final bool canManage;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final t = FleetT.of(context);
    final text = Theme.of(context).textTheme;
    final seen = box.lastSeenAt;
    final line = [
      groupId(box.boxId),
      if (box.role == 'primary') t.boxPrimary,
      seen == null ? t.neverSeen : t.ago(now.difference(seen)),
    ].join('  ');
    final action = !canManage
        ? null
        : box.revoked
        ? TextButton(
            key: ValueKey('unrevoke-${box.boxId}'),
            onPressed: () => unrevokeBox(context, ref, box),
            child: Text(t.unrevokeBox),
          )
        : TextButton(
            key: ValueKey('revoke-${box.boxId}'),
            style: TextButton.styleFrom(foregroundColor: SurauColors.danger),
            onPressed: () => revokeBox(context, ref, box),
            child: Text(t.revokeBox),
          );
    return ListTile(
      key: ValueKey('box-row-${box.boxId}'),
      title: Text(box.name.isEmpty ? groupId(box.boxId) : box.name),
      isThreeLine: action != null,
      subtitle: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(line, style: text.bodySmall!.copyWith(color: SurauColors.muted)),
          if (action != null) Align(alignment: AlignmentDirectional.centerStart, child: action),
        ],
      ),
      trailing: box.revoked ? Text(t.boxRevoked, style: text.labelMedium!.copyWith(color: SurauColors.dangerInk)) : null,
    );
  }
}
