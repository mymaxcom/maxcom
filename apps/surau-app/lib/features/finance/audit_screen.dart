// Sejarah audit kewangan (mockup screen 7): every finance action, who made it
// on which device, when it was entered, when this MAXCOM and the cloud got it,
// and whether the device's signature held. Pentadbir and Bendahari only
// (`finance:write`). Rows a revoked device or a closed month refused show in
// red with the reason. The list is the box's own log; the app only reads it
// (the read cache keeps the last copy for when the box is away).
//
// Route: /finance/audit, `FinanceAuditScreen()`.

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../app/providers.dart';
import '../../app/shell.dart';
import '../../app/theme.dart';
import '../../finance/finance_repository.dart';
import '../../finance/ledger.dart';
import '../../l10n/generated/s.dart';
import '../../screens/widgets/box_read.dart' show writeErrorText;
import '../shell/permissions.dart';
import 'finance_box_api.dart';
import 'finance_widgets.dart' show FinTwoColumnPage, finTwoColumnMinWidth;
import 'report_a4.dart' show klStamp, monthNameMs;

/// Which chip a row belongs to.
enum AuditGroup { entryIn, entryOut, correction, settings, report, refused }

AuditGroup auditGroupOf(FinanceAuditRow r) {
  if (r.refused) return AuditGroup.refused;
  switch (r.entity) {
    case 'finance:entry':
      return switch (r.after?['kind']) {
        'out' => AuditGroup.entryOut,
        'adjust' => AuditGroup.correction,
        _ => AuditGroup.entryIn,
      };
    case 'finance:report':
      return AuditGroup.report;
    default:
      return AuditGroup.settings;
  }
}

class FinanceAuditScreen extends ConsumerStatefulWidget {
  const FinanceAuditScreen({super.key});

  @override
  ConsumerState<FinanceAuditScreen> createState() => _FinanceAuditScreenState();
}

class _FinanceAuditScreenState extends ConsumerState<FinanceAuditScreen> {
  Future<(FinanceAuditResult, Map<String, String>)>? _data;
  AuditGroup? _filter;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    _data ??= _load();
  }

  Future<(FinanceAuditResult, Map<String, String>)> _load() async {
    final api = ref.read(financeBoxApiProvider);
    if (api == null) throw StateError('locked');
    final result = await api.audit();
    final names = <String, String>{};
    final repo = ref.read(financeRepositoryProvider);
    if (repo != null) {
      for (final f in await repo.funds(includeArchived: true)) {
        names[f.id] = f.name;
      }
    }
    return (result, names);
  }

  @override
  Widget build(BuildContext context) {
    final s = S.of(context);
    final roles = ref.watch(rolesProvider);
    return ShellPage(
      title: s.finrAuditTitle,
      body: !canSee(roles, 'finance:write')
          ? SurauTheme.page(
              children: [
                Text(s.errorForbidden, key: const Key('finr-audit-forbidden')),
              ],
            )
          : FutureBuilder<(FinanceAuditResult, Map<String, String>)>(
              future: _data,
              builder: (context, snap) {
                if (snap.hasError) {
                  return SurauTheme.page(
                    children: [
                      Text(
                        writeErrorText(s, snap.error!),
                        key: const Key('finr-audit-failed'),
                      ),
                      const SizedBox(height: 12),
                      OutlinedButton.icon(
                        onPressed: () => setState(() => _data = _load()),
                        icon: const Icon(Icons.refresh_rounded),
                        label: Text(s.actionRetry),
                      ),
                    ],
                  );
                }
                final d = snap.data;
                if (d == null) {
                  return const Padding(
                    padding: EdgeInsets.all(24),
                    child: LinearProgressIndicator(minHeight: 2),
                  );
                }
                return _list(context, d.$1, d.$2);
              },
            ),
    );
  }

  Widget _list(
    BuildContext context,
    FinanceAuditResult result,
    Map<String, String> fundNames,
  ) {
    final s = S.of(context);
    final text = Theme.of(context).textTheme;
    final rows = [
      for (final r in result.rows)
        if (_filter == null || auditGroupOf(r) == _filter) r,
    ];
    final labels = {
      null: s.finrFilterAll,
      AuditGroup.entryIn: s.finrFilterIn,
      AuditGroup.entryOut: s.finrFilterOut,
      AuditGroup.correction: s.finrFilterCor,
      AuditGroup.settings: s.finrFilterSet,
      AuditGroup.report: s.finrFilterReport,
      AuditGroup.refused: s.finrFilterRefused,
    };
    return FinTwoColumnPage(
      left: [
        Text(
          s.finrAuditIntro,
          style: text.bodyMedium!.copyWith(color: SurauColors.muted),
        ),
        const SizedBox(height: 12),
        Wrap(
          spacing: 8,
          children: [
            for (final e in labels.entries)
              ChoiceChip(
                key: Key('finr-filter-${e.key?.name ?? 'all'}'),
                label: Text(e.value),
                selected: _filter == e.key,
                onSelected: (_) => setState(() => _filter = e.key),
              ),
          ],
        ),
        if (result.stale)
          Padding(
            padding: const EdgeInsets.only(top: 10),
            child: Text(
              s.finrAuditStale,
              key: const Key('finr-audit-stale'),
              style: text.bodyMedium!.copyWith(color: SurauColors.muted),
            ),
          ),
        const SizedBox(height: 12),
        if (rows.isEmpty)
          Padding(
            padding: const EdgeInsets.symmetric(vertical: 28),
            child: Text(
              s.finrAuditEmpty,
              key: const Key('finr-audit-empty'),
              textAlign: TextAlign.center,
              style: text.bodyLarge!.copyWith(color: SurauColors.muted),
            ),
          )
        else
          LayoutBuilder(
            builder: (context, constraints) {
              final table = constraints.maxWidth >= finTwoColumnMinWidth;
              return Card(
                clipBehavior: Clip.antiAlias,
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    if (table) const _AuditHeader(),
                    for (var i = 0; i < rows.length; i++) ...[
                      if (i > 0 || table) const Divider(),
                      if (table)
                        _AuditTableRow(
                          row: rows[i],
                          title: auditTitle(s, rows[i], fundNames),
                          amount: _amount(rows[i]),
                          onTap: () => _detail(context, rows[i], fundNames),
                        )
                      else
                        _AuditTile(
                          row: rows[i],
                          title: auditTitle(s, rows[i], fundNames),
                          amount: _amount(rows[i]),
                          onTap: () => _detail(context, rows[i], fundNames),
                        ),
                    ],
                  ],
                ),
              );
            },
          ),
      ],
    );
  }

  String? _amount(FinanceAuditRow r) {
    final a = r.after?['amountSen'];
    return r.entity == 'finance:entry' && a is int ? formatRm(a) : null;
  }

  void _detail(
    BuildContext context,
    FinanceAuditRow r,
    Map<String, String> fundNames,
  ) {
    showModalBottomSheet<void>(
      context: context,
      isScrollControlled: true,
      showDragHandle: true,
      builder: (_) => _AuditDetail(
        row: r,
        title: auditTitle(S.of(context), r, fundNames),
        amount: _amount(r),
      ),
    );
  }
}

/// The row's title in plain BM, without the person's counters, payee or
/// note (those stay in the ledger).
String auditTitle(S s, FinanceAuditRow r, Map<String, String> fundNames) {
  final a = r.after;
  String fund() => fundNames[a?['fundId']] ?? '';
  String ref() => (a?['refNo'] as String?) ?? '';
  switch (r.entity) {
    case 'finance:entry':
      final kind = a?['kind'];
      final name = fund();
      return switch (kind) {
        'out' => s.finrAuditOut(ref(), name),
        'adjust' => s.finrAuditCor(ref(), name),
        'opening' => s.finrAuditOpening(name),
        _ => s.finrAuditIn(ref(), name),
      };
    case 'finance:fund':
      return s.finrAuditFund((a?['name'] as String?) ?? '');
    case 'finance:perihal':
      return s.finrAuditPerihal((a?['label'] as String?) ?? '');
    case 'finance:month':
      final ym = r.entityId ?? '';
      return a?['status'] == 'closed'
          ? s.finrAuditMonthClosed(monthNameMs(ym))
          : s.finrAuditMonthOpened(monthNameMs(ym));
    case 'finance:report':
      final ym = (a?['ym'] as String?) ?? r.entityId ?? '';
      return a?['action'] == 'share'
          ? s.finrAuditReportShared(monthNameMs(ym))
          : s.finrAuditReportDownloaded(monthNameMs(ym));
    case 'finance:refused':
      return s.finrAuditRefused(refusalText(s, r.refusedDetail));
    default:
      return r.entity;
  }
}

/// The reason a signed op was refused, in words.
String refusalText(S s, String? detail) => switch (detail) {
  'device_revoked' => s.finrRefusedRevoked,
  'apply_finance_month_closed' => s.finrRefusedMonthClosed,
  'apply_finance_fund_archived' => s.finrRefusedFundArchived,
  _ => s.finrRefusedOther,
};

class _AuditTile extends StatelessWidget {
  const _AuditTile({
    required this.row,
    required this.title,
    required this.amount,
    required this.onTap,
  });

  final FinanceAuditRow row;
  final String title;
  final String? amount;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final s = S.of(context);
    final text = Theme.of(context).textTheme;
    final bad = row.refused;
    final waiting = !bad && row.syncedAt == null && row.origin != 'local';
    final who = row.userName ?? row.actor;
    final dot = bad
        ? SurauColors.danger
        : (waiting ? const Color(0xFFB07400) : SurauColors.teal);
    return InkWell(
      onTap: onTap,
      child: Padding(
        padding: const EdgeInsets.fromLTRB(16, 12, 16, 12),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Padding(
                  padding: const EdgeInsets.only(top: 6),
                  child: Icon(Icons.circle, size: 10, color: dot),
                ),
                const SizedBox(width: 10),
                Expanded(
                  child: Text(
                    title,
                    style: text.titleSmall!.copyWith(
                      color: bad ? SurauColors.danger : null,
                    ),
                  ),
                ),
                if (amount != null) ...[
                  const SizedBox(width: 8),
                  Text(
                    amount!,
                    style: text.titleSmall!.copyWith(
                      fontFeatures: const [FontFeature.tabularFigures()],
                    ),
                  ),
                ],
              ],
            ),
            Padding(
              padding: const EdgeInsets.only(left: 20, top: 2),
              child: Text(
                '$who, ${klStamp(row.editedAt)}',
                style: text.bodyMedium!.copyWith(color: SurauColors.muted),
              ),
            ),
            if (bad)
              Padding(
                padding: const EdgeInsets.only(left: 20, top: 2),
                child: Text(
                  refusalText(s, row.refusedDetail),
                  key: const Key('finr-audit-reason'),
                  style: text.bodyMedium!.copyWith(
                    color: SurauColors.danger,
                    fontWeight: FontWeight.w600,
                  ),
                ),
              ),
          ],
        ),
      ),
    );
  }
}

/// The column shares of the table an iPad held sideways shows.
const List<int> _auditColumns = [5, 3, 3, 3, 3, 3];

/// The short device id the detail sheet also shows.
String _deviceLabel(S s, FinanceAuditRow row) => row.deviceId == null
    ? s.finrNoDevice
    : (row.deviceId!.length > 8
          ? row.deviceId!.substring(0, 8)
          : row.deviceId!);

class _AuditHeader extends StatelessWidget {
  const _AuditHeader();

  @override
  Widget build(BuildContext context) {
    final s = S.of(context);
    final style = Theme.of(context).textTheme.labelSmall!
        .copyWith(color: SurauColors.muted, fontWeight: FontWeight.w700);
    final labels = [
      s.finrColAction,
      s.finrColWho,
      s.finrColDevice,
      s.finrColEntered,
      s.finrColReceived,
      s.finrColCloud,
    ];
    return Padding(
      padding: const EdgeInsets.fromLTRB(16, 12, 16, 10),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          for (var i = 0; i < labels.length; i++)
            Expanded(
              flex: _auditColumns[i],
              child: Padding(
                padding: const EdgeInsets.only(right: 10),
                child: Text(labels[i].toUpperCase(), style: style),
              ),
            ),
        ],
      ),
    );
  }
}

class _AuditTableRow extends StatelessWidget {
  const _AuditTableRow({
    required this.row,
    required this.title,
    required this.amount,
    required this.onTap,
  });

  final FinanceAuditRow row;
  final String title;
  final String? amount;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final s = S.of(context);
    final text = Theme.of(context).textTheme;
    final bad = row.refused;
    final cell = text.bodySmall!.copyWith(color: SurauColors.text);
    const waiting = Color(0xFF8A5A00);
    Widget time(String? iso) => iso == null || iso.isEmpty
        ? Text(
            s.finrNotYet,
            style: cell.copyWith(color: bad ? SurauColors.danger : waiting),
          )
        : Text(klStamp(iso), style: cell);
    final children = <Widget>[
      Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            title,
            style: text.bodyMedium!.copyWith(
              fontWeight: FontWeight.w700,
              color: bad ? SurauColors.danger : null,
            ),
          ),
          if (amount != null)
            Text(
              amount!,
              style: cell.copyWith(
                color: SurauColors.muted,
                fontFeatures: const [FontFeature.tabularFigures()],
              ),
            ),
        ],
      ),
      Text(row.userName ?? row.actor, style: cell),
      Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(_deviceLabel(s, row), style: cell),
          Text(
            bad ? refusalText(s, row.refusedDetail) : s.finrSigOk,
            key: bad ? const Key('finr-audit-reason') : null,
            style: cell.copyWith(
              color: bad ? SurauColors.danger : SurauColors.teal,
              fontWeight: FontWeight.w600,
            ),
          ),
        ],
      ),
      Text(klStamp(row.editedAt), style: cell),
      time(row.at),
      time(row.cloudReceivedAt),
    ];
    return InkWell(
      onTap: onTap,
      child: Padding(
        padding: const EdgeInsets.fromLTRB(16, 12, 16, 12),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            for (var i = 0; i < children.length; i++)
              Expanded(
                flex: _auditColumns[i],
                child: Padding(
                  padding: const EdgeInsets.only(right: 10),
                  child: children[i],
                ),
              ),
          ],
        ),
      ),
    );
  }
}

class _AuditDetail extends StatelessWidget {
  const _AuditDetail({
    required this.row,
    required this.title,
    required this.amount,
  });

  final FinanceAuditRow row;
  final String title;
  final String? amount;

  @override
  Widget build(BuildContext context) {
    final s = S.of(context);
    final text = Theme.of(context).textTheme;
    final bad = row.refused;
    String when(String? iso, String none) =>
        iso == null || iso.isEmpty ? none : klStamp(iso);
    final device = _deviceLabel(s, row);
    final cells = <(String, String, Color?)>[
      (s.finrColWho, row.userName ?? row.actor, null),
      (s.finrColDevice, device, null),
      (
        s.finrColSignature,
        bad ? refusalText(s, row.refusedDetail) : s.finrSigOk,
        bad ? SurauColors.danger : SurauColors.teal,
      ),
      (s.finrColEntered, when(row.editedAt, s.finrNotYet), null),
      (s.finrColReceived, when(row.at, s.finrNotYet), null),
      (s.finrColCloud, when(row.cloudReceivedAt, s.finrNotYet), null),
    ];
    final reason = row.after?['reason'];
    return SafeArea(
      child: Padding(
        padding: const EdgeInsets.fromLTRB(20, 0, 20, 20),
        child: SingleChildScrollView(
          child: Column(
            key: const Key('finr-audit-detail'),
            crossAxisAlignment: CrossAxisAlignment.stretch,
            mainAxisSize: MainAxisSize.min,
            children: [
              Text(title, style: text.titleLarge),
              if (amount != null)
                Text(
                  amount!,
                  style: text.titleMedium!.copyWith(color: SurauColors.muted),
                ),
              const SizedBox(height: 12),
              for (final c in cells)
                Padding(
                  padding: const EdgeInsets.symmetric(vertical: 5),
                  child: Row(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      SizedBox(
                        width: 130,
                        child: Text(
                          c.$1,
                          style: text.bodyMedium!.copyWith(
                            color: SurauColors.muted,
                          ),
                        ),
                      ),
                      Expanded(
                        child: Text(
                          c.$2,
                          style: text.bodyMedium!.copyWith(
                            color: c.$3,
                            fontWeight: c.$3 == null
                                ? FontWeight.w500
                                : FontWeight.w700,
                          ),
                        ),
                      ),
                    ],
                  ),
                ),
              if (reason is String && reason.isNotEmpty) ...[
                const SizedBox(height: 8),
                Text(s.finrDetailReason(reason), style: text.bodyMedium),
              ],
            ],
          ),
        ),
      ),
    );
  }
}
