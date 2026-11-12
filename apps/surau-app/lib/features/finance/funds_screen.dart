// Tetapan tabung (mockup screen 5), Pentadbir only (`settings:write`): the
// funds with their TV switch, rename, target, order and archive (a fund is
// never deleted; archiving needs a balance of exactly RM 0.00), the perihal
// lists (the system "Penceramah" is locked), the kiosk card settings written
// to `tabungCard`, the module switch and the "Baki pembukaan" row.
//
// Route: /finance/tabung, `FundsScreen()`.

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../app/providers.dart';
import '../../app/shell.dart';
import '../../app/theme.dart';
import '../../box/box_client.dart' show BoxError;
import '../../content/asset_picker.dart' show ImageField;
import '../../content/image_ref.dart' show ImageSlot;
import '../../finance/finance_local.dart' show isoMs;
import '../../finance/finance_models.dart';
import '../../finance/finance_repository.dart';
import '../../finance/ledger.dart';
import '../../l10n/generated/s.dart';
import '../../screens/widgets/box_read.dart' show writeErrorText;
import '../../screens/widgets/pieces.dart' show SectionLabel;
import '../shell/permissions.dart';
import 'finance_box_api.dart';
import 'finance_widgets.dart' show FinTwoColumnPage;
import 'report_a4.dart' show dmy;

/// Where the setup screen lives (registered in the router).
const String financeSetupPath = '/finance/setup';

const List<String> _figures = ['balance', 'month', 'lastEntry'];

class _FundsData {
  const _FundsData({
    required this.funds,
    required this.balances,
    required this.inP,
    required this.outP,
    required this.card,
    required this.financeOn,
    required this.opening,
  });

  final List<Fund> funds;
  final Map<String, int> balances;
  final List<Perihal> inP;
  final List<Perihal> outP;
  final Map<String, dynamic> card;
  final bool financeOn;

  /// The opening entries (one per fund) or empty when setup has not run.
  final List<FinanceEntry> opening;
}

Fund _copyFund(
  Fund f, {
  String? name,
  bool? public,
  Object? targetSen = _keep,
  int? sortOrder,
  Object? archivedAt = _keep,
}) => Fund(
  id: f.id,
  name: name ?? f.name,
  public: public ?? f.public,
  targetSen: identical(targetSen, _keep) ? f.targetSen : targetSen as int?,
  jumaat: f.jumaat,
  sortOrder: sortOrder ?? f.sortOrder,
  archivedAt: identical(archivedAt, _keep)
      ? f.archivedAt
      : archivedAt as String?,
);

const Object _keep = Object();

class FundsScreen extends ConsumerStatefulWidget {
  const FundsScreen({super.key});

  @override
  ConsumerState<FundsScreen> createState() => _FundsScreenState();
}

class _FundsScreenState extends ConsumerState<FundsScreen> {
  Future<_FundsData>? _data;
  String? _error;

  // Edits of the TV card not saved yet.
  final Map<String, Object?> _cardEdits = {};

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    _data ??= _load();
  }

  Future<_FundsData> _load() async {
    final repo = ref.read(financeRepositoryProvider);
    final api = ref.read(financeBoxApiProvider);
    if (repo == null || api == null) throw StateError('locked');
    final summary = await repo.summary();
    final settings = await api.settings();
    final entries = await repo.entries();
    final card = settings['tabungCard'];
    final fin = settings['finance'];
    return _FundsData(
      funds: await repo.funds(includeArchived: true),
      balances: {for (final b in summary.funds) b.fund.id: b.balanceSen},
      inP: await repo.perihal('in', true),
      outP: await repo.perihal('out', true),
      card: card is Map ? card.cast<String, dynamic>() : const {},
      financeOn: fin is Map && fin['enabled'] == true,
      opening: [
        for (final e in entries)
          if (e.kind == 'opening') e,
      ],
    );
  }

  void _reload() => setState(() {
    _error = null;
    _data = _load();
  });

  @override
  Widget build(BuildContext context) {
    final s = S.of(context);
    final roles = ref.watch(rolesProvider);
    return ShellPage(
      title: s.finrFundsTitle,
      body: !canSee(roles, 'settings:write')
          ? SurauTheme.page(
              children: [
                Text(s.errorForbidden, key: const Key('finr-funds-forbidden')),
              ],
            )
          : FutureBuilder<_FundsData>(
              future: _data,
              builder: (context, snap) {
                if (snap.hasError) {
                  return SurauTheme.page(
                    children: [
                      Text(s.loadFailed),
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
                return _body(context, d);
              },
            ),
    );
  }

  Widget _body(BuildContext context, _FundsData d) {
    final s = S.of(context);
    final text = Theme.of(context).textTheme;
    final active = [
      for (final f in d.funds)
        if (!f.archived) f,
    ];
    final archived = [
      for (final f in d.funds)
        if (f.archived) f,
    ];
    final heading = <Widget>[
      Text(
        s.finrFundsIntro,
        style: text.bodyMedium!.copyWith(color: SurauColors.muted),
      ),
      if (_error != null) ...[
        const SizedBox(height: 10),
        Container(
          padding: const EdgeInsets.fromLTRB(14, 12, 14, 12),
          decoration: BoxDecoration(
            color: SurauColors.dangerSoft,
            borderRadius: BorderRadius.circular(SurauTheme.radiusControl),
          ),
          child: Text(
            _error!,
            key: const Key('finr-funds-error'),
            style: text.bodyMedium!.copyWith(color: SurauColors.dangerInk),
          ),
        ),
      ],
      const SizedBox(height: 16),
    ];
    final tabung = <Widget>[
      SectionLabel(s.finrFundsSection),
      Card(
        child: Column(
          children: [
            ReorderableListView(
              shrinkWrap: true,
              physics: const NeverScrollableScrollPhysics(),
              buildDefaultDragHandles: false,
              onReorderItem: (from, to) => _reorder(active, from, to),
              children: [
                for (var i = 0; i < active.length; i++)
                  _fundRow(context, d, active, i),
              ],
            ),
            for (final f in archived) _archivedRow(context, f),
          ],
        ),
      ),
      const SizedBox(height: 12),
      Align(
        alignment: Alignment.centerLeft,
        child: OutlinedButton.icon(
          key: const Key('finr-add-fund'),
          onPressed: () => _fundDialog(context, d, null),
          icon: const Icon(Icons.add_rounded),
          label: Text(s.finrAddFund),
        ),
      ),
    ];
    final tvCard = <Widget>[
      SectionLabel(s.finrCardSection),
      _cardSettings(context, d),
    ];
    final perihal = <Widget>[
      SectionLabel(s.finrPerihalSection),
      _perihalCard(context, d),
    ];
    final module = <Widget>[
      SectionLabel(s.finrModuleSection),
      _moduleCard(context, d),
    ];
    const gap = SizedBox(height: 24);
    return FinTwoColumnPage(
      top: heading,
      left: [...tabung, gap, ...perihal, gap, ...module],
      right: tvCard,
      narrow: [...tabung, gap, ...tvCard, gap, ...perihal, gap, ...module],
    );
  }

  // ---- funds ----

  Widget _fundRow(BuildContext context, _FundsData d, List<Fund> list, int i) {
    final s = S.of(context);
    final text = Theme.of(context).textTheme;
    final f = list[i];
    final bal = d.balances[f.id] ?? 0;
    final zero = bal == 0;
    final sub = [
      s.finrBalance(formatRm(bal)),
      if (f.targetSen != null) s.finrTarget(formatRm(f.targetSen!)),
    ].join(', ');
    return Padding(
      key: ValueKey(f.id),
      padding: const EdgeInsets.fromLTRB(4, 8, 8, 8),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Row(
            children: [
              ReorderableDragStartListener(
                index: i,
                child: const Padding(
                  padding: EdgeInsets.all(10),
                  child: Icon(
                    Icons.drag_indicator_rounded,
                    color: SurauColors.outline,
                  ),
                ),
              ),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(f.name, style: text.titleSmall),
                    Text(
                      sub,
                      style: text.bodyMedium!.copyWith(
                        color: SurauColors.muted,
                        fontFeatures: const [FontFeature.tabularFigures()],
                      ),
                    ),
                  ],
                ),
              ),
              IconButton(
                key: Key('finr-rename-${f.id}'),
                tooltip: s.finrRename,
                onPressed: () => _fundDialog(context, d, f),
                icon: const Icon(Icons.edit_outlined),
              ),
              Column(
                mainAxisSize: MainAxisSize.min,
                children: [
                  Switch(
                    key: Key('finr-pub-${f.id}'),
                    value: f.public,
                    onChanged: (v) => _saveFund(_copyFund(f, public: v)),
                  ),
                  Text(s.finrOnTv, style: text.labelSmall),
                ],
              ),
            ],
          ),
          Padding(
            padding: const EdgeInsets.only(left: 12),
            child: Row(
              children: [
                TextButton.icon(
                  key: Key('finr-archive-${f.id}'),
                  onPressed: zero ? () => _archive(f) : null,
                  icon: const Icon(Icons.archive_outlined, size: 18),
                  label: Text(s.finrArchive),
                ),
                if (!zero)
                  Expanded(
                    child: Text(
                      s.finrArchiveNeedsZero,
                      key: Key('finr-archive-hint-${f.id}'),
                      style: text.bodySmall!.copyWith(color: SurauColors.muted),
                    ),
                  ),
              ],
            ),
          ),
        ],
      ),
    );
  }

  Widget _archivedRow(BuildContext context, Fund f) {
    final s = S.of(context);
    final text = Theme.of(context).textTheme;
    return ListTile(
      key: Key('finr-archived-${f.id}'),
      title: Text(
        f.name,
        style: text.titleSmall!.copyWith(color: SurauColors.muted),
      ),
      subtitle: Text(
        s.finrArchivedOn(
          f.archivedAt == null ? '' : dmy(f.archivedAt!.substring(0, 10)),
        ),
      ),
      trailing: TextButton(
        key: Key('finr-restore-${f.id}'),
        onPressed: () => _saveFund(_copyFund(f, archivedAt: null)),
        child: Text(s.finrRestore),
      ),
    );
  }

  Future<void> _reorder(List<Fund> list, int from, int to) async {
    final next = [...list];
    final moved = next.removeAt(from);
    next.insert(to, moved);
    for (var i = 0; i < next.length; i++) {
      if (next[i].sortOrder != i) {
        await _saveFund(_copyFund(next[i], sortOrder: i), reload: false);
      }
    }
    _reload();
  }

  Future<void> _archive(Fund f) async {
    final s = S.of(context);
    final ok = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        key: const Key('finr-archive-confirm'),
        title: Text(s.finrArchiveTitle(f.name)),
        content: Text(s.finrArchiveBody),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(context).pop(false),
            child: Text(s.actionCancel),
          ),
          FilledButton(
            key: const Key('finr-archive-yes'),
            onPressed: () => Navigator.of(context).pop(true),
            child: Text(s.finrArchive),
          ),
        ],
      ),
    );
    if (ok == true) {
      await _saveFund(_copyFund(f, archivedAt: isoMs(DateTime.now())));
    }
  }

  /// Queues the fund. A 409 from the box means the name is taken.
  Future<bool> _saveFund(Fund f, {bool reload = true}) async {
    final repo = ref.read(financeRepositoryProvider)!;
    try {
      await repo.putFund(f);
      if (reload && mounted) _reload();
      return true;
    } on BoxError catch (e) {
      if (mounted) {
        setState(
          () => _error = e.status == 409
              ? S.of(context).finrFundNameTaken
              : writeErrorText(S.of(context), e),
        );
      }
      return false;
    } on Object catch (e) {
      if (mounted) setState(() => _error = writeErrorText(S.of(context), e));
      return false;
    }
  }

  Future<void> _fundDialog(
    BuildContext context,
    _FundsData d,
    Fund? existing,
  ) async {
    final repo = ref.read(financeRepositoryProvider)!;
    final result = await showDialog<Fund>(
      context: context,
      builder: (_) => _FundDialog(
        existing: existing,
        taken: {
          for (final f in d.funds)
            if (f.id != existing?.id) f.name.trim().toLowerCase(),
        },
        newId: repo.newId,
        nextOrder: d.funds.isEmpty
            ? 0
            : d.funds.map((f) => f.sortOrder).reduce((a, b) => a > b ? a : b) +
                  1,
      ),
    );
    if (result != null) await _saveFund(result);
  }

  // ---- TV card ----

  Object? _cardValue(_FundsData d, String key, Object? fallback) =>
      _cardEdits.containsKey(key) ? _cardEdits[key] : (d.card[key] ?? fallback);

  Widget _cardSettings(BuildContext context, _FundsData d) {
    final s = S.of(context);
    final text = Theme.of(context).textTheme;
    final figure = _cardValue(d, 'figure', 'balance') as String;
    final seconds = (_cardValue(d, 'highlightSeconds', 20) as num).toInt();
    final showTarget = _cardValue(d, 'showTarget', true) == true;
    final qr = _cardValue(d, 'qrAssetId', '');
    final labels = {
      'balance': s.finrFigBalance,
      'month': s.finrFigMonth,
      'lastEntry': s.finrFigLast,
    };
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Text(s.finrCardFigure, style: text.titleSmall),
            const SizedBox(height: 8),
            SegmentedButton<String>(
              key: const Key('finr-card-figure'),
              showSelectedIcon: false,
              segments: [
                for (final f in _figures)
                  ButtonSegment(value: f, label: Text(labels[f]!)),
              ],
              selected: {figure},
              onSelectionChanged: (v) =>
                  setState(() => _cardEdits['figure'] = v.first),
            ),
            const SizedBox(height: 16),
            Text(s.finrCardHighlight(seconds), style: text.titleSmall),
            Slider(
              key: const Key('finr-card-highlight'),
              value: seconds.toDouble().clamp(0, 120),
              min: 0,
              max: 120,
              divisions: 24,
              label: '$seconds',
              onChanged: (v) =>
                  setState(() => _cardEdits['highlightSeconds'] = v.round()),
            ),
            SwitchListTile(
              key: const Key('finr-card-target'),
              contentPadding: EdgeInsets.zero,
              title: Text(s.finrCardShowTarget),
              value: showTarget,
              onChanged: (v) => setState(() => _cardEdits['showTarget'] = v),
            ),
            const SizedBox(height: 8),
            ImageField(
              label: s.finrCardQr,
              value: (qr is String && qr.isNotEmpty) ? qr : null,
              slot: ImageSlot.logoSquare,
              onChanged: (v) => setState(
                () => _cardEdits['qrAssetId'] = v is String ? v : '',
              ),
            ),
            const SizedBox(height: 12),
            Align(
              alignment: Alignment.centerRight,
              child: FilledButton(
                key: const Key('finr-card-save'),
                onPressed: _cardEdits.isEmpty ? null : () => _saveCard(d),
                child: Text(s.actionSave),
              ),
            ),
          ],
        ),
      ),
    );
  }

  Future<void> _saveCard(_FundsData d) async {
    final api = ref.read(financeBoxApiProvider)!;
    try {
      await api.saveSettings('tabungCard', Map<String, dynamic>.of(_cardEdits));
      _cardEdits.clear();
      _reload();
    } on Object catch (e) {
      if (mounted) setState(() => _error = writeErrorText(S.of(context), e));
    }
  }

  // ---- perihal ----

  Widget _perihalCard(BuildContext context, _FundsData d) {
    final s = S.of(context);
    Widget group(String title, String direction, List<Perihal> list) {
      final text = Theme.of(context).textTheme;
      return Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(title, style: text.titleSmall),
          const SizedBox(height: 8),
          Wrap(
            spacing: 8,
            runSpacing: 8,
            children: [
              for (final p in list)
                InputChip(
                  key: Key('finr-perihal-${p.id}'),
                  label: Text(p.label),
                  avatar: p.system != null
                      ? const Icon(Icons.lock_outline_rounded, size: 16)
                      : null,
                  onPressed: p.system != null
                      ? null
                      : () => _perihalDialog(context, d, direction, p),
                  backgroundColor: p.archived ? SurauColors.paperDeep : null,
                  labelStyle: p.archived
                      ? const TextStyle(color: SurauColors.muted)
                      : null,
                ),
              ActionChip(
                key: Key('finr-add-perihal-$direction'),
                avatar: const Icon(Icons.add_rounded, size: 18),
                label: Text(s.actionAdd),
                onPressed: () => _perihalDialog(context, d, direction, null),
              ),
            ],
          ),
        ],
      );
    }

    return Card(
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            group(s.finrPerihalIn, 'in', d.inP),
            const SizedBox(height: 16),
            group(s.finrPerihalOut, 'out', d.outP),
            const SizedBox(height: 8),
            Text(
              s.finrPerihalSystemNote,
              style: Theme.of(context).textTheme.bodySmall!
                  .copyWith(color: SurauColors.muted),
            ),
          ],
        ),
      ),
    );
  }

  Future<void> _perihalDialog(
    BuildContext context,
    _FundsData d,
    String direction,
    Perihal? existing,
  ) async {
    final repo = ref.read(financeRepositoryProvider)!;
    final all = direction == 'in' ? d.inP : d.outP;
    final result = await showDialog<Perihal>(
      context: context,
      builder: (_) => _PerihalDialog(
        existing: existing,
        direction: direction,
        taken: {
          for (final p in all)
            if (p.id != existing?.id) p.label.trim().toLowerCase(),
        },
        newId: repo.newId,
        nextOrder: all.isEmpty
            ? 0
            : all.map((p) => p.sortOrder).reduce((a, b) => a > b ? a : b) + 1,
      ),
    );
    if (result == null) return;
    try {
      await repo.putPerihal(result);
      if (mounted) _reload();
    } on Object catch (e) {
      if (mounted) setState(() => _error = writeErrorText(S.of(context), e));
    }
  }

  // ---- module ----

  Widget _moduleCard(BuildContext context, _FundsData d) {
    final s = S.of(context);
    final text = Theme.of(context).textTheme;
    final opening = d.opening;
    final sub = opening.isEmpty
        ? s.finrOpeningNone
        : s.finrOpeningDone(dmy(opening.first.entryDate), opening.length);
    return Card(
      child: Column(
        children: [
          SwitchListTile(
            key: const Key('finr-module-switch'),
            title: Text(s.finrModuleTitle),
            subtitle: Text(s.finrModuleHelp),
            value: d.financeOn,
            onChanged: (v) => _toggleModule(v),
          ),
          const Divider(),
          ListTile(
            key: const Key('finr-opening-row'),
            title: Text(s.finrOpeningTitle),
            subtitle: Text(
              sub,
              style: text.bodyMedium!.copyWith(color: SurauColors.muted),
            ),
            trailing: const Icon(Icons.chevron_right_rounded),
            onTap: () => GoRouter.of(context).push(financeSetupPath),
          ),
        ],
      ),
    );
  }

  Future<void> _toggleModule(bool on) async {
    final s = S.of(context);
    if (!on) {
      final ok = await showDialog<bool>(
        context: context,
        builder: (context) => AlertDialog(
          key: const Key('finr-module-off-confirm'),
          title: Text(s.finrModuleOffTitle),
          content: Text(s.finrModuleOffBody),
          actions: [
            TextButton(
              onPressed: () => Navigator.of(context).pop(false),
              child: Text(s.actionCancel),
            ),
            FilledButton(
              key: const Key('finr-module-off-yes'),
              onPressed: () => Navigator.of(context).pop(true),
              child: Text(s.actionContinue),
            ),
          ],
        ),
      );
      if (ok != true) return;
    }
    try {
      await ref.read(financeBoxApiProvider)!.saveSettings('finance', {
        'enabled': on,
      });
      _reload();
    } on Object catch (e) {
      if (mounted) setState(() => _error = writeErrorText(S.of(context), e));
    }
  }
}

class _FundDialog extends StatefulWidget {
  const _FundDialog({
    required this.existing,
    required this.taken,
    required this.newId,
    required this.nextOrder,
  });

  final Fund? existing;
  final Set<String> taken;
  final String Function() newId;
  final int nextOrder;

  @override
  State<_FundDialog> createState() => _FundDialogState();
}

class _FundDialogState extends State<_FundDialog> {
  late final TextEditingController _name = TextEditingController(
    text: widget.existing?.name ?? '',
  );
  late final TextEditingController _target = TextEditingController(
    text: widget.existing?.targetSen == null
        ? ''
        : formatRm(widget.existing!.targetSen!),
  );
  late bool _public = widget.existing?.public ?? false;
  String? _nameError;
  String? _targetError;

  @override
  void dispose() {
    _name.dispose();
    _target.dispose();
    super.dispose();
  }

  void _submit() {
    final s = S.of(context);
    final name = _name.text.trim();
    int? target;
    String? nameError;
    String? targetError;
    if (name.isEmpty || name.length > 60) {
      nameError = s.finrFundNameInvalid;
    } else if (widget.taken.contains(name.toLowerCase())) {
      nameError = s.finrFundNameTaken;
    }
    final t = _target.text.trim();
    if (t.isNotEmpty) {
      target = parseRm(t);
      if (target == null) targetError = s.finrAmountInvalid;
    }
    setState(() {
      _nameError = nameError;
      _targetError = targetError;
    });
    if (nameError != null || targetError != null) return;
    final e = widget.existing;
    Navigator.of(context).pop(
      e == null
          ? Fund(
              id: widget.newId(),
              name: name,
              public: _public,
              targetSen: target,
              sortOrder: widget.nextOrder,
            )
          : _copyFund(e, name: name, public: _public, targetSen: target),
    );
  }

  @override
  Widget build(BuildContext context) {
    final s = S.of(context);
    final add = widget.existing == null;
    return AlertDialog(
      key: const Key('finr-fund-dialog'),
      title: Text(add ? s.finrAddFund : s.finrRenameFund),
      content: SingleChildScrollView(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Text(add ? s.finrAddFundHelp : s.finrRenameFundHelp),
            const SizedBox(height: 12),
            TextField(
              key: const Key('finr-fund-name'),
              controller: _name,
              maxLength: 60,
              decoration: InputDecoration(
                labelText: s.finrFundName,
                errorText: _nameError,
              ),
            ),
            SwitchListTile(
              key: const Key('finr-fund-public'),
              contentPadding: EdgeInsets.zero,
              title: Text(s.finrFundPublic),
              value: _public,
              onChanged: (v) => setState(() => _public = v),
            ),
            TextField(
              key: const Key('finr-fund-target'),
              controller: _target,
              keyboardType: const TextInputType.numberWithOptions(
                decimal: true,
              ),
              decoration: InputDecoration(
                labelText: s.finrFundTarget,
                hintText: 'RM 0.00',
                errorText: _targetError,
              ),
            ),
          ],
        ),
      ),
      actions: [
        TextButton(
          onPressed: () => Navigator.of(context).pop(),
          child: Text(s.actionCancel),
        ),
        FilledButton(
          key: const Key('finr-fund-save'),
          onPressed: _submit,
          child: Text(add ? s.actionAdd : s.actionSave),
        ),
      ],
    );
  }
}

class _PerihalDialog extends StatefulWidget {
  const _PerihalDialog({
    required this.existing,
    required this.direction,
    required this.taken,
    required this.newId,
    required this.nextOrder,
  });

  final Perihal? existing;
  final String direction;
  final Set<String> taken;
  final String Function() newId;
  final int nextOrder;

  @override
  State<_PerihalDialog> createState() => _PerihalDialogState();
}

class _PerihalDialogState extends State<_PerihalDialog> {
  late final TextEditingController _label = TextEditingController(
    text: widget.existing?.label ?? '',
  );
  String? _error;

  @override
  void dispose() {
    _label.dispose();
    super.dispose();
  }

  Perihal _build(String label, {String? archivedAt, bool keepArchive = true}) {
    final e = widget.existing;
    return Perihal(
      id: e?.id ?? widget.newId(),
      direction: widget.direction,
      label: label,
      sortOrder: e?.sortOrder ?? widget.nextOrder,
      archivedAt: keepArchive ? e?.archivedAt : archivedAt,
    );
  }

  void _submit() {
    final s = S.of(context);
    final label = _label.text.trim();
    if (label.isEmpty || label.length > 60) {
      setState(() => _error = s.finrFundNameInvalid);
      return;
    }
    if (widget.taken.contains(label.toLowerCase())) {
      setState(() => _error = s.finrPerihalNameTaken);
      return;
    }
    Navigator.of(context).pop(_build(label));
  }

  @override
  Widget build(BuildContext context) {
    final s = S.of(context);
    final e = widget.existing;
    return AlertDialog(
      key: const Key('finr-perihal-dialog'),
      title: Text(e == null ? s.finrAddPerihal : s.finrRenamePerihal),
      content: TextField(
        key: const Key('finr-perihal-label'),
        controller: _label,
        maxLength: 60,
        decoration: InputDecoration(
          labelText: s.finrPerihalLabel,
          errorText: _error,
        ),
      ),
      actions: [
        if (e != null)
          TextButton(
            key: const Key('finr-perihal-archive'),
            onPressed: () => Navigator.of(context).pop(
              _build(
                e.label,
                archivedAt: e.archived ? null : isoMs(DateTime.now()),
                keepArchive: false,
              ),
            ),
            child: Text(e.archived ? s.finrRestore : s.finrArchive),
          ),
        TextButton(
          onPressed: () => Navigator.of(context).pop(),
          child: Text(s.actionCancel),
        ),
        FilledButton(
          key: const Key('finr-perihal-save'),
          onPressed: _submit,
          child: Text(e == null ? s.actionAdd : s.actionSave),
        ),
      ],
    );
  }
}
