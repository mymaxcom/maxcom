// One day of Data waktu solat: its times, what the calculation says, and a
// manual correction (a time and a mandatory reason) for one prayer. A
// correction sits on top of every source and survives a new download.

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../app/theme.dart';
import '../../l10n/generated/s.dart';
import '../../screens/widgets/pieces.dart';
import 'location_screen.dart';
import 'prayer_repository.dart';
import 'sources_screen.dart' show prayerKeys, prayerNamesMs;
import 'widgets/country_picker.dart' show InfoBox, InfoTone;

/// True when the day was changed.
Future<bool> showDaySheet(BuildContext context, ResolvedDay day) async {
  final changed = await showModalBottomSheet<bool>(
    context: context,
    useSafeArea: true,
    isScrollControlled: true,
    constraints: const BoxConstraints(maxWidth: 560),
    builder: (context) => DaySheet(day: day),
  );
  return changed ?? false;
}

const List<String> _weekdaysMs = ['Isnin', 'Selasa', 'Rabu', 'Khamis', 'Jumaat', 'Sabtu', 'Ahad'];

final RegExp _timeRe = RegExp(r'^([01]\d|2[0-3]):[0-5]\d$');

class DaySheet extends ConsumerStatefulWidget {
  const DaySheet({super.key, required this.day});

  final ResolvedDay day;

  @override
  ConsumerState<DaySheet> createState() => _DaySheetState();
}

class _DaySheetState extends ConsumerState<DaySheet> {
  ResolvedDay? _calc;
  String _prayer = 'subuh';
  late final _time = TextEditingController(text: widget.day.times[_prayer] ?? '');
  final _reason = TextEditingController();
  bool _busy = false;
  String? _error;

  @override
  void initState() {
    super.initState();
    _loadCalc();
  }

  @override
  void dispose() {
    _time.dispose();
    _reason.dispose();
    super.dispose();
  }

  Future<void> _loadCalc() async {
    final repo = ref.read(prayerRepositoryProvider);
    if (repo == null) return;
    try {
      final c = await repo.calcPreview(widget.day.date);
      if (mounted) setState(() => _calc = c);
    } catch (_) {
      // The column stays empty; the correction does not need it.
    }
  }

  void _choose(String p) => setState(() {
    _prayer = p;
    _time.text = widget.day.times[p] ?? '';
    _error = null;
  });

  void _step(int delta) {
    final t = _time.text.trim();
    if (!_timeRe.hasMatch(t)) return;
    final total = (int.parse(t.substring(0, 2)) * 60 + int.parse(t.substring(3, 5)) + delta) % 1440;
    setState(() {
      _time.text = '${(total ~/ 60).toString().padLeft(2, '0')}:${(total % 60).toString().padLeft(2, '0')}';
    });
  }

  Future<void> _save() async {
    final s = S.of(context);
    final repo = ref.read(prayerRepositoryProvider);
    final time = _time.text.trim();
    final reason = _reason.text.trim();
    if (repo == null || _busy) return;
    if (!_timeRe.hasMatch(time)) {
      setState(() => _error = s.pdTimeInvalid);
      return;
    }
    if (reason.length < 3 || reason.length > 200) {
      setState(() => _error = s.pdReasonNeeded);
      return;
    }
    await _run(() => repo.putCorrection(widget.day.date, _prayer, time, reason));
  }

  Future<void> _remove() async {
    final repo = ref.read(prayerRepositoryProvider);
    if (repo == null || _busy) return;
    await _run(() => repo.removeCorrection(widget.day.date, _prayer));
  }

  Future<void> _run(Future<Object?> Function() action) async {
    final s = S.of(context);
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      await action();
      if (mounted) Navigator.of(context).pop(true);
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _busy = false;
        _error = prayerErrorText(s, e);
      });
    }
  }

  String _sourceName(S s, ResolvedDay d) {
    if (d.corrected.isNotEmpty) return s.pdLegendCorrection;
    return switch (d.source) {
      'official' => s.pdLegendOfficial,
      'file' => s.pdLegendFile,
      _ => s.pdLegendCalc,
    };
  }

  String _overrideLabel(S s, String key) {
    if (key == 'jumaat_khutbah') return s.pdOverrideKhutbah;
    if (key.startsWith('iqamah_')) return s.pdOverrideIqamah(prayerNamesMs[key.substring(7)] ?? key.substring(7));
    return key;
  }

  @override
  Widget build(BuildContext context) {
    final s = S.of(context);
    final text = Theme.of(context).textTheme;
    final d = widget.day;
    final date = DateTime.parse(d.date);
    final head = text.labelSmall!.copyWith(color: SurauColors.muted, fontWeight: FontWeight.w700);
    final num = text.bodyMedium!.copyWith(fontFeatures: const [FontFeature.tabularFigures()]);
    Widget row(Widget a, Widget b, Widget c) => Padding(
      padding: const EdgeInsets.symmetric(vertical: 5),
      child: Row(children: [Expanded(flex: 4, child: a), Expanded(flex: 3, child: b), Expanded(flex: 3, child: c)]),
    );
    return SingleChildScrollView(
      padding: EdgeInsets.fromLTRB(20, 0, 20, 20 + MediaQuery.viewInsetsOf(context).bottom),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Text(
            '${_weekdaysMs[date.weekday - 1]}, ${date.day} ${monthsLongMs[date.month - 1]} ${date.year}',
            style: text.titleLarge,
          ),
          const SizedBox(height: 6),
          Wrap(
            spacing: 8,
            runSpacing: 6,
            crossAxisAlignment: WrapCrossAlignment.center,
            children: [
              StateChip(
                label: _sourceName(s, d),
                background: d.corrected.isNotEmpty ? SurauColors.goldSoft : SurauColors.tealSoft,
                foreground: d.corrected.isNotEmpty ? SurauColors.ink : SurauColors.teal,
              ),
              if (d.emergency)
                StateChip(label: s.pdEmergency, background: SurauColors.goldSoft, foreground: SurauColors.ink),
            ],
          ),
          const SizedBox(height: 12),
          row(Text(s.srcPreviewPrayer, style: head), Text(s.pdUsed, style: head), Text(s.srcCalcShort, style: head)),
          const Divider(),
          for (final p in prayerKeys)
            row(
              Text(prayerNamesMs[p]!, style: num.copyWith(fontWeight: FontWeight.w600)),
              Text(
                d.times[p] ?? '-',
                style: num.copyWith(
                  fontWeight: FontWeight.w700,
                  color: d.corrected.contains(p) ? const Color(0xFF8A5B00) : null,
                ),
              ),
              Text(_calc?.times[p] ?? '-', style: num.copyWith(color: SurauColors.muted)),
            ),
          if (d.dhuha != null) row(Text('Dhuha', style: num.copyWith(fontWeight: FontWeight.w600)), Text(d.dhuha!, style: num), const SizedBox.shrink()),
          if (d.imsakDerived) Text(s.pdImsakDerived, style: text.bodySmall),
          for (final e in (d.overrides ?? const <String, String>{}).entries)
            Text('${_overrideLabel(s, e.key)}: ${e.value}', style: text.bodySmall),
          const Divider(height: 24),
          Text(s.pdCorrectionTitle, style: text.titleSmall),
          const SizedBox(height: 8),
          Wrap(
            spacing: 6,
            runSpacing: 2,
            children: [
              for (final p in prayerKeys)
                ChoiceChip(
                  key: ValueKey('pd-cor-prayer-$p'),
                  label: Text(prayerNamesMs[p]!),
                  selected: p == _prayer,
                  onSelected: (_) => _choose(p),
                ),
            ],
          ),
          const SizedBox(height: 10),
          Row(
            children: [
              IconButton(
                tooltip: s.srcLess,
                icon: const Icon(Icons.remove_rounded),
                color: SurauColors.teal,
                onPressed: () => _step(-1),
              ),
              Expanded(
                child: TextField(
                  key: const ValueKey('pd-cor-time'),
                  controller: _time,
                  textAlign: TextAlign.center,
                  keyboardType: TextInputType.datetime,
                  decoration: InputDecoration(labelText: s.pdCorrectionTime),
                  onChanged: (_) => setState(() => _error = null),
                ),
              ),
              IconButton(
                tooltip: s.srcMore,
                icon: const Icon(Icons.add_rounded),
                color: SurauColors.teal,
                onPressed: () => _step(1),
              ),
            ],
          ),
          const SizedBox(height: 10),
          TextField(
            key: const ValueKey('pd-cor-reason'),
            controller: _reason,
            maxLength: 200,
            decoration: InputDecoration(labelText: s.pdCorrectionReason, hintText: s.pdCorrectionReasonHint, counterText: ''),
            onChanged: (_) => setState(() => _error = null),
          ),
          if (_error != null) ...[const SizedBox(height: 10), ErrorLine(_error!)],
          const SizedBox(height: 12),
          FilledButton(
            key: const ValueKey('pd-cor-save'),
            onPressed: _busy ? null : _save,
            child: Text(s.pdCorrectionSave),
          ),
          if (d.corrected.contains(_prayer) && d.officialChanged.contains(_prayer)) ...[
            const SizedBox(height: 8),
            InfoBox(
              key: const ValueKey('pd-official-changed'),
              tone: InfoTone.gold,
              icon: Icons.info_outline_rounded,
              child: Text(s.pdOfficialChanged),
            ),
          ],
          if (d.correctionIgnored.contains(_prayer)) ...[
            const SizedBox(height: 8),
            InfoBox(
              key: const ValueKey('pd-correction-ignored'),
              tone: InfoTone.gold,
              icon: Icons.info_outline_rounded,
              child: Text(s.pdCorrectionIgnored),
            ),
          ],
          if (d.corrected.contains(_prayer) || d.correctionIgnored.contains(_prayer)) ...[
            const SizedBox(height: 4),
            TextButton(
              key: const ValueKey('pd-cor-remove'),
              onPressed: _busy ? null : _remove,
              child: Text(s.pdCorrectionRemove),
            ),
          ],
        ],
      ),
    );
  }
}
