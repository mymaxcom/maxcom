// Surah names in the app: Arabic name in the Arabic UI, the Malaysian transliteration (the same spelling
// the TV uses) in BM and EN. The table is generated from core (islamic/surahs.ts) into registry.g.dart:
// row = [number, Malaysian name, ayat count, Arabic name].

import '../l10n/generated/s.dart';
import 'registry.g.dart';

List<Object> _row(int n) => surahs[n.clamp(1, surahs.length) - 1];

/// The name to show for surah [n] in the language of [s].
String surahName(S s, int n) => s.localeName == 'ar' ? _row(n)[3] as String : _row(n)[1] as String;

/// "18. الكهف" / "18. Al-Kahfi"; in Arabic the marks keep the number first when read inside Arabic text.
String surahNumbered(S s, int n) => s.localeName == 'ar' ? '‎$n. ${surahName(s, n)}‎' : '$n. ${surahName(s, n)}';

/// Lower case, without spaces, hyphens, apostrophes and dots, so "Ya-Sin", "ya sin" and "yasin" are one.
String normaliseSearch(String text) =>
    text.toLowerCase().replaceAll(RegExp("[\\s\\-'’‘ʿʾ.‎‏]"), '');

/// What a search matches for surah [n]: number, Arabic name and Malaysian name.
String surahSearchText(int n) {
  final row = _row(n);
  return '${row[0]} ${row[3]} ${row[1]}';
}
