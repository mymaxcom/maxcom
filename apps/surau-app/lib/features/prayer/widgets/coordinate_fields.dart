// Latitude and longitude typed in decimal degrees, stored to 4 places. A
// pasted `3.2486, 101.6556` in either field splits into both.

import 'package:flutter/material.dart';

import '../../../l10n/generated/s.dart';

final RegExp _pair = RegExp(r'^\s*(-?\d+(?:\.\d+)?)\s*[,;\s]\s*(-?\d+(?:\.\d+)?)\s*$');
final RegExp _number = RegExp(r'^-?\d+(?:\.\d+)?$');

/// The value of [text] when it is a number from [min] to [max], to 4 places.
double? parseCoordinate(String text, double min, double max) {
  final t = text.trim();
  if (!_number.hasMatch(t)) return null;
  final v = double.parse(t);
  if (v < min || v > max) return null;
  return double.parse(v.toStringAsFixed(4));
}

double? parseLatitude(String text) => parseCoordinate(text, -90, 90);

double? parseLongitude(String text) => parseCoordinate(text, -180, 180);

/// [v] to 4 places, the way the fields show it.
String formatCoordinate(num v) => v.toStringAsFixed(4);

class CoordinateFields extends StatefulWidget {
  const CoordinateFields({
    super.key,
    required this.latitude,
    required this.longitude,
    this.onChanged,
    this.enabled = true,
  });

  static const Key latitudeKey = ValueKey('loc-latitude');
  static const Key longitudeKey = ValueKey('loc-longitude');

  final TextEditingController latitude;
  final TextEditingController longitude;
  final VoidCallback? onChanged;
  final bool enabled;

  @override
  State<CoordinateFields> createState() => _CoordinateFieldsState();
}

class _CoordinateFieldsState extends State<CoordinateFields> {
  void _changed(TextEditingController field, String value) {
    final m = _pair.firstMatch(value);
    if (m != null) {
      final lat = parseLatitude(m.group(1)!);
      final lon = parseLongitude(m.group(2)!);
      if (lat != null && lon != null) {
        widget.latitude.text = formatCoordinate(lat);
        widget.longitude.text = formatCoordinate(lon);
      }
    }
    setState(() {});
    widget.onChanged?.call();
  }

  void _tidy(TextEditingController field, double? Function(String) parse) {
    final v = parse(field.text);
    if (v != null) field.text = formatCoordinate(v);
  }

  Widget _field({
    required Key key,
    required TextEditingController controller,
    required String label,
    required String help,
    required String? error,
    required double? Function(String) parse,
  }) {
    return Focus(
      onFocusChange: (focused) {
        if (!focused) _tidy(controller, parse);
      },
      child: TextField(
        key: key,
        controller: controller,
        enabled: widget.enabled,
        keyboardType: const TextInputType.numberWithOptions(decimal: true, signed: true),
        autocorrect: false,
        enableSuggestions: false,
        style: const TextStyle(fontFeatures: [FontFeature.tabularFigures()]),
        decoration: InputDecoration(labelText: label, helperText: help, errorText: error, errorMaxLines: 2),
        onChanged: (v) => _changed(controller, v),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final s = S.of(context);
    final lat = widget.latitude.text;
    final lon = widget.longitude.text;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        _field(
          key: CoordinateFields.latitudeKey,
          controller: widget.latitude,
          label: s.locLatitude,
          help: s.locLatitudeHelp,
          error: lat.trim().isEmpty || parseLatitude(lat) != null ? null : s.locLatitudeError,
          parse: parseLatitude,
        ),
        const SizedBox(height: 12),
        _field(
          key: CoordinateFields.longitudeKey,
          controller: widget.longitude,
          label: s.locLongitude,
          help: s.locLongitudeHelp,
          error: lon.trim().isEmpty || parseLongitude(lon) != null ? null : s.locLongitudeError,
          parse: parseLongitude,
        ),
      ],
    );
  }
}
