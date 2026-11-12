// Kutipan baharu: keying in money received. Works offline: the entry is
// signed, shown at once as pending with a temporary number, and queued.
// Cash needs exactly two counters; a bank, DuitNow or cheque receipt needs
// a reference instead. The review sheet always shows before saving; an
// amount over the big-amount limit adds a warning to it.

import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../app/providers.dart';
import '../../app/shell.dart';
import '../../app/theme.dart';
import '../../content/asset_picker.dart' show pickImageProvider;
import '../../finance/finance_models.dart';
import '../../finance/finance_repository.dart';
import '../../finance/ledger.dart';
import '../../finance/photo_prep.dart';
import '../../l10n/generated/s.dart';
import 'finance_widgets.dart';

/// The denominations in the order they are keyed, notes of ringgit.
const List<String> kutipanDenoms = ['100', '50', '20', '10', '5', '1'];

class KutipanScreen extends ConsumerStatefulWidget {
  const KutipanScreen({super.key});

  @override
  ConsumerState<KutipanScreen> createState() => _KutipanScreenState();
}

class _KutipanScreenState extends ConsumerState<KutipanScreen> {
  String? _date;
  String? _fundId;
  String? _perihalId;
  String _method = 'tunai';
  final _amount = TextEditingController();
  final _reference = TextEditingController();
  final _note = TextEditingController();
  final _otherName = TextEditingController();
  final _coins = TextEditingController();
  final Map<String, TextEditingController> _den = {
    for (final d in kutipanDenoms) d: TextEditingController(),
  };
  bool _denOpen = false;
  bool _otherOpen = false;
  final List<Counter> _counters = [];
  Uint8List? _photo;
  String? _photoError;
  bool _saving = false;
  String? _error;
  FinanceEntry? _saved;

  @override
  void dispose() {
    _amount.dispose();
    _reference.dispose();
    _note.dispose();
    _otherName.dispose();
    _coins.dispose();
    for (final c in _den.values) {
      c.dispose();
    }
    super.dispose();
  }

  String get _today =>
      ref.read(financeRepositoryProvider)?.todayKl ?? finYmd(DateTime.now());

  String get _dateValue => _date ?? _today;

  /// The last Friday before today.
  String _lastFriday() {
    final t = DateTime.parse('${_today}T00:00:00Z');
    var d = t.subtract(const Duration(days: 1));
    while (d.weekday != DateTime.friday) {
      d = d.subtract(const Duration(days: 1));
    }
    return finYmd(d);
  }

  bool _sameCounter(Counter a, Counter b) =>
      a.userId != null ? a.userId == b.userId : a.name == b.name;

  bool _hasCounter(Counter c) => _counters.any((x) => _sameCounter(x, c));

  void _toggleCounter(Counter c) {
    setState(() {
      if (_hasCounter(c)) {
        _counters.removeWhere((x) => _sameCounter(x, c));
      } else if (_counters.length < 2) {
        _counters.add(c);
      }
    });
  }

  int? get _amountSen => parseRm(_amount.text);

  /// The notes and coins as keyed, or null when none were keyed.
  Map<String, int>? _denominations() {
    final out = <String, int>{};
    for (final d in kutipanDenoms) {
      final t = _den[d]!.text.trim();
      if (t.isEmpty) continue;
      final n = int.tryParse(t);
      if (n == null || n < 0) return null;
      if (n > 0) out[d] = n;
    }
    final ct = _coins.text.trim();
    if (ct.isNotEmpty) {
      final c = parseRm(ct);
      if (c == null) return null;
      if (c > 0) out['coinsSen'] = c;
    }
    return out;
  }

  bool get _denKeyed =>
      _den.values.any((c) => c.text.trim().isNotEmpty) ||
      _coins.text.trim().isNotEmpty;

  int? get _denSum {
    final d = _denominations();
    if (d == null) return null;
    var sum = 0;
    for (final e in d.entries) {
      sum += e.key == 'coinsSen' ? e.value : e.value * int.parse(e.key) * 100;
    }
    return sum;
  }

  bool get _denMismatch =>
      _method == 'tunai' && _denKeyed && _denSum != _amountSen;

  bool _canReview(String? fundId, String? perihalId) {
    final sen = _amountSen;
    if (sen == null || sen <= 0) return false;
    if (fundId == null || perihalId == null) return false;
    final date = _dateValue;
    if (date.compareTo(_today) > 0) return false;
    if (_method == 'tunai') {
      if (_counters.length != 2) return false;
      if (_denMismatch) return false;
    } else if (_reference.text.trim().length < 3) {
      return false;
    }
    return true;
  }

  Future<void> _pickPhoto() async {
    final s = S.of(context);
    final bytes = await ref.read(pickImageProvider)();
    if (bytes == null) return;
    try {
      final prepared = await prepareFinancePhotoAsync(bytes);
      if (!mounted) return;
      setState(() {
        _photo = prepared;
        _photoError = null;
      });
    } on FinancePhotoError catch (e) {
      if (!mounted) return;
      setState(() {
        _photoError = e.message == FinancePhotoError.tooBig
            ? s.finPhotoTooBig
            : s.finPhotoNotImage;
      });
    }
  }

  Future<void> _review(
    String fundName,
    String perihalLabel,
    Map<String, String> counterNames,
  ) async {
    final s = S.of(context);
    final sen = _amountSen!;
    final big = ref.read(financeSettingsProvider).bigAmountSen;
    final ok = await showFinanceReview(
      context,
      title: s.finConfirmTitle,
      rows: [
        (s.finDate, finDmy(_dateValue)),
        (s.finFund, fundName),
        (s.finPerihal, perihalLabel),
        (s.finMethod, finMethodLabel(s, _method)),
        (s.finAmount, formatRm(sen)),
        if (_method == 'tunai')
          (
            s.finCountedBy,
            [
              for (final c in _counters)
                c.userId != null
                    ? (counterNames[c.userId] ?? s.finUnknownUser)
                    : (c.name ?? ''),
            ].join(', '),
          )
        else
          (s.finReference, _reference.text.trim()),
        (s.finPhoto, _photo == null ? s.finNone : s.finPhotoOne),
      ],
      bigWarning: sen > big ? s.finBigWarn(formatRm(big)) : null,
    );
    if (ok) await _save(sen);
  }

  Future<void> _save(int sen) async {
    final repo = ref.read(financeRepositoryProvider);
    if (repo == null) return;
    final s = S.of(context);
    setState(() {
      _saving = true;
      _error = null;
    });
    try {
      final input = <String, dynamic>{
        'entryDate': _dateValue,
        'fundId': _fundId ?? (await repo.funds()).first.id,
        'perihalId': _perihalId ?? (await repo.perihal('in')).first.id,
        'amountSen': sen,
        'method': _method,
        if (_method == 'tunai') 'counters': List<Counter>.of(_counters),
        if (_method != 'tunai') 'reference': _reference.text.trim(),
        if (_method == 'tunai' && _denKeyed) 'denominations': _denominations(),
        if (_note.text.trim().isNotEmpty) 'note': _note.text.trim(),
      };
      final saved = await repo.appendCollection(input, photo: _photo);
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
      _amount.clear();
      _reference.clear();
      _note.clear();
      _coins.clear();
      for (final c in _den.values) {
        c.clear();
      }
      _counters.clear();
      _photo = null;
      _denOpen = false;
    });
  }

  @override
  Widget build(BuildContext context) {
    final s = S.of(context);
    final saved = _saved;
    if (saved != null) return _savedPage(context, saved);

    final text = Theme.of(context).textTheme;
    final funds = ref.watch(financeFundsProvider).value ?? const <Fund>[];
    final perihal =
        ref.watch(financePerihalProvider('in')).value ?? const <Perihal>[];
    final candidates =
        ref.watch(financeCounterCandidatesProvider).value ?? const [];
    final session = ref.watch(sessionProvider);
    final fundId = _fundId ?? (funds.isEmpty ? null : funds.first.id);
    final perihalId = _perihalId ?? (perihal.isEmpty ? null : perihal.first.id);
    final people = <({String id, String name})>[
      ...candidates,
      if (session != null && !candidates.any((c) => c.id == session.user.id))
        (id: session.user.id, name: session.user.name),
    ];
    final names = {for (final p in people) p.id: p.name};
    final date = _dateValue;
    final today = _today;
    final prevMonth =
        date.compareTo(today) <= 0 &&
        date.substring(0, 7) != today.substring(0, 7);
    final future = date.compareTo(today) > 0;
    final cash = _method == 'tunai';
    final sen = _amountSen;
    final canReview = _canReview(fundId, perihalId);

    return ShellPage(
      title: s.finKutipanTitle,
      body: SurauTheme.page(
        children: [
          Text(
            s.finKutipanIntro,
            style: text.bodyMedium!.copyWith(color: SurauColors.muted),
          ),
          const SizedBox(height: 14),
          Card(
            child: Padding(
              padding: const EdgeInsets.all(16),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  FinField(
                    label: s.finDate,
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.stretch,
                      children: [
                        InkWell(
                          key: const Key('fin-date'),
                          onTap: () async {
                            final t = DateTime.parse('${today}T00:00:00Z');
                            final first = DateTime(t.year, t.month - 1, 1);
                            final picked = await showDatePicker(
                              context: context,
                              initialDate: DateTime.parse(date),
                              firstDate: first,
                              lastDate: DateTime(t.year, t.month, t.day),
                            );
                            if (picked != null) {
                              setState(() => _date = finYmd(picked));
                            }
                          },
                          child: InputDecorator(
                            decoration: const InputDecoration(
                              prefixIcon: Icon(Icons.calendar_today_outlined),
                            ),
                            child: Text(
                              finDmy(date),
                              style: text.titleMedium!.copyWith(
                                fontWeight: FontWeight.w600,
                              ),
                            ),
                          ),
                        ),
                        const SizedBox(height: 10),
                        Wrap(
                          spacing: 8,
                          children: [
                            ActionChip(
                              key: const Key('fin-date-today'),
                              label: Text(s.finToday),
                              onPressed: () => setState(() => _date = today),
                            ),
                            ActionChip(
                              key: const Key('fin-date-friday'),
                              label: Text(
                                '${s.finLastFriday}, ${finDmy(_lastFriday()).substring(0, 5)}',
                              ),
                              onPressed: () =>
                                  setState(() => _date = _lastFriday()),
                            ),
                          ],
                        ),
                        if (prevMonth) ...[
                          const SizedBox(height: 10),
                          FinInfoBox(
                            key: const Key('fin-prev-month'),
                            text: s.finPrevMonthWarn,
                            icon: Icons.warning_amber_rounded,
                            tone: FinTone.gold,
                          ),
                        ],
                        if (future) ...[
                          const SizedBox(height: 10),
                          FinInfoBox(
                            text: s.finDateFuture,
                            icon: Icons.error_outline_rounded,
                            tone: FinTone.danger,
                          ),
                        ],
                      ],
                    ),
                  ),
                  FinField(
                    label: s.finFund,
                    child: funds.isEmpty
                        ? Text(s.finNoFunds)
                        : FinChips<String>(
                            items: [for (final f in funds) (f.id, f.name)],
                            value: fundId,
                            onChanged: (v) => setState(() => _fundId = v),
                          ),
                  ),
                  FinField(
                    label: s.finPerihal,
                    child: perihal.isEmpty
                        ? Text(s.finNoPerihal)
                        : FinChips<String>(
                            items: [for (final p in perihal) (p.id, p.label)],
                            value: perihalId,
                            onChanged: (v) => setState(() => _perihalId = v),
                          ),
                  ),
                  FinField(
                    label: s.finMethod,
                    child: FinChips<String>(
                      items: [
                        for (final m in const [
                          'tunai',
                          'bank',
                          'duitnow',
                          'cek',
                        ])
                          (m, finMethodLabel(s, m)),
                      ],
                      value: _method,
                      onChanged: (v) => setState(() => _method = v),
                    ),
                  ),
                  FinField(
                    label: s.finAmount,
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.stretch,
                      children: [
                        FinMoneyField(
                          fieldKey: const Key('fin-amount'),
                          controller: _amount,
                          onChanged: () => setState(() {}),
                        ),
                        if (cash) _denominationsBlock(context),
                      ],
                    ),
                  ),
                  if (cash)
                    _countersBlock(context, people)
                  else
                    FinField(
                      label: s.finReference,
                      help: s.finReferenceHelp,
                      child: TextField(
                        key: const Key('fin-reference'),
                        controller: _reference,
                        onChanged: (_) => setState(() {}),
                      ),
                    ),
                  FinField(
                    label: s.finPhotoCount,
                    trailing: s.finOptional,
                    child: _photoBlock(context),
                  ),
                  FinField(
                    label: s.finNote,
                    trailing: s.finOptional,
                    child: TextField(
                      key: const Key('fin-note'),
                      controller: _note,
                      maxLength: 200,
                      minLines: 2,
                      maxLines: 3,
                    ),
                  ),
                ],
              ),
            ),
          ),
          const SizedBox(height: 14),
          FinInfoBox(
            text: s.finLockedInfo,
            icon: Icons.lock_outline_rounded,
            tone: FinTone.gold,
          ),
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
            key: const Key('fin-review'),
            onPressed: !canReview || _saving || sen == null
                ? null
                : () => _review(
                    funds
                            .where((f) => f.id == fundId)
                            .map((f) => f.name)
                            .firstOrNull ??
                        '',
                    perihal
                            .where((p) => p.id == perihalId)
                            .map((p) => p.label)
                            .firstOrNull ??
                        '',
                    names,
                  ),
            icon: const Icon(Icons.check_rounded),
            label: Text(s.finReview),
          ),
        ],
      ),
    );
  }

  Widget _denominationsBlock(BuildContext context) {
    final s = S.of(context);
    final text = Theme.of(context).textTheme;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Align(
          alignment: Alignment.centerLeft,
          child: TextButton.icon(
            key: const Key('fin-den-toggle'),
            onPressed: () => setState(() => _denOpen = !_denOpen),
            icon: Icon(
              _denOpen ? Icons.expand_less_rounded : Icons.expand_more_rounded,
            ),
            label: Text(_denOpen ? s.finDenomClose : s.finDenomOpen),
          ),
        ),
        if (_denOpen) ...[
          for (final d in kutipanDenoms)
            Padding(
              padding: const EdgeInsets.only(bottom: 8),
              child: Row(
                children: [
                  SizedBox(
                    width: 80,
                    child: Text('RM$d x', style: text.bodyLarge),
                  ),
                  Expanded(
                    child: TextField(
                      key: Key('fin-den-$d'),
                      controller: _den[d],
                      keyboardType: TextInputType.number,
                      onChanged: (_) => setState(() {}),
                    ),
                  ),
                  const SizedBox(width: 12),
                  SizedBox(
                    width: 110,
                    child: Text(
                      formatRm(
                        (int.tryParse(_den[d]!.text.trim()) ?? 0) *
                            int.parse(d) *
                            100,
                      ),
                      textAlign: TextAlign.right,
                      style: text.bodyMedium,
                    ),
                  ),
                ],
              ),
            ),
          Row(
            children: [
              SizedBox(
                width: 80,
                child: Text(s.finDenomCoins, style: text.bodyMedium),
              ),
              Expanded(
                child: TextField(
                  key: const Key('fin-den-coins'),
                  controller: _coins,
                  keyboardType: const TextInputType.numberWithOptions(
                    decimal: true,
                  ),
                  onChanged: (_) => setState(() {}),
                ),
              ),
            ],
          ),
          const SizedBox(height: 10),
          Row(
            children: [
              Expanded(
                child: Text(
                  s.finDenomSum,
                  style: text.bodyLarge!.copyWith(fontWeight: FontWeight.w700),
                ),
              ),
              Text(
                formatRm(_denSum ?? 0),
                key: const Key('fin-den-sum'),
                style: text.bodyLarge!.copyWith(fontWeight: FontWeight.w800),
              ),
            ],
          ),
          if (_denMismatch)
            Padding(
              padding: const EdgeInsets.only(top: 8),
              child: FinInfoBox(
                key: const Key('fin-den-mismatch'),
                text: s.finDenomMismatch(
                  formatRm(_denSum ?? 0),
                  formatRm(_amountSen ?? 0),
                ),
                icon: Icons.error_outline_rounded,
                tone: FinTone.danger,
              ),
            ),
        ],
      ],
    );
  }

  Widget _countersBlock(
    BuildContext context,
    List<({String id, String name})> people,
  ) {
    final s = S.of(context);
    final text = Theme.of(context).textTheme;
    final me = ref.watch(sessionProvider)?.user.id;
    final named = [
      for (final c in _counters)
        if (c.name != null) c,
    ];
    return FinField(
      label: s.finCounters,
      trailing: s.finCountersCount(_counters.length),
      child: Column(
        children: [
          for (final p in people)
            CheckboxListTile(
              key: Key('fin-counter-${p.id}'),
              contentPadding: EdgeInsets.zero,
              controlAffinity: ListTileControlAffinity.leading,
              value: _hasCounter(Counter.user(p.id)),
              onChanged: (_) => _toggleCounter(Counter.user(p.id)),
              title: Text(
                p.id == me ? '${p.name} (${s.finCounterYou})' : p.name,
                style: text.bodyLarge!.copyWith(fontWeight: FontWeight.w600),
              ),
            ),
          for (final c in named)
            CheckboxListTile(
              key: Key('fin-counter-named-${c.name}'),
              contentPadding: EdgeInsets.zero,
              controlAffinity: ListTileControlAffinity.leading,
              value: true,
              onChanged: (_) => _toggleCounter(c),
              title: Text(
                c.name!,
                style: text.bodyLarge!.copyWith(fontWeight: FontWeight.w600),
              ),
            ),
          ListTile(
            key: const Key('fin-counter-other'),
            contentPadding: EdgeInsets.zero,
            leading: const Icon(
              Icons.add_circle_outline_rounded,
              color: SurauColors.teal,
            ),
            title: Text(
              s.finCounterOther,
              style: text.bodyLarge!.copyWith(
                color: SurauColors.teal,
                fontWeight: FontWeight.w600,
              ),
            ),
            onTap: () => setState(() => _otherOpen = !_otherOpen),
          ),
          if (_otherOpen)
            Row(
              children: [
                Expanded(
                  child: TextField(
                    key: const Key('fin-counter-name'),
                    controller: _otherName,
                    decoration: InputDecoration(
                      labelText: s.finCounterOtherLabel,
                    ),
                  ),
                ),
                const SizedBox(width: 8),
                FilledButton(
                  key: const Key('fin-counter-add'),
                  onPressed: () {
                    final n = _otherName.text.trim();
                    if (n.isEmpty) return;
                    _toggleCounter(Counter.named(n));
                    _otherName.clear();
                    setState(() => _otherOpen = false);
                  },
                  child: Text(s.finCounterAdd),
                ),
              ],
            ),
        ],
      ),
    );
  }

  Widget _photoBlock(BuildContext context) {
    final s = S.of(context);
    final text = Theme.of(context).textTheme;
    final photo = _photo;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        if (photo == null)
          OutlinedButton.icon(
            key: const Key('fin-photo-pick'),
            onPressed: _pickPhoto,
            icon: const Icon(Icons.photo_camera_outlined),
            label: Text(s.finPhotoPick),
          )
        else
          Row(
            children: [
              ClipRRect(
                borderRadius: BorderRadius.circular(SurauTheme.radiusChip),
                child: Image.memory(
                  photo,
                  width: 56,
                  height: 56,
                  fit: BoxFit.cover,
                ),
              ),
              const SizedBox(width: 12),
              Expanded(
                child: Text(
                  s.finPhotoReady((photo.length / 1024).ceil()),
                  key: const Key('fin-photo-ready'),
                  style: text.bodyMedium!.copyWith(fontWeight: FontWeight.w600),
                ),
              ),
              TextButton(
                key: const Key('fin-photo-remove'),
                onPressed: () => setState(() => _photo = null),
                child: Text(s.finPhotoRemove),
              ),
            ],
          ),
        if (_photoError != null)
          Padding(
            padding: const EdgeInsets.only(top: 8),
            child: Text(
              _photoError!,
              style: text.bodySmall!.copyWith(color: SurauColors.danger),
            ),
          ),
      ],
    );
  }

  Widget _savedPage(BuildContext context, FinanceEntry saved) {
    final s = S.of(context);
    return FinSavedView(
      title: s.finKutipanTitle,
      entry: saved,
      againLabel: s.finAnotherKutipan,
      onAgain: _again,
    );
  }
}

class _ReviewSheet extends StatelessWidget {
  const _ReviewSheet({
    required this.title,
    required this.rows,
    this.bigWarning,
  });

  final String title;
  final List<(String, String)> rows;
  final String? bigWarning;

  @override
  Widget build(BuildContext context) {
    final s = S.of(context);
    final text = Theme.of(context).textTheme;
    return SingleChildScrollView(
      key: const Key('fin-confirm-sheet'),
      padding: const EdgeInsets.fromLTRB(20, 4, 20, 24),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        mainAxisSize: MainAxisSize.min,
        children: [
          Text(
            title,
            style: text.titleLarge!.copyWith(fontWeight: FontWeight.w700),
          ),
          const SizedBox(height: 6),
          Text(
            s.finConfirmHelp,
            style: text.bodyMedium!.copyWith(color: SurauColors.muted),
          ),
          const SizedBox(height: 14),
          FinKeyValues(rows),
          if (bigWarning != null) ...[
            const SizedBox(height: 12),
            FinInfoBox(
              key: const Key('fin-big-warning'),
              bold: s.finBigTitle,
              text: bigWarning!,
              icon: Icons.warning_amber_rounded,
              tone: FinTone.danger,
            ),
          ],
          const SizedBox(height: 18),
          Row(
            children: [
              Expanded(
                child: TextButton(
                  key: const Key('fin-confirm-back'),
                  onPressed: () => Navigator.of(context).pop(false),
                  child: Text(s.actionBack),
                ),
              ),
              const SizedBox(width: 10),
              Expanded(
                child: FilledButton(
                  key: const Key('fin-confirm-save'),
                  onPressed: () => Navigator.of(context).pop(true),
                  child: Text(s.finConfirmSave),
                ),
              ),
            ],
          ),
        ],
      ),
    );
  }
}

/// The review sheet, shared with the payment screen.
Future<bool> showFinanceReview(
  BuildContext context, {
  required String title,
  required List<(String, String)> rows,
  String? bigWarning,
}) async {
  final ok = await showModalBottomSheet<bool>(
    context: context,
    isScrollControlled: true,
    showDragHandle: true,
    useSafeArea: true,
    constraints: const BoxConstraints(maxWidth: SurauTheme.contentMaxWidth),
    builder: (_) =>
        _ReviewSheet(title: title, rows: rows, bigWarning: bigWarning),
  );
  return ok == true;
}
