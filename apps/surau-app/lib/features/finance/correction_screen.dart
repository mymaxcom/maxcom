// Pembetulan: an entry is never edited or deleted; a mistake is fixed with a
// new row that points at the original, gives a reason of at least 15
// characters and is one of three kinds: adjust the amount, cancel the entry
// (count it as zero) or move it to another tabung. A correction of an entry
// that was already corrected still points at the ORIGINAL entry.

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../app/shell.dart';
import '../../app/theme.dart';
import '../../finance/finance_models.dart';
import '../../finance/finance_repository.dart';
import '../../finance/ledger.dart';
import '../../l10n/generated/s.dart';
import '../../store/local_store.dart';
import '../../screens/widgets/pieces.dart';
import 'finance_widgets.dart';

/// Fewest characters a reason may have (core: `REASON_MIN`).
const int correctionReasonMin = 15;

class CorrectionScreen extends ConsumerStatefulWidget {
  const CorrectionScreen({super.key, this.initialEntryId});

  final String? initialEntryId;

  @override
  ConsumerState<CorrectionScreen> createState() => _CorrectionScreenState();
}

class _CorrectionScreenState extends ConsumerState<CorrectionScreen> {
  String? _id;
  String _kind = 'amount';
  String? _toFundId;
  final _amount = TextEditingController();
  final _reason = TextEditingController();
  final _search = TextEditingController();
  bool _saving = false;
  String? _error;
  FinanceEntry? _saved;
  EntryDetail? _detail;

  @override
  void initState() {
    super.initState();
    final id = widget.initialEntryId;
    if (id != null && id.isNotEmpty) _open(id);
  }

  @override
  void dispose() {
    _amount.dispose();
    _reason.dispose();
    _search.dispose();
    super.dispose();
  }

  /// Opens the form for [id]; a correction's id leads to its original.
  Future<void> _open(String id) async {
    final repo = ref.read(financeRepositoryProvider);
    if (repo == null) return;
    var target = id;
    // A correction's id leads to the original it points at.
    final row = await repo.store.getDoc(Collections.financeEntries, id);
    if (row != null && row['kind'] == 'adjust' && row['correctsId'] is String) {
      target = row['correctsId'] as String;
    }
    final detail = await repo.entry(target);
    if (!mounted || detail == null) return;
    setState(() {
      _detail = detail;
      _id = detail.entry.id;
      _kind = 'amount';
      _toFundId = null;
      _amount.clear();
      _reason.clear();
      _error = null;
    });
  }

  int? get _right => parseRm(_amount.text);

  int get _reasonLen => _reason.text.trim().length;

  bool get _valid {
    if (_reasonLen < correctionReasonMin) return false;
    switch (_kind) {
      case 'amount':
        final r = _right;
        return r != null && r > 0;
      case 'fund':
        return _toFundId != null;
      default:
        return true;
    }
  }

  Future<void> _save() async {
    final repo = ref.read(financeRepositoryProvider);
    final d = _detail;
    if (repo == null || d == null) return;
    final s = S.of(context);
    setState(() {
      _saving = true;
      _error = null;
    });
    try {
      final saved = await repo.appendCorrection({
        'correctsId': d.entry.id,
        'correctionKind': _kind,
        'entryDate': repo.todayKl,
        'fundId': d.effective.effFundId,
        'amountSen': _kind == 'amount' ? _right! : 0,
        if (_kind == 'fund') 'toFundId': _toFundId,
        'reason': _reason.text.trim(),
      });
      if (!mounted) return;
      setState(() {
        _saved = saved;
        _saving = false;
      });
    } on Object {
      if (!mounted) return;
      setState(() {
        _saving = false;
        _error = s.finSaveFailed;
      });
    }
  }

  void _again() {
    setState(() {
      _saved = null;
      _id = null;
      _detail = null;
    });
  }

  @override
  Widget build(BuildContext context) {
    final s = S.of(context);
    final saved = _saved;
    if (saved != null) {
      return FinSavedView(
        title: s.finCorTitle,
        entry: saved,
        againLabel: s.finHistFixAgain,
        onAgain: _again,
      );
    }
    return ShellPage(
      title: s.finCorTitle,
      body: SurauTheme.page(
        children: _id == null ? _pick(context) : _form(context),
      ),
    );
  }

  List<Widget> _pick(BuildContext context) {
    final s = S.of(context);
    final entries =
        ref.watch(financeEntriesProvider).value ?? const <FinanceEntry>[];
    final lookups =
        ref.watch(financeLookupsProvider).value ?? const FinLookups();
    final corrected = <String>{
      for (final e in entries)
        if (e.kind == 'adjust' && e.correctsId != null) e.correctsId!,
    };
    final q = _search.text.trim().toLowerCase();
    final list = [
      for (final e in entries)
        if (e.kind != 'adjust' &&
            (q.isEmpty ||
                '${e.refLabel} ${lookups.fundName(e.fundId)} ${finEntryTitle(s, e, lookups)} ${lookups.perihalLabel(e.perihalId)}'
                    .toLowerCase()
                    .contains(q)))
          e,
    ];
    return [
      Text(
        s.finCorIntro,
        style: Theme.of(context).textTheme.bodyMedium!
            .copyWith(color: SurauColors.muted),
      ),
      const SizedBox(height: 12),
      TextField(
        key: const Key('fin-cor-search'),
        controller: _search,
        onChanged: (_) => setState(() {}),
        decoration: InputDecoration(
          prefixIcon: const Icon(Icons.search_rounded),
          hintText: s.finCorSearch,
        ),
      ),
      const SizedBox(height: 12),
      if (list.isEmpty)
        Padding(
          padding: const EdgeInsets.all(24),
          child: Text(s.finCorNoEntries, textAlign: TextAlign.center),
        )
      else
        RowsCard(
          children: [
            for (final e in list)
              FinEntryTile(
                key: Key('fin-pick-${e.id}'),
                entry: e,
                lookups: lookups,
                corrected: corrected.contains(e.id),
                onTap: () => _open(e.id),
              ),
          ],
        ),
    ];
  }

  List<Widget> _form(BuildContext context) {
    final s = S.of(context);
    final text = Theme.of(context).textTheme;
    final d = _detail!;
    final e = d.entry;
    final lookups =
        ref.watch(financeLookupsProvider).value ?? const FinLookups();
    final funds = ref.watch(financeFundsProvider).value ?? const <Fund>[];
    final cur = d.effective.voided ? 0 : d.effective.effAmountSen;
    final sign = e.kind == 'out' ? -1 : 1;
    final right = _right;
    final delta = switch (_kind) {
      'amount' => right == null ? null : sign * (right - cur),
      'void' => sign * -cur,
      _ => null,
    };
    final n = _reasonLen;
    final ok = n >= correctionReasonMin;
    final counters = e.counters ?? const <Counter>[];

    return [
      Card(
        color: SurauColors.paperDeep,
        child: Padding(
          padding: const EdgeInsets.all(16),
          child: Column(
            key: const Key('fin-cor-original'),
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Row(
                children: [
                  const Icon(
                    Icons.lock_outline_rounded,
                    size: 16,
                    color: SurauColors.muted,
                  ),
                  const SizedBox(width: 6),
                  Text(
                    s.finCorLocked,
                    style: text.labelMedium!.copyWith(color: SurauColors.muted),
                  ),
                ],
              ),
              const SizedBox(height: 8),
              FinKeyValues([
                (s.finReference, e.refLabel),
                (s.finDate, finDmy(e.entryDate)),
                (s.finFund, lookups.fundName(e.fundId)),
                (s.finPerihal, finEntryTitle(s, e, lookups)),
                (s.finAmount, formatRm(e.amountSen)),
              ]),
              if (cur != e.amountSen)
                Padding(
                  padding: const EdgeInsets.only(top: 4),
                  child: Text(
                    s.finCorCurrent(formatRm(cur)),
                    key: const Key('fin-cor-current'),
                    style: text.bodyMedium!.copyWith(
                      fontWeight: FontWeight.w700,
                    ),
                  ),
                ),
              if (counters.isNotEmpty)
                Padding(
                  padding: const EdgeInsets.only(top: 6),
                  child: Row(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      SizedBox(
                        width: 110,
                        child: Text(
                          s.finCountedBy,
                          style: text.bodySmall!.copyWith(
                            color: SurauColors.muted,
                          ),
                        ),
                      ),
                      Expanded(
                        child: Column(
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
                    ],
                  ),
                ),
            ],
          ),
        ),
      ),
      const SizedBox(height: 14),
      Card(
        child: Padding(
          padding: const EdgeInsets.all(16),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              FinField(
                label: s.finCorKind,
                child: FinChips<String>(
                  items: [
                    ('amount', s.finCorKindAmount),
                    ('void', s.finCorKindVoid),
                    ('fund', s.finCorKindFund),
                  ],
                  value: _kind,
                  onChanged: (v) => setState(() => _kind = v),
                ),
              ),
              if (_kind == 'amount')
                FinField(
                  label: s.finCorRightAmount,
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.stretch,
                    children: [
                      FinMoneyField(
                        fieldKey: const Key('fin-cor-amount'),
                        controller: _amount,
                        onChanged: () => setState(() {}),
                      ),
                      if (delta != null)
                        Row(
                          children: [
                            Expanded(
                              child: Text(
                                s.finCorDelta,
                                style: text.bodyMedium,
                              ),
                            ),
                            Text(
                              finSigned(delta),
                              key: const Key('fin-cor-delta'),
                              style: text.bodyLarge!.copyWith(
                                color: const Color(0xFF7A5D00),
                                fontWeight: FontWeight.w700,
                              ),
                            ),
                          ],
                        ),
                    ],
                  ),
                ),
              if (_kind == 'void')
                Padding(
                  padding: const EdgeInsets.only(bottom: 18),
                  child: FinInfoBox(
                    key: const Key('fin-cor-void-info'),
                    text: s.finCorVoidInfo(e.refLabel, finSigned(delta ?? 0)),
                    icon: Icons.warning_amber_rounded,
                    tone: FinTone.danger,
                  ),
                ),
              if (_kind == 'fund')
                FinField(
                  label: s.finCorRightFund,
                  child: FinChips<String>(
                    items: [
                      for (final f in funds)
                        if (f.id != d.effective.effFundId) (f.id, f.name),
                    ],
                    value: _toFundId,
                    onChanged: (v) => setState(() => _toFundId = v),
                  ),
                ),
              FinField(
                label: s.finCorReason,
                trailing: s.finCorRequired,
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    TextField(
                      key: const Key('fin-cor-reason'),
                      controller: _reason,
                      minLines: 3,
                      maxLines: 5,
                      maxLength: 500,
                      onChanged: (_) => setState(() {}),
                      decoration: InputDecoration(hintText: s.finCorReasonHint),
                    ),
                    Text(
                      ok ? s.finCorReasonOk(n) : s.finCorReasonCount(n),
                      key: const Key('fin-cor-count'),
                      style: text.bodySmall!.copyWith(
                        color: ok ? SurauColors.teal : SurauColors.danger,
                      ),
                    ),
                    const SizedBox(height: 8),
                    Wrap(
                      spacing: 8,
                      children: [
                        for (final (label, preset) in [
                          (s.finPresetRecount, s.finPresetRecountText),
                          (s.finPresetTypo, s.finPresetTypoText),
                          (s.finPresetWrongFund, s.finPresetWrongFundText),
                        ])
                          ActionChip(
                            key: Key('fin-preset-$label'),
                            label: Text(label),
                            onPressed: () => setState(() {
                              _reason.text = preset;
                              _reason.selection = TextSelection.collapsed(
                                offset: preset.length,
                              );
                            }),
                          ),
                      ],
                    ),
                  ],
                ),
              ),
            ],
          ),
        ),
      ),
      const SizedBox(height: 14),
      FinInfoBox(text: s.finCorNote),
      if (_error != null) ...[
        const SizedBox(height: 12),
        FinInfoBox(
          text: _error!,
          icon: Icons.error_outline_rounded,
          tone: FinTone.danger,
        ),
      ],
      const SizedBox(height: 14),
      FilledButton.icon(
        key: const Key('fin-cor-save'),
        onPressed: _valid && !_saving ? _save : null,
        icon: const Icon(Icons.check_rounded),
        label: Text(s.finCorSave),
      ),
      if (!ok)
        Padding(
          padding: const EdgeInsets.only(top: 8),
          child: Text(
            s.finCorFillReason,
            textAlign: TextAlign.center,
            style: text.bodySmall!.copyWith(color: SurauColors.muted),
          ),
        ),
    ];
  }
}
