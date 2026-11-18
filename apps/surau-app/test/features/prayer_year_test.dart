import 'package:flutter_test/flutter_test.dart';
import 'package:surau_app/features/prayer_year.dart';

void main() {
  final nov4 = DateTime(2026, 11, 4);

  test('days in a year: leap years have 366', () {
    expect(daysInYear(2026), 365);
    expect(daysInYear(2028), 366);
    expect(daysInYear(2100), 365);
    expect(daysInYear(2000), 366);
  });

  test('[P1] default year: current while official data for it is missing or incomplete, else next', () {
    expect(defaultPrayerYear(officialDays: const {}, today: nov4), 2026);
    expect(defaultPrayerYear(officialDays: const {2026: 20}, today: nov4), 2026);
    expect(defaultPrayerYear(officialDays: const {2026: 364}, today: nov4), 2026);
    expect(defaultPrayerYear(officialDays: const {2026: 365}, today: nov4), 2027);
    expect(defaultPrayerYear(officialDays: const {2026: 365, 2027: 365}, today: nov4), 2027);
    expect(defaultPrayerYear(officialDays: null, today: nov4), 2027);
    expect(defaultPrayerYear(officialDays: const {2028: 365}, today: DateTime(2028, 3, 1)), 2028);
    expect(defaultPrayerYear(officialDays: const {2028: 366}, today: DateTime(2028, 3, 1)), 2029);
  });

  test('[P1] the replace warning only when the chosen year already holds official days', () {
    bool r(int y, Map<int, int>? d) => replacesExistingData(year: y, officialDays: d);
    expect(r(2026, const {}), isFalse);
    expect(r(2026, null), isFalse);
    expect(r(2026, const {2026: 20}), isTrue);
    expect(r(2027, const {2026: 365}), isFalse);
    expect(r(2027, const {2027: 1}), isTrue);
  });

  test('[P1] no data this year only for a zero count', () {
    expect(noDataThisYear(0), isTrue);
    expect(noDataThisYear(1), isFalse);
    expect(noDataThisYear(null), isFalse);
  });
}
