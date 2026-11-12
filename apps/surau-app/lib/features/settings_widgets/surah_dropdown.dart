// The surah picker (search by name, verse count on each row) and the
// verse range under it: two steppers that never leave the surah and never
// span more than five verses.

import 'package:flutter/material.dart';

import '../../app/theme.dart';
import '../../l10n/generated/s.dart';
import '../registry.g.dart';
import 'field_meta.dart';
import 'named_dropdown.dart';

/// The most verses the card shows at once (core's `ayatCard` rule).
const int maxAyatAtOnce = 5;

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
        title: '$n. ${row[1]}',
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
                        '${r[0]}. ${r[1]}',
                        subtitle: s.settingsAyatCount(r[2] as int),
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
    required this.labelTo,
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
  final String labelTo;

  /// Called with the new `ayatFrom`, then [onTo] when `ayatTo` must follow.
  final void Function(int value) onFrom;
  final void Function(int value) onTo;
  final String? errorFrom;
  final String? errorTo;
  final bool readOnly;

  void _setFrom(int next) {
    onFrom(next);
    if (to < next) onTo(next);
    if (to - next > maxAyatAtOnce - 1) onTo(next + maxAyatAtOnce - 1);
  }

  void _setTo(int next) {
    onTo(next);
    if (from > next) onFrom(next);
    if (next - from > maxAyatAtOnce - 1) onFrom(next - maxAyatAtOnce + 1);
  }

  @override
  Widget build(BuildContext context) {
    final s = S.of(context);
    final text = Theme.of(context).textTheme;
    final row = surahs[surah.clamp(1, surahs.length) - 1];
    final last = row[2] as int;
    final error = errorFrom ?? errorTo;
    return Padding(
      padding: const EdgeInsets.fromLTRB(20, 14, 20, 14),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Row(
            children: [
              Expanded(
                child: _Stepper(
                  stepKey: 'ayatFrom',
                  label: labelFrom,
                  value: from,
                  onMinus: readOnly || from <= 1 ? null : () => _setFrom(from - 1),
                  onPlus: readOnly || from >= last ? null : () => _setFrom(from + 1),
                ),
              ),
              const SizedBox(width: 12),
              Expanded(
                child: _Stepper(
                  stepKey: 'ayatTo',
                  label: labelTo,
                  value: to,
                  onMinus: readOnly || to <= 1 ? null : () => _setTo(to - 1),
                  onPlus: readOnly || to >= last ? null : () => _setTo(to + 1),
                ),
              ),
            ],
          ),
          const SizedBox(height: 8),
          Text(s.settingsAyatHelp(row[1] as String, last), style: text.bodySmall),
          if (error != null) ...[
            const SizedBox(height: 6),
            Text(error, style: text.bodySmall!.copyWith(color: SurauColors.danger)),
          ],
        ],
      ),
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
  });

  final String stepKey;
  final String label;
  final int value;
  final VoidCallback? onMinus;
  final VoidCallback? onPlus;

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
              button(Icons.add_rounded, s.settingsIncrease, 'plus', onPlus),
            ],
          ),
        ),
      ],
    );
  }
}
