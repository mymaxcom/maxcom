// Baki pembukaan: the first thing after Kewangan is switched on. One amount
// for each tabung (RM 0.00 is fine), posted as `opening` entries dated the
// day the module started (`finance.startedOn`), then the person lands on the
// Kewangan home. Opening balances are entries like any other: once posted
// they are changed only by a correction, so the screen then says they are
// done instead of offering the form again.
//
// Route: /finance/setup, `FinanceSetupScreen()`.

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
import '../../screens/widgets/box_read.dart' show writeErrorText;
import '../shell/permissions.dart';
import 'finance_box_api.dart';
import 'report_a4.dart' show dmy;

/// The Kewangan home (registered in the router).
const String financeHomePath = '/finance';

class _SetupData {
  const _SetupData(this.funds, this.opening, this.startedOn);

  final List<Fund> funds;
  final List<FinanceEntry> opening;
  final String startedOn;
}

class FinanceSetupScreen extends ConsumerStatefulWidget {
  const FinanceSetupScreen({super.key});

  @override
  ConsumerState<FinanceSetupScreen> createState() => _FinanceSetupScreenState();
}

class _FinanceSetupScreenState extends ConsumerState<FinanceSetupScreen> {
  Future<_SetupData>? _data;
  final Map<String, TextEditingController> _amounts = {};
  final Set<String> _bad = {};
  bool _busy = false;
  String? _error;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    _data ??= _load();
  }

  @override
  void dispose() {
    for (final c in _amounts.values) {
      c.dispose();
    }
    super.dispose();
  }

  Future<_SetupData> _load() async {
    final repo = ref.read(financeRepositoryProvider);
    if (repo == null) throw StateError('locked');
    final funds = await repo.funds();
    final entries = await repo.entries();
    var started = '';
    final api = ref.read(financeBoxApiProvider);
    if (api != null) {
      final fin = (await api.settings())['finance'];
      if (fin is Map && fin['startedOn'] is String) {
        started = fin['startedOn'] as String;
      }
    }
    if (started.isEmpty) started = repo.todayKl;
    for (final f in funds) {
      _amounts.putIfAbsent(f.id, () => TextEditingController(text: '0.00'));
    }
    return _SetupData(funds, [
      for (final e in entries)
        if (e.kind == 'opening') e,
    ], started);
  }

  @override
  Widget build(BuildContext context) {
    final s = S.of(context);
    final roles = ref.watch(rolesProvider);
    return ShellPage(
      title: s.finrSetupTitle,
      body: !canSee(roles, 'finance:write')
          ? SurauTheme.page(
              children: [
                Text(s.errorForbidden, key: const Key('finr-setup-forbidden')),
              ],
            )
          : FutureBuilder<_SetupData>(
              future: _data,
              builder: (context, snap) {
                if (snap.hasError) {
                  return SurauTheme.page(children: [Text(s.loadFailed)]);
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

  Widget _body(BuildContext context, _SetupData d) {
    final s = S.of(context);
    final text = Theme.of(context).textTheme;
    if (d.opening.isNotEmpty) {
      return SurauTheme.page(
        children: [
          Card(
            key: const Key('finr-setup-done'),
            child: Padding(
              padding: const EdgeInsets.all(16),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(s.finrSetupDoneTitle, style: text.titleMedium),
                  const SizedBox(height: 4),
                  Text(
                    s.finrOpeningDone(
                      dmy(d.opening.first.entryDate),
                      d.opening.length,
                    ),
                    style: text.bodyMedium!.copyWith(color: SurauColors.muted),
                  ),
                  const SizedBox(height: 12),
                  Text(s.finrSetupDoneHelp, style: text.bodyMedium),
                ],
              ),
            ),
          ),
          const SizedBox(height: 16),
          FilledButton(
            key: const Key('finr-setup-open-home'),
            onPressed: () => GoRouter.of(context).go(financeHomePath),
            child: Text(s.finrOpenFinance),
          ),
        ],
      );
    }
    return SurauTheme.page(
      children: [
        Text(
          s.finrSetupIntro(dmy(d.startedOn)),
          style: text.bodyMedium!.copyWith(color: SurauColors.muted),
        ),
        const SizedBox(height: 16),
        if (d.funds.isEmpty)
          Text(s.finrSetupNoFunds, key: const Key('finr-setup-no-funds'))
        else
          Card(
            child: Padding(
              padding: const EdgeInsets.all(16),
              child: Column(
                children: [
                  for (final f in d.funds) ...[
                    Padding(
                      padding: const EdgeInsets.symmetric(vertical: 6),
                      child: TextField(
                        key: Key('finr-open-${f.id}'),
                        controller: _amounts[f.id],
                        keyboardType: const TextInputType.numberWithOptions(
                          decimal: true,
                        ),
                        decoration: InputDecoration(
                          labelText: f.name,
                          prefixText: 'RM ',
                          errorText: _bad.contains(f.id)
                              ? s.finrAmountInvalid
                              : null,
                        ),
                      ),
                    ),
                  ],
                ],
              ),
            ),
          ),
        if (_error != null) ...[
          const SizedBox(height: 12),
          Text(
            _error!,
            key: const Key('finr-setup-error'),
            style: text.bodyMedium!.copyWith(color: SurauColors.danger),
          ),
        ],
        const SizedBox(height: 16),
        FilledButton(
          key: const Key('finr-setup-save'),
          onPressed: _busy || d.funds.isEmpty ? null : () => _save(d),
          child: Text(s.finrSetupSave),
        ),
        const SizedBox(height: 8),
        Text(
          s.finrSetupHint,
          style: text.bodySmall!.copyWith(color: SurauColors.muted),
        ),
      ],
    );
  }

  Future<void> _save(_SetupData d) async {
    final repo = ref.read(financeRepositoryProvider)!;
    final amounts = <String, int>{};
    final bad = <String>{};
    for (final f in d.funds) {
      final sen = parseRm(_amounts[f.id]!.text);
      if (sen == null) {
        bad.add(f.id);
      } else {
        amounts[f.id] = sen;
      }
    }
    setState(() {
      _bad
        ..clear()
        ..addAll(bad);
      _error = null;
    });
    if (bad.isNotEmpty) return;
    setState(() => _busy = true);
    try {
      for (final f in d.funds) {
        await repo.appendOpening({
          'entryDate': d.startedOn,
          'fundId': f.id,
          'amountSen': amounts[f.id],
        });
      }
      if (mounted) GoRouter.of(context).go(financeHomePath);
    } on Object catch (e) {
      if (mounted) {
        setState(() {
          _busy = false;
          _error = writeErrorText(S.of(context), e);
        });
      }
    }
  }
}
