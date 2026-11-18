// Which year the prayer-data screen offers first, and when loading a year
// replaces data the box already holds. Both come from the official days the
// box holds per year (`official.years` of the prayer status) and from the
// box's own date, never from the resolved count (a calculated day is a
// fallback and must not hide missing data) and never from the phone's clock
// (around 1 January a phone in another time zone is a day ahead or behind).

/// Days in [year]: 366 in a leap year.
int daysInYear(int year) => (year % 4 == 0 && (year % 100 != 0 || year % 400 == 0)) ? 366 : 365;

/// The year pre-selected: the box's current year while its official data for
/// that year is missing or incomplete, otherwise next year. [officialDays]
/// maps a year to the official days held; null (status not read yet) offers
/// next year.
int defaultPrayerYear({required Map<int, int>? officialDays, required DateTime today}) {
  if (officialDays != null && (officialDays[today.year] ?? 0) < daysInYear(today.year)) {
    return today.year;
  }
  return today.year + 1;
}

/// True when loading [year] overwrites official days the box already holds.
bool replacesExistingData({required int year, required Map<int, int>? officialDays}) =>
    (officialDays?[year] ?? 0) > 0;

/// The current year has no data from today onward: [coverage] is the count of
/// days ahead that official or file data covers, 0 for none.
bool noDataThisYear(int? coverage) => coverage == 0;
