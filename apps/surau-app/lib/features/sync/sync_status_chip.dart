// The sync status chip (Plan 6 Task 9), top right of every page: synced,
// edits waiting, offline (edits kept for later), the cloud waking, or synced
// through the cloud, with a red count when an edit did not land. A tap opens
// the sheet: which way the app is connected, the last sync, the last error
// in BM, `Selaraskan sekarang` and `Lihat konflik`.
//
// Hidden while there is no sync engine (not unlocked or no local store), so
// a page never claims a state nobody is keeping.

import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../app/providers.dart';
import '../../app/theme.dart';
import '../../l10n/generated/s.dart';
import '../../sync/sync_engine.dart';
import '../../sync/sync_providers.dart';
import 'live_only_dialog.dart';
import 'sync_actions.dart';

/// Where the conflicts list lives (the router owns the route).
const String conflictsRoute = '/sync/conflicts';

enum SyncChipKind { synced, viaCloud, pending, offline, waking, running }

/// The one state the chip shows for [v], most urgent first.
SyncChipKind chipKindOf(SyncView v) {
  if (v.state == SyncState.waking) return SyncChipKind.waking;
  if (v.state == SyncState.offline || v.lastError == 'unreachable') {
    return SyncChipKind.offline;
  }
  if (v.pendingOut > 0) return SyncChipKind.pending;
  if (v.lastSync == null) return SyncChipKind.running;
  return v.via == 'cloud' ? SyncChipKind.viaCloud : SyncChipKind.synced;
}

/// `HH:mm` in 24 hours, as the plan words it (`Diselaraskan 10:05`).
String clockOf(DateTime local) =>
    '${local.hour.toString().padLeft(2, '0')}:${local.minute.toString().padLeft(2, '0')}';

const List<String> _monthsMs = [
  'Jan',
  'Feb',
  'Mac',
  'Apr',
  'Mei',
  'Jun',
  'Jul',
  'Ogos',
  'Sep',
  'Okt',
  'Nov',
  'Dis', //
];

/// `HH:mm` today, else `5 Nov 10:05`. Both in the reader's zone.
String stampWords(DateTime local, {required DateTime today}) {
  final same =
      local.year == today.year &&
      local.month == today.month &&
      local.day == today.day;
  if (same) return clockOf(local);
  return '${local.day} ${_monthsMs[local.month - 1]} ${clockOf(local)}';
}

/// The engine's error code in the person's words; null for none.
String? syncErrorWords(S s, String? code) => switch (code) {
  null => null,
  'unreachable' => s.syncErrUnreachable,
  'cloud_unreachable' => s.syncCloudUnreachable,
  'needs_unlock' => s.syncErrNeedsUnlock,
  'session_expired' => s.errorSessionExpired,
  'device_revoked' => s.syncDeviceRevoked,
  _ => s.syncErrFailed,
};

class _ChipLook {
  const _ChipLook(
    this.icon,
    this.background,
    this.foreground, {
    this.border,
    this.busy = false,
  });

  final IconData icon;
  final Color background;
  final Color foreground;
  final Color? border;
  final bool busy;
}

/// The amber of a chip that has work waiting (dark enough on goldSoft).
const Color _amberInk = Color(0xFF6B4A00);

class SyncStatusChip extends ConsumerWidget {
  const SyncStatusChip({super.key, this.compact, this.iconOnly = false});

  /// Only the icon (and the conflicts count): a long page title on a phone
  /// keeps its room. The words stay in the semantics label and the sheet.
  final bool iconOnly;

  /// Short labels for a narrow app bar; null decides from the screen width.
  final bool? compact;

  /// Below this width the labels are the short ones (the full sentence
  /// stays in the semantics label and the sheet).
  static const double compactBelow = 600;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    if (ref.watch(syncActionsProvider) == null) return const SizedBox.shrink();
    final v = ref.watch(syncViewProvider).value ?? SyncView.empty;
    final s = S.of(context);
    final text = Theme.of(context).textTheme;
    final small = compact ?? MediaQuery.sizeOf(context).width < compactBelow;
    final kind = chipKindOf(v);
    final syncing = v.state == SyncState.syncing;

    final (String label, String full, _ChipLook look) = switch (kind) {
      SyncChipKind.synced => (
        s.syncSynced,
        s.syncSynced,
        _ChipLook(
          Icons.check_circle_outline_rounded,
          SurauColors.paperDeep,
          SurauColors.muted,
          busy: syncing,
        ),
      ),
      SyncChipKind.viaCloud => (
        s.syncViaCloud,
        '${s.syncSynced}, ${s.syncViaCloud.toLowerCase()}',
        _ChipLook(
          Icons.cloud_done_outlined,
          SurauColors.tealSoft,
          SurauColors.teal,
          busy: syncing,
        ),
      ),
      SyncChipKind.pending => (
        small ? s.syncPendingShort(v.pendingOut) : s.syncPending(v.pendingOut),
        s.syncPending(v.pendingOut),
        _ChipLook(
          Icons.schedule_rounded,
          SurauColors.goldSoft,
          _amberInk,
          busy: syncing,
        ),
      ),
      SyncChipKind.offline => (
        small ? s.syncOfflineShort : s.syncOffline,
        s.syncOffline,
        const _ChipLook(
          Icons.cloud_off_rounded,
          SurauColors.card,
          SurauColors.danger,
          border: SurauColors.danger,
        ),
      ),
      SyncChipKind.waking => (
        small ? s.syncWakingShort : s.syncWaking,
        s.syncWaking,
        _ChipLook(
          Icons.cloud_sync_outlined,
          SurauColors.tealSoft,
          SurauColors.teal,
          busy: syncing,
        ),
      ),
      SyncChipKind.running => (
        s.syncRunning,
        s.syncRunning,
        _ChipLook(
          Icons.sync_rounded,
          SurauColors.paperDeep,
          SurauColors.muted,
          busy: syncing,
        ),
      ),
    };

    final semantics = [
      full,
      if (v.conflicts > 0) s.syncConflicts(v.conflicts),
    ].join('. ');

    return Semantics(
      button: true,
      label: semantics,
      excludeSemantics: true,
      child: Padding(
        padding: const EdgeInsets.only(left: 4, right: 12),
        child: ConstrainedBox(
          constraints: BoxConstraints(
            maxWidth: small ? 190 : 340,
            minHeight: 40,
          ),
          child: Material(
            key: ValueKey('sync-chip-${kind.name}'),
            color: look.background,
            shape: StadiumBorder(
              side: BorderSide(
                color: look.border ?? Colors.transparent,
                width: 1.4,
              ),
            ),
            clipBehavior: Clip.antiAlias,
            child: InkWell(
              onTap: () => showSyncSheet(context),
              child: Padding(
                padding: const EdgeInsets.fromLTRB(12, 8, 12, 8),
                child: Row(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    if (look.busy)
                      SizedBox(
                        width: 16,
                        height: 16,
                        child: CircularProgressIndicator(
                          strokeWidth: 2.2,
                          color: look.foreground,
                        ),
                      )
                    else
                      Icon(look.icon, size: 18, color: look.foreground),
                    if (!iconOnly) ...[
                      const SizedBox(width: 8),
                      Flexible(
                        child: Text(
                          label,
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: text.labelMedium!.copyWith(
                            color: look.foreground,
                            fontWeight: FontWeight.w700,
                          ),
                        ),
                      ),
                    ],
                    if (v.conflicts > 0) ...[
                      const SizedBox(width: 8),
                      _Badge(count: v.conflicts),
                    ],
                  ],
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }
}

class _Badge extends StatelessWidget {
  const _Badge({required this.count});

  final int count;

  @override
  Widget build(BuildContext context) {
    return Container(
      key: const ValueKey('sync-chip-conflicts'),
      constraints: const BoxConstraints(minWidth: 22),
      height: 22,
      padding: const EdgeInsets.symmetric(horizontal: 6),
      alignment: Alignment.center,
      decoration: const BoxDecoration(
        color: SurauColors.danger,
        borderRadius: BorderRadius.all(Radius.circular(11)),
      ),
      child: Text(
        '$count',
        style: Theme.of(context).textTheme.labelSmall!
            .copyWith(color: Colors.white, fontWeight: FontWeight.w800),
      ),
    );
  }
}

// ---- the sheet ----

/// The chip's sheet; also opened by the dashboard's sync row.
Future<void> showSyncSheet(BuildContext context) async {
  final go = await showModalBottomSheet<String>(
    context: context,
    useSafeArea: true,
    isScrollControlled: true,
    constraints: const BoxConstraints(maxWidth: 520),
    builder: (context) => const SyncSheet(),
  );
  if (go != null && context.mounted) unawaited(context.push(go));
}

class SyncSheet extends ConsumerStatefulWidget {
  const SyncSheet({super.key});

  @override
  ConsumerState<SyncSheet> createState() => _SyncSheetState();
}

class _SyncSheetState extends ConsumerState<SyncSheet> {
  bool _busy = false;

  Future<void> _syncNow() async {
    final actions = ref.read(syncActionsProvider);
    if (actions == null) return;
    setState(() => _busy = true);
    final v = await actions.syncNow();
    if (!mounted) return;
    setState(() => _busy = false);
    if (v.state == SyncState.offline) {
      await showLiveOnlyDialog(context, action: S.of(context).syncNow);
    }
  }

  @override
  Widget build(BuildContext context) {
    final s = S.of(context);
    final text = Theme.of(context).textTheme;
    final deps = ref.watch(appDepsProvider);
    final v = ref.watch(syncViewProvider).value ?? SyncView.empty;
    final today = deps.toLocal(deps.now());
    final last = v.lastSync;
    final kind = chipKindOf(v);
    final error = syncErrorWords(s, v.lastError);

    final String connection = switch (kind) {
      SyncChipKind.offline => s.syncNoConnection,
      SyncChipKind.waking => s.syncWaking,
      _ => switch (v.via) {
        'cloud' => s.syncViaCloud,
        'box' => s.syncViaBox,
        _ => s.syncNoConnection,
      },
    };

    return SingleChildScrollView(
      padding: const EdgeInsets.fromLTRB(20, 4, 20, 24),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Row(
            children: [
              const Icon(Icons.sync_rounded, color: SurauColors.teal, size: 26),
              const SizedBox(width: 12),
              Expanded(child: Text(s.syncSheetTitle, style: text.titleLarge)),
              const SyncStatusChip(compact: true),
            ],
          ),
          if (kind == SyncChipKind.offline) ...[
            const SizedBox(height: 12),
            Text(
              s.syncOfflineHelp,
              style: text.bodyMedium!.copyWith(color: SurauColors.muted),
            ),
          ],
          const SizedBox(height: 16),
          Card(
            child: Column(
              children: [
                _SheetRow(label: s.syncConnection, value: connection),
                const Divider(),
                _SheetRow(
                  label: s.syncLastSync,
                  value: last == null
                      ? s.syncNever
                      : stampWords(deps.toLocal(last), today: today),
                ),
                const Divider(),
                _SheetRow(label: s.syncWaitingLabel, value: '${v.pendingOut}'),
                if (error != null) ...[
                  const Divider(),
                  _SheetRow(
                    label: s.syncErrorLabel,
                    value: error,
                    danger: true,
                  ),
                ],
              ],
            ),
          ),
          const SizedBox(height: 18),
          FilledButton.icon(
            onPressed: _busy ? null : _syncNow,
            icon: _busy
                ? const SizedBox(
                    width: 18,
                    height: 18,
                    child: CircularProgressIndicator(
                      strokeWidth: 2.2,
                      color: Colors.white,
                    ),
                  )
                : const Icon(Icons.sync_rounded),
            label: Text(s.syncNow),
          ),
          if (v.conflicts > 0) ...[
            const SizedBox(height: 10),
            OutlinedButton.icon(
              onPressed: () => Navigator.of(context).pop(conflictsRoute),
              style: OutlinedButton.styleFrom(
                foregroundColor: SurauColors.danger,
              ),
              icon: const Icon(Icons.report_gmailerrorred_rounded),
              label: Text('${s.syncSeeConflicts} (${v.conflicts})'),
            ),
          ],
        ],
      ),
    );
  }
}

class _SheetRow extends StatelessWidget {
  const _SheetRow({
    required this.label,
    required this.value,
    this.danger = false,
  });

  final String label;
  final String value;
  final bool danger;

  @override
  Widget build(BuildContext context) {
    final text = Theme.of(context).textTheme;
    return Padding(
      padding: const EdgeInsets.fromLTRB(18, 12, 18, 12),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Expanded(
            flex: 4,
            child: Text(
              label,
              style: text.bodyMedium!.copyWith(color: SurauColors.muted),
            ),
          ),
          const SizedBox(width: 12),
          Expanded(
            flex: 6,
            child: Text(
              value,
              textAlign: TextAlign.end,
              style: text.bodyLarge!.copyWith(
                fontWeight: FontWeight.w600,
                color: danger ? SurauColors.danger : SurauColors.text,
              ),
            ),
          ),
        ],
      ),
    );
  }
}

// ---- the dashboard row ----

/// `Penyelarasan` on the home page: the chip with the way the app is
/// connected and the last sync under it; a tap opens the sheet.
class SyncDashboardCard extends ConsumerWidget {
  const SyncDashboardCard({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    if (ref.watch(syncActionsProvider) == null) return const SizedBox.shrink();
    final s = S.of(context);
    final text = Theme.of(context).textTheme;
    final deps = ref.watch(appDepsProvider);
    final v = ref.watch(syncViewProvider).value ?? SyncView.empty;
    final last = v.lastSync;
    final via = switch (v.via) {
      'cloud' => s.syncViaCloud,
      'box' => s.syncViaBox,
      _ => null,
    };
    final when = last == null
        ? s.syncNever
        : stampWords(deps.toLocal(last), today: deps.toLocal(deps.now()));
    return Padding(
      padding: const EdgeInsets.only(top: 16),
      child: Card(
        key: const ValueKey('sync-dashboard'),
        child: InkWell(
          borderRadius: BorderRadius.circular(SurauTheme.radiusCard),
          onTap: () => showSyncSheet(context),
          child: Padding(
            padding: const EdgeInsets.fromLTRB(20, 16, 8, 16),
            child: Row(
              children: [
                const Icon(
                  Icons.sync_rounded,
                  color: SurauColors.teal,
                  size: 28,
                ),
                const SizedBox(width: 14),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(s.syncSheetTitle, style: text.titleMedium),
                      const SizedBox(height: 2),
                      Text(
                        [?via, '${s.syncLastSync} $when'].join('. '),
                        style: text.bodyMedium!.copyWith(
                          color: SurauColors.muted,
                        ),
                      ),
                    ],
                  ),
                ),
                const SyncStatusChip(compact: true),
              ],
            ),
          ),
        ),
      ),
    );
  }
}
