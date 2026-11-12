// A whole number with a natural range: the value in teal on the right, the
// slider, the two ends written under it.

import 'package:flutter/material.dart';

import '../../app/theme.dart';
import 'field_meta.dart';

class SliderField extends StatelessWidget {
  const SliderField({
    super.key,
    required this.path,
    required this.label,
    required this.value,
    required this.meta,
    required this.onChanged,
    this.help,
    this.error,
    this.readOnly = false,
  });

  final String path;
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
    final min = meta.min ?? 0;
    final max = meta.max ?? 100;
    final step = meta.step ?? 1;
    final current = value is num ? (value as num).toInt() : min;
    return FieldFrame(
      label: label,
      help: help,
      error: error,
      trailing: Text(
        withUnit(current, meta.unit),
        key: ValueKey('setting-$path-value'),
        style: text.titleMedium!.copyWith(
          color: SurauColors.teal,
          fontWeight: FontWeight.w700,
          fontFeatures: const [FontFeature.tabularFigures()],
        ),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          SliderTheme(
            data: SliderTheme.of(context).copyWith(
              overlayShape: const RoundSliderOverlayShape(overlayRadius: 22),
              // Fine sliders (one second a step) would be a row of dots.
              tickMarkShape: (max - min) ~/ step > 20 ? SliderTickMarkShape.noTickMark : null,
            ),
            child: Slider(
              key: ValueKey('setting-$path'),
              min: min.toDouble(),
              max: max.toDouble(),
              divisions: (max - min) ~/ step,
              value: current.clamp(min, max).toDouble(),
              onChanged: readOnly ? null : (v) => onChanged(v.round()),
            ),
          ),
          Row(
            mainAxisAlignment: MainAxisAlignment.spaceBetween,
            children: [
              Text(withUnit(min, meta.unit), style: text.bodySmall),
              Text(withUnit(max, meta.unit), style: text.bodySmall),
            ],
          ),
        ],
      ),
    );
  }
}
