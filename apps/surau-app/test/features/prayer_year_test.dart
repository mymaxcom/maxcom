import 'package:flutter_test/flutter_test.dart';
import 'package:surau_app/features/prayer_year.dart';

void main() {
  final nov4 = DateTime(2026, 11, 4); // 58 days left in the year
  test('days left in the year counts today', () {
    expect(daysLeftInYear(nov4), 58);
    expect(daysLeftInYear(DateTime(2026, 12, 31)), 1);
    expect(daysLeftInYear(DateTime(2028, 1, 1)), 366);
  });

  test('default year: current when no or incomplete data, else next', () {
    expect(defaultPrayerYear(daysAhead: 0, today: nov4), 2026);
    expect(defaultPrayerYear(daysAhead: 20, today: nov4), 2026);
    expect(defaultPrayerYear(daysAhead: 57, today: nov4), 2026);
    expect(defaultPrayerYear(daysAhead: 58, today: nov4), 2027);
    expect(defaultPrayerYear(daysAhead: 212, today: nov4), 2027);
    expect(defaultPrayerYear(daysAhead: null, today: nov4), 2027);
  });

  test('replace warning only when the chosen year already holds data', () {
    bool r(int y, int? d) =>
        replacesExistingData(year: y, daysAhead: d, today: nov4);
    expect(r(2026, 0), isFalse);
    expect(r(2026, null), isFalse);
    expect(r(2026, 20), isTrue);
    expect(r(2027, 20), isFalse);
    expect(r(2027, 58), isFalse);
    expect(r(2027, 59), isTrue);
    expect(r(2028, 500), isFalse);
  });

  test('no data this year only for a zero count', () {
    expect(noDataThisYear(0), isTrue);
    expect(noDataThisYear(1), isFalse);
    expect(noDataThisYear(null), isFalse);
  });
}
