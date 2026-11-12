// Laporan bulanan (mockup screen 6): month chips, a status card (Draf sedia,
// Bulan belum tamat, Muktamad), the report drawn as an A4 sheet from the
// local ledger (works offline), and for those who may write: Muat turun PDF,
// Kongsi (warning sheet first, the audit note only when the system says the
// file was really sent), Cetak, Tutup bulan (Muktamad), and for the
// Pentadbir the audited reopen. An AJK reads the report and gets no file.
//
// Route: /finance/laporan, `ReportScreen({initialYm})`.

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../app/providers.dart';
import '../../app/shell.dart';
import '../../app/theme.dart';
import '../../finance/finance_models.dart';
import '../../finance/finance_repository.dart';
import '../../l10n/generated/s.dart';
import '../../screens/widgets/box_read.dart' show writeErrorText;
import '../shell/permissions.dart';
import '../common/surau_info.dart' show SurauInfo;
import 'finance_box_api.dart';
import 'finance_widgets.dart' show FinTwoColumnPage;
import 'report_a4.dart';
import 'share.dart' show ShareResult;
import 'share_sheet.dart';
import '../shell/box_gateway.dart' show LiveOnly;

class _ReportData {
  const _ReportData({
    required this.report,
    required this.month,
    required this.pending,
    required this.earlierOpen,
    required this.known,
  });

  final MonthReport report;
  final MonthState? month;
  final int pending;

  /// Months before this one with entries that are not Muktamad yet.
  final List<String> earlierOpen;

  /// Months a person may pick (entries, or Muktamad, or the current one).
  final List<String> known;

  bool get closed => month?.closed ?? false;
}

class ReportScreen extends ConsumerStatefulWidget {
  const ReportScreen({super.key, this.initialYm});

  /// `YYYY-MM`; the current month when null.
  final String? initialYm;

  @override
  ConsumerState<ReportScreen> createState() => _ReportScreenState();
}

class _ReportScreenState extends ConsumerState<ReportScreen> {
  String? _ym;
  bool _full = false;
  bool _busy = false;
  String? _error;
  Future<_ReportData>? _data;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    _data ??= _load();
  }

  String _currentYm(FinanceRepository repo) => repo.todayKl.substring(0, 7);

  String _previousYm(String ym) {
    var y = int.parse(ym.substring(0, 4));
    var m = int.parse(ym.substring(5, 7)) - 1;
    if (m == 0) {
      m = 12;
      y -= 1;
    }
    return '$y-${m.toString().padLeft(2, '0')}';
  }

  Future<_ReportData> _load() async {
    final repo = ref.read(financeRepositoryProvider);
    if (repo == null) throw StateError('locked');
    final cur = _currentYm(repo);
    final ym = _ym ?? widget.initialYm ?? cur;
    _ym = ym;
    final report = await repo.report(ym);
    final months = await repo.months();
    MonthState? month;
    for (final m in months) {
      if (m.ym == ym) month = m;
    }
    final entries = await repo.entries();
    final withEntries = <String>{
      for (final e in entries)
        if (e.entryDate.length >= 7) e.entryDate.substring(0, 7),
    };
    final closed = {
      for (final m in months)
        if (m.closed) m.ym,
    };
    final known = {...withEntries, ...closed, cur}.toList()
      ..sort((a, b) => b.compareTo(a));
    final earlierOpen = [
      for (final m in withEntries)
        if (m.compareTo(ym) < 0 && !closed.contains(m)) m,
    ]..sort();
    return _ReportData(
      report: report,
      month: month,
      pending: await repo.pendingFinanceCount(),
      earlierOpen: earlierOpen,
      known: known,
    );
  }

  void _reload({String? ym}) {
    setState(() {
      if (ym != null) _ym = ym;
      _error = null;
      _data = _load();
    });
  }

  @override
  Widget build(BuildContext context) {
    final s = S.of(context);
    final repo = ref.watch(financeRepositoryProvider);
    return ShellPage(
      title: s.finrReportTitle,
      body: repo == null
          ? const SizedBox.shrink()
          : FutureBuilder<_ReportData>(
              future: _data,
              builder: (context, snap) {
                if (snap.hasError) {
                  return SurauTheme.page(
                    children: [
                      Text(s.loadFailed, key: const Key('finr-report-failed')),
                      const SizedBox(height: 12),
                      OutlinedButton.icon(
                        onPressed: _reload,
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
                return _body(context, repo, d);
              },
            ),
    );
  }

  Widget _body(BuildContext context, FinanceRepository repo, _ReportData d) {
    final s = S.of(context);
    final text = Theme.of(context).textTheme;
    final roles = ref.watch(rolesProvider);
    final canWrite = canSee(roles, 'finance:write');
    final isAdmin = canSee(roles, 'settings:write');
    final info = ref.watch(surauInfoProvider);
    final ym = _ym!;
    final cur = _currentYm(repo);
    final isCurrent = ym == cur;
    final monthName = monthNameMs(ym);
    final last = _previousYm(cur);
    final today = repo.todayKl;

    Widget chip(String label, String value) => ChoiceChip(
      key: Key('finr-month-$value'),
      label: Text(label),
      selected: ym == value,
      onSelected: (_) => _reload(ym: value),
    );

    final chips = Wrap(
      spacing: 8,
      runSpacing: 8,
      children: [
        chip(s.finrMonthThis, cur),
        chip(s.finrMonthLast, last),
        ActionChip(
          key: const Key('finr-month-pick'),
          label: Text(s.finrMonthPick),
          avatar: ym != cur && ym != last
              ? const Icon(Icons.check_rounded, size: 18)
              : null,
          onPressed: () => _pickMonth(d),
        ),
      ],
    );
    final top = <Widget>[
      chips,
      const SizedBox(height: 12),
      _statusCard(s, text, d, isCurrent, today, monthName),
      const SizedBox(height: 12),
      if (d.pending > 0)
        Padding(
          padding: const EdgeInsets.only(bottom: 12),
          child: Text(
            s.finrPendingNote(d.pending),
            key: const Key('finr-pending-note'),
            style: text.bodyMedium!.copyWith(color: SurauColors.muted),
          ),
        ),
    ];
    final sheet = <Widget>[
      _preview(info, d),
      const SizedBox(height: 8),
      SwitchListTile(
        key: const Key('finr-full-page'),
        contentPadding: EdgeInsets.zero,
        title: Text(s.finrFullPage),
        value: _full,
        onChanged: (v) => setState(() => _full = v),
      ),
    ];
    final actions = <Widget>[
      if (_error != null) ...[
        const SizedBox(height: 8),
        Container(
          padding: const EdgeInsets.fromLTRB(14, 12, 14, 12),
          decoration: BoxDecoration(
            color: SurauColors.dangerSoft,
            borderRadius: BorderRadius.circular(SurauTheme.radiusControl),
          ),
          child: Text(
            _error!,
            key: const Key('finr-report-error'),
            style: text.bodyMedium!.copyWith(color: SurauColors.dangerInk),
          ),
        ),
      ],
      if (canWrite) ...[
        const SizedBox(height: 12),
        FilledButton.icon(
          key: const Key('finr-download'),
          onPressed: _busy ? null : () => _download(info, ym),
          icon: const Icon(Icons.download_rounded),
          label: Text(s.finrDownloadPdf),
        ),
        const SizedBox(height: 10),
        Row(
          children: [
            Expanded(
              child: OutlinedButton.icon(
                key: const Key('finr-share'),
                onPressed: _busy ? null : () => _share(info, ym),
                icon: const Icon(Icons.share_rounded),
                label: Text(s.finrShare),
              ),
            ),
            const SizedBox(width: 10),
            Expanded(
              child: OutlinedButton.icon(
                key: const Key('finr-print'),
                onPressed: _busy ? null : () => _print(info, ym),
                icon: const Icon(Icons.print_rounded),
                label: Text(s.finrPrint),
              ),
            ),
          ],
        ),
        if (!d.closed && ym.compareTo(cur) < 0) ...[
          const SizedBox(height: 10),
          OutlinedButton.icon(
            key: const Key('finr-close-month'),
            onPressed: _busy || d.earlierOpen.isNotEmpty
                ? null
                : () => _closeMonth(ym),
            icon: const Icon(Icons.lock_outline_rounded),
            label: Text(s.finrCloseMonth),
          ),
          if (d.earlierOpen.isNotEmpty)
            Padding(
              padding: const EdgeInsets.only(top: 6),
              child: Text(
                s.finrCloseOrder(monthNameMs(d.earlierOpen.first)),
                key: const Key('finr-close-order'),
                style: text.bodyMedium!.copyWith(color: SurauColors.muted),
              ),
            ),
        ],
      ],
      if (d.closed && isAdmin) ...[
        const SizedBox(height: 10),
        OutlinedButton.icon(
          key: const Key('finr-reopen'),
          onPressed: _busy ? null : () => _reopen(ym),
          icon: const Icon(Icons.lock_open_rounded),
          label: Text(s.finrReopenMonth),
        ),
      ],
    ];
    return FinTwoColumnPage(
      leftFlex: 3,
      rightFlex: 2,
      left: [
        Material(
          color: SurauColors.paperDeep,
          borderRadius: BorderRadius.circular(SurauTheme.radiusCard),
          child: Padding(
            padding: const EdgeInsets.fromLTRB(14, 14, 14, 6),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: sheet,
            ),
          ),
        ),
      ],
      right: [...top, ...actions],
      narrow: [...top, ...sheet, ...actions],
    );
  }

  Widget _statusCard(
    S s,
    TextTheme text,
    _ReportData d,
    bool isCurrent,
    String today,
    String monthName,
  ) {
    final (String title, String sub, Color tone, IconData icon) = d.closed
        ? (
            s.finrStatusClosed,
            s.finrStatusClosedSub(
              d.month?.closedAt == null ? '' : dmy(_dateOf(d.month!.closedAt!)),
            ),
            SurauColors.teal,
            Icons.lock_rounded,
          )
        : isCurrent
        ? (
            s.finrStatusOpenMonth,
            s.finrStatusOpenMonthSub(dmy(today)),
            const Color(0xFF8A5A00),
            Icons.warning_amber_rounded,
          )
        : (
            s.finrStatusReady,
            d.pending > 0 ? s.finrStatusReadyPending : s.finrStatusReadySub,
            SurauColors.teal,
            Icons.check_circle_rounded,
          );
    return Card(
      key: const Key('finr-status'),
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Row(
          children: [
            Icon(icon, color: tone),
            const SizedBox(width: 12),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(title, style: text.titleMedium),
                  const SizedBox(height: 2),
                  Text(
                    sub,
                    style: text.bodyMedium!.copyWith(color: SurauColors.muted),
                  ),
                ],
              ),
            ),
            Container(
              padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
              decoration: BoxDecoration(
                color: d.closed ? SurauColors.tealSoft : SurauColors.goldSoft,
                borderRadius: BorderRadius.circular(SurauTheme.radiusChip),
              ),
              child: Text(
                d.closed ? s.finrPillFinal : s.finrPillDraft,
                style: text.labelMedium,
              ),
            ),
          ],
        ),
      ),
    );
  }

  String _dateOf(String iso) {
    final t = DateTime.tryParse(iso);
    if (t == null) return iso.length >= 10 ? iso.substring(0, 10) : iso;
    final k = t.toUtc().add(const Duration(hours: 8));
    String p(int n) => n.toString().padLeft(2, '0');
    return '${k.year}-${p(k.month)}-${p(k.day)}';
  }

  Widget _preview(SurauInfo? info, _ReportData d) {
    final name = info?.name ?? 'MAXCOM';
    final addr = info?.shortAddress;
    return Container(
      decoration: BoxDecoration(
        border: Border.all(color: SurauColors.line),
        boxShadow: const [
          BoxShadow(
            color: Color(0x14000000),
            blurRadius: 8,
            offset: Offset(0, 2),
          ),
        ],
      ),
      child: FittedBox(
        fit: BoxFit.fitWidth,
        alignment: Alignment.topCenter,
        child: ReportA4(
          report: d.report,
          surauName: name,
          shortAddress: addr,
          closedAt: d.month?.closedAt,
          fullPage: _full,
        ),
      ),
    );
  }

  Future<void> _pickMonth(_ReportData d) async {
    final s = S.of(context);
    final pick = await showModalBottomSheet<String>(
      context: context,
      showDragHandle: true,
      builder: (context) => SafeArea(
        child: ListView(
          shrinkWrap: true,
          children: [
            for (final m in d.known)
              ListTile(
                key: Key('finr-pick-$m'),
                title: Text(monthNameMs(m)),
                trailing: m == _ym ? const Icon(Icons.check_rounded) : null,
                onTap: () => Navigator.of(context).pop(m),
              ),
            if (d.known.isEmpty) ListTile(title: Text(s.finrNoMonths)),
          ],
        ),
      ),
    );
    if (pick != null && pick != _ym) _reload(ym: pick);
  }

  String _fileName(SurauInfo? info, String ym) =>
      reportFileName(info?.name ?? '', ym);

  Future<void> _liveOnly() async {
    final s = S.of(context);
    await showDialog<void>(
      context: context,
      builder: (context) => AlertDialog(
        key: const Key('finr-live-only'),
        title: Text(s.liveOnlyTitle),
        content: Text(s.liveOnlyBody(s.finrLiveOnlyAction)),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(context).pop(),
            child: Text(s.liveOnlyOk),
          ),
        ],
      ),
    );
  }

  void _snack(String message) {
    ScaffoldMessenger.of(context)
        .showSnackBar(SnackBar(content: Text(message)));
  }

  /// Runs [act] with the busy flag; a live-only refusal opens the dialog,
  /// any other failure the red line.
  Future<void> _guarded(Future<void> Function() act) async {
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      await act();
    } on LiveOnly {
      if (mounted) await _liveOnly();
    } on Object catch (e) {
      if (mounted) setState(() => _error = writeErrorText(S.of(context), e));
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _download(SurauInfo? info, String ym) => _guarded(() async {
    final api = ref.read(financeBoxApiProvider);
    if (api == null) throw const LiveOnly('/api/finance/report');
    final bytes = await api.reportPdf(ym);
    await ref.read(reportFileOpsProvider).save(bytes, _fileName(info, ym));
    if (mounted) _snack(S.of(context).finrDownloaded);
  });

  Future<void> _share(SurauInfo? info, String ym) async {
    final name = _fileName(info, ym);
    final go = await showReportShareSheet(context, filename: name);
    if (!go || !mounted) return;
    await _guarded(() async {
      final api = ref.read(financeBoxApiProvider);
      if (api == null) throw const LiveOnly('/api/finance/report');
      final bytes = await api.reportPdf(ym);
      final ShareResult r = await ref
          .read(reportFileOpsProvider)
          .share(bytes, name);
      // Noted only when the system says the file was really sent.
      if (!r.completed) return;
      try {
        await api.reportShared(ym, r.via);
      } on Object {
        if (mounted) _snack(S.of(context).finrShareNoteFailed);
      }
    });
  }

  Future<void> _print(SurauInfo? info, String ym) => _guarded(() async {
    final api = ref.read(financeBoxApiProvider);
    if (api == null) throw const LiveOnly('/api/finance/report');
    final bytes = await api.reportPdf(ym);
    await ref.read(reportFileOpsProvider).share(bytes, _fileName(info, ym));
  });

  Future<bool> _confirm(String title, String body) async {
    final s = S.of(context);
    final ok = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        key: const Key('finr-confirm'),
        title: Text(title),
        content: Text(body),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(context).pop(false),
            child: Text(s.actionCancel),
          ),
          FilledButton(
            key: const Key('finr-confirm-yes'),
            onPressed: () => Navigator.of(context).pop(true),
            child: Text(s.actionContinue),
          ),
        ],
      ),
    );
    return ok == true;
  }

  Future<void> _closeMonth(String ym) async {
    final s = S.of(context);
    if (!await _confirm(s.finrCloseTitle(monthNameMs(ym)), s.finrCloseBody)) {
      return;
    }
    await _guarded(() async {
      await ref.read(financeRepositoryProvider)!.setMonth(ym, 'closed');
      _reload();
      if (mounted) _snack(s.finrClosedDone);
    });
  }

  Future<void> _reopen(String ym) async {
    final s = S.of(context);
    if (!await _confirm(s.finrReopenTitle(monthNameMs(ym)), s.finrReopenBody)) {
      return;
    }
    await _guarded(() async {
      await ref.read(financeRepositoryProvider)!.setMonth(ym, 'open');
      _reload();
      if (mounted) _snack(s.finrReopenDone);
    });
  }
}
