// The kuliah picker of the payment screen: the lectures a penceramah may be
// paid for, grouped Malam ini / Belum dibayar / Dibayar, then the coming
// ones greyed and impossible to pick. A cancelled lecture carries a
// `Dibatalkan` chip.

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../app/theme.dart';
import '../../finance/finance_models.dart';
import '../../finance/finance_repository.dart';
import '../../l10n/generated/s.dart';
import '../../store/local_store.dart';
import 'finance_widgets.dart';

/// A lecture in the picker; [future] ones are shown but cannot be chosen.
class PickerKuliah {
  const PickerKuliah(this.kuliah, {this.future = false});

  final KuliahCandidate kuliah;
  final bool future;
}

/// Past and today's lectures from the repository, then up to five coming
/// ones (soonest first) read from the same local copy.
final financeKuliahProvider = FutureProvider.autoDispose<List<PickerKuliah>>((
  ref,
) async {
  ref.watch(financeSummaryProvider);
  final repo = ref.watch(financeRepositoryProvider);
  if (repo == null) return const [];
  final out = [for (final k in await repo.kuliahCandidates()) PickerKuliah(k)];
  final today = repo.todayKl;
  final coming = <KuliahCandidate>[];
  for (final k in await repo.store.list(Collections.content('kuliah'))) {
    if (k['_deleted'] == true) continue;
    final id = k['id'];
    final date = k['date'];
    if (id is! String || date is! String || date.compareTo(today) <= 0) {
      continue;
    }
    final pid = (k['penceramahId'] as String?) ?? '';
    final p = await repo.store.getDoc(Collections.content('penceramah'), pid);
    final topic = k['topic'];
    coming.add(
      KuliahCandidate(
        kuliahId: id,
        date: date,
        title: topic is String && topic.trim().isNotEmpty
            ? topic
            : (k['label'] as String?) ?? '',
        penceramahId: pid,
        penceramahName: (p?['name'] as String?) ?? '',
        paid: false,
        cancelled: k['status'] == 'batal',
        tonight: false,
      ),
    );
  }
  coming.sort((a, b) => a.date.compareTo(b.date));
  return [
    ...out,
    for (final k in coming.take(5)) PickerKuliah(k, future: true),
  ];
});

/// The button that shows the chosen lecture and opens the list.
class KuliahPickerField extends StatelessWidget {
  const KuliahPickerField({
    super.key,
    required this.items,
    required this.selected,
    required this.onPicked,
  });

  final List<PickerKuliah> items;
  final String? selected;
  final ValueChanged<KuliahCandidate> onPicked;

  @override
  Widget build(BuildContext context) {
    final s = S.of(context);
    final text = Theme.of(context).textTheme;
    final current = items
        .where((i) => i.kuliah.kuliahId == selected)
        .map((i) => i.kuliah)
        .firstOrNull;
    return InkWell(
      key: const Key('fin-kuliah-field'),
      borderRadius: BorderRadius.circular(SurauTheme.radiusControl),
      onTap: () async {
        final picked = await showModalBottomSheet<KuliahCandidate>(
          context: context,
          isScrollControlled: true,
          showDragHandle: true,
          useSafeArea: true,
          constraints: const BoxConstraints(
            maxWidth: SurauTheme.contentMaxWidth,
          ),
          builder: (_) => KuliahPickerSheet(items: items, selected: selected),
        );
        if (picked != null) onPicked(picked);
      },
      child: InputDecorator(
        decoration: const InputDecoration(
          prefixIcon: Icon(Icons.event_outlined),
          suffixIcon: Icon(Icons.expand_more_rounded),
        ),
        child: current == null
            ? Text(
                s.finKuliahPick,
                style: text.bodyLarge!.copyWith(color: SurauColors.muted),
              )
            : Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    current.title,
                    maxLines: 2,
                    overflow: TextOverflow.ellipsis,
                    style: text.bodyLarge!.copyWith(
                      fontWeight: FontWeight.w700,
                    ),
                  ),
                  Text(
                    finDmy(current.date),
                    style: text.bodySmall!.copyWith(color: SurauColors.muted),
                  ),
                ],
              ),
      ),
    );
  }
}

class KuliahPickerSheet extends StatelessWidget {
  const KuliahPickerSheet({super.key, required this.items, this.selected});

  final List<PickerKuliah> items;
  final String? selected;

  @override
  Widget build(BuildContext context) {
    final s = S.of(context);
    final text = Theme.of(context).textTheme;
    final groups = <(String, List<PickerKuliah>)>[
      (
        s.finKuliahTonight,
        [
          for (final i in items)
            if (!i.future && i.kuliah.tonight && !i.kuliah.paid) i,
        ],
      ),
      (
        s.finKuliahDue,
        [
          for (final i in items)
            if (!i.future && !i.kuliah.tonight && !i.kuliah.paid) i,
        ],
      ),
      (
        s.finKuliahPaid,
        [
          for (final i in items)
            if (!i.future && i.kuliah.paid) i,
        ],
      ),
      (
        s.finKuliahFuture,
        [
          for (final i in items)
            if (i.future) i,
        ],
      ),
    ];
    final any = groups.any((g) => g.$2.isNotEmpty);
    return ListView(
      key: const Key('fin-kuliah-sheet'),
      shrinkWrap: true,
      padding: const EdgeInsets.fromLTRB(16, 0, 16, 24),
      children: [
        if (!any)
          Padding(
            padding: const EdgeInsets.all(20),
            child: Text(s.finKuliahNone, textAlign: TextAlign.center),
          ),
        for (final (title, list) in groups)
          if (list.isNotEmpty) ...[
            Padding(
              padding: const EdgeInsets.fromLTRB(4, 14, 4, 6),
              child: Text(
                title,
                style: text.titleSmall!.copyWith(color: SurauColors.muted),
              ),
            ),
            for (final i in list)
              ListTile(
                key: Key('fin-kuliah-${i.kuliah.kuliahId}'),
                enabled: !i.future,
                selected: i.kuliah.kuliahId == selected,
                selectedTileColor: SurauColors.tealSoft,
                shape: RoundedRectangleBorder(
                  borderRadius: BorderRadius.circular(SurauTheme.radiusControl),
                ),
                title: Text(
                  i.kuliah.title,
                  maxLines: 2,
                  overflow: TextOverflow.ellipsis,
                  style: text.bodyLarge!.copyWith(
                    fontWeight: FontWeight.w600,
                    color: i.future ? SurauColors.outline : null,
                  ),
                ),
                subtitle: Text(
                  [
                    finDmy(i.kuliah.date),
                    i.kuliah.penceramahName,
                  ].where((p) => p.isNotEmpty).join(', '),
                ),
                trailing: i.kuliah.cancelled
                    ? FinPill(s.finKuliahCancelled, danger: true)
                    : null,
                onTap: i.future
                    ? null
                    : () => Navigator.of(context).pop(i.kuliah),
              ),
          ],
      ],
    );
  }
}
