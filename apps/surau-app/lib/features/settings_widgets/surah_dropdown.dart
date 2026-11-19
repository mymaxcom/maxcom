// The surah picker (search by name, verse count on each row) and the
// verse range under it: "start at verse" (stepper, or tap the number to type
// it) and "number of verses" chips, never past the surah's end and never more
// than three verses, with a line saying what the TV will show.

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../../app/theme.dart';
import '../../l10n/generated/s.dart';
import '../registry.g.dart';
import '../surah_names.dart';
import '../validate.dart' show maxAyatAtOnce;
import 'field_meta.dart';
import 'named_dropdown.dart';

int surahAyatCount(int surah) => surahs[surah.clamp(1, surahs.length) - 1][2] as int;

class SurahDropdown extends StatelessWidget {
  const SurahDropdown({
    super.key,
    required this.path,
    required this.label,
    required this.value,
    required this.onChanged,
    this.error,
    this.readOnly = false,
  });

  final String path;
  final String label;
  final Object? value;
  final void Function(Object? value) onChanged;
  final String? error;
  final bool readOnly;

  @override
  Widget build(BuildContext context) {
    final s = S.of(context);
    final n = value is num ? (value as num).toInt().clamp(1, surahs.length) : 1;
    final row = surahs[n - 1];
    return FieldFrame(
      label: label,
      error: error,
      child: PickerButton(
        key: ValueKey('setting-$path'),
        title: surahNumbered(s, n),
        subtitle: s.settingsAyatCount(row[2] as int),
        onTap: readOnly
            ? null
            : () async {
                final picked = await showPickerSheet<int>(
                  context,
                  title: label,
                  selected: n,
                  searchHint: s.settingsSurahSearch,
                  options: [
                    for (final r in surahs)
                      PickerOption(
                        r[0] as int,
                        surahNumbered(s, r[0] as int),
                        subtitle: s.settingsAyatCount(r[2] as int),
                        search: surahSearchText(r[0] as int),
                      ),
                  ],
                );
                if (picked != null) onChanged(picked);
              },
      ),
    );
  }
}

class AyatRange extends StatelessWidget {
  const AyatRange({
    super.key,
    required this.surah,
    required this.from,
    required this.to,
    required this.labelFrom,
    required this.onFrom,
    required this.onTo,
    this.errorFrom,
    this.errorTo,
    this.readOnly = false,
  });

  final int surah;
  final int from;
  final int to;
  final String labelFrom;

  /// Called with the new `ayatFrom`, then [onTo] with the matching `ayatTo`: the two always move together.
  final void Function(int value) onFrom;
  final void Function(int value) onTo;
  final String? errorFrom;
  final String? errorTo;
  final bool readOnly;

  /// Start verse and count the picker shows for the stored range: inside the surah and at most
  /// [maxAyatAtOnce] verses (an older stored range of four or five verses shows its first three).
  static ({int start, int count, bool shortened}) shown(int surah, int from, int to) {
    final last = surahAyatCount(surah);
    final start = from.clamp(1, last);
    final raw = to - from + 1;
    final cut = raw.clamp(1, maxAyatAtOnce);
    return (start: start, count: cut.clamp(1, last - start + 1), shortened: raw > maxAyatAtOnce);
  }

  void _setStart(int next, int count) {
    final last = surahAyatCount(surah);
    final start = next.clamp(1, last);
    onFrom(start);
    onTo(start + count.clamp(1, last - start + 1) - 1);
  }

  void _setCount(int start, int count) {
    onFrom(start);
    onTo(start + count - 1);
  }

  Future<void> _type(BuildContext context, int start, int count, int last) async {
    final picked = await showDialog<int>(
      context: context,
      builder: (_) => _VerseNumberDialog(title: labelFrom, initial: start, last: last),
    );
    if (picked != null) _setStart(picked, count);
  }

  @override
  Widget build(BuildContext context) {
    final s = S.of(context);
    final text = Theme.of(context).textTheme;
    final row = surahs[surah.clamp(1, surahs.length) - 1];
    final last = row[2] as int;
    final name = surahName(s, surah.clamp(1, surahs.length));
    final v = shown(surah, from, to);
    final end = v.start + v.count - 1;
    final cutOff = [for (var c = 1; c <= maxAyatAtOnce; c++) if (v.start + c - 1 > last) c];
    final error = errorFrom ?? errorTo;
    return Padding(
      padding: const EdgeInsets.fromLTRB(20, 14, 20, 14),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          _Stepper(
            stepKey: 'ayatFrom',
            label: labelFrom,
            value: v.start,
            onMinus: readOnly || v.start <= 1 ? null : () => _setStart(v.start - 1, v.count),
            onPlus: readOnly || v.start >= last ? null : () => _setStart(v.start + 1, v.count),
            onTapValue: readOnly ? null : () => _type(context, v.start, v.count, last),
          ),
          const SizedBox(height: 14),
          Text(s.settingsAyatCountLabel, style: text.bodySmall),
          const SizedBox(height: 6),
          Wrap(
            spacing: 8,
            runSpacing: 8,
            children: [
              for (var c = 1; c <= maxAyatAtOnce; c++)
                ChoiceChip(
                  key: ValueKey('setting-ayatCount-$c'),
                  label: Text('$c'),
                  selected: c == v.count,
                  showCheckmark: false,
                  onSelected: readOnly || cutOff.contains(c) ? null : (_) => _setCount(v.start, c),
                  labelStyle: text.labelLarge!.copyWith(
                    color: cutOff.contains(c)
                        ? SurauColors.line
                        : (c == v.count ? SurauColors.glass : SurauColors.text),
                    fontWeight: FontWeight.w600,
                  ),
                  backgroundColor: SurauColors.paperDeep,
                  selectedColor: SurauColors.tealSoft,
                  disabledColor: SurauColors.paperDeep,
                  side: BorderSide(color: c == v.count ? SurauColors.teal : SurauColors.paperDeep, width: 1.5),
                  shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(SurauTheme.radiusChip)),
                  padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 8),
                ),
            ],
          ),
          if (cutOff.isNotEmpty) ...[
            const SizedBox(height: 6),
            Text(s.settingsAyatSurahEnds(last), key: const ValueKey('setting-ayat-ends'), style: text.bodySmall),
          ],
          const SizedBox(height: 8),
          Text(s.settingsAyatHelp(name, last), style: text.bodySmall),
          if (v.shortened) ...[
            const SizedBox(height: 6),
            Text(s.settingsAyatOldRange, key: const ValueKey('setting-ayat-old'), style: text.bodySmall),
          ],
          const SizedBox(height: 10),
          Container(
            key: const ValueKey('setting-ayat-summary'),
            padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
            decoration: BoxDecoration(
              color: SurauColors.paperDeep,
              borderRadius: BorderRadius.circular(SurauTheme.radiusControl),
            ),
            child: Text(
              v.count == 1
                  ? s.settingsAyatTvOne(name, last, v.start)
                  : s.settingsAyatTv(name, last, v.start, end),
              style: text.bodyMedium!.copyWith(fontWeight: FontWeight.w600),
            ),
          ),
          if (error != null) ...[
            const SizedBox(height: 6),
            Text(error, style: text.bodySmall!.copyWith(color: SurauColors.danger)),
          ],
        ],
      ),
    );
  }
}

/// Type a verse number: 1 to [last]; a wrong entry says so under the field and the dialog stays open.
class _VerseNumberDialog extends StatefulWidget {
  const _VerseNumberDialog({required this.title, required this.initial, required this.last});

  final String title;
  final int initial;
  final int last;

  @override
  State<_VerseNumberDialog> createState() => _VerseNumberDialogState();
}

class _VerseNumberDialogState extends State<_VerseNumberDialog> {
  late final TextEditingController _c = TextEditingController(text: '${widget.initial}');
  bool _bad = false;

  @override
  void dispose() {
    _c.dispose();
    super.dispose();
  }

  void _submit() {
    final n = int.tryParse(_c.text.trim());
    if (n == null || n < 1 || n > widget.last) {
      setState(() => _bad = true);
      return;
    }
    Navigator.of(context).pop(n);
  }

  @override
  Widget build(BuildContext context) {
    final s = S.of(context);
    return AlertDialog(
      title: Text(widget.title),
      content: TextField(
        key: const ValueKey('setting-ayatFrom-input'),
        controller: _c,
        autofocus: true,
        keyboardType: TextInputType.number,
        inputFormatters: [FilteringTextInputFormatter.digitsOnly],
        decoration: InputDecoration(
          hintText: s.settingsAyatTypeHint(widget.last),
          errorText: _bad ? s.settingsAyatTypeError(widget.last) : null,
        ),
        onChanged: (_) {
          if (_bad) setState(() => _bad = false);
        },
        onSubmitted: (_) => _submit(),
      ),
      actions: [
        TextButton(onPressed: () => Navigator.of(context).pop(), child: Text(s.actionCancel)),
        TextButton(
          key: const ValueKey('setting-ayatFrom-input-ok'),
          onPressed: _submit,
          child: Text(s.settingsSave),
        ),
      ],
    );
  }
}

class _Stepper extends StatelessWidget {
  const _Stepper({
    required this.stepKey,
    required this.label,
    required this.value,
    required this.onMinus,
    required this.onPlus,
    this.onTapValue,
  });

  final String stepKey;
  final String label;
  final int value;
  final VoidCallback? onMinus;
  final VoidCallback? onPlus;

  /// Tapping the number opens a field to type it.
  final VoidCallback? onTapValue;

  @override
  Widget build(BuildContext context) {
    final s = S.of(context);
    final text = Theme.of(context).textTheme;
    Widget button(IconData icon, String tip, String suffix, VoidCallback? onTap) => SizedBox(
      width: 48,
      height: 52,
      child: Material(
        color: SurauColors.paper,
        child: InkWell(
          key: ValueKey('setting-$stepKey-$suffix'),
          onTap: onTap,
          child: Tooltip(
            message: tip,
            child: Icon(icon, color: onTap == null ? SurauColors.line : SurauColors.teal),
          ),
        ),
      ),
    );
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(label, style: text.bodySmall),
        const SizedBox(height: 6),
        Container(
          clipBehavior: Clip.antiAlias,
          decoration: BoxDecoration(
            color: SurauColors.card,
            borderRadius: BorderRadius.circular(SurauTheme.radiusControl),
            border: Border.all(color: SurauColors.line),
          ),
          child: Row(
            children: [
              button(Icons.remove_rounded, s.settingsDecrease, 'minus', onMinus),
              Expanded(
                child: InkWell(
                  key: ValueKey('setting-$stepKey-edit'),
                  onTap: onTapValue,
                  child: Container(
                    height: 52,
                    alignment: Alignment.center,
                    child: Text(
                      '$value',
                      key: ValueKey('setting-$stepKey-value'),
                      textAlign: TextAlign.center,
                      style: text.titleMedium!.copyWith(
                        fontWeight: FontWeight.w700,
                        fontFeatures: const [FontFeature.tabularFigures()],
                      ),
                    ),
                  ),
                ),
              ),
              button(Icons.add_rounded, s.settingsIncrease, 'plus', onPlus),
            ],
          ),
        ),
      ],
    );
  }
}
