// The backup lines of the main box's row on "Skrin TV dan MAXCOM Kiosk Box": the backup taken before the link with
// "Buang sandaran" and "Kembali ke data sebelum dipautkan" (only while no follower is linked), and the data kept
// after an unlink with "Buang data lama". Each action asks for a typed word and, with the app lock on, the PIN.

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../app/providers.dart';
import '../../app/theme.dart';
import '../../box/box_client.dart' show BoxUnreachable;
import '../../l10n/generated/s.dart';
import '../../screens/widgets/pieces.dart' show toast;
import '../common/ltr.dart';
import '../labels.dart' show appLangOf;
import '../screens/screens_data.dart';
import 'link_api.dart';
import 'link_backup.dart';
import 'link_backup_sheet.dart';
import 'link_controller.dart' show linkApiProvider;
import 'link_text.dart';

/// Runs one backup call and words nothing: the refusal code, or null when it was accepted. The list of screens is read
/// again after a success.
Future<String?> runBackupCall(WidgetRef ref, Future<void> Function(LinkApi api, String? pin) call, String? pin) async {
  final api = ref.read(linkApiProvider);
  if (api == null) return 'unreachable';
  try {
    await call(api, pin);
    ref.invalidate(screensDataProvider);
    return null;
  } on LinkRefusal catch (e) {
    return e.code;
  } on BoxUnreachable {
    return 'unreachable';
  }
}

/// "Buang data lama": the sheet with the typed word (and the PIN when the app lock is on) that drops the data this box
/// keeps after an unlink. [onDropped] runs after the box accepted it.
Future<void> showKeptDrop(BuildContext context, WidgetRef ref, LinkKept k, {VoidCallback? onDropped}) {
  final s = S.of(context);
  return showBackupSheet(
    context,
    title: s.backupKeptDropTitle,
    body: s.backupKeptDropBody(ltr(linkBytesWords(k.bytes))),
    word: s.backupWordDrop,
    action: s.backupKeptDrop,
    needsPin: ref.read(appLockProvider),
    submit: (pin) async {
      final code = await runBackupCall(ref, (api, p) => api.dropBackup(pin: p, linkId: k.linkId, kept: true), pin);
      if (code == null) {
        onDropped?.call();
        if (context.mounted) toast(context, s.backupKeptDroppedToast);
      }
      return code;
    },
  );
}

class BackupLines extends ConsumerWidget {
  const BackupLines({super.key, required this.backup, required this.kept, required this.followers});

  final LinkBackup? backup;
  final LinkKept? kept;
  final int followers;

  Future<String?> _run(WidgetRef ref, Future<void> Function(LinkApi api, String? pin) call, String? pin) =>
      runBackupCall(ref, call, pin);

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    if (backup == null && kept == null) return const SizedBox.shrink();
    final s = S.of(context);
    final text = Theme.of(context).textTheme;
    final deps = ref.watch(appDepsProvider);
    final lang = appLangOf(context);
    final needsPin = ref.watch(appLockProvider);
    final muted = text.bodyMedium!.copyWith(color: SurauColors.muted);

    final b = backup;
    final k = kept;
    final children = <Widget>[];
    if (b != null) {
      final when = deps.toLocal(b.at);
      children.add(
        Padding(
          padding: const EdgeInsets.only(top: 6),
          child: Text(
            s.backupLine(ltr(linkDateTimeWords(when, lang)), ltr(linkBytesWords(b.bytes))),
            key: const ValueKey('backup-line'),
            style: muted,
          ),
        ),
      );
      children.add(
        Wrap(
          children: [
            TextButton(
              key: const ValueKey('backup-drop'),
              onPressed: () => showBackupSheet(
                context,
                title: s.backupDropTitle,
                body: s.backupDropBody(ltr(linkDateWords(when, lang))),
                word: s.backupWordDrop,
                action: s.backupDrop,
                needsPin: needsPin,
                submit: (pin) async {
                  final code = await _run(ref, (api, p) => api.dropBackup(pin: p, linkId: b.linkId), pin);
                  if (code == null && context.mounted) toast(context, s.backupDroppedToast);
                  return code;
                },
              ),
              style: TextButton.styleFrom(foregroundColor: SurauColors.danger),
              child: Text(s.backupDrop),
            ),
            if (followers == 0)
              TextButton(
                key: const ValueKey('backup-restore'),
                onPressed: () => showBackupSheet(
                  context,
                  title: s.backupRestoreTitle,
                  body: s.backupRestoreBody(ltr(linkDateWords(when, lang))),
                  word: s.backupWordRestore,
                  action: s.backupRestore,
                  needsPin: needsPin,
                  submit: (pin) async {
                    final code = await _run(ref, (api, p) => api.restoreBackup(pin: p, linkId: b.linkId), pin);
                    if (code == null && context.mounted) toast(context, s.backupRestoredToast);
                    return code;
                  },
                ),
                style: TextButton.styleFrom(foregroundColor: SurauColors.danger),
                child: Text(s.backupRestore),
              ),
          ],
        ),
      );
    }
    if (k != null) {
      children.add(
        Padding(
          padding: const EdgeInsets.only(top: 6),
          child: Text(
            s.backupKeptLine(ltr(linkDateWords(deps.toLocal(k.until), lang))),
            key: const ValueKey('backup-kept-line'),
            style: muted,
          ),
        ),
      );
      children.add(
        Wrap(
          children: [
            TextButton(
              key: const ValueKey('backup-kept-drop'),
              onPressed: () => showKeptDrop(context, ref, k),
              style: TextButton.styleFrom(foregroundColor: SurauColors.danger),
              child: Text(s.backupKeptDrop),
            ),
          ],
        ),
      );
    }
    return Column(crossAxisAlignment: CrossAxisAlignment.start, children: children);
  }
}
