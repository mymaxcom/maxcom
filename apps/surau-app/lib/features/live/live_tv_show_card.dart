// "Paparkan siaran langsung": one switch per box in Tetapan siaran (2026.11.15 build 5, mockup B1).
//
// Turning a box off keeps that box's TV on its normal display during a live; it does not touch the live itself.
// A pure widget: it holds no text of its own, every visible string arrives in [TvShowTexts], and it makes no
// network call. The screen builds the rows and saves a change in [LiveTvShowCard.onChanged].
//
// Keys: card `live-tv-show`, switch `live-tv-show-<tvId>`, badge `live-tv-show-server`, note `live-tv-show-all-off`.

import 'package:flutter/material.dart';

import '../../app/theme.dart';

/// One box of the card: the main box, then each follower that is not removed.
class TvShowRow {
  const TvShowRow({
    required this.tvId,
    required this.name,
    required this.kindLabel,
    required this.server,
    required this.show,
    this.cpuLine,
    this.busy = false,
  });

  /// `self` for the main box, the device id of a follower.
  final String tvId;
  final String name;

  /// The kind of device under the name ("Kotak TV Android", "PC mini Windows").
  final String kindLabel;

  /// This box serves the live to the others: it gets the badge and the CPU line.
  final bool server;

  /// The box's TV shows the live (the switch is on).
  final bool show;

  /// The finished CPU sentence of the server row; null when the box gives no figure.
  final String? cpuLine;

  /// A save of this row is in flight: its switch waits.
  final bool busy;
}

/// Every visible string of the card, finished by the caller.
class TvShowTexts {
  const TvShowTexts({
    required this.title,
    required this.hint,
    required this.serverBadge,
    required this.offLine,
    required this.allOffNote,
    required this.switchLabel,
  });

  final String title;
  final String hint;
  final String serverBadge;

  /// Under a row that is off ("Paparan biasa semasa siaran").
  final String offLine;

  /// One muted line when every row is off.
  final String allOffNote;

  /// The accessibility label of one switch.
  final String Function(String name) switchLabel;
}

class LiveTvShowCard extends StatelessWidget {
  const LiveTvShowCard({super.key, required this.rows, required this.texts, required this.onChanged});

  final List<TvShowRow> rows;
  final TvShowTexts texts;

  /// Null: the switches are disabled (no permission, or the box cannot be reached).
  final void Function(String tvId, bool show)? onChanged;

  @override
  Widget build(BuildContext context) {
    final text = Theme.of(context).textTheme;
    final allOff = rows.isNotEmpty && rows.every((r) => !r.show);
    final firstServer = rows.indexWhere((r) => r.server);
    final children = <Widget>[
      Padding(
        padding: const EdgeInsetsDirectional.fromSTEB(16, 14, 16, 12),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            const Padding(
              padding: EdgeInsets.only(top: 1),
              child: Icon(Icons.tv_rounded, color: SurauColors.teal),
            ),
            const SizedBox(width: 14),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(texts.title, style: text.titleMedium),
                  const SizedBox(height: 4),
                  Text(texts.hint, style: text.bodySmall!.copyWith(color: SurauColors.muted, height: 1.4)),
                ],
              ),
            ),
          ],
        ),
      ),
      for (var i = 0; i < rows.length; i++) ...[
        const Divider(height: 1),
        _TvRow(
          row: rows[i],
          texts: texts,
          onChanged: onChanged,
          badgeKey: i == firstServer ? const ValueKey('live-tv-show-server') : null,
        ),
      ],
      if (allOff) ...[
        const Divider(height: 1),
        Padding(
          key: const ValueKey('live-tv-show-all-off'),
          padding: const EdgeInsetsDirectional.fromSTEB(16, 10, 16, 12),
          child: Row(
            children: [
              const Icon(Icons.visibility_off_outlined, size: 18, color: SurauColors.muted),
              const SizedBox(width: 10),
              Expanded(child: Text(texts.allOffNote, style: text.bodySmall!.copyWith(color: SurauColors.muted))),
            ],
          ),
        ),
      ],
    ];
    return Card(
      key: const ValueKey('live-tv-show'),
      child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: children),
    );
  }
}

class _TvRow extends StatelessWidget {
  const _TvRow({required this.row, required this.texts, required this.onChanged, required this.badgeKey});

  final TvShowRow row;
  final TvShowTexts texts;
  final void Function(String tvId, bool show)? onChanged;
  final Key? badgeKey;

  @override
  Widget build(BuildContext context) {
    final text = Theme.of(context).textTheme;
    final enabled = onChanged != null && !row.busy;
    return ConstrainedBox(
      constraints: const BoxConstraints(minHeight: 68),
      child: Padding(
        padding: const EdgeInsetsDirectional.fromSTEB(16, 10, 8, 10),
        child: Row(
          children: [
            Container(
              width: 42,
              height: 42,
              decoration: BoxDecoration(color: SurauColors.tealSoft, borderRadius: BorderRadius.circular(12)),
              child: Icon(row.server ? Icons.dns_rounded : Icons.tv_rounded, color: SurauColors.teal, size: 22),
            ),
            const SizedBox(width: 12),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(row.name, style: text.titleSmall),
                  Text(row.kindLabel, style: text.bodySmall!.copyWith(color: SurauColors.muted)),
                  if (row.server)
                    Padding(
                      padding: const EdgeInsets.only(top: 5),
                      child: Align(
                        alignment: AlignmentDirectional.centerStart,
                        child: Container(
                          key: badgeKey,
                          padding: const EdgeInsetsDirectional.fromSTEB(7, 2, 9, 2),
                          decoration: BoxDecoration(color: SurauColors.tealSoft, borderRadius: BorderRadius.circular(999)),
                          child: Row(
                            mainAxisSize: MainAxisSize.min,
                            children: [
                              const Icon(Icons.dns_rounded, size: 13, color: SurauColors.teal),
                              const SizedBox(width: 5),
                              Flexible(
                                child: Text(
                                  texts.serverBadge,
                                  style: text.labelSmall!.copyWith(color: SurauColors.teal, fontWeight: FontWeight.w700),
                                ),
                              ),
                            ],
                          ),
                        ),
                      ),
                    ),
                  if (row.server && row.cpuLine != null)
                    Padding(
                      padding: const EdgeInsets.only(top: 4),
                      child: Text(row.cpuLine!, style: text.bodySmall!.copyWith(color: SurauColors.muted)),
                    ),
                  if (!row.show)
                    Padding(
                      padding: const EdgeInsets.only(top: 4),
                      child: Text(texts.offLine, style: text.bodySmall!.copyWith(color: SurauColors.text, fontWeight: FontWeight.w600)),
                    ),
                ],
              ),
            ),
            if (row.busy)
              const Padding(
                padding: EdgeInsetsDirectional.only(end: 8),
                child: SizedBox(width: 18, height: 18, child: CircularProgressIndicator(strokeWidth: 2.4)),
              ),
            Semantics(
              label: texts.switchLabel(row.name),
              toggled: row.show,
              child: Switch(
                key: ValueKey('live-tv-show-${row.tvId}'),
                value: row.show,
                onChanged: enabled ? (v) => onChanged!(row.tvId, v) : null,
              ),
            ),
          ],
        ),
      ),
    );
  }
}
