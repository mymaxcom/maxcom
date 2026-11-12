// The calm refusal for an action that cannot wait in the queue (Plan 6
// Task 9): `Perlukan sambungan`, which action it was, and one `Faham`.
// Shown when a live-only action is tapped with neither MAXCOM at the surau
// nor the cloud reachable, so nothing vanishes without the person knowing.

import 'package:flutter/material.dart';

import '../../app/theme.dart';
import '../../l10n/generated/s.dart';
import '../../sync/live_only.dart';

/// The BM label of the live-only action at [path] (any method), as
/// `live_only.dart` lists it; null when the path is not in the list.
String? liveOnlyLabelFor(String path) {
  final p = path.split('?').first;
  for (final e in liveOnlyList) {
    if (e.pattern.hasMatch(p)) return e.label;
  }
  return null;
}

/// Shows the dialog for [action] (already in words).
Future<void> showLiveOnlyDialog(
  BuildContext context, {
  required String action,
}) {
  return showDialog<void>(
    context: context,
    builder: (context) => LiveOnlyDialog(action: action),
  );
}

/// When [error] is a [LiveOnly], shows the dialog naming its action (or
/// [fallbackAction]) and answers true; otherwise false and nothing shown.
Future<bool> showLiveOnlyIf(
  BuildContext context,
  Object error, {
  String? fallbackAction,
}) async {
  if (error is! LiveOnly) return false;
  final action =
      liveOnlyLabelFor(error.path) ??
      fallbackAction ??
      S.of(context).liveOnlyNeedsConnection;
  await showLiveOnlyDialog(context, action: action);
  return true;
}

class LiveOnlyDialog extends StatelessWidget {
  const LiveOnlyDialog({super.key, required this.action});

  final String action;

  @override
  Widget build(BuildContext context) {
    final s = S.of(context);
    final text = Theme.of(context).textTheme;
    return AlertDialog(
      icon: Container(
        width: 56,
        height: 56,
        decoration: const BoxDecoration(
          color: SurauColors.paperDeep,
          shape: BoxShape.circle,
        ),
        child: const Icon(
          Icons.cloud_off_rounded,
          size: 30,
          color: SurauColors.teal,
        ),
      ),
      title: Text(s.liveOnlyTitle, textAlign: TextAlign.center),
      content: ConstrainedBox(
        constraints: const BoxConstraints(maxWidth: 420),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Container(
              padding: const EdgeInsets.fromLTRB(14, 10, 14, 10),
              decoration: BoxDecoration(
                color: SurauColors.goldSoft,
                borderRadius: BorderRadius.circular(SurauTheme.radiusControl),
              ),
              child: Text(
                action,
                key: const ValueKey('live-only-action'),
                textAlign: TextAlign.center,
                style: text.titleSmall!.copyWith(color: SurauColors.ink),
              ),
            ),
            const SizedBox(height: 14),
            Text(s.liveOnlyBody(action), style: text.bodyLarge),
          ],
        ),
      ),
      actionsAlignment: MainAxisAlignment.center,
      actionsPadding: const EdgeInsets.fromLTRB(20, 0, 20, 18),
      actions: [
        FilledButton(
          onPressed: () => Navigator.of(context).pop(),
          style: FilledButton.styleFrom(
            minimumSize: const Size(160, SurauTheme.minTapSize),
          ),
          child: Text(s.liveOnlyOk),
        ),
      ],
    );
  }
}
