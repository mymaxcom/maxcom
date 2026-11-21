// "Simpan rakaman di peranti?" (2026.11.14): asked ONCE, only after the live's recording is one joined file and
// YouTube has confirmed it has the whole of the broadcast. Keep leaves the file for good; Delete lets the clean-up
// remove it now (it asks YouTube once more right before). Nothing is deleted without this answer. If YouTube has not
// confirmed, nothing is asked and the file stays (the live summary says so).

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../l10n/generated/s.dart';
import '../../upload/recording_cleanup.dart';
import 'cleanup_providers.dart';

/// The first recording that waits for the person's answer; null when none.
CleanupRecord? recordToAsk(Map<String, CleanupRecord>? records) {
  if (records == null) return null;
  for (final r in records.values) {
    if (r.needsAnswer) return r;
  }
  return null;
}

class KeepRecordingDialog extends StatelessWidget {
  const KeepRecordingDialog({super.key});

  @override
  Widget build(BuildContext context) {
    final s = S.of(context);
    return AlertDialog(
      key: const ValueKey('keep-recording'),
      title: Text(s.recKeepTitle),
      content: Text(s.recKeepBody),
      actions: [
        TextButton(
          key: const ValueKey('keep-recording-delete'),
          onPressed: () => Navigator.of(context, rootNavigator: true).pop(false),
          child: Text(s.recKeepDelete),
        ),
        FilledButton(
          key: const ValueKey('keep-recording-keep'),
          onPressed: () => Navigator.of(context, rootNavigator: true).pop(true),
          child: Text(s.recKeepKeep),
        ),
      ],
    );
  }
}

/// Asks about [record] and stores the answer. The dialog cannot be dismissed by a tap outside: no answer is a
/// kept file, and the question comes back next time.
Future<void> askKeepRecording(BuildContext context, WidgetRef ref, CleanupRecord record) async {
  final keep = await showDialog<bool>(
    context: context,
    barrierDismissible: false,
    builder: (_) => const KeepRecordingDialog(),
  );
  if (keep == null) return;
  final cleanup = ref.read(recordingCleanupProvider);
  await cleanup?.choose(record.sessionId, keep ? 'keep' : 'delete');
}
