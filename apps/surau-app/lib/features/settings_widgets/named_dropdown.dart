// A value picked from a named list: a button showing the current name and a
// second line, opening a sheet (with a search box when the list is long).
// `NamedDropdown` is the Hijri month picker; the surah and reciter pickers
// use the same button and sheet.

import 'package:flutter/material.dart';

import '../../app/theme.dart';
import '../../l10n/generated/s.dart';
import '../registry.g.dart';
import 'field_meta.dart';

class PickerOption<T> {
  const PickerOption(this.value, this.title, {this.subtitle});

  final T value;
  final String title;
  final String? subtitle;
}

/// The sheet; the chosen value, or null when dismissed.
Future<T?> showPickerSheet<T>(
  BuildContext context, {
  required String title,
  required List<PickerOption<T>> options,
  required T selected,
  String? searchHint,
}) {
  return showModalBottomSheet<T>(
    context: context,
    isScrollControlled: true,
    backgroundColor: SurauColors.card,
    constraints: const BoxConstraints(maxWidth: 560),
    shape: const RoundedRectangleBorder(borderRadius: BorderRadius.vertical(top: Radius.circular(22))),
    builder: (context) => _PickerSheet<T>(title: title, options: options, selected: selected, searchHint: searchHint),
  );
}

class _PickerSheet<T> extends StatefulWidget {
  const _PickerSheet({required this.title, required this.options, required this.selected, this.searchHint});

  final String title;
  final List<PickerOption<T>> options;
  final T selected;
  final String? searchHint;

  @override
  State<_PickerSheet<T>> createState() => _PickerSheetState<T>();
}

class _PickerSheetState<T> extends State<_PickerSheet<T>> {
  String _q = '';

  @override
  Widget build(BuildContext context) {
    final s = S.of(context);
    final text = Theme.of(context).textTheme;
    final q = _q.trim().toLowerCase();
    final shown = q.isEmpty
        ? widget.options
        : widget.options.where((o) => o.title.toLowerCase().contains(q)).toList();
    return SafeArea(
      child: Padding(
        padding: EdgeInsets.only(bottom: MediaQuery.viewInsetsOf(context).bottom),
        child: SizedBox(
          height: MediaQuery.sizeOf(context).height * 0.7,
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Padding(
                padding: const EdgeInsets.fromLTRB(20, 18, 20, 10),
                child: Text(widget.title, style: text.titleMedium),
              ),
              if (widget.searchHint != null)
                Padding(
                  padding: const EdgeInsets.fromLTRB(16, 0, 16, 8),
                  child: TextField(
                    key: const ValueKey('picker-search'),
                    onChanged: (t) => setState(() => _q = t),
                    decoration: InputDecoration(
                      hintText: widget.searchHint,
                      prefixIcon: const Icon(Icons.search_rounded),
                      isDense: true,
                    ),
                  ),
                ),
              Expanded(
                child: shown.isEmpty
                    ? Padding(
                        padding: const EdgeInsets.all(24),
                        child: Text(s.settingsPickerNoMatch, textAlign: TextAlign.center, style: text.bodyLarge),
                      )
                    : ListView.builder(
                        padding: const EdgeInsets.fromLTRB(8, 0, 8, 8),
                        itemCount: shown.length,
                        itemBuilder: (context, i) {
                          final o = shown[i];
                          final on = o.value == widget.selected;
                          return Material(
                            color: on ? SurauColors.tealSoft : Colors.transparent,
                            borderRadius: BorderRadius.circular(10),
                            child: ListTile(
                              key: ValueKey('picker-${o.value}'),
                              shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(10)),
                              title: Text(o.title, style: text.bodyLarge!.copyWith(fontWeight: on ? FontWeight.w600 : null)),
                              subtitle: o.subtitle == null ? null : Text(o.subtitle!),
                              trailing: on ? const Icon(Icons.check_rounded, color: SurauColors.teal) : null,
                              onTap: () => Navigator.of(context).pop(o.value),
                            ),
                          );
                        },
                      ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

/// The closed picker: current name, second line, chevron.
class PickerButton extends StatelessWidget {
  const PickerButton({
    super.key,
    required this.title,
    required this.onTap,
    this.subtitle,
  });

  final String title;
  final String? subtitle;

  /// Null when read-only.
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    final text = Theme.of(context).textTheme;
    final radius = BorderRadius.circular(SurauTheme.radiusControl);
    return Material(
      color: SurauColors.card,
      shape: RoundedRectangleBorder(borderRadius: radius, side: const BorderSide(color: SurauColors.line)),
      child: InkWell(
        borderRadius: radius,
        onTap: onTap,
        child: ConstrainedBox(
          constraints: const BoxConstraints(minHeight: 56),
          child: Padding(
            padding: const EdgeInsets.fromLTRB(16, 10, 12, 10),
            child: Row(
              children: [
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      Text(title, style: text.bodyLarge),
                      if (subtitle != null) ...[
                        const SizedBox(height: 1),
                        Text(subtitle!, style: text.bodySmall),
                      ],
                    ],
                  ),
                ),
                const SizedBox(width: 8),
                Icon(Icons.expand_more_rounded, color: onTap == null ? SurauColors.line : SurauColors.muted),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

/// The Hijri month: 1..12 by name.
class NamedDropdown extends StatelessWidget {
  const NamedDropdown({
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
    final n = value is num ? (value as num).toInt().clamp(1, 12) : 1;
    return FieldFrame(
      label: label,
      error: error,
      child: PickerButton(
        key: ValueKey('setting-$path'),
        title: hijriMonthsMs[n - 1],
        subtitle: s.settingsHijriMonthN(n),
        onTap: readOnly
            ? null
            : () async {
                final picked = await showPickerSheet<int>(
                  context,
                  title: label,
                  selected: n,
                  options: [
                    for (final (i, m) in hijriMonthsMs.indexed)
                      PickerOption(i + 1, m, subtitle: s.settingsHijriMonthN(i + 1)),
                  ],
                );
                if (picked != null) onChanged(picked);
              },
      ),
    );
  }
}
