// The days of a month as a table with a colour strip for the source of each
// day, the year as twelve small calendars, and the legend both share.

import 'package:flutter/material.dart';

import '../../../app/theme.dart';
import '../../../l10n/generated/s.dart';
import '../location_screen.dart' show monthsLongMs;
import '../prayer_repository.dart';
import '../sources_screen.dart' show crossCheckMinutes, flagBackground, flagInk, prayerNamesMs;

const Map<String, Color> prayerSourceColours = {
  'official': Color(0xFF0B5C55),
  'calc': Color(0xFF5B7FA6),
  'file': Color(0xFF7A5AA6),
};

const Color prayerCorrectionColour = Color(0xFFC99400);

/// The strip of a day: a correction wins over its source.
Color dayColour(ResolvedDay d) =>
    d.corrected.isNotEmpty ? prayerCorrectionColour : prayerSourceColours[d.source] ?? SurauColors.outline;

const List<String> _dayShortMs = ['Isn', 'Sel', 'Rab', 'Kha', 'Jum', 'Sab', 'Ahd'];

/// The six times of the table; imsak is on the day sheet.
const List<String> gridPrayers = ['subuh', 'syuruk', 'zohor', 'asar', 'maghrib', 'isyak'];

/// A table of [days]: a strip and day name, then the six times.
class MonthGrid extends StatelessWidget {
  const MonthGrid({
    super.key,
    required this.days,
    this.flags = const {},
    this.today,
    this.onTapDay,
    this.showStrip = true,
    this.dateLabel,
  });

  final List<ResolvedDay> days;

  /// Differences by date, from the cross-check.
  final Map<String, Map<String, int>> flags;
  final String? today;
  final ValueChanged<ResolvedDay>? onTapDay;
  final bool showStrip;

  /// Replaces the day column's text (a week table across months).
  final String Function(ResolvedDay)? dateLabel;

  @override
  Widget build(BuildContext context) {
    final text = Theme.of(context).textTheme;
    final s = S.of(context);
    final head = text.labelSmall!.copyWith(color: SurauColors.muted, fontWeight: FontWeight.w700);
    return Card(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 10),
            child: Row(
              children: [
                SizedBox(width: _dayWidth, child: Text(s.pdGridDay, style: head)),
                for (final p in gridPrayers)
                  Expanded(child: FittedBox(fit: BoxFit.scaleDown, child: Text(prayerNamesMs[p]!, style: head))),
              ],
            ),
          ),
          const Divider(),
          for (final d in days) _row(d, text),
        ],
      ),
    );
  }

  static const double _dayWidth = 66;

  Widget _row(ResolvedDay d, TextTheme text) {
    final date = DateTime.parse(d.date);
    final isToday = d.date == today;
    final label = dateLabel?.call(d) ?? '${_dayShortMs[date.weekday - 1]} ${date.day}';
    final tap = onTapDay;
    final num = text.bodySmall!.copyWith(
      color: SurauColors.text,
      fontSize: 13,
      fontFeatures: const [FontFeature.tabularFigures()],
      fontWeight: isToday ? FontWeight.w700 : FontWeight.w400,
    );
    return InkWell(
      key: ValueKey('pd-day-${d.date}'),
      onTap: tap == null ? null : () => tap(d),
      child: Container(
        color: isToday ? SurauColors.tealSoft.withValues(alpha: 0.35) : null,
        constraints: const BoxConstraints(minHeight: 40),
        padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
        child: Row(
          children: [
            SizedBox(
              width: _dayWidth,
              child: Row(
                children: [
                  if (showStrip) ...[
                    Container(
                      key: ValueKey('pd-strip-${d.date}'),
                      width: 5,
                      height: 22,
                      decoration: BoxDecoration(color: dayColour(d), borderRadius: BorderRadius.circular(3)),
                    ),
                    const SizedBox(width: 7),
                  ],
                  Expanded(child: Text(label, style: num.copyWith(fontWeight: FontWeight.w600))),
                ],
              ),
            ),
            for (final p in gridPrayers) Expanded(child: Center(child: _time(d, p, num))),
          ],
        ),
      ),
    );
  }

  Widget _time(ResolvedDay d, String p, TextStyle num) {
    final t = d.times[p] ?? '-';
    if (d.corrected.contains(p)) {
      return Text(t, key: ValueKey('pd-cor-${d.date}-$p'), style: num.copyWith(color: flagInk, fontWeight: FontWeight.w800));
    }
    final diff = flags[d.date]?[p];
    if (diff != null && diff.abs() > crossCheckMinutes) {
      return Container(
        key: ValueKey('pd-flag-${d.date}-$p'),
        padding: const EdgeInsets.symmetric(horizontal: 3, vertical: 1),
        decoration: BoxDecoration(color: flagBackground, borderRadius: BorderRadius.circular(5)),
        child: Text(t, style: num.copyWith(color: flagInk, fontWeight: FontWeight.w700)),
      );
    }
    return Text(t, style: num);
  }
}

/// The source colours with their names.
class SourceLegend extends StatelessWidget {
  const SourceLegend({super.key, required this.hasOfficial, this.withFlag = false});

  final bool hasOfficial;
  final bool withFlag;

  @override
  Widget build(BuildContext context) {
    final s = S.of(context);
    final text = Theme.of(context).textTheme.bodySmall!;
    Widget entry(Color c, String label, {Color? border}) => Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        Container(
          width: 12,
          height: 12,
          decoration: BoxDecoration(
            color: c,
            borderRadius: BorderRadius.circular(3),
            border: border == null ? null : Border.all(color: border),
          ),
        ),
        const SizedBox(width: 6),
        Text(label, style: text),
      ],
    );
    return Wrap(
      spacing: 14,
      runSpacing: 6,
      children: [
        if (hasOfficial) entry(prayerSourceColours['official']!, s.pdLegendOfficial),
        entry(prayerSourceColours['calc']!, s.pdLegendCalc),
        entry(prayerSourceColours['file']!, s.pdLegendFile),
        entry(prayerCorrectionColour, s.pdLegendCorrection),
        if (withFlag) entry(flagBackground, s.pdLegendFlag, border: flagInk),
      ],
    );
  }
}

/// Twelve small calendars: a cell per day in its source colour.
class YearGrid extends StatelessWidget {
  const YearGrid({super.key, required this.year, required this.days, this.today, this.onTapMonth});

  final int year;
  final List<ResolvedDay> days;
  final String? today;
  final ValueChanged<int>? onTapMonth;

  @override
  Widget build(BuildContext context) {
    final text = Theme.of(context).textTheme;
    final byDate = {for (final d in days) d.date: d};
    return Wrap(
      spacing: 10,
      runSpacing: 10,
      children: [
        for (var m = 1; m <= 12; m++)
          SizedBox(
            width: 168,
            child: InkWell(
              onTap: onTapMonth == null ? null : () => onTapMonth!(m),
              child: Card(
                child: Padding(
                  padding: const EdgeInsets.all(10),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.stretch,
                    children: [
                      Text(monthsLongMs[m - 1], style: text.titleSmall),
                      const SizedBox(height: 6),
                      _cells(m, byDate),
                    ],
                  ),
                ),
              ),
            ),
          ),
      ],
    );
  }

  Widget _cells(int m, Map<String, ResolvedDay> byDate) {
    final first = DateTime(year, m);
    final count = DateTime(year, m + 1, 0).day;
    return Wrap(
      spacing: 2,
      runSpacing: 2,
      children: [
        for (var i = 0; i < first.weekday % 7; i++) const SizedBox(width: 18, height: 12),
        for (var d = 1; d <= count; d++) _cell(m, d, byDate),
      ],
    );
  }

  Widget _cell(int m, int d, Map<String, ResolvedDay> byDate) {
    final date = '$year-${m.toString().padLeft(2, '0')}-${d.toString().padLeft(2, '0')}';
    final day = byDate[date];
    return Container(
      key: ValueKey('pd-cell-$date'),
      width: 18,
      height: 12,
      decoration: BoxDecoration(
        color: day == null ? SurauColors.paperDeep : dayColour(day),
        borderRadius: BorderRadius.circular(2),
        border: date == today ? Border.all(color: SurauColors.ink, width: 1.5) : null,
      ),
    );
  }
}
