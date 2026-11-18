// Plan 14 Task 14: the pieces the fleet screens share: the status chip, the storage bar and the load states of a
// cloud read. Ops build only.

import 'package:flutter/material.dart';

import '../../app/shell.dart' show ShellPage;
import '../../app/theme.dart';
import '../../box/box_client.dart';
import '../../l10n/generated/s.dart';
import '../../screens/widgets/box_read.dart' show writeErrorText;
import '../../screens/widgets/pieces.dart' show StateChip;
import 'fleet_models.dart';
import 'fleet_texts.dart';

class SurauStateChip extends StatelessWidget {
  const SurauStateChip(this.state, {super.key});

  final SurauState state;

  @override
  Widget build(BuildContext context) {
    final (bg, fg) = switch (state) {
      SurauState.ok => (SurauColors.tealSoft, SurauColors.teal),
      SurauState.offline => (SurauColors.goldSoft, SurauColors.ink),
      SurauState.waiting => (SurauColors.goldSoft, SurauColors.ink),
      SurauState.suspended => (SurauColors.dangerSoft, SurauColors.dangerInk),
    };
    return StateChip(
      key: ValueKey('state-chip-${state.name}'),
      label: FleetT.of(context).stateLabel(state),
      background: bg,
      foreground: fg,
    );
  }
}

/// A surau nothing was ever put in: muted, like the state chips.
class EmptyChip extends StatelessWidget {
  const EmptyChip({super.key});

  @override
  Widget build(BuildContext context) => StateChip(
    label: FleetT.of(context).stateEmpty,
    background: SurauColors.paperDeep,
    foreground: SurauColors.muted,
  );
}

/// Storage in use against the limit: teal, yellow from 80 percent, red from 95.
class StorageBar extends StatelessWidget {
  const StorageBar({super.key, required this.used, required this.limit});

  final int used;
  final int limit;

  @override
  Widget build(BuildContext context) {
    final t = FleetT.of(context);
    final text = Theme.of(context).textTheme;
    final ratio = limit <= 0 ? 0.0 : used / limit;
    final colour = ratio >= storageDangerAt
        ? SurauColors.danger
        : ratio >= storageWarnAt
        ? const Color(0xFFC9951A)
        : SurauColors.teal;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Row(
          children: [
            Text(t.storage, style: text.bodySmall!.copyWith(color: SurauColors.muted)),
            const Spacer(),
            Text(
              '${bytesLabel(used)} / ${bytesLabel(limit)}',
              key: const ValueKey('storage-text'),
              style: text.bodySmall!.copyWith(color: SurauColors.muted),
            ),
          ],
        ),
        const SizedBox(height: 4),
        ClipRRect(
          borderRadius: BorderRadius.circular(4),
          child: LinearProgressIndicator(
            key: const ValueKey('storage-bar'),
            value: ratio.clamp(0.0, 1.0),
            minHeight: 6,
            color: colour,
            backgroundColor: SurauColors.paperDeep,
          ),
        ),
      ],
    );
  }
}

/// A calm failure with a retry, for a cloud read that did not answer.
class FleetError extends StatelessWidget {
  const FleetError({super.key, required this.message, required this.onRetry});

  final String message;
  final VoidCallback onRetry;

  @override
  Widget build(BuildContext context) {
    final s = S.of(context);
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 28),
      child: Column(
        children: [
          const Icon(Icons.cloud_off_rounded, size: 36, color: SurauColors.outline),
          const SizedBox(height: 12),
          Text(message, textAlign: TextAlign.center, style: Theme.of(context).textTheme.bodyLarge),
          const SizedBox(height: 12),
          OutlinedButton.icon(
            key: const ValueKey('fleet-retry'),
            onPressed: onRetry,
            icon: const Icon(Icons.refresh_rounded),
            label: Text(s.actionRetry),
          ),
        ],
      ),
    );
  }
}

/// What a failed fleet call means in the person's words: the app's own BM wording for the cloud's reason code, else
/// the server's message, else the app's general wording.
String fleetFailure(BuildContext context, Object error) {
  final t = FleetT.of(context);
  if (error is BoxError) {
    final known = t.refusal(error.code);
    if (known != null) return known;
    if (error.status != 403 && error.status != 429 && error.status != 401) return error.message;
  }
  return writeErrorText(S.of(context), error);
}

/// Kewangan, the upload queue and the sync pages work from the phone's own copy of one surau; while this phone acts
/// as MAXCOM they are closed and the guard sends the person here.
class LocalOnlyNotice extends StatelessWidget {
  const LocalOnlyNotice({super.key});

  @override
  Widget build(BuildContext context) {
    final t = FleetT.of(context);
    final text = Theme.of(context).textTheme;
    return ShellPage(
      title: t.localOnlyTitle,
      body: ListView(
        padding: SurauTheme.pagePadding,
        children: [
          const SizedBox(height: 12),
          Text(t.localOnlyTitle, key: const ValueKey('ops-local-only'), style: text.titleLarge),
          const SizedBox(height: 8),
          Text(t.localOnlyBody),
        ],
      ),
    );
  }
}
