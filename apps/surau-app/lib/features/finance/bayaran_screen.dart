// Bayaran: a payment out of a tabung. Two kinds: a penceramah, chosen from
// the kuliah calendar (the speaker, the date and the title come from the
// kuliah and the fee is suggested from the last payment), or any other
// spending (a perihal, a payee, a note). The balance after the payment is
// shown; paying more than the balance warns but saves, as the operator
// decided.

import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../app/shell.dart';
import '../../app/theme.dart';
import '../../content/asset_picker.dart' show pickImageProvider;
import '../../finance/finance_models.dart';
import '../../finance/finance_repository.dart';
import '../../finance/ledger.dart';
import '../../finance/photo_prep.dart';
import '../../l10n/generated/s.dart';
import 'finance_widgets.dart';
import 'kuliah_picker.dart';
import 'kutipan_screen.dart' show showFinanceReview;

class BayaranScreen extends ConsumerStatefulWidget {
  const BayaranScreen({super.key});

  @override
  ConsumerState<BayaranScreen> createState() => _BayaranScreenState();
}

class _BayaranScreenState extends ConsumerState<BayaranScreen> {
  bool _speaker = true;
  KuliahCandidate? _kuliah;
  String? _fundId;
  bool _fundPicked = false;
  String? _perihalId;
  String? _date;
  String _method = 'tunai';
  final _amount = TextEditingController();
  bool _amountTyped = false;
  int? _suggestedSen;
  final _reference = TextEditingController();
  final _payee = TextEditingController();
  final _note = TextEditingController();
  Uint8List? _photo;
  String? _photoError;
  bool _saving = false;
  String? _error;
  FinanceEntry? _saved;

  @override
  void dispose() {
    _amount.dispose();
    _reference.dispose();
    _payee.dispose();
    _note.dispose();
    super.dispose();
  }

  String get _today =>
      ref.read(financeRepositoryProvider)?.todayKl ?? finYmd(DateTime.now());

  Future<void> _pickKuliah(KuliahCandidate k) async {
    final repo = ref.read(financeRepositoryProvider);
    setState(() {
      _kuliah = k;
      _suggestedSen = null;
    });
    if (repo == null) return;
    final last = await repo.lastPayment(k.penceramahId);
    if (!mounted) return;
    setState(() {
      _suggestedSen = last?.amountSen;
      if (last != null && !_amountTyped) {
        _amount.text = _plain(last.amountSen);
      }
      if (!_fundPicked) {
        final preferred = ref.read(financeSettingsProvider).penceramahFundId;
        final funds = ref.read(financeFundsProvider).value ?? const <Fund>[];
        if (preferred.isNotEmpty && funds.any((f) => f.id == preferred)) {
          _fundId = preferred;
        } else if (last != null && funds.any((f) => f.id == last.fundId)) {
          _fundId = last.fundId;
        }
      }
    });
  }

  /// `15000` -> `150.00`, for the amount field.
  String _plain(int sen) =>
      '${sen ~/ 100}.${(sen % 100).toString().padLeft(2, '0')}';

  int? get _amountSen => parseRm(_amount.text);

  /// The date the entry is posted under: the kuliah's day when it falls in
  /// this or last month (an older month may be closed), else today.
  String _entryDate() {
    if (!_speaker) return _date ?? _today;
    final k = _kuliah;
    if (k == null) return _today;
    final t = DateTime.parse('${_today}T00:00:00Z');
    final prev = finYmd(DateTime.utc(t.year, t.month - 1, 1)).substring(0, 7);
    return k.date.substring(0, 7).compareTo(prev) >= 0 &&
            k.date.compareTo(_today) <= 0
        ? k.date
        : _today;
  }

  bool _canReview(String? fundId, String? perihalId) {
    final sen = _amountSen;
    if (sen == null || sen <= 0 || fundId == null || perihalId == null) {
      return false;
    }
    if (_speaker && _kuliah == null) return false;
    if (!_speaker && _payee.text.trim().isEmpty) return false;
    if (_method != 'tunai' && _reference.text.trim().length < 3) return false;
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

  Future<void> _review(String fundName, String perihalLabel) async {
    final s = S.of(context);
    final sen = _amountSen!;
    final big = ref.read(financeSettingsProvider).bigAmountSen;
    final ok = await showFinanceReview(
      context,
      title: s.finConfirmPayTitle,
      rows: [
        (s.finDate, finDmy(_entryDate())),
        (s.finFund, fundName),
        if (_speaker && _kuliah != null) ...[
          (s.finPenceramahName, _kuliah!.penceramahName),
          (s.finKuliahLabel, _kuliah!.title),
        ] else ...[
          (s.finPerihal, perihalLabel),
          (s.finPayee, _payee.text.trim()),
        ],
        (s.finPayMethod, finMethodLabel(s, _method)),
        (s.finAmount, formatRm(sen)),
        if (_method != 'tunai') (s.finReference, _reference.text.trim()),
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
      final funds = await repo.funds();
      final out = await repo.perihal('out');
      final perihalId = _speaker
          ? out
                .where((p) => p.system == 'penceramah')
                .map((p) => p.id)
                .firstOrNull
          : (_perihalId ?? out.where((p) => p.system != 'penceramah').first.id);
      final input = <String, dynamic>{
        'entryDate': _entryDate(),
        'fundId': _fundId ?? funds.first.id,
        'perihalId': perihalId,
        'amountSen': sen,
        'method': _method,
        if (_method != 'tunai') 'reference': _reference.text.trim(),
        if (_speaker) 'kuliahId': _kuliah!.kuliahId,
        if (_speaker) 'penceramahId': _kuliah!.penceramahId,
        if (_speaker) 'penceramahName': _kuliah!.penceramahName,
        if (!_speaker) 'payee': _payee.text.trim(),
        if (_note.text.trim().isNotEmpty) 'note': _note.text.trim(),
      };
      final saved = await repo.appendPayment(input, photo: _photo);
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
      _kuliah = null;
      _suggestedSen = null;
      _amount.clear();
      _amountTyped = false;
      _reference.clear();
      _payee.clear();
      _note.clear();
      _photo = null;
    });
  }

  @override
  Widget build(BuildContext context) {
    final s = S.of(context);
    final saved = _saved;
    if (saved != null) {
      return FinSavedView(
        title: s.finBayaranTitle,
        entry: saved,
        againLabel: s.finAnotherBayaran,
        onAgain: _again,
      );
    }
    final text = Theme.of(context).textTheme;
    final summary = ref.watch(financeSummaryProvider).value;
    final funds = ref.watch(financeFundsProvider).value ?? const <Fund>[];
    final outPerihal =
        ref.watch(financePerihalProvider('out')).value ?? const <Perihal>[];
    final other = [
      for (final p in outPerihal)
        if (p.system != 'penceramah') p,
    ];
    final speakerPerihal = outPerihal
        .where((p) => p.system == 'penceramah')
        .firstOrNull;
    final kuliah =
        ref.watch(financeKuliahProvider).value ?? const <PickerKuliah>[];
    final fundId = _fundId ?? (funds.isEmpty ? null : funds.first.id);
    final perihalId = _speaker
        ? speakerPerihal?.id
        : (_perihalId ?? (other.isEmpty ? null : other.first.id));
    final sen = _amountSen;
    final balance = summary?.funds
        .where((f) => f.fund.id == fundId)
        .map((f) => f.balanceSen)
        .firstOrNull;
    final after = balance == null || sen == null ? null : balance - sen;
    final today = _today;
    final k = _kuliah;

    return ShellPage(
      title: s.finBayaranTitle,
      body: SurauTheme.page(
        children: [
          SegmentedButton<bool>(
            key: const Key('fin-pay-type'),
            segments: [
              ButtonSegment(value: true, label: Text(s.finPayPenceramah)),
              ButtonSegment(value: false, label: Text(s.finPayOther)),
            ],
            selected: {_speaker},
            onSelectionChanged: (v) => setState(() => _speaker = v.first),
          ),
          const SizedBox(height: 14),
          Card(
            child: Padding(
              padding: const EdgeInsets.all(16),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  if (_speaker) ...[
                    FinField(
                      label: s.finKuliahLabel,
                      child: KuliahPickerField(
                        items: kuliah,
                        selected: k?.kuliahId,
                        onPicked: _pickKuliah,
                      ),
                    ),
                    if (k != null)
                      FinField(
                        label: s.finPenceramahName,
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            Text(
                              k.penceramahName,
                              key: const Key('fin-penceramah-name'),
                              style: text.titleMedium!.copyWith(
                                fontWeight: FontWeight.w700,
                              ),
                            ),
                            Text(
                              s.finKuliahOn(k.title, finDmy(k.date)),
                              style: text.bodySmall!.copyWith(
                                color: SurauColors.muted,
                              ),
                            ),
                            if (k.cancelled)
                              Padding(
                                padding: const EdgeInsets.only(top: 8),
                                child: FinInfoBox(
                                  key: const Key('fin-kuliah-cancelled'),
                                  text: s.finKuliahCancelledWarn,
                                  icon: Icons.warning_amber_rounded,
                                  tone: FinTone.danger,
                                ),
                              ),
                            if (k.tonight && !k.paid)
                              Padding(
                                padding: const EdgeInsets.only(top: 8),
                                child: FinInfoBox(
                                  key: const Key('fin-kuliah-tonight'),
                                  text: s.finKuliahTonightInfo,
                                  tone: FinTone.gold,
                                ),
                              ),
                            if (k.paid)
                              Padding(
                                padding: const EdgeInsets.only(top: 8),
                                child: FinInfoBox(
                                  key: const Key('fin-kuliah-paid'),
                                  text: s.finKuliahAlreadyPaid,
                                  icon: Icons.warning_amber_rounded,
                                  tone: FinTone.gold,
                                ),
                              ),
                          ],
                        ),
                      ),
                    if (speakerPerihal == null && outPerihal.isNotEmpty)
                      Padding(
                        padding: const EdgeInsets.only(bottom: 14),
                        child: FinInfoBox(
                          text: s.finNoPenceramahPerihal,
                          icon: Icons.error_outline_rounded,
                          tone: FinTone.danger,
                        ),
                      ),
                  ] else ...[
                    FinField(
                      label: s.finPerihal,
                      child: other.isEmpty
                          ? Text(s.finNoPerihal)
                          : FinChips<String>(
                              items: [for (final p in other) (p.id, p.label)],
                              value: perihalId,
                              onChanged: (v) => setState(() => _perihalId = v),
                            ),
                    ),
                    FinField(
                      label: s.finPayee,
                      child: TextField(
                        key: const Key('fin-payee'),
                        controller: _payee,
                        onChanged: (_) => setState(() {}),
                      ),
                    ),
                    FinField(
                      label: s.finDate,
                      child: InkWell(
                        key: const Key('fin-date'),
                        onTap: () async {
                          final t = DateTime.parse('${today}T00:00:00Z');
                          final picked = await showDatePicker(
                            context: context,
                            initialDate: DateTime.parse(_date ?? today),
                            firstDate: DateTime(t.year, t.month - 1, 1),
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
                            finDmy(_date ?? today),
                            style: text.titleMedium!.copyWith(
                              fontWeight: FontWeight.w600,
                            ),
                          ),
                        ),
                      ),
                    ),
                  ],
                  FinField(
                    label: s.finAmount,
                    help: _speaker && _suggestedSen != null
                        ? s.finSuggestFee(formatRm(_suggestedSen!))
                        : null,
                    child: FinMoneyField(
                      fieldKey: const Key('fin-amount'),
                      controller: _amount,
                      onChanged: () => setState(() => _amountTyped = true),
                    ),
                  ),
                  FinField(
                    label: s.finPayMethod,
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.stretch,
                      children: [
                        FinChips<String>(
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
                        if (_method != 'tunai')
                          Padding(
                            padding: const EdgeInsets.only(top: 10),
                            child: TextField(
                              key: const Key('fin-reference'),
                              controller: _reference,
                              decoration: InputDecoration(
                                hintText: s.finReference,
                              ),
                              onChanged: (_) => setState(() {}),
                            ),
                          ),
                      ],
                    ),
                  ),
                  FinField(
                    label: s.finPaidFrom,
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.stretch,
                      children: [
                        funds.isEmpty
                            ? Text(s.finNoFunds)
                            : FinChips<String>(
                                items: [for (final f in funds) (f.id, f.name)],
                                value: fundId,
                                onChanged: (v) => setState(() {
                                  _fundId = v;
                                  _fundPicked = true;
                                }),
                              ),
                        if (balance != null && after != null)
                          Padding(
                            padding: const EdgeInsets.only(top: 8),
                            child: Text(
                              s.finBalanceAfter(
                                funds
                                    .where((f) => f.id == fundId)
                                    .map((f) => f.name)
                                    .first,
                                formatRm(balance),
                                formatRm(after),
                              ),
                              key: const Key('fin-balance-after'),
                              style: text.bodySmall!.copyWith(
                                color: SurauColors.muted,
                              ),
                            ),
                          ),
                        if (after != null && after < 0)
                          Padding(
                            padding: const EdgeInsets.only(top: 8),
                            child: FinInfoBox(
                              key: const Key('fin-overdraw'),
                              text: s.finOverdraw,
                              icon: Icons.warning_amber_rounded,
                              tone: FinTone.gold,
                            ),
                          ),
                      ],
                    ),
                  ),
                  FinField(
                    label: _speaker ? s.finPhotoVoucher : s.finPhotoReceipt,
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
            onPressed: !_canReview(fundId, perihalId) || _saving
                ? null
                : () => _review(
                    funds
                            .where((f) => f.id == fundId)
                            .map((f) => f.name)
                            .firstOrNull ??
                        '',
                    outPerihal
                            .where((p) => p.id == perihalId)
                            .map((p) => p.label)
                            .firstOrNull ??
                        '',
                  ),
            icon: const Icon(Icons.check_rounded),
            label: Text(s.finReview),
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
}
