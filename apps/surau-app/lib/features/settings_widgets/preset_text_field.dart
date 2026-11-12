// A short message: ready-made sentences as chips above a text row with a
// counter. The chips write the row; typing is still allowed.

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../../app/theme.dart';
import '../../l10n/generated/s.dart';
import 'field_meta.dart';

class PresetTextField extends StatefulWidget {
  const PresetTextField({
    super.key,
    required this.path,
    required this.label,
    required this.value,
    required this.meta,
    required this.onChanged,
    this.error,
    this.readOnly = false,
  });

  final String path;
  final String label;
  final String value;
  final FieldMeta meta;
  final void Function(Object? value) onChanged;
  final String? error;
  final bool readOnly;

  @override
  State<PresetTextField> createState() => _PresetTextFieldState();
}

class _PresetTextFieldState extends State<PresetTextField> {
  late final TextEditingController _c = TextEditingController(text: widget.value);

  @override
  void didUpdateWidget(covariant PresetTextField old) {
    super.didUpdateWidget(old);
    if (_c.text != widget.value) _c.text = widget.value;
  }

  @override
  void dispose() {
    _c.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final s = S.of(context);
    final text = Theme.of(context).textTheme;
    final max = widget.meta.maxLen ?? 100;
    final n = widget.value.length;
    return FieldFrame(
      label: widget.label,
      error: widget.error,
      help: s.settingsPresetHelp,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Wrap(
            spacing: 8,
            runSpacing: 8,
            children: [
              for (final (i, p) in widget.meta.presets.indexed)
                ChoiceChip(
                  key: ValueKey('preset-$i'),
                  label: Text(p),
                  selected: p == widget.value,
                  showCheckmark: false,
                  onSelected: widget.readOnly ? null : (_) => widget.onChanged(p),
                  labelStyle: text.labelLarge!.copyWith(
                    color: p == widget.value ? SurauColors.glass : SurauColors.text,
                    fontWeight: FontWeight.w600,
                  ),
                  backgroundColor: SurauColors.paperDeep,
                  selectedColor: SurauColors.tealSoft,
                  side: BorderSide(color: p == widget.value ? SurauColors.teal : SurauColors.paperDeep, width: 1.5),
                  shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(SurauTheme.radiusChip)),
                ),
            ],
          ),
          const SizedBox(height: 12),
          TextField(
            key: ValueKey('setting-${widget.path}'),
            controller: _c,
            enabled: !widget.readOnly,
            inputFormatters: [LengthLimitingTextInputFormatter(max)],
            onChanged: widget.onChanged,
          ),
          const SizedBox(height: 4),
          Text(
            '$n / $max',
            key: ValueKey('preset-count-${widget.path}'),
            textAlign: TextAlign.end,
            style: text.bodySmall!.copyWith(
              color: n >= max ? SurauColors.danger : SurauColors.muted,
              fontWeight: n >= max ? FontWeight.w700 : null,
              fontFeatures: const [FontFeature.tabularFigures()],
            ),
          ),
        ],
      ),
    );
  }
}
