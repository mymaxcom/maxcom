// A moment as a Malaysian would say it: "10:45 malam", "8:00 pagi",
// "12:30 tengah hari". Used for "Jemputan sah hingga ..." and "Cuba lagi
// pada ...", where a clock time is clearer than "dalam 15 minit", which
// goes stale on the screen. Each takes the app language (BM when none is
// given): English says "10:45 pm" and "tomorrow", Arabic the part of the day.

import '../../app/app_lang.dart';
import '../labels.dart' show dayPartWord, monthWord;
import '../labels_content.dart' show monthWordsMs;

/// Time of day in 12-hour form with the day part; [t] must already be
/// in the reader's time zone.
String timeOfDayWords(DateTime t, {AppLang lang = AppLang.ms}) {
  final h24 = t.hour;
  final h12 = h24 % 12 == 0 ? 12 : h24 % 12;
  final mm = t.minute.toString().padLeft(2, '0');
  final part = lang == AppLang.ms
      ? switch (h24) {
          < 12 => 'pagi',
          12 => 'tengah hari',
          < 19 => 'petang',
          _ => 'malam',
        }
      : dayPartWord(h24, lang);
  return '$h12:$mm $part';
}

/// [timeOfDayWords], with "esok" when [t] falls on the day after [today]
/// and a short date when it is further away. Both in the reader's zone.
String whenWords(DateTime t, {required DateTime today, AppLang lang = AppLang.ms}) {
  final time = timeOfDayWords(t, lang: lang);
  final d0 = DateTime(today.year, today.month, today.day);
  final d1 = DateTime(t.year, t.month, t.day);
  final days = d1.difference(d0).inDays;
  if (days == 0) return time;
  final comma = lang == AppLang.ar ? '\u060C' : ',';
  if (days == 1) {
    return switch (lang) {
      AppLang.ms => '$time esok',
      AppLang.en => '$time tomorrow',
      AppLang.ar => '$time \u063A\u062F\u064B\u0627',
    };
  }
  return '$time$comma ${t.day} ${monthWord(t.month, lang, ms: monthWordsMs[t.month - 1])}';
}
