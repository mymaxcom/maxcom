// A short set of choices as chips, and the larger choice cards (radio dot,
// name, one sentence) for a setting whose choices need explaining.

import 'package:flutter/material.dart';

import '../../app/theme.dart';
import '../../l10n/generated/s.dart';
import '../labels_ms.dart';
import 'field_meta.dart';

class ChipsField extends StatelessWidget {
  const ChipsField({
    super.key,
    required this.path,
    required this.name,
    required this.label,
    required this.value,
    required this.meta,
    required this.onChanged,
    this.help,
    this.error,
    this.readOnly = false,
    this.padding = const EdgeInsets.fromLTRB(20, 14, 20, 14),
  });

  /// Inside a card that already has side padding, less of its own.
  final EdgeInsets padding;
  final String path;
  final String name;
  final String label;
  final Object? value;
  final FieldMeta meta;
  final void Function(Object? value) onChanged;
  final String? help;
  final String? error;
  final bool readOnly;

  @override
  Widget build(BuildContext context) {
    final text = Theme.of(context).textTheme;
    final choices = meta.choices;
    final shown = [
      ...choices,
      // A stored value outside the chips (set before they existed) stays visible.
      if (value != null && !choices.any((c) => '$c' == '$value')) value!,
    ];
    return FieldFrame(
      label: label,
      help: help,
      error: error,
      padding: padding,
      child: Wrap(
        key: ValueKey('setting-$path'),
        spacing: 8,
        runSpacing: 8,
        children: [
          for (final c in shown)
            ChoiceChip(
              key: ValueKey('setting-$path-$c'),
              label: Text(choiceLabelMs(name, '$c')),
              selected: '$c' == '$value',
              showCheckmark: false,
              onSelected: readOnly ? null : (_) => onChanged(c),
              labelStyle: text.labelLarge!.copyWith(
                color: '$c' == '$value' ? SurauColors.glass : SurauColors.text,
                fontWeight: FontWeight.w600,
              ),
              backgroundColor: SurauColors.paperDeep,
              selectedColor: SurauColors.tealSoft,
              disabledColor: SurauColors.paperDeep,
              side: BorderSide(
                color: '$c' == '$value' ? SurauColors.teal : SurauColors.paperDeep,
                width: 1.5,
              ),
              shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(SurauTheme.radiusChip)),
              padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 8),
            ),
        ],
      ),
    );
  }
}

/// One card per choice: a radio dot, the choice's name and its sentence
/// ([choiceHelpMs]). A disabled choice stays drawn with its hint.
class ChoiceCards extends StatelessWidget {
  const ChoiceCards({
    super.key,
    required this.path,
    required this.name,
    required this.label,
    required this.value,
    required this.meta,
    required this.onChanged,
    this.error,
    this.readOnly = false,
  });

  final String path;
  final String name;
  final String label;
  final String value;
  final FieldMeta meta;
  final void Function(String value) onChanged;
  final String? error;
  final bool readOnly;

  @override
  Widget build(BuildContext context) {
    final s = S.of(context);
    final text = Theme.of(context).textTheme;
    final disabled = meta.disabledChoices;
    return FieldFrame(
      label: label,
      error: error,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          for (final (i, c) in meta.choices.map((c) => '$c').indexed) ...[
            if (i > 0) const SizedBox(height: 10),
            _Card(
              key: ValueKey('setting-$path-$c'),
              title: choiceLabelMs(name, c),
              sentence: choiceHelpMs[name]?[c],
              hint: disabled.contains(c) ? s.settingsComingSoon : null,
              selected: c == value,
              onTap: readOnly || disabled.contains(c) ? null : () => onChanged(c),
              text: text,
            ),
          ],
        ],
      ),
    );
  }
}

class _Card extends StatelessWidget {
  const _Card({
    super.key,
    required this.title,
    required this.sentence,
    required this.hint,
    required this.selected,
    required this.onTap,
    required this.text,
  });

  final String title;
  final String? sentence;
  final String? hint;
  final bool selected;
  final VoidCallback? onTap;
  final TextTheme text;

  @override
  Widget build(BuildContext context) {
    final off = hint != null;
    final radius = BorderRadius.circular(16);
    return Material(
      color: selected ? const Color(0xFFF8FCFB) : SurauColors.card,
      shape: RoundedRectangleBorder(
        borderRadius: radius,
        side: BorderSide(color: selected ? SurauColors.teal : SurauColors.line, width: selected ? 2 : 1),
      ),
      child: InkWell(
        borderRadius: radius,
        onTap: onTap,
        child: Padding(
          padding: const EdgeInsets.all(14),
          child: Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Container(
                width: 22,
                height: 22,
                margin: const EdgeInsets.only(top: 1),
                decoration: BoxDecoration(
                  shape: BoxShape.circle,
                  color: SurauColors.card,
                  border: Border.all(color: selected ? SurauColors.teal : SurauColors.outline, width: 2),
                ),
                alignment: Alignment.center,
                child: selected
                    ? Container(
                        width: 10,
                        height: 10,
                        decoration: const BoxDecoration(shape: BoxShape.circle, color: SurauColors.teal),
                      )
                    : null,
              ),
              const SizedBox(width: 12),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      title,
                      style: text.bodyLarge!.copyWith(
                        fontWeight: FontWeight.w700,
                        color: off ? SurauColors.muted : SurauColors.text,
                      ),
                    ),
                    if (sentence != null) ...[
                      const SizedBox(height: 3),
                      Text(sentence!, style: text.bodyMedium!.copyWith(color: SurauColors.muted)),
                    ],
                    if (hint != null) ...[
                      const SizedBox(height: 6),
                      Text(hint!, style: text.bodySmall!.copyWith(color: SurauColors.teal, fontWeight: FontWeight.w600)),
                    ],
                  ],
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
