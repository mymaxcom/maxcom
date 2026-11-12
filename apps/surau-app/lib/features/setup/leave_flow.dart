// "Keluar dari surau": this phone asks the box to cancel its own device, then
// wipes its key and local copy. The last Pentadbir phone is refused (the surau
// would be left with nobody). With the box away the phone can still forget
// itself; the device then stays active on the box until a Pentadbir cancels it.

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../app/providers.dart';
import '../../app/router.dart';
import '../../box/box_client.dart';
import '../../box/setup_client.dart';
import '../shell/box_gateway.dart' show OfflineWriteRefused;
import '../../sync/live_only.dart' show LiveOnly;
import '../../l10n/generated/s.dart';
import '../../screens/widgets/box_read.dart';
import '../../screens/widgets/pieces.dart';
import '../../sync/sync_providers.dart' show syncViewProvider;
import '../sync/sync_actions.dart';

/// Forgets the box on this phone: biometric seal, device key, session, local copy, the enrolment record.
Future<void> wipeThisDevice(WidgetRef ref) async {
  final deps = ref.read(appDepsProvider);
  await deps.biometric.clear();
  await deps.key.clear();
  ref.read(sessionProvider.notifier).clear();
  await ref.read(enrolledBoxProvider.notifier).forget();
}

/// The whole leave conversation. [onBusy] lets the caller grey its buttons while the box answers.
Future<void> startLeave(BuildContext context, WidgetRef ref, {void Function(bool busy)? onBusy}) async {
  final s = S.of(context);
  final surau = ref.read(surauInfoProvider)?.name ?? s.productName;

  // 1. confirm, with the unsynced warning and the chance to sync first
  final go = await showDialog<bool>(
    context: context,
    builder: (_) => _LeaveDialog(surau: surau),
  );
  if (go != true || !context.mounted) return;

  final gateway = ref.read(gatewayProvider);
  if (gateway == null) return;
  onBusy?.call(true);
  try {
    await SetupClient(gateway.client).leave(gateway);
  } on LastAdminDevice {
    onBusy?.call(false);
    if (!context.mounted) return;
    final enrolOther = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: Text(s.leaveLastAdminTitle),
        content: Text(s.leaveLastAdminBody),
        actions: [
          TextButton(onPressed: () => Navigator.of(context).pop(false), child: Text(s.actionClose)),
          FilledButton(
            key: const ValueKey('leave-enrol-other'),
            onPressed: () => Navigator.of(context).pop(true),
            child: Text(s.leaveEnrolOther),
          ),
        ],
      ),
    );
    if (enrolOther == true && context.mounted) context.go(AppRoutes.users);
    return;
  } on Object catch (e) {
    onBusy?.call(false);
    // The box did not answer (the gateway reports a refused write or a live-only action when it is away).
    final away = e is BoxUnreachable || e is OfflineWriteRefused || e is LiveOnly;
    if (!away) {
      if (context.mounted) toast(context, writeErrorText(s, e));
      return;
    }
    if (!context.mounted) return;
    final forgetOnly = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: Text(s.leaveTitle),
        content: Text(s.leaveOfflineBody),
        actions: [
          TextButton(onPressed: () => Navigator.of(context).pop(false), child: Text(s.actionCancel)),
          FilledButton(
            key: const ValueKey('leave-forget-only'),
            onPressed: () => Navigator.of(context).pop(true),
            child: Text(s.leaveForgetOnly),
          ),
        ],
      ),
    );
    if (forgetOnly == true) await wipeThisDevice(ref);
    return;
  }

  // 2. the box cancelled this device. The phone is wiped FIRST: if the app is closed or killed while the message is
  // up, no revoked key and no stale enrolment is left behind. Wiping sends the app back to the enrol page and may
  // unmount this screen, so the message goes on the root navigator, which outlives it.
  onBusy?.call(false);
  final root = context.mounted ? Navigator.of(context, rootNavigator: true).context : null;
  await wipeThisDevice(ref);
  // let the redirect to the enrol page land first, or it would take the message down with the page it sat on
  await WidgetsBinding.instance.endOfFrame;
  await WidgetsBinding.instance.endOfFrame;
  if (root != null && root.mounted) {
    await showDialog<void>(
      context: root,
      barrierDismissible: false,
      builder: (context) => AlertDialog(
        title: Text(s.leftTitle),
        content: Text(s.leftBody(surau)),
        actions: [
          FilledButton(
            key: const ValueKey('left-join-other'),
            onPressed: () => Navigator.of(context).pop(),
            child: Text(s.leftJoinOther),
          ),
        ],
      ),
    );
  }
}

class _LeaveDialog extends ConsumerWidget {
  const _LeaveDialog({required this.surau});

  final String surau;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final s = S.of(context);
    final pending = ref.watch(syncViewProvider).value?.pendingOut ?? 0;
    final actions = ref.watch(syncActionsProvider);
    return AlertDialog(
      title: Text(s.leaveTitle),
      content: ConstrainedBox(
        constraints: const BoxConstraints(maxWidth: 420),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(s.leaveBody(surau)),
            if (pending > 0) ...[
              const SizedBox(height: 12),
              Text(s.leaveUnsynced(pending), key: const ValueKey('leave-unsynced')),
              if (actions != null)
                TextButton(
                  key: const ValueKey('leave-sync-first'),
                  onPressed: () => actions.syncNow(),
                  child: Text(s.leaveSyncFirst),
                ),
            ],
          ],
        ),
      ),
      actions: [
        TextButton(onPressed: () => Navigator.of(context).pop(false), child: Text(s.actionCancel)),
        FilledButton(
          key: const ValueKey('leave-confirm'),
          onPressed: () => Navigator.of(context).pop(true),
          style: FilledButton.styleFrom(backgroundColor: Colors.red.shade700, foregroundColor: Colors.white),
          child: Text(s.leaveConfirm),
        ),
      ],
    );
  }
}
