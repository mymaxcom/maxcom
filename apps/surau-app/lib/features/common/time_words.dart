// A moment as a Malaysian would say it: "10:45 malam", "8:00 pagi",
// "12:30 tengah hari". Used for "Jemputan sah hingga ..." and "Cuba lagi
// pada ...", where a clock time is clearer than "dalam 15 minit", which
// goes stale on the screen.

/// Time of day in 12-hour form with the BM day part; [t] must already be
/// in the reader's time zone.
String timeOfDayWords(DateTime t) {
  final h24 = t.hour;
  final h12 = h24 % 12 == 0 ? 12 : h24 % 12;
  final mm = t.minute.toString().padLeft(2, '0');
  final part = switch (h24) {
    < 12 => 'pagi',
    12 => 'tengah hari',
    < 19 => 'petang',
    _ => 'malam',
  };
  return '$h12:$mm $part';
}

const List<String> _monthsMs = [
  'Jan',
  'Feb',
  'Mac',
  'Apr',
  'Mei',
  'Jun',
  'Jul',
  'Ogos',
  'Sep',
  'Okt',
  'Nov',
  'Dis',
];

/// [timeOfDayWords], with "esok" when [t] falls on the day after [today]
/// and a short date when it is further away. Both in the reader's zone.
String whenWords(DateTime t, {required DateTime today}) {
  final time = timeOfDayWords(t);
  final d0 = DateTime(today.year, today.month, today.day);
  final d1 = DateTime(t.year, t.month, t.day);
  final days = d1.difference(d0).inDays;
  if (days == 0) return time;
  if (days == 1) return '$time esok';
  return '$time, ${t.day} ${_monthsMs[t.month - 1]}';
}
