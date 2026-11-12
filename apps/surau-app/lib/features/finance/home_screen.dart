// Kewangan home: the total of every tabung, what came in and went out this
// month, the actions the person may take (four for `finance:write`, only
// the report for AJK), each tabung with its balance and whether the TV shows
// it, the sync card ("N catatan belum di skrin TV"), the corrections badge
// for the Pentadbir and the latest entries.

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../app/providers.dart';
import '../../app/router.dart';
import '../../app/shell.dart';
import '../../app/theme.dart';
import '../../finance/finance_models.dart';
import '../../finance/finance_repository.dart';
import '../../finance/ledger.dart';
import '../../l10n/generated/s.dart';
import '../../screens/widgets/pieces.dart';
import '../../sync/sync_providers.dart';
import '../sync/sync_actions.dart';
import '../sync/sync_status_chip.dart';
import 'entry_history_sheet.dart';
import 'finance_widgets.dart';

class FinanceHomeScreen extends ConsumerWidget {
  const FinanceHomeScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final s = S.of(context);
    final summaryAsync = ref.watch(financeSummaryProvider);
    final summary = summaryAsync.value;
    if (summary == null) {
      return ShellPage(
        title: s.navFinance,
        body: Center(
          child: summaryAsync.hasError
              ? Text(s.finUnavailable)
              : const CircularProgressIndicator(),
        ),
      );
    }
    final roles = ref.watch(rolesProvider);
    final canWrite = financeCanWrite(roles);
    final isAdmin = financeIsAdmin(roles);
    final lookups =
        ref.watch(financeLookupsProvider).value ?? const FinLookups();
    final entries =
        ref.watch(financeEntriesProvider).value ?? const <FinanceEntry>[];
    final deps = ref.watch(appDepsProvider);
    final today = deps.toLocal(deps.now());
    final corrected = <String>{
      for (final e in entries)
        if (e.kind == 'adjust' && e.correctsId != null) e.correctsId!,
    };
    final corrections = entries.where((e) => e.kind == 'adjust').toList();
    final latest = entries.take(7).toList();
    final todayText =
        '${today.day.toString().padLeft(2, '0')}/${today.month.toString().padLeft(2, '0')}/${today.year}';

    return ShellPage(
      title: s.navFinance,
      body: FinTwoColumnPage(
        top: [
          if (roles.contains('superadmin')) ...[
            FinInfoBox(
              key: const Key('fin-super-banner'),
              text: s.finSuperBanner,
              icon: Icons.shield_outlined,
              tone: FinTone.gold,
            ),
            const SizedBox(height: 12),
          ],
          if (!canWrite) ...[
            FinInfoBox(
              key: const Key('fin-view-only'),
              text: s.finViewOnly,
              icon: Icons.visibility_outlined,
            ),
            const SizedBox(height: 12),
          ],
        ],
        left: [
          FinHero(
            title: s.finTotalAll,
            value: formatRm(summary.totalSen),
            subtitle: s.finAsOf(todayText, summary.funds.length),
            io: [
              (s.finMonthIn, formatRm(summary.monthInSen)),
              (s.finMonthOut, formatRm(summary.monthOutSen)),
            ],
          ),
          const SizedBox(height: 14),
          _Actions(canWrite: canWrite),
          if (isAdmin) ...[
            const SizedBox(height: 10),
            OutlinedButton.icon(
              key: const Key('fin-action-tetapan'),
              onPressed: () => context.push(AppRoutes.financeFunds),
              icon: const Icon(Icons.tune_rounded),
              label: Text(s.finActionTetapan),
            ),
          ],
          const SizedBox(height: 18),
          SectionLabel(s.finFundsTitle),
          RowsCard(
            children: [
              for (final f in summary.funds)
                Padding(
                  padding: const EdgeInsets.symmetric(
                    horizontal: 16,
                    vertical: 12,
                  ),
                  child: Row(
                    children: [
                      Expanded(
                        child: Wrap(
                          spacing: 8,
                          runSpacing: 4,
                          crossAxisAlignment: WrapCrossAlignment.center,
                          children: [
                            Text(
                              f.fund.name,
                              style: Theme.of(context).textTheme.bodyMedium!
                                  .copyWith(fontWeight: FontWeight.w700),
                            ),
                            if (f.fund.public)
                              FinPill(s.finOnTv, icon: Icons.tv_rounded),
                          ],
                        ),
                      ),
                      const SizedBox(width: 12),
                      Text(
                        formatRm(f.balanceSen),
                        key: Key('fin-fund-balance-${f.fund.id}'),
                        style: Theme.of(context).textTheme.titleSmall!.copyWith(
                          fontWeight: FontWeight.w800,
                          color: f.balanceSen < 0 ? SurauColors.danger : null,
                          fontFeatures: const [FontFeature.tabularFigures()],
                        ),
                      ),
                    ],
                  ),
                ),
            ],
          ),
          const SizedBox(height: 18),
        ],
        right: [
          SectionLabel(s.finSyncTitle),
          _SyncCard(pending: summary.pendingCount),
          if (isAdmin && corrections.isNotEmpty) ...[
            const SizedBox(height: 18),
            Row(
              children: [
                Expanded(child: SectionLabel(s.finCorrectionsTitle)),
                if (summary.unseenCorrections > 0)
                  Padding(
                    padding: const EdgeInsets.only(bottom: 8),
                    child: Container(
                      key: const Key('fin-corrections-badge'),
                      padding: const EdgeInsets.symmetric(
                        horizontal: 10,
                        vertical: 3,
                      ),
                      decoration: BoxDecoration(
                        color: SurauColors.goldSoft,
                        borderRadius: BorderRadius.circular(
                          SurauTheme.radiusChip,
                        ),
                      ),
                      child: Text(
                        '${summary.unseenCorrections}',
                        style: Theme.of(context).textTheme.labelMedium!
                            .copyWith(
                              color: const Color(0xFF7A5D00),
                              fontWeight: FontWeight.w800,
                            ),
                      ),
                    ),
                  ),
              ],
            ),
            RowsCard(
              children: [
                for (final c in corrections.take(5))
                  _CorrectionRow(entry: c, lookups: lookups),
              ],
            ),
          ],
          const SizedBox(height: 18),
          SectionLabel(s.finRecent),
          if (latest.isEmpty)
            Padding(
              padding: const EdgeInsets.symmetric(vertical: 20),
              child: Text(
                s.finNoEntries,
                textAlign: TextAlign.center,
                style: Theme.of(context).textTheme.bodyLarge!
                    .copyWith(color: SurauColors.muted),
              ),
            )
          else
            RowsCard(
              children: [
                for (final e in latest)
                  FinEntryTile(
                    key: Key('fin-entry-${e.id}'),
                    entry: e,
                    lookups: lookups,
                    corrected: corrected.contains(e.id),
                    onTap: () => showEntryHistory(
                      context,
                      e.kind == 'adjust' ? (e.correctsId ?? e.id) : e.id,
                    ),
                  ),
              ],
            ),
          if (canWrite) ...[
            const SizedBox(height: 18),
            RowsCard(
              children: [
                ListTile(
                  key: const Key('fin-link-audit'),
                  leading: const Icon(Icons.history_rounded),
                  title: Text(s.finrAuditTitle),
                  trailing: const Icon(Icons.chevron_right_rounded),
                  onTap: () => context.push(AppRoutes.financeAudit),
                ),
                ListTile(
                  key: const Key('fin-link-setup'),
                  leading: const Icon(Icons.account_balance_wallet_outlined),
                  title: Text(s.finrSetupTitle),
                  trailing: const Icon(Icons.chevron_right_rounded),
                  onTap: () => context.push(AppRoutes.financeSetup),
                ),
              ],
            ),
          ],
        ],
      ),
    );
  }
}

class _Actions extends StatelessWidget {
  const _Actions({required this.canWrite});

  final bool canWrite;

  @override
  Widget build(BuildContext context) {
    final s = S.of(context);
    final tile = OutlinedButton.styleFrom(
      backgroundColor: SurauColors.card,
      foregroundColor: SurauColors.text,
      padding: const EdgeInsets.symmetric(horizontal: 2, vertical: 10),
      side: const BorderSide(color: SurauColors.line),
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(SurauTheme.radiusControl),
      ),
    );
    Widget action(
      Key key,
      IconData icon,
      String label,
      String route, {
      bool primary = false,
    }) {
      return Expanded(
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: 4),
          child: OutlinedButton(
            key: key,
            style: tile,
            onPressed: () => context.push(route),
            child: _ActionLabel(icon, label, primary: primary),
          ),
        ),
      );
    }

    if (!canWrite) {
      return Row(
        children: [
          action(
            const Key('fin-action-laporan'),
            Icons.receipt_long_outlined,
            s.finActionLaporanBulanan,
            AppRoutes.financeReport,
          ),
        ],
      );
    }
    return Row(
      children: [
        action(
          const Key('fin-action-kutipan'),
          Icons.south_rounded,
          s.finActionKutipan,
          AppRoutes.financeKutipan,
          primary: true,
        ),
        action(
          const Key('fin-action-bayaran'),
          Icons.north_rounded,
          s.finActionBayaran,
          AppRoutes.financeBayaran,
        ),
        action(
          const Key('fin-action-pembetulan'),
          Icons.swap_vert_rounded,
          s.finActionPembetulan,
          AppRoutes.financeCorrection,
        ),
        action(
          const Key('fin-action-laporan'),
          Icons.receipt_long_outlined,
          s.finActionLaporan,
          AppRoutes.financeReport,
        ),
      ],
    );
  }
}

class _ActionLabel extends StatelessWidget {
  const _ActionLabel(this.icon, this.label, {this.primary = false});

  final IconData icon;
  final String label;
  final bool primary;

  @override
  Widget build(BuildContext context) {
    return Column(
      mainAxisSize: MainAxisSize.min,
      children: [
        Container(
          width: 44,
          height: 44,
          decoration: BoxDecoration(
            color: primary ? SurauColors.gold : SurauColors.tealSoft,
            borderRadius: BorderRadius.circular(SurauTheme.radiusChip),
          ),
          child: Icon(
            icon,
            size: 22,
            color: primary ? SurauColors.ink : SurauColors.teal,
          ),
        ),
        const SizedBox(height: 6),
        // Never an ellipsis: a label wider than its tile shrinks to fit.
        FittedBox(
          fit: BoxFit.scaleDown,
          child: Text(
            label,
            maxLines: 1,
            softWrap: false,
            style: Theme.of(context).textTheme.labelMedium!
                .copyWith(fontSize: 13, fontWeight: FontWeight.w700),
          ),
        ),
      ],
    );
  }
}

class _CorrectionRow extends ConsumerWidget {
  const _CorrectionRow({required this.entry, required this.lookups});

  final FinanceEntry entry;
  final FinLookups lookups;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final s = S.of(context);
    final text = Theme.of(context).textTheme;
    final orig = lookups.refs[entry.correctsId] ?? '';
    return InkWell(
      onTap: () {
        ref.read(financeRepositoryProvider)?.markCorrectionsSeen();
        showEntryHistory(context, entry.correctsId ?? entry.id);
      },
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              s.finCorrectionLine(
                entry.refLabel,
                orig,
                lookups.fundName(entry.fundId),
              ),
              style: text.bodyLarge!.copyWith(fontWeight: FontWeight.w600),
            ),
            const SizedBox(height: 2),
            Text(
              entry.reason ?? '',
              maxLines: 2,
              overflow: TextOverflow.ellipsis,
              style: text.bodySmall!.copyWith(color: SurauColors.muted),
            ),
          ],
        ),
      ),
    );
  }
}

class _SyncCard extends ConsumerStatefulWidget {
  const _SyncCard({required this.pending});

  final int pending;

  @override
  ConsumerState<_SyncCard> createState() => _SyncCardState();
}

class _SyncCardState extends ConsumerState<_SyncCard> {
  bool _busy = false;

  Future<void> _syncNow() async {
    final actions = ref.read(syncActionsProvider);
    if (actions == null) return;
    setState(() => _busy = true);
    try {
      await actions.syncNow();
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final s = S.of(context);
    final text = Theme.of(context).textTheme;
    final deps = ref.watch(appDepsProvider);
    final view = ref.watch(syncViewProvider).value;
    final last = view?.lastSync;
    final pending = widget.pending;
    if (pending == 0) {
      return Card(
        child: Padding(
          padding: const EdgeInsets.all(16),
          child: Row(
            children: [
              const Icon(
                Icons.check_circle_outline_rounded,
                color: SurauColors.teal,
              ),
              const SizedBox(width: 12),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      last == null
                          ? s.syncSynced
                          : s.syncSyncedAt(clockOf(deps.toLocal(last))),
                      style: text.bodyLarge!.copyWith(
                        fontWeight: FontWeight.w700,
                      ),
                    ),
                    Text(
                      s.finAllOnTv,
                      style: text.bodySmall!.copyWith(color: SurauColors.muted),
                    ),
                  ],
                ),
              ),
            ],
          ),
        ),
      );
    }
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                const Icon(Icons.schedule_rounded, color: Color(0xFF8A5B00)),
                const SizedBox(width: 12),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        s.finPendingTv(pending),
                        key: const Key('fin-pending-tv'),
                        style: text.bodyLarge!.copyWith(
                          fontWeight: FontWeight.w700,
                        ),
                      ),
                      const SizedBox(height: 2),
                      Text(
                        s.finPendingHelp,
                        style: text.bodySmall!.copyWith(
                          color: SurauColors.muted,
                        ),
                      ),
                    ],
                  ),
                ),
              ],
            ),
            const SizedBox(height: 12),
            OutlinedButton.icon(
              key: const Key('fin-sync-now'),
              onPressed: _busy ? null : _syncNow,
              icon: const Icon(Icons.refresh_rounded),
              label: Text(s.syncNow),
            ),
          ],
        ),
      ),
    );
  }
}
