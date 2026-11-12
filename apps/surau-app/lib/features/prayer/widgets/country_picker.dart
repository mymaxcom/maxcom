// The field and bottom-sheet pickers the prayer screens share: a tappable
// field showing the current choice, a searchable sheet (country, time zone,
// JAKIM zone, method) and the soft info banners of the mockup.

import 'package:flutter/material.dart';

import '../../../app/theme.dart';
import '../../../l10n/generated/s.dart';
import '../prayer_repository.dart';

/// A labelled field showing the current choice; null [onTap] makes it
/// read-only, [dimmed] draws it faded (a rule that has no effect here).
class PickerField extends StatelessWidget {
  const PickerField({
    super.key,
    required this.label,
    required this.value,
    this.sub,
    this.onTap,
    this.dimmed = false,
  });

  final String label;
  final String value;
  final String? sub;
  final VoidCallback? onTap;
  final bool dimmed;

  @override
  Widget build(BuildContext context) {
    final text = Theme.of(context).textTheme;
    return Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Text(label, style: text.titleSmall),
          const SizedBox(height: 6),
          Material(
            color: onTap == null ? SurauColors.paper : SurauColors.card,
            shape: RoundedRectangleBorder(
              borderRadius: BorderRadius.circular(SurauTheme.radiusControl),
              side: const BorderSide(color: SurauColors.line),
            ),
            clipBehavior: Clip.antiAlias,
            child: InkWell(
              onTap: onTap,
              child: ConstrainedBox(
                constraints: const BoxConstraints(minHeight: 56),
                child: Padding(
                  padding: const EdgeInsets.fromLTRB(16, 10, 10, 10),
                  child: Row(
                    children: [
                      Expanded(
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            Text(
                              value,
                              style: dimmed
                                  ? text.bodyLarge!.copyWith(color: SurauColors.muted)
                                  : text.bodyLarge!.copyWith(fontWeight: FontWeight.w600),
                            ),
                            if (sub != null) Text(sub!, style: text.bodySmall),
                          ],
                        ),
                      ),
                      if (onTap != null) const Icon(Icons.expand_more_rounded, color: SurauColors.teal),
                    ],
                  ),
                ),
              ),
            ),
          ),
        ],
    );
  }
}

/// One row of a [showPickerSheet].
class PickerItem<T> {
  const PickerItem({
    required this.value,
    required this.title,
    this.subtitle,
    this.group,
    this.tag,
    this.tagStrong = false,
    this.keywords = '',
  });

  final T value;
  final String title;
  final String? subtitle;

  /// Rows sharing a group sit under its heading.
  final String? group;

  /// A short note at the end of the row.
  final String? tag;
  final bool tagStrong;

  /// More text the search matches (a state name, a country code).
  final String keywords;

  bool matches(String q) =>
      '$title ${subtitle ?? ''} ${group ?? ''} $keywords'.toLowerCase().contains(q);
}

/// A searchable list in a bottom sheet; the chosen value, or null when the
/// person backed out. [pinned] rows sit on top and are left out of a search.
Future<T?> showPickerSheet<T>(
  BuildContext context, {
  required String title,
  required List<PickerItem<T>> items,
  List<PickerItem<T>> pinned = const [],
  T? current,
  String? searchHint,
}) {
  return showModalBottomSheet<T>(
    context: context,
    useSafeArea: true,
    isScrollControlled: true,
    constraints: const BoxConstraints(maxWidth: 560),
    builder: (context) => _PickerSheet<T>(
      title: title,
      items: items,
      pinned: pinned,
      current: current,
      searchHint: searchHint,
    ),
  );
}

class _PickerSheet<T> extends StatefulWidget {
  const _PickerSheet({
    required this.title,
    required this.items,
    required this.pinned,
    required this.current,
    required this.searchHint,
  });

  final String title;
  final List<PickerItem<T>> items;
  final List<PickerItem<T>> pinned;
  final T? current;
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
    final shown = [
      if (q.isEmpty) ...widget.pinned,
      for (final i in widget.items)
        if (q.isEmpty || i.matches(q)) i,
    ];
    // Headings and rows as one flat list, so a long one stays lazy.
    final rows = <Object>[];
    String? group;
    for (final i in shown) {
      if (i.group != null && i.group != group) rows.add(i.group!);
      group = i.group;
      rows.add(i);
    }
    return SizedBox(
      height: MediaQuery.sizeOf(context).height * 0.82,
      child: Padding(
        padding: EdgeInsets.only(bottom: MediaQuery.viewInsetsOf(context).bottom),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Padding(
              padding: const EdgeInsets.fromLTRB(20, 0, 20, 10),
              child: Text(widget.title, style: text.titleLarge),
            ),
            Padding(
              padding: const EdgeInsets.fromLTRB(20, 0, 20, 8),
              child: TextField(
                key: const ValueKey('picker-search'),
                autocorrect: false,
                decoration: InputDecoration(
                  hintText: widget.searchHint ?? s.locPickerSearch,
                  prefixIcon: const Icon(Icons.search_rounded),
                ),
                onChanged: (v) => setState(() => _q = v),
              ),
            ),
            Expanded(
              child: rows.isEmpty
                  ? Padding(
                      padding: const EdgeInsets.all(24),
                      child: Text(s.locPickerNone, textAlign: TextAlign.center, style: text.bodyLarge),
                    )
                  : ListView.builder(
                      itemCount: rows.length,
                      itemBuilder: (context, i) {
                        final row = rows[i];
                        if (row is String) {
                          return Padding(
                            padding: const EdgeInsets.fromLTRB(20, 14, 20, 4),
                            child: Text(row, style: text.titleSmall!.copyWith(color: SurauColors.muted)),
                          );
                        }
                        return _row(row as PickerItem<T>, text);
                      },
                    ),
            ),
          ],
        ),
      ),
    );
  }

  Widget _row(PickerItem<T> item, TextTheme text) {
    final selected = item.value == widget.current;
    return InkWell(
      onTap: () => Navigator.of(context).pop(item.value),
      child: ConstrainedBox(
        constraints: const BoxConstraints(minHeight: SurauTheme.minTapSize + 8),
        child: Padding(
          padding: const EdgeInsets.fromLTRB(20, 8, 16, 8),
          child: Row(
            children: [
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(item.title, style: text.bodyLarge!.copyWith(fontWeight: FontWeight.w600)),
                    if (item.subtitle != null) Text(item.subtitle!, style: text.bodySmall),
                    if (item.tag != null) ...[
                      const SizedBox(height: 3),
                      Text(
                        item.tag!,
                        style: text.labelSmall!.copyWith(
                          color: item.tagStrong ? SurauColors.teal : SurauColors.muted,
                          fontWeight: FontWeight.w700,
                        ),
                      ),
                    ],
                  ],
                ),
              ),
              if (selected) const Icon(Icons.check_rounded, color: SurauColors.teal),
            ],
          ),
        ),
      ),
    );
  }
}

/// The country field of Lokasi surau: names from the box, no flags.
class CountryField extends StatelessWidget {
  const CountryField({
    super.key,
    required this.countries,
    required this.code,
    this.onChanged,
  });

  final List<CountryInfo> countries;
  final String code;
  final ValueChanged<String>? onChanged;

  @override
  Widget build(BuildContext context) {
    final s = S.of(context);
    final c = countries.where((x) => x.code == code).firstOrNull;
    final changed = onChanged;
    return PickerField(
      label: s.locCountry,
      value: c?.name ?? code,
      sub: c?.hasOfficial == true ? s.locCountryOfficial : s.locCountryNoOfficial,
      onTap: changed == null || countries.isEmpty
          ? null
          : () async {
              final picked = await showPickerSheet<String>(
                context,
                title: s.locCountry,
                current: code,
                searchHint: s.locCountrySearch,
                items: [
                  for (final x in countries)
                    PickerItem(
                      value: x.code,
                      title: x.name,
                      subtitle: x.timezones.length == 1 ? x.timezones.first : s.locZonesCount(x.timezones.length),
                      keywords: x.code,
                    ),
                ],
              );
              if (picked != null) changed(picked);
            },
    );
  }
}

enum InfoTone { teal, gold, red }

/// A soft banner with an icon, the mockup's `.info`.
class InfoBox extends StatelessWidget {
  const InfoBox({
    super.key,
    required this.child,
    this.tone = InfoTone.teal,
    this.icon = Icons.info_outline_rounded,
  });

  final Widget child;
  final InfoTone tone;
  final IconData icon;

  @override
  Widget build(BuildContext context) {
    final (bg, ink) = switch (tone) {
      InfoTone.teal => (SurauColors.tealSoft, SurauColors.glass),
      InfoTone.gold => (SurauColors.goldSoft, SurauColors.ink),
      InfoTone.red => (SurauColors.dangerSoft, SurauColors.dangerInk),
    };
    return Container(
      padding: const EdgeInsets.fromLTRB(14, 12, 14, 12),
      decoration: BoxDecoration(
        color: bg,
        borderRadius: BorderRadius.circular(SurauTheme.radiusControl),
      ),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Icon(icon, size: 22, color: ink),
          const SizedBox(width: 12),
          Expanded(
            child: DefaultTextStyle.merge(
              style: Theme.of(context).textTheme.bodyMedium!.copyWith(color: ink),
              child: child,
            ),
          ),
        ],
      ),
    );
  }
}
