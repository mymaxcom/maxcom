// Plan 14 Task 15: Kotak menunggu. The boxes the Worker knows that the cloud has not linked (a box links itself; one
// shows here when the daily cap of new suraus holds it back, or it needs a hand). Each card gives the registered
// name, the box name, platform, version, the id in groups of four and how long ago it registered; Pentadbir MAXCOM
// can approve it (approve_sheet.dart). Sokongan MAXCOM only reads. Ops build only.

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../app/providers.dart';
import '../../app/shell.dart';
import '../../app/theme.dart';
import '../../l10n/generated/s.dart';
import '../../screens/widgets/pieces.dart' show StateChip, toast;
import 'approve_sheet.dart';
import 'box_actions.dart' show rejectPendingBox;
import 'fleet_models.dart';
import 'fleet_providers.dart';
import 'fleet_screen.dart' show cloudErrorText;
import 'fleet_texts.dart';
import 'fleet_widgets.dart';

/// The platform word the box registered with.
String platformWord(String platform) => switch (platform) {
  'android' => 'Android',
  'windows' => 'Windows',
  'linux' => 'Linux',
  _ => platform,
};

class PendingScreen extends ConsumerWidget {
  const PendingScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final t = FleetT.of(context);
    final s = S.of(context);
    final text = Theme.of(context).textTheme;
    final now = ref.watch(appDepsProvider).now();
    final canManage = fleetCanManage(ref.watch(rolesProvider));
    final async = ref.watch(pendingBoxesProvider);
    final list = async.value;

    Widget body;
    if (list == null) {
      body = async.hasError
          ? FleetError(
              message: cloudErrorText(s, async.error!),
              onRetry: () => ref.invalidate(pendingBoxesProvider),
            )
          : const Padding(padding: EdgeInsets.symmetric(vertical: 24), child: LinearProgressIndicator(minHeight: 2));
    } else if (list.isEmpty) {
      body = Padding(
        padding: const EdgeInsets.symmetric(vertical: 28),
        child: Text(t.pendingEmpty, key: const ValueKey('pending-empty'), textAlign: TextAlign.center, style: text.bodyLarge),
      );
    } else {
      body = Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          for (final b in list) ...[PendingCard(box: b, now: now, canManage: canManage), const SizedBox(height: 10)],
        ],
      );
    }

    return ShellPage(
      title: t.pendingMenu,
      body: RefreshIndicator(
        onRefresh: () async {
          ref.invalidate(pendingBoxesProvider);
          try {
            await ref.read(pendingBoxesProvider.future);
          } on Object {
            // The screen shows the error with its own Cuba lagi; the gesture itself does not throw.
          }
        },
        child: ListView(
          padding: SurauTheme.pagePadding,
          children: [
            Text(t.pendingNote, style: text.bodyMedium!.copyWith(color: SurauColors.muted)),
            const SizedBox(height: 14),
            body,
          ],
        ),
      ),
    );
  }
}

class PendingCard extends ConsumerWidget {
  const PendingCard({super.key, required this.box, required this.now, required this.canManage});

  final PendingBox box;
  final DateTime now;
  final bool canManage;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final t = FleetT.of(context);
    final text = Theme.of(context).textTheme;
    final muted = text.bodySmall!.copyWith(color: SurauColors.muted);
    final at = box.at;
    return Card(
      key: ValueKey('pending-card-${box.boxId}'),
      child: Padding(
        padding: const EdgeInsets.fromLTRB(16, 14, 16, 14),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                Expanded(
                  child: Text(
                    box.name.isEmpty ? box.idGroups : box.name,
                    maxLines: 2,
                    overflow: TextOverflow.ellipsis,
                    style: text.titleMedium,
                  ),
                ),
                if (box.held != null) ...[
                  const SizedBox(width: 8),
                  StateChip(
                    key: ValueKey('pending-held-${box.boxId}'),
                    label: box.held == 'daily_cap' ? t.pendingHeld : t.pendingHeldOther,
                    background: SurauColors.goldSoft,
                    foreground: SurauColors.ink,
                  ),
                ],
              ],
            ),
            const SizedBox(height: 6),
            if (box.boxName != null) Text(t.pendingBoxName(box.boxName!), style: muted),
            if (box.platform != null) Text(t.pendingPlatform(platformWord(box.platform!)), style: muted),
            if (box.version != null) Text(t.pendingVersion(box.version!), style: muted),
            Text(t.pendingId(box.idGroups), key: ValueKey('pending-id-${box.boxId}'), style: muted),
            if (at != null) Text(t.pendingRegistered(t.ago(now.difference(at))), style: muted),
            if (canManage) ...[
              const SizedBox(height: 12),
              Row(
                mainAxisAlignment: MainAxisAlignment.end,
                children: [
                  OutlinedButton(
                    key: ValueKey('pending-reject-${box.boxId}'),
                    onPressed: () => rejectPendingBox(context, ref, box),
                    child: Text(t.rejectAction),
                  ),
                  const SizedBox(width: 10),
                  FilledButton(
                    key: ValueKey('pending-approve-${box.boxId}'),
                    onPressed: () async {
                      final created = await showApproveSheet(context, box);
                      if (created == null || !context.mounted) return;
                      toast(context, created ? t.approvedNew : t.approvedExisting);
                    },
                    child: Text(t.approveAction),
                  ),
                ],
              ),
            ],
          ],
        ),
      ),
    );
  }
}
