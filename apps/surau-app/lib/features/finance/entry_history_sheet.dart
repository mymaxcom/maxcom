// One entry's history: the original as it was keyed in, every correction
// with its reason, and the value now. Everyone with `finance:read` sees who
// counted the cash; the photo row is for `finance:write` only (the feed
// never carries a photo for the others). Opened as a bottom sheet from the
// lists and as a page at `/finance/entry/:id`.

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../app/providers.dart';
import '../../app/shell.dart';
import '../../app/theme.dart';
import '../../finance/finance_models.dart';
import '../../finance/finance_repository.dart';
import '../../finance/ledger.dart';
import '../../l10n/generated/s.dart';
import '../../store/local_store.dart';
import 'finance_widgets.dart';

/// Where the correction screen lives (the router owns the route).
String financeCorrectionRoute([String? entryId]) => entryId == null
    ? '/finance/pembetulan'
    : '/finance/pembetulan?entry=$entryId';

Future<void> showEntryHistory(BuildContext context, String entryId) {
  return showModalBottomSheet<void>(
    context: context,
    isScrollControlled: true,
    showDragHandle: true,
    useSafeArea: true,
    constraints: const BoxConstraints(maxWidth: SurauTheme.contentMaxWidth),
    builder: (_) => DraggableScrollableSheet(
      expand: false,
      initialChildSize: 0.9,
      minChildSize: 0.5,
      maxChildSize: 0.95,
      builder: (context, controller) => EntryHistoryBody(
        entryId: entryId,
        controller: controller,
        onCorrect: () {
          Navigator.of(context).pop();
          context.push(financeCorrectionRoute(entryId));
        },
      ),
    ),
  );
}

/// The `/finance/entry/:id` page.
class EntryHistoryScreen extends StatelessWidget {
  const EntryHistoryScreen({super.key, required this.entryId});

  final String entryId;

  @override
  Widget build(BuildContext context) {
    final s = S.of(context);
    return ShellPage(
      title: s.finHistTitle,
      body: EntryHistoryBody(
        entryId: entryId,
        onCorrect: () => context.push(financeCorrectionRoute(entryId)),
      ),
    );
  }
}

final _entryDetailProvider = FutureProvider.autoDispose
    .family<EntryDetail?, String>((ref, id) async {
      ref.watch(financeSummaryProvider);
      final repo = ref.watch(financeRepositoryProvider);
      return repo?.entry(id);
    });

class EntryHistoryBody extends ConsumerWidget {
  const EntryHistoryBody({
    super.key,
    required this.entryId,
    required this.onCorrect,
    this.controller,
  });

  final String entryId;
  final VoidCallback onCorrect;
  final ScrollController? controller;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final s = S.of(context);
    final text = Theme.of(context).textTheme;
    final roles = ref.watch(rolesProvider);
    final canWrite = financeCanWrite(roles);
    final detail = ref.watch(_entryDetailProvider(entryId)).value;
    final lookups =
        ref.watch(financeLookupsProvider).value ?? const FinLookups();
    if (detail == null) {
      return ListView(
        controller: controller,
        padding: SurauTheme.pagePadding,
        children: [Text(s.finNoEntries)],
      );
    }
    final e = detail.entry;
    final isOut = e.kind == 'out';
    final cur = detail.effective.voided ? 0 : detail.effective.effAmountSen;
    final deps = ref.watch(appDepsProvider);

    String stamp(String iso) {
      final t = DateTime.tryParse(iso);
      if (t == null) return iso;
      final l = deps.toLocal(t);
      String two(int n) => n.toString().padLeft(2, '0');
      return '${two(l.day)}/${two(l.month)}/${l.year} ${two(l.hour)}:${two(l.minute)}';
    }

    List<(String, Widget)> who(FinanceEntry x) => [
      (
        s.finHistBy,
        FinUserName(
          x.createdBy,
          style: text.bodyMedium!.copyWith(fontWeight: FontWeight.w600),
        ),
      ),
      if ((x.deviceId ?? '').isNotEmpty)
        (s.finHistDevice, _DeviceName(x.deviceId!)),
      (
        s.finHistEntered,
        Text(
          stamp(x.editedAt),
          style: text.bodyMedium!.copyWith(fontWeight: FontWeight.w600),
        ),
      ),
    ];

    Widget rows(List<(String, Widget)> items) => Column(
      children: [
        for (final (k, v) in items)
          Padding(
            padding: const EdgeInsets.symmetric(vertical: 4),
            child: Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                SizedBox(
                  width: 110,
                  child: Text(
                    k,
                    style: text.bodySmall!.copyWith(color: SurauColors.muted),
                  ),
                ),
                Expanded(child: v),
              ],
            ),
          ),
      ],
    );

    final counters = e.counters ?? const <Counter>[];
    final originalRows = <(String, Widget)>[
      ...who(e),
      if (counters.isNotEmpty)
        (
          s.finCountedBy,
          Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              for (final c in counters)
                c.userId != null
                    ? FinUserName(
                        c.userId!,
                        style: text.bodyMedium!.copyWith(
                          fontWeight: FontWeight.w600,
                        ),
                      )
                    : Text(
                        c.name ?? '',
                        style: text.bodyMedium!.copyWith(
                          fontWeight: FontWeight.w600,
                        ),
                      ),
            ],
          ),
        ),
      if (canWrite && (e.photoId ?? '').isNotEmpty)
        (
          s.finPhoto,
          Row(
            key: const Key('fin-history-photo'),
            children: [
              const Icon(
                Icons.photo_outlined,
                size: 20,
                color: SurauColors.teal,
              ),
              const SizedBox(width: 8),
              Expanded(
                child: Text(
                  '${s.finHistPhoto}. ${s.finHistPhotoNote}',
                  style: text.bodyMedium,
                ),
              ),
            ],
          ),
        ),
    ];

    return ListView(
      controller: controller,
      padding: SurauTheme.pagePadding,
      children: [
        FinHero(
          title:
              '${e.refLabel} · ${lookups.fundName(detail.effective.effFundId)} · ${finDmy(e.entryDate)}',
          value: formatRm(cur),
          subtitle: detail.corrections.isEmpty
              ? finEntryTitle(s, e, lookups)
              : s.finHistAfter(
                  detail.corrections.length,
                  formatRm(e.amountSen),
                ),
        ),
        const SizedBox(height: 14),
        Card(
          child: Padding(
            padding: const EdgeInsets.all(16),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                Row(
                  children: [
                    Expanded(
                      child: Text(
                        s.finHistOriginal(finEntryTitle(s, e, lookups)),
                        style: text.titleSmall!.copyWith(
                          fontWeight: FontWeight.w700,
                        ),
                      ),
                    ),
                    Text(
                      isOut ? formatRm(e.amountSen) : formatRm(e.amountSen),
                      style: text.titleSmall!.copyWith(
                        fontWeight: FontWeight.w700,
                      ),
                    ),
                  ],
                ),
                const SizedBox(height: 8),
                rows(originalRows),
              ],
            ),
          ),
        ),
        for (final c in detail.corrections)
          Padding(
            padding: const EdgeInsets.only(top: 10),
            child: Card(
              color: const Color(0xFFFFFDF6),
              child: Padding(
                padding: const EdgeInsets.all(16),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    Row(
                      children: [
                        Expanded(
                          child: Text(
                            s.finHistCorrection(c.refLabel),
                            style: text.titleSmall!.copyWith(
                              fontWeight: FontWeight.w700,
                            ),
                          ),
                        ),
                        Text(
                          switch (c.correctionKind) {
                            'void' => s.finVoided,
                            'fund' => s.finFundChanged(
                              lookups.fundName(c.toFundId ?? ''),
                            ),
                            _ => formatRm(c.amountSen),
                          },
                          style: text.titleSmall!.copyWith(
                            color: const Color(0xFF7A5D00),
                            fontWeight: FontWeight.w700,
                          ),
                        ),
                      ],
                    ),
                    const SizedBox(height: 6),
                    Text('"${c.reason ?? ''}"', style: text.bodyMedium),
                    const SizedBox(height: 8),
                    rows(who(c)),
                  ],
                ),
              ),
            ),
          ),
        Padding(
          padding: const EdgeInsets.symmetric(vertical: 14),
          child: Text(
            s.finHistCurrent(formatRm(cur)),
            style: text.titleMedium!.copyWith(fontWeight: FontWeight.w700),
          ),
        ),
        FinInfoBox(text: s.finHistLocked, icon: Icons.lock_outline_rounded),
        if (canWrite) ...[
          const SizedBox(height: 14),
          OutlinedButton.icon(
            key: const Key('fin-history-correct'),
            onPressed: onCorrect,
            icon: const Icon(Icons.swap_vert_rounded),
            label: Text(s.finHistFixAgain),
          ),
        ],
      ],
    );
  }
}

class _DeviceName extends ConsumerWidget {
  const _DeviceName(this.id);

  final String id;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final name = ref
        .watch(financeNameProvider((collection: Collections.devices, id: id)))
        .value;
    return Text(
      name ?? id,
      style: Theme.of(context).textTheme.bodyMedium!
          .copyWith(fontWeight: FontWeight.w600),
    );
  }
}
