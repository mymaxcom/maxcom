// The words of the Waktu solat screens that depend on the language: months,
// weekdays, prayer names, calculation methods, the box's warning codes and
// the reasons a file row is refused. Every one reads the catalogue [S], so a
// screen in English or Arabic never shows a BM word.

import '../../l10n/generated/s.dart';

/// Long month name, [m] is 1 to 12.
String monthLong(S s, int m) => switch (m) {
  1 => s.ra2Month1,
  2 => s.ra2Month2,
  3 => s.ra2Month3,
  4 => s.ra2Month4,
  5 => s.ra2Month5,
  6 => s.ra2Month6,
  7 => s.ra2Month7,
  8 => s.ra2Month8,
  9 => s.ra2Month9,
  10 => s.ra2Month10,
  11 => s.ra2Month11,
  _ => s.ra2Month12,
};

/// Short month name, [m] is 1 to 12.
String monthShort(S s, int m) => switch (m) {
  1 => s.ra2MonthShort1,
  2 => s.ra2MonthShort2,
  3 => s.ra2MonthShort3,
  4 => s.ra2MonthShort4,
  5 => s.ra2MonthShort5,
  6 => s.ra2MonthShort6,
  7 => s.ra2MonthShort7,
  8 => s.ra2MonthShort8,
  9 => s.ra2MonthShort9,
  10 => s.ra2MonthShort10,
  11 => s.ra2MonthShort11,
  _ => s.ra2MonthShort12,
};

/// Weekday name, [wd] is `DateTime.weekday` (1 Monday to 7 Sunday).
String weekdayLong(S s, int wd) => switch (wd) {
  1 => s.ra2Weekday1,
  2 => s.ra2Weekday2,
  3 => s.ra2Weekday3,
  4 => s.ra2Weekday4,
  5 => s.ra2Weekday5,
  6 => s.ra2Weekday6,
  _ => s.ra2Weekday7,
};

String weekdayShort(S s, int wd) => switch (wd) {
  1 => s.ra2WeekdayShort1,
  2 => s.ra2WeekdayShort2,
  3 => s.ra2WeekdayShort3,
  4 => s.ra2WeekdayShort4,
  5 => s.ra2WeekdayShort5,
  6 => s.ra2WeekdayShort6,
  _ => s.ra2WeekdayShort7,
};

/// `2026-11-06` as "6 Nov 2026" in the language of [s]; [iso] itself when it
/// is not a date.
String shortDate(S s, String iso) {
  final d = DateTime.tryParse(iso);
  return d == null ? iso : '${d.day} ${monthShort(s, d.month)} ${d.year}';
}

/// The prayer key the box uses (`subuh`, `isyak`, ...) as a name; the key
/// itself when it is not one of them.
String prayerName(S s, String key) => switch (key) {
  'imsak' => s.ra2PrayerImsak,
  'subuh' => s.ra2PrayerSubuh,
  'syuruk' => s.ra2PrayerSyuruk,
  'zohor' => s.ra2PrayerZohor,
  'asar' => s.ra2PrayerAsar,
  'maghrib' => s.ra2PrayerMaghrib,
  'isyak' => s.ra2PrayerIsyak,
  'dhuha' => s.ra2PrayerDhuha,
  _ => key,
};

/// `METHODS` of packages/core/src/prayer/methods.ts, by id.
String methodLabel(S s, String id) => switch (id) {
  'mwl' => s.ra2MethodMwl,
  'egyptian' => s.ra2MethodEgyptian,
  'karachi' => s.ra2MethodKarachi,
  'ummAlQura' => s.ra2MethodUmmAlQura,
  'dubai' => s.ra2MethodDubai,
  'qatar' => s.ra2MethodQatar,
  'kuwait' => s.ra2MethodKuwait,
  'moonsighting' => s.ra2MethodMoonsighting,
  'singapore' => s.ra2MethodSingapore,
  'tehran' => s.ra2MethodTehran,
  'turkey' => s.ra2MethodTurkey,
  'northAmerica' => s.ra2MethodNorthAmerica,
  'jakim' => s.ra2MethodJakim,
  'kemenag' => s.ra2MethodKemenag,
  'uoif' => s.ra2MethodUoif,
  'morocco' => s.ra2MethodMorocco,
  'algeria' => s.ra2MethodAlgeria,
  'russia' => s.ra2MethodRussia,
  _ => id,
};

/// The ids of [methodLabel], in the box's order.
const List<String> methodIds = [
  'mwl', 'egyptian', 'karachi', 'ummAlQura', 'dubai', 'qatar', 'kuwait', 'moonsighting', 'singapore',
  'tehran', 'turkey', 'northAmerica', 'jakim', 'kemenag', 'uoif', 'morocco', 'algeria', 'russia',
];

/// A warning the box reports by code (`warningCodes` of the status and of a
/// zone save). Null for a code this app does not know: the caller then
/// shows the box's own sentence.
String? prayerWarningText(S s, String code, Map<String, dynamic> detail) => switch (code) {
  'no_data_today' => s.ra2WarnNoDataToday,
  'not_located' => s.ra2WarnNotLocated,
  'emergency_today' => s.ra2WarnEmergencyToday,
  'zone_no_data' => detail['willFetch'] == true ? s.ra2WarnZoneNoDataFetch : s.ra2WarnZoneNoDataManual,
  _ => null,
};

/// One warning of the box: [code]'s text when known, else [fallback].
class PrayerWarning {
  const PrayerWarning({required this.code, this.detail = const {}, this.sentence = ''});

  final String code;
  final Map<String, dynamic> detail;

  /// The box's own sentence for the same warning, for an older or newer box.
  final String sentence;

  String text(S s) => prayerWarningText(s, code, detail) ?? sentence;
}

/// The field of a refused row as a person reads it: a prayer name, "Date",
/// or the box's word for it.
String rowFieldName(S s, String field) => field == 'date' ? s.ra2FieldDate : prayerName(s, field);

/// Why one row of a file was refused. Null when the reason is not one this
/// app knows; the box's sentence is shown then.
String? importRowReason(S s, String field, String reason) {
  final f = rowFieldName(s, field);
  return switch (reason) {
    'missing_column' => s.ra2RowMissingColumn(f),
    'masjid_only' => s.ra2RowMasjidOnly(f),
    'empty' => s.ra2RowEmpty(f),
    'invalid' => s.ra2RowInvalid(f),
    'out_of_range' => s.ra2RowOutOfRange(f),
    'duplicate' => s.ra2RowDuplicate,
    'before_midnight' => s.ra2RowBeforeMidnight,
    'order' => s.ra2RowOrder,
    'no_rows' => s.ra2RowNoRows,
    'too_many_rows' => s.ra2RowTooMany,
    'gap' => s.ra2RowGap,
    _ => null,
  };
}
