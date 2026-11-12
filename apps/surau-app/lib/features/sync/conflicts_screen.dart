// Konflik (Plan 6 Task 9): every edit made on this device that did not land,
// one card each. What it was (`Pengumuman: Gotong-royong surau`), when the
// person made it and what they changed, then who won and when, or why the
// server refused it, in BM. An edit that lost to a later one can be sent
// again (`Guna versi saya semula`); any can be put away (`Buang`).

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../app/providers.dart';
import '../../app/shell.dart';
import '../../app/theme.dart';
import '../../content/kinds.dart';
import '../../l10n/generated/s.dart';
import '../../screens/widgets/pieces.dart';
import '../validate.dart' show featureByKey;
import 'sync_actions.dart';
import 'sync_status_chip.dart';

class ConflictsScreen extends ConsumerWidget {
  const ConflictsScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final s = S.of(context);
    final text = Theme.of(context).textTheme;
    final list = ref.watch(syncConflictsProvider);
    final items = list.value;

    final List<Widget> children;
    if (items == null) {
      children = [
        const Padding(
          padding: EdgeInsets.symmetric(vertical: 24),
          child: LinearProgressIndicator(minHeight: 2),
        ),
      ];
    } else if (items.isEmpty) {
      children = [
        const SizedBox(height: 48),
        Container(
          width: 76,
          height: 76,
          alignment: Alignment.center,
          decoration: const BoxDecoration(
            color: SurauColors.tealSoft,
            shape: BoxShape.circle,
          ),
          child: const Icon(
            Icons.task_alt_rounded,
            size: 40,
            color: SurauColors.teal,
          ),
        ),
        const SizedBox(height: 18),
        Text(
          s.conflictsEmpty,
          textAlign: TextAlign.center,
          style: text.titleLarge,
        ),
        const SizedBox(height: 6),
        Text(
          s.conflictsEmptyHint,
          textAlign: TextAlign.center,
          style: text.bodyLarge!.copyWith(color: SurauColors.muted),
        ),
      ];
    } else {
      children = [
        Text(
          s.conflictsIntro,
          style: text.bodyLarge!.copyWith(color: SurauColors.muted),
        ),
        const SizedBox(height: 16),
        for (final c in items) ...[
          ConflictCard(key: ValueKey('conflict-${c['opId']}'), conflict: c),
          const SizedBox(height: 14),
        ],
      ];
    }

    return ShellPage(
      title: s.conflictsTitle,
      body: SurauTheme.page(children: children),
    );
  }
}

/// `Pengumuman: <title>`, `Tetapan: Waktu iqamah` and so on.
String conflictEntityLabel(S s, Map<String, dynamic> c) {
  final entity = (c['entity'] as String?) ?? '';
  final id = (c['entityId'] as String?) ?? '';
  final mine = c['mine'];
  if (entity.startsWith('content:')) {
    final spec = contentKindByKey(entity.substring('content:'.length));
    final kind = spec?.labelMs ?? entity.substring('content:'.length);
    String? title;
    if (mine is Map) {
      for (final k in const [
        'title',
        'name',
        'label',
        'text',
        'city',
        'topic',
        'textMs',
      ]) {
        final v = mine[k];
        if (v is String && v.trim().isNotEmpty) {
          title = v.trim();
          break;
        }
      }
    }
    return '$kind: ${title ?? id}';
  }
  switch (entity) {
    case 'settings':
      return '${s.conflictEntitySettings}: ${featureByKey(id)?.labelMs ?? id}';
    case 'user':
      return '${s.conflictEntityUser}: $id';
    case 'device':
      return '${s.conflictEntityDevice}: $id';
    case 'asset':
      return s.conflictEntityAsset;
  }
  return '$entity: $id';
}

/// The refusal in BM, or null for an edit that lost to a later one.
String? conflictReasonWords(S s, String? reason) => switch (reason) {
  'superseded' => null,
  'forbidden' => s.conflictRefusedForbidden,
  'live_only' => s.conflictRefusedLiveOnly,
  'too_large' => s.conflictRefusedTooLarge,
  'invalid' => s.conflictRefusedInvalid,
  _ => s.conflictRefusedOther,
};

/// The fields of the person's edit as `label: value` lines, short.
List<(String, String)> conflictFieldLines(Map<String, dynamic> c) {
  final mine = c['mine'];
  if (mine is! Map) return const [];
  final entity = (c['entity'] as String?) ?? '';
  final spec = entity.startsWith('content:')
      ? contentKindByKey(entity.substring(8))
      : null;
  // Only content has field names a person knows; settings, users and
  // pictures are named by the card's title alone.
  if (spec == null) return const [];
  String show(Object? v) {
    final out = switch (v) {
      final List<Object?> l => l.join(', '),
      final Map<Object?, Object?> _ => '...',
      null => '',
      _ => '$v',
    };
    return out.length > 60 ? '${out.substring(0, 57)}...' : out;
  }

  return [
    for (final e in mine.entries)
      if (e.key is String &&
          !(e.key as String).startsWith('_') &&
          e.key != 'id')
        (
          spec.fieldOrNull(e.key as String)?.labelMs ?? e.key as String,
          show(e.value),
        ),
  ].take(6).toList();
}

class ConflictCard extends ConsumerStatefulWidget {
  const ConflictCard({super.key, required this.conflict});

  final Map<String, dynamic> conflict;

  @override
  ConsumerState<ConflictCard> createState() => _ConflictCardState();
}

class _ConflictCardState extends ConsumerState<ConflictCard> {
  bool _busy = false;

  Future<void> _act(
    Future<void> Function(SyncActions a) run, {
    String? done,
  }) async {
    final actions = ref.read(syncActionsProvider);
    if (actions == null) return;
    setState(() => _busy = true);
    try {
      await run(actions);
      ref.invalidate(syncConflictsProvider);
      if (mounted && done != null) toast(context, done);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  DateTime? _parse(Object? iso) =>
      iso is String ? DateTime.tryParse(iso) : null;

  @override
  Widget build(BuildContext context) {
    final s = S.of(context);
    final text = Theme.of(context).textTheme;
    final deps = ref.watch(appDepsProvider);
    final today = deps.toLocal(deps.now());
    final c = widget.conflict;
    String when(Object? iso) {
      final t = _parse(iso);
      return t == null ? '' : stampWords(deps.toLocal(t), today: today);
    }

    final reason = conflictReasonWords(s, c['reason'] as String?);
    final winner = c['winner'];
    final String verdict;
    if (reason != null) {
      verdict = reason;
    } else {
      final w = winner is Map ? winner : const <String, Object?>{};
      final name = (w['userName'] as String?) ?? s.conflictSomeoneElse;
      verdict = s.conflictWinner(name, when(w['editedAt']));
    }
    final lines = conflictFieldLines(c);
    final deleted = c['kind'] == 'content.delete';
    final mineAt = c['editedAt'] ?? c['at'];

    return Card(
      child: Padding(
        padding: const EdgeInsets.fromLTRB(20, 18, 20, 14),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Text(conflictEntityLabel(s, c), style: text.titleMedium),
            const SizedBox(height: 4),
            Text(
              s.conflictMine(when(mineAt)),
              style: text.bodyMedium!.copyWith(color: SurauColors.muted),
            ),
            if (deleted || lines.isNotEmpty) ...[
              const SizedBox(height: 10),
              Container(
                padding: const EdgeInsets.fromLTRB(14, 10, 14, 10),
                decoration: BoxDecoration(
                  color: SurauColors.paper,
                  borderRadius: BorderRadius.circular(SurauTheme.radiusControl),
                  border: const Border(
                    left: BorderSide(color: SurauColors.gold, width: 4),
                  ),
                ),
                child: deleted
                    ? Text(s.conflictDeleted, style: text.bodyMedium)
                    : Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          for (final (label, value) in lines)
                            Padding(
                              padding: const EdgeInsets.symmetric(vertical: 2),
                              child: Text.rich(
                                TextSpan(
                                  children: [
                                    TextSpan(
                                      text: '$label: ',
                                      style: text.bodyMedium!.copyWith(
                                        color: SurauColors.muted,
                                      ),
                                    ),
                                    TextSpan(
                                      text: value,
                                      style: text.bodyMedium,
                                    ),
                                  ],
                                ),
                              ),
                            ),
                        ],
                      ),
              ),
            ],
            const SizedBox(height: 12),
            Row(
              children: [
                Icon(
                  reason == null
                      ? Icons.how_to_reg_outlined
                      : Icons.block_rounded,
                  size: 20,
                  color: reason == null ? SurauColors.teal : SurauColors.danger,
                ),
                const SizedBox(width: 8),
                Expanded(
                  child: Text(
                    verdict,
                    style: text.bodyLarge!.copyWith(
                      fontWeight: FontWeight.w600,
                      color: reason == null
                          ? SurauColors.text
                          : SurauColors.danger,
                    ),
                  ),
                ),
              ],
            ),
            const SizedBox(height: 10),
            Wrap(
              alignment: WrapAlignment.end,
              spacing: 8,
              runSpacing: 4,
              children: [
                TextButton(
                  onPressed: _busy
                      ? null
                      : () => _act((a) => a.discard(c['opId'] as String)),
                  child: Text(s.conflictDiscard),
                ),
                if (canReapply(c))
                  FilledButton.tonal(
                    onPressed: _busy
                        ? null
                        : () => _act(
                            (a) => a.reapply(c),
                            done: s.conflictReapplied,
                          ),
                    child: Text(s.conflictReapply),
                  ),
              ],
            ),
          ],
        ),
      ),
    );
  }
}
