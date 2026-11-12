// The TV text colour: `Auto` (null), five swatches, or `Lain` with a hex
// row; a preview of the time and the kuliah line over a background.

import 'package:flutter/material.dart';

import '../../app/theme.dart';
import '../../l10n/generated/s.dart';
import '../validate.dart' show hexColourRe;

const String _customDefault = '#F6E7B8';

Color? _parse(String? hex) {
  if (hex == null || !hexColourRe.hasMatch(hex)) return null;
  return Color(0xFF000000 | int.parse(hex.substring(1), radix: 16));
}

class ColourSwatches extends StatefulWidget {
  const ColourSwatches({
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

  /// Null for Auto.
  final String? value;
  final void Function(Object? value) onChanged;
  final String? error;
  final bool readOnly;

  @override
  State<ColourSwatches> createState() => _ColourSwatchesState();
}

class _ColourSwatchesState extends State<ColourSwatches> {
  static const List<(String, Color)> _named = [
    ('#FFFFFF', Color(0xFFFFFFFF)),
    ('#FBEFD3', Color(0xFFFBEFD3)),
    ('#F0C97A', Color(0xFFF0C97A)),
    ('#D3EBE6', Color(0xFFD3EBE6)),
    ('#10211E', Color(0xFF10211E)),
  ];

  static bool _isNamed(String? v) => v != null && _named.any((n) => n.$1 == v.toUpperCase());

  late final TextEditingController _hex = TextEditingController(text: widget.value ?? _customDefault);
  late bool _custom = widget.value != null && !_isNamed(widget.value);

  @override
  void didUpdateWidget(covariant ColourSwatches old) {
    super.didUpdateWidget(old);
    if (widget.value == old.value) return;
    if (widget.value == null || _isNamed(widget.value)) {
      _custom = false;
    } else {
      _custom = true;
      if (_hex.text != widget.value) _hex.text = widget.value!;
    }
  }

  @override
  void dispose() {
    _hex.dispose();
    super.dispose();
  }

  void _choose(String? v) {
    setState(() => _custom = false);
    widget.onChanged(v);
  }

  void _chooseCustom() {
    setState(() => _custom = true);
    widget.onChanged(_hex.text);
  }

  @override
  Widget build(BuildContext context) {
    final s = S.of(context);
    final text = Theme.of(context).textTheme;
    final names = [s.swatchWhite, s.swatchCream, s.swatchGold, s.swatchGreen, s.swatchBlack];
    final ro = widget.readOnly;
    final isAuto = !_custom && widget.value == null;
    final preview = isAuto ? Colors.white : _parse(widget.value) ?? Colors.white;
    return Padding(
      padding: const EdgeInsets.fromLTRB(20, 16, 20, 16),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Wrap(
            spacing: 10,
            runSpacing: 12,
            children: [
              _Swatch(
                swatchKey: 'swatch-auto',
                label: s.swatchAuto,
                selected: isAuto,
                decoration: const BoxDecoration(
                  gradient: LinearGradient(
                    begin: Alignment.topLeft,
                    end: Alignment.bottomRight,
                    colors: [Colors.white, Colors.white, Color(0xFF10211E), Color(0xFF10211E)],
                    stops: [0, 0.5, 0.5, 1],
                  ),
                ),
                onTap: ro ? null : () => _choose(null),
              ),
              for (final (i, n) in _named.indexed)
                _Swatch(
                  swatchKey: 'swatch-${n.$1}',
                  label: names[i],
                  selected: !_custom && widget.value?.toUpperCase() == n.$1,
                  decoration: BoxDecoration(color: n.$2),
                  onTap: ro ? null : () => _choose(n.$1),
                ),
              _Swatch(
                swatchKey: 'swatch-custom',
                label: s.swatchOther,
                selected: _custom,
                decoration: const BoxDecoration(
                  gradient: SweepGradient(
                    colors: [
                      Color(0xFFEE6666),
                      Color(0xFFEEEE66),
                      Color(0xFF66EE66),
                      Color(0xFF66EEEE),
                      Color(0xFF6666EE),
                      Color(0xFFEE66EE),
                      Color(0xFFEE6666),
                    ],
                  ),
                ),
                onTap: ro ? null : _chooseCustom,
              ),
            ],
          ),
          if (_custom) ...[
            const SizedBox(height: 14),
            TextField(
              key: ValueKey('setting-${widget.path}'),
              controller: _hex,
              enabled: !ro,
              maxLength: 7,
              autocorrect: false,
              enableSuggestions: false,
              decoration: InputDecoration(
                labelText: s.settingsHexLabel,
                helperText: s.settingsHexHelp,
                errorText: widget.error,
                errorMaxLines: 2,
                counterText: '',
              ),
              onChanged: widget.onChanged,
            ),
          ] else if (widget.error != null) ...[
            const SizedBox(height: 6),
            Text(widget.error!, style: text.bodySmall!.copyWith(color: SurauColors.danger)),
          ],
          const SizedBox(height: 12),
          Text(isAuto ? s.settingsColourAutoHelp : s.settingsColourFixedHelp, style: text.bodySmall),
          const SizedBox(height: 14),
          _TvPreview(colour: preview),
          const SizedBox(height: 6),
          Text(s.settingsColourPreview, style: text.bodySmall),
        ],
      ),
    );
  }
}

class _Swatch extends StatelessWidget {
  const _Swatch({
    required this.swatchKey,
    required this.label,
    required this.selected,
    required this.decoration,
    required this.onTap,
  });

  final String swatchKey;
  final String label;
  final bool selected;
  final BoxDecoration decoration;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    final text = Theme.of(context).textTheme;
    return InkWell(
      key: ValueKey(swatchKey),
      borderRadius: BorderRadius.circular(12),
      onTap: onTap,
      child: SizedBox(
        width: 52,
        child: Column(
          children: [
            const SizedBox(height: 4),
            Container(
              padding: const EdgeInsets.all(2),
              decoration: BoxDecoration(
                shape: BoxShape.circle,
                border: Border.all(color: selected ? SurauColors.teal : Colors.transparent, width: 2),
              ),
              child: Container(
                width: 38,
                height: 38,
                decoration: decoration.copyWith(
                  shape: BoxShape.circle,
                  border: Border.all(color: const Color(0x2E000000)),
                ),
              ),
            ),
            const SizedBox(height: 3),
            Text(
              label,
              maxLines: 1,
              overflow: TextOverflow.visible,
              style: text.labelSmall!.copyWith(
                color: selected ? SurauColors.glass : SurauColors.muted,
                fontWeight: FontWeight.w600,
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _TvPreview extends StatelessWidget {
  const _TvPreview({required this.colour});

  final Color colour;

  @override
  Widget build(BuildContext context) {
    final text = Theme.of(context).textTheme;
    return Container(
      key: const ValueKey('tone-preview'),
      height: 120,
      padding: const EdgeInsets.fromLTRB(14, 12, 14, 12),
      decoration: BoxDecoration(
        borderRadius: BorderRadius.circular(12),
        gradient: const LinearGradient(
          begin: Alignment.topLeft,
          end: Alignment.bottomRight,
          colors: [Color(0xFF3B5D58), Color(0xFF9BB7A4), Color(0xFFE9E2C7)],
          stops: [0, 0.55, 1],
        ),
      ),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.end,
        children: [
          Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                'MAGHRIB',
                style: text.labelSmall!.copyWith(color: colour, fontWeight: FontWeight.w700, letterSpacing: 1.8),
              ),
              Text(
                '7:12',
                style: text.headlineMedium!.copyWith(color: colour, fontWeight: FontWeight.w800, height: 1.05),
              ),
            ],
          ),
          const SizedBox(width: 16),
          Expanded(
            child: Text(
              'Kuliah Maghrib, Ustaz Haji Ahmad Fauzi',
              maxLines: 2,
              style: text.bodySmall!.copyWith(color: colour, fontWeight: FontWeight.w600),
            ),
          ),
        ],
      ),
    );
  }
}
