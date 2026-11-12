// A YouTube title or description template: placeholder chips that insert
// `{key}` at the cursor, a warning for a placeholder the box will not fill,
// a live preview from a sample kuliah, and a length meter.

import 'package:flutter/material.dart';

import '../../app/theme.dart';
import '../../l10n/generated/s.dart';
import 'field_meta.dart';

/// The placeholders the box fills (core `YOUTUBE_PLACEHOLDERS`).
const List<(String, String)> youtubePlaceholders = [
  ('label', 'Label kuliah'),
  ('penceramah', 'Penceramah'),
  ('topic', 'Topik'),
  ('kitab', 'Kitab'),
  ('surau', 'Nama surau'),
  ('date', 'Tarikh'),
  ('time', 'Masa'),
];

const Map<String, String> _sample = {
  'label': 'Kuliah Maghrib',
  'penceramah': 'Ustaz Haji Ahmad Fauzi bin Ismail',
  'topic': 'Sifat 20: Wujud, Qidam dan Baqa',
  'kitab': 'Aqidatun Najin',
  'surau': 'Surau D\'Waqaf',
  'date': 'Sabtu, 7 November 2026',
  'time': '8:30 malam',
};

final RegExp _placeholderRe = RegExp(r'\{(\w+)\}');

/// [template] with the sample kuliah filled in; unknown marks stay as typed.
String fillSample(String template) =>
    template.replaceAllMapped(_placeholderRe, (m) => _sample[m.group(1)] ?? m.group(0)!);

class TemplateField extends StatefulWidget {
  const TemplateField({
    super.key,
    required this.path,
    required this.label,
    required this.value,
    required this.meta,
    required this.onChanged,
    this.title = false,
    this.error,
    this.readOnly = false,
  });

  final String path;
  final String label;
  final String value;
  final FieldMeta meta;
  final void Function(Object? value) onChanged;

  /// The YouTube title: one line, the card preview, the too-long sentence.
  final bool title;
  final String? error;
  final bool readOnly;

  @override
  State<TemplateField> createState() => _TemplateFieldState();
}

class _TemplateFieldState extends State<TemplateField> {
  late final TextEditingController _c = TextEditingController(text: widget.value);

  @override
  void didUpdateWidget(covariant TemplateField old) {
    super.didUpdateWidget(old);
    if (_c.text != widget.value) _c.text = widget.value;
  }

  @override
  void dispose() {
    _c.dispose();
    super.dispose();
  }

  void _insert(String key) {
    final mark = '{$key}';
    final sel = _c.selection;
    final text = _c.text;
    final start = sel.isValid ? sel.start : text.length;
    final end = sel.isValid ? sel.end : text.length;
    final next = text.replaceRange(start, end, mark);
    _c.value = TextEditingValue(
      text: next,
      selection: TextSelection.collapsed(offset: start + mark.length),
    );
    widget.onChanged(next);
  }

  @override
  Widget build(BuildContext context) {
    final s = S.of(context);
    final text = Theme.of(context).textTheme;
    final max = widget.meta.maxLen ?? 500;
    final filled = fillSample(widget.value);
    final n = filled.length;
    final tooLong = n > max;
    final unknown = _placeholderRe
        .allMatches(widget.value)
        .map((m) => m.group(0)!)
        .where((m) => !_sample.containsKey(m.substring(1, m.length - 1)))
        .toSet();
    return FieldFrame(
      label: widget.label,
      error: widget.error,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          TextField(
            key: ValueKey('setting-${widget.path}'),
            controller: _c,
            enabled: !widget.readOnly,
            maxLines: widget.title ? 1 : 3,
            minLines: widget.title ? 1 : 3,
            autocorrect: false,
            onChanged: widget.onChanged,
          ),
          if (!widget.readOnly) ...[
            const SizedBox(height: 10),
            Text(s.settingsTapToAdd, style: text.bodySmall),
            const SizedBox(height: 6),
            Wrap(
              spacing: 8,
              runSpacing: 8,
              children: [
                for (final (key, label) in youtubePlaceholders)
                  ActionChip(
                    key: ValueKey('placeholder-${widget.path}-$key'),
                    onPressed: () => _insert(key),
                    backgroundColor: SurauColors.card,
                    side: const BorderSide(color: SurauColors.line),
                    shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(SurauTheme.radiusChip)),
                    padding: const EdgeInsets.symmetric(horizontal: 2),
                    label: Text.rich(
                      TextSpan(
                        children: [
                          TextSpan(
                            text: '{$key} ',
                            style: text.labelMedium!.copyWith(color: SurauColors.glass, fontWeight: FontWeight.w700),
                          ),
                          TextSpan(text: label, style: text.labelMedium!.copyWith(color: SurauColors.teal)),
                        ],
                      ),
                    ),
                  ),
              ],
            ),
          ],
          if (unknown.isNotEmpty) ...[
            const SizedBox(height: 8),
            Text(
              s.settingsUnknownPlaceholder(unknown.join(', ')),
              key: ValueKey('template-unknown-${widget.path}'),
              style: text.bodySmall!.copyWith(color: SurauColors.danger, fontWeight: FontWeight.w600),
            ),
          ],
          const SizedBox(height: 14),
          Text(s.settingsTemplatePreview, style: text.bodySmall!.copyWith(fontWeight: FontWeight.w600, color: SurauColors.text)),
          const SizedBox(height: 6),
          if (widget.title) _YoutubeCard(title: filled) else _DescriptionBox(text: filled),
          const SizedBox(height: 8),
          ClipRRect(
            borderRadius: BorderRadius.circular(3),
            child: LinearProgressIndicator(
              minHeight: 6,
              value: (n / max).clamp(0.0, 1.0),
              backgroundColor: SurauColors.paperDeep,
              color: tooLong ? SurauColors.danger : SurauColors.teal,
            ),
          ),
          const SizedBox(height: 4),
          Text(
            '${s.settingsCharMeter(n, max)}${tooLong && widget.title ? ': ${s.settingsTitleTooLong}' : ''}',
            key: ValueKey('template-meter-${widget.path}'),
            textAlign: TextAlign.end,
            style: text.bodySmall!.copyWith(
              color: tooLong ? SurauColors.danger : SurauColors.muted,
              fontWeight: tooLong ? FontWeight.w700 : null,
              fontFeatures: const [FontFeature.tabularFigures()],
            ),
          ),
        ],
      ),
    );
  }
}

class _YoutubeCard extends StatelessWidget {
  const _YoutubeCard({required this.title});

  final String title;

  @override
  Widget build(BuildContext context) {
    final text = Theme.of(context).textTheme;
    return Container(
      padding: const EdgeInsets.all(10),
      decoration: BoxDecoration(
        color: SurauColors.card,
        borderRadius: BorderRadius.circular(SurauTheme.radiusControl),
        border: Border.all(color: SurauColors.line),
      ),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Container(
            width: 120,
            height: 68,
            padding: const EdgeInsets.all(6),
            decoration: BoxDecoration(
              borderRadius: BorderRadius.circular(8),
              gradient: const LinearGradient(colors: [SurauColors.glass, SurauColors.teal]),
            ),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              mainAxisAlignment: MainAxisAlignment.spaceBetween,
              children: [
                Container(
                  padding: const EdgeInsets.symmetric(horizontal: 5, vertical: 1),
                  decoration: BoxDecoration(color: const Color(0xFFC4302B), borderRadius: BorderRadius.circular(3)),
                  child: Text('LANGSUNG', style: text.labelSmall!.copyWith(color: Colors.white, fontSize: 9.5)),
                ),
                Text("D'Waqaf", style: text.labelSmall!.copyWith(color: SurauColors.gold, fontSize: 10, fontWeight: FontWeight.w700)),
              ],
            ),
          ),
          const SizedBox(width: 12),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(title, style: text.bodyMedium!.copyWith(fontWeight: FontWeight.w700)),
                const SizedBox(height: 4),
                Text("D'Waqaf", style: text.bodySmall),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

class _DescriptionBox extends StatelessWidget {
  const _DescriptionBox({required this.text});

  final String text;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.fromLTRB(12, 10, 12, 10),
      decoration: BoxDecoration(color: SurauColors.paper, borderRadius: BorderRadius.circular(12)),
      child: Text(text, style: Theme.of(context).textTheme.bodyMedium),
    );
  }
}
