// Which year the prayer-data screen offers first, and when loading a year
// replaces data the box already holds. The box reports only `daysAhead`
// (prayer days from today onward), so "has data" is read from that count:
// the current year is complete when the count reaches 31 December, and
// next year holds data when the count runs past it.

/// Days from [today] to 31 December of the same year, counting today.
int daysLeftInYear(DateTime today) {
  final a = DateTime.utc(today.year, today.month, today.day);
  final b = DateTime.utc(today.year, 12, 31);
  return b.difference(a).inDays + 1;
}

/// The year pre-selected: the current year when it has no or incomplete
/// data (the count stops short of 31 December), otherwise next year.
/// An unknown count offers next year.
int defaultPrayerYear({required int? daysAhead, required DateTime today}) {
  if (daysAhead != null && daysAhead < daysLeftInYear(today)) return today.year;
  return today.year + 1;
}

/// True when loading [year] overwrites rows the box already holds.
bool replacesExistingData({
  required int year,
  required int? daysAhead,
  required DateTime today,
}) {
  if (daysAhead == null || daysAhead <= 0) return false;
  if (year == today.year) return true;
  if (year == today.year + 1) return daysAhead > daysLeftInYear(today);
  return false;
}

/// The current year has no data from today onward.
bool noDataThisYear(int? daysAhead) => daysAhead == 0;
