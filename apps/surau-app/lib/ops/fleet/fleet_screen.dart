// Plan 14 Task 14: Senarai surau (the reduced Armada). Every surau of the cloud with its status, boxes, last seen and
// storage; "Menunggu MAXCOM" and "Luar talian" first. Tapping a card opens its page. Ops build only.

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../app/providers.dart';
import '../../app/shell.dart';
import '../../app/theme.dart';
import '../../box/box_client.dart';
import '../../l10n/generated/s.dart';
import '../../screens/widgets/box_read.dart' show writeErrorText;
import 'fleet_models.dart';
import 'fleet_providers.dart';
import 'fleet_routes.dart';
import 'fleet_texts.dart';
import 'fleet_widgets.dart';

/// The words under a card: boxes and when the primary box was last seen.
String lastSeenLine(FleetT t, FleetSurau s, DateTime now) {
  final live = s.liveBoxes;
  final n = t.boxCount(live.length);
  if (live.isEmpty) return n;
  final primary = live.firstWhere((b) => b.role == 'primary', orElse: () => live.first);
  final seen = primary.lastSeenAt;
  return '$n  ${seen == null ? t.neverSeen : t.ago(now.difference(seen))}';
}

/// The error line of a failed cloud read: the server's BM message, else the app's.
String cloudErrorText(S s, Object error) {
  if (error is BoxError && error.status != 403 && error.status != 429) return error.message;
  return writeErrorText(s, error);
}

class FleetScreen extends ConsumerStatefulWidget {
  const FleetScreen({super.key});

  @override
  ConsumerState<FleetScreen> createState() => _FleetScreenState();
}

class _FleetScreenState extends ConsumerState<FleetScreen> {
  String _query = '';
  SurauState? _filter;

  bool _matches(FleetSurau s) {
    if (_filter != null && s.stateAt(ref.read(appDepsProvider).now()) != _filter) return false;
    final q = _query.trim().toLowerCase();
    if (q.isEmpty) return true;
    if (s.name.toLowerCase().contains(q) || s.id.toLowerCase().contains(q)) return true;
    return s.boxes.any((b) => b.boxId.replaceAll('-', '').toLowerCase().contains(q.replaceAll('-', '')));
  }

  @override
  Widget build(BuildContext context) {
    final t = FleetT.of(context);
    final s = S.of(context);
    final text = Theme.of(context).textTheme;
    final now = ref.watch(appDepsProvider).now();
    final async = ref.watch(fleetSurausProvider);
    final needs = ref.watch(needsSurauProvider);

    Widget body;
    final all = async.value;
    if (all == null) {
      body = async.hasError
          ? FleetError(
              message: cloudErrorText(s, async.error!),
              onRetry: () => ref.invalidate(fleetSurausProvider),
            )
          : const Padding(
              padding: EdgeInsets.symmetric(vertical: 24),
              child: LinearProgressIndicator(minHeight: 2),
            );
    } else {
      final sorted = sortFleet(all, now);
      final counts = <SurauState, int>{for (final st in SurauState.values) st: 0};
      for (final x in sorted) {
        counts[x.stateAt(now)] = counts[x.stateAt(now)]! + 1;
      }
      final shown = [
        for (final x in sorted)
          if (_matches(x)) x,
      ];
      body = Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          TextField(
            key: const ValueKey('fleet-search'),
            decoration: InputDecoration(prefixIcon: const Icon(Icons.search_rounded), hintText: t.searchHint),
            onChanged: (v) => setState(() => _query = v),
          ),
          const SizedBox(height: 12),
          SingleChildScrollView(
            scrollDirection: Axis.horizontal,
            child: Row(
              children: [
                _FilterChip(
                  keyName: 'fleet-filter-all',
                  label: '${t.filterAll} ${sorted.length}',
                  selected: _filter == null,
                  onTap: () => setState(() => _filter = null),
                ),
                for (final st in [SurauState.ok, SurauState.offline, SurauState.waiting, SurauState.suspended])
                  _FilterChip(
                    keyName: 'fleet-filter-${st.name}',
                    label: '${t.stateLabel(st)} ${counts[st]}',
                    selected: _filter == st,
                    onTap: () => setState(() => _filter = st),
                  ),
              ],
            ),
          ),
          const SizedBox(height: 12),
          if (shown.isEmpty)
            Padding(
              padding: const EdgeInsets.symmetric(vertical: 28),
              child: Text(t.armadaEmpty, textAlign: TextAlign.center, style: text.bodyLarge),
            ),
          for (final x in shown) ...[FleetCard(surau: x, now: now), const SizedBox(height: 10)],
        ],
      );
    }

    return ShellPage(
      title: t.armadaTitle,
      body: RefreshIndicator(
        onRefresh: () async {
          retryOpsContext(ref);
          ref.invalidate(fleetSurausProvider);
          try {
            await ref.read(fleetSurausProvider.future);
          } on Object {
            // The screen shows the error with its own Cuba lagi; the gesture itself does not throw.
          }
        },
        child: ListView(
          padding: SurauTheme.pagePadding,
          children: [
            if (needs) ...[
              Container(
                key: const ValueKey('fleet-choose-hint'),
                padding: const EdgeInsets.fromLTRB(14, 12, 14, 12),
                decoration: BoxDecoration(
                  color: SurauColors.goldSoft,
                  borderRadius: BorderRadius.circular(SurauTheme.radiusControl),
                ),
                child: Text(t.armadaChooseFirst, style: text.bodyMedium!.copyWith(color: SurauColors.ink)),
              ),
              const SizedBox(height: 12),
            ],
            body,
          ],
        ),
      ),
    );
  }
}

class _FilterChip extends StatelessWidget {
  const _FilterChip({required this.keyName, required this.label, required this.selected, required this.onTap});

  final String keyName;
  final String label;
  final bool selected;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsetsDirectional.only(end: 8),
      child: ChoiceChip(key: ValueKey(keyName), label: Text(label), selected: selected, onSelected: (_) => onTap()),
    );
  }
}

class FleetCard extends StatelessWidget {
  const FleetCard({super.key, required this.surau, required this.now});

  final FleetSurau surau;
  final DateTime now;

  @override
  Widget build(BuildContext context) {
    final t = FleetT.of(context);
    final text = Theme.of(context).textTheme;
    return Card(
      key: ValueKey('fleet-card-${surau.id}'),
      clipBehavior: Clip.antiAlias,
      child: InkWell(
        onTap: () => context.go(OpsRoutes.detailFor(surau.id)),
        child: Padding(
          padding: const EdgeInsets.fromLTRB(16, 14, 16, 14),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Row(
                children: [
                  Expanded(child: Text(surau.name, maxLines: 2, overflow: TextOverflow.ellipsis, style: text.titleMedium)),
                  const SizedBox(width: 8),
                  if (surau.empty) ...[
                    EmptyChip(key: ValueKey('empty-chip-${surau.id}')),
                    const SizedBox(width: 6),
                  ],
                  SurauStateChip(surau.stateAt(now)),
                ],
              ),
              const SizedBox(height: 4),
              Text(lastSeenLine(t, surau, now), style: text.bodySmall!.copyWith(color: SurauColors.muted)),
              const SizedBox(height: 10),
              StorageBar(used: surau.storageUsedBytes, limit: surau.storageLimitBytes),
            ],
          ),
        ),
      ),
    );
  }
}
