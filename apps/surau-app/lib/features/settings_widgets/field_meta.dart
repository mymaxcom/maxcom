// What the generated metadata says about one setting, read as a typed value,
// and the frame every metadata widget sits in: label, optional value on the
// right, the control, a help sentence, the red line.

import 'package:flutter/material.dart';

import '../../app/theme.dart';
import '../registry.g.dart';

class FieldMeta {
  const FieldMeta(this.raw);

  final Map<String, Object?> raw;

  String? get ui => raw['ui'] as String?;
  int? get step => (raw['step'] as num?)?.toInt();
  int? get min => (raw['min'] as num?)?.toInt();
  int? get max => (raw['max'] as num?)?.toInt();
  int? get maxLen => (raw['maxLen'] as num?)?.toInt();
  String? get unit => raw['unit'] as String?;
  bool get isSystem => raw['scope'] == 'system';
  bool get testable => raw['testable'] == true;
  bool get readOnly => raw['readOnly'] == true;

  List<Object> get choices => [...?(raw['choices'] as List?)?.cast<Object>()];
  List<String> get disabledChoices => [...?(raw['disabledChoices'] as List?)?.cast<String>()];
  List<String> get presets => [...?(raw['presets'] as List?)?.cast<String>()];
}

/// The metadata of [path] (dot-joined for a nested value) in [feature].
FieldMeta? fieldMeta(String feature, String path) {
  final raw = fieldMetaTable[feature]?[path];
  return raw == null ? null : FieldMeta(raw);
}

/// A number with its unit as the mockup writes it: `2500 kbps`, `60%`.
String withUnit(num value, String? unit) {
  if (unit == null) return '$value';
  return unit == '%' ? '$value%' : '$value $unit';
}

/// Label (and optional [trailing]) over [child], then help and error.
class FieldFrame extends StatelessWidget {
  const FieldFrame({
    super.key,
    required this.label,
    required this.child,
    this.trailing,
    this.help,
    this.error,
    this.padding = const EdgeInsets.fromLTRB(20, 14, 20, 14),
  });

  final EdgeInsets padding;
  final String label;
  final Widget child;
  final Widget? trailing;
  final String? help;
  final String? error;

  @override
  Widget build(BuildContext context) {
    final text = Theme.of(context).textTheme;
    return Padding(
      padding: padding,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Row(
            crossAxisAlignment: CrossAxisAlignment.baseline,
            textBaseline: TextBaseline.alphabetic,
            children: [
              Expanded(
                child: Text(label, style: text.bodyLarge!.copyWith(fontWeight: FontWeight.w600)),
              ),
              if (trailing != null) ...[const SizedBox(width: 8), trailing!],
            ],
          ),
          const SizedBox(height: 10),
          child,
          if (help != null) ...[
            const SizedBox(height: 8),
            Text(help!, style: text.bodySmall),
          ],
          if (error != null) ...[
            const SizedBox(height: 6),
            Text(error!, style: text.bodySmall!.copyWith(color: SurauColors.danger)),
          ],
        ],
      ),
    );
  }
}
