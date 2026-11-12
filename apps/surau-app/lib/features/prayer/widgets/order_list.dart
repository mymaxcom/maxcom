// The sources in the order the surau chose, with up and down buttons.

import 'package:flutter/material.dart';

import '../../../app/theme.dart';
import '../../../l10n/generated/s.dart';

class OrderEntry {
  const OrderEntry({required this.id, required this.title, required this.detail, this.note});

  final String id;
  final String title;
  final String detail;
  final String? note;
}

class OrderList extends StatelessWidget {
  const OrderList({super.key, required this.entries, this.onMove});

  final List<OrderEntry> entries;

  /// Moves the row at the index by the delta (-1 up, 1 down); null is
  /// read-only.
  final void Function(int index, int delta)? onMove;

  @override
  Widget build(BuildContext context) {
    final s = S.of(context);
    final text = Theme.of(context).textTheme;
    final move = onMove;
    return Card(
      child: Column(
        children: [
          for (var i = 0; i < entries.length; i++) ...[
            if (i > 0) const Divider(),
            Padding(
              key: ValueKey('order-row-${entries[i].id}'),
              padding: const EdgeInsets.fromLTRB(16, 12, 6, 12),
              child: Row(
                children: [
                  Container(
                    width: 30,
                    height: 30,
                    alignment: Alignment.center,
                    decoration: const BoxDecoration(color: SurauColors.tealSoft, shape: BoxShape.circle),
                    child: Text('${i + 1}', style: text.labelLarge!.copyWith(color: SurauColors.teal)),
                  ),
                  const SizedBox(width: 12),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(entries[i].title, style: text.titleSmall),
                        Text(entries[i].detail, style: text.bodyMedium),
                        if (entries[i].note != null) Text(entries[i].note!, style: text.bodySmall),
                      ],
                    ),
                  ),
                  IconButton(
                    key: ValueKey('order-up-${entries[i].id}'),
                    tooltip: s.srcMoveUp,
                    icon: const Icon(Icons.keyboard_arrow_up_rounded),
                    color: SurauColors.teal,
                    onPressed: move == null || i == 0 ? null : () => move(i, -1),
                  ),
                  IconButton(
                    key: ValueKey('order-down-${entries[i].id}'),
                    tooltip: s.srcMoveDown,
                    icon: const Icon(Icons.keyboard_arrow_down_rounded),
                    color: SurauColors.teal,
                    onPressed: move == null || i == entries.length - 1 ? null : () => move(i, 1),
                  ),
                ],
              ),
            ),
          ],
        ],
      ),
    );
  }
}
