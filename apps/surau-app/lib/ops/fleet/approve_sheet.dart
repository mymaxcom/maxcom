// Plan 14 Task 15: approve a waiting box into a NEW surau (named from its registration, as the automatic link would
// name it) or into an EXISTING surau that has no live box. Pentadbir MAXCOM only; the cloud decides again and its
// refusals (surau_has_box, foreign_surau, worker_unreachable, ...) are shown in BM. Ops build only.
//
// The request carries no claim code: the box registered with its claim hash, and the cloud checks that itself
// (mockup decision 7).

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../app/providers.dart';
import '../../app/theme.dart';
import '../../l10n/generated/s.dart';
import 'fleet_models.dart';
import 'fleet_providers.dart';
import 'fleet_texts.dart';
import 'fleet_widgets.dart';

/// The cloud path that approves [boxId].
String approvePath(String boxId) => '/api/fleet/pending/$boxId/approve';

/// The body of the approval: exactly one target, never a default.
Map<String, Object> approveBody({required bool existing, String? surauId}) =>
    existing ? {'surauId': surauId ?? ''} : {'newSurau': true};

/// The suraus a waiting box may join: no live box and not suspended.
List<FleetSurau> joinable(List<FleetSurau> all, DateTime now) => [
  for (final s in all)
    if (!s.hasLiveBox && s.stateAt(now) != SurauState.suspended) s,
];

/// True when a NEW surau was created, false when an existing one took the box, null when nothing was approved.
Future<bool?> showApproveSheet(BuildContext context, PendingBox box) =>
    showModalBottomSheet<bool>(
      context: context,
      isScrollControlled: true,
      showDragHandle: true,
      builder: (context) => ApproveSheet(box: box),
    );

class ApproveSheet extends ConsumerStatefulWidget {
  const ApproveSheet({super.key, required this.box});

  final PendingBox box;

  @override
  ConsumerState<ApproveSheet> createState() => _ApproveSheetState();
}

class _ApproveSheetState extends ConsumerState<ApproveSheet> {
  bool _existing = false;
  FleetSurau? _picked;
  bool _busy = false;
  String? _error;
  final _confirm = TextEditingController();

  @override
  void dispose() {
    _confirm.dispose();
    super.dispose();
  }

  bool get _ready {
    if (_busy) return false;
    if (!_existing) return true;
    final p = _picked;
    return p != null && _confirm.text.trim() == p.name;
  }

  Future<void> _submit() async {
    final gateway = ref.read(gatewayProvider);
    if (gateway == null) return;
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      final done = await gateway.post(
        approvePath(widget.box.boxId),
        approveBody(existing: _existing, surauId: _picked?.id),
      );
      ref.invalidate(pendingBoxesProvider);
      ref.invalidate(fleetSurausProvider);
      if (mounted) Navigator.of(context).pop(done['created'] == true);
    } on Object catch (e) {
      if (!mounted) return;
      setState(() {
        _busy = false;
        _error = fleetFailure(context, e);
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    final t = FleetT.of(context);
    final s = S.of(context);
    final text = Theme.of(context).textTheme;
    final now = ref.watch(appDepsProvider).now();
    final list = ref.watch(fleetSurausProvider);
    final all = list.value;
    final options = all == null ? const <FleetSurau>[] : joinable(all, now);

    // A sheet with a request in flight stays open until the cloud has answered.
    return PopScope(
      canPop: !_busy,
      child: Padding(
        padding: EdgeInsets.fromLTRB(
          20,
          0,
          20,
          20 + MediaQuery.viewInsetsOf(context).bottom,
        ),
        child: SingleChildScrollView(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Text(t.approveTitle, style: text.titleLarge),
              const SizedBox(height: 4),
              Text(
                widget.box.boxName == null
                    ? t.approveFor(widget.box.idGroups)
                    : '${t.approveFor(widget.box.boxName!)} ${t.pendingId(widget.box.idGroups)}',
                style: text.bodySmall!.copyWith(color: SurauColors.muted),
              ),
              const SizedBox(height: 16),
              SegmentedButton<bool>(
                key: const ValueKey('approve-target'),
                showSelectedIcon: false,
                segments: [
                  ButtonSegment(
                    value: false,
                    label: Text(
                      t.targetNew,
                      key: const ValueKey('approve-new'),
                    ),
                  ),
                  ButtonSegment(
                    value: true,
                    label: Text(
                      t.targetExisting,
                      key: const ValueKey('approve-existing'),
                    ),
                  ),
                ],
                selected: {_existing},
                onSelectionChanged: _busy
                    ? null
                    : (v) => setState(() {
                        _existing = v.first;
                        _error = null;
                      }),
              ),
              const SizedBox(height: 16),
              if (!_existing) ...[
                Text(t.newNameLabel, style: text.labelLarge),
                const SizedBox(height: 4),
                Text(
                  widget.box.name.isEmpty
                      ? widget.box.idGroups
                      : widget.box.name,
                  key: const ValueKey('approve-new-name'),
                  style: text.titleMedium,
                ),
                const SizedBox(height: 8),
                Text(
                  t.newNameNote,
                  style: text.bodySmall!.copyWith(color: SurauColors.muted),
                ),
              ] else ...[
                Text(
                  t.existingNote,
                  style: text.bodySmall!.copyWith(color: SurauColors.muted),
                ),
                const SizedBox(height: 8),
                if (all == null && list.hasError)
                  FleetError(
                    message: fleetFailure(context, list.error!),
                    onRetry: () => ref.invalidate(fleetSurausProvider),
                  )
                else if (all == null)
                  const Padding(
                    key: ValueKey('approve-loading'),
                    padding: EdgeInsets.symmetric(vertical: 16),
                    child: LinearProgressIndicator(minHeight: 2),
                  )
                else if (options.isEmpty)
                  Padding(
                    padding: const EdgeInsets.symmetric(vertical: 12),
                    child: Text(
                      t.existingNone,
                      key: const ValueKey('approve-none'),
                      style: text.bodyMedium,
                    ),
                  ),
                for (final o in options)
                  Card(
                    child: ListTile(
                      key: ValueKey('approve-surau-${o.id}'),
                      title: Text(o.name),
                      subtitle: Text(t.stateLabel(o.stateAt(now))),
                      selected: _picked?.id == o.id,
                      trailing: _picked?.id == o.id
                          ? const Icon(Icons.check_circle_rounded)
                          : null,
                      onTap: _busy
                          ? null
                          : () => setState(() {
                              _picked = o;
                              _confirm.clear();
                            }),
                    ),
                  ),
                if (_picked != null) ...[
                  const SizedBox(height: 12),
                  Text(t.existingConfirmLabel, style: text.labelLarge),
                  const SizedBox(height: 6),
                  TextField(
                    key: const ValueKey('approve-confirm-name'),
                    controller: _confirm,
                    autocorrect: false,
                    decoration: InputDecoration(hintText: _picked!.name),
                    onChanged: (_) => setState(() {}),
                  ),
                ],
              ],
              if (_error != null) ...[
                const SizedBox(height: 12),
                Container(
                  key: const ValueKey('approve-error'),
                  padding: const EdgeInsets.fromLTRB(14, 12, 14, 12),
                  decoration: BoxDecoration(
                    color: SurauColors.dangerSoft,
                    borderRadius: BorderRadius.circular(
                      SurauTheme.radiusControl,
                    ),
                  ),
                  child: Text(
                    _error!,
                    style: text.bodyMedium!.copyWith(
                      color: SurauColors.dangerInk,
                    ),
                  ),
                ),
              ],
              const SizedBox(height: 16),
              Row(
                children: [
                  Expanded(
                    child: OutlinedButton(
                      key: const ValueKey('approve-cancel'),
                      onPressed: _busy
                          ? null
                          : () => Navigator.of(context).pop(),
                      child: Text(s.actionCancel),
                    ),
                  ),
                  const SizedBox(width: 12),
                  Expanded(
                    child: FilledButton(
                      key: const ValueKey('approve-submit'),
                      onPressed: _ready ? _submit : null,
                      child: Text(t.approveSubmit),
                    ),
                  ),
                ],
              ),
            ],
          ),
        ),
      ),
    );
  }
}
