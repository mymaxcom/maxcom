// The 114 surah names in BM (Latin script, Malaysian transliteration), index 0 = surah 1.
// One source: core `islamic/surahs.ts`, generated into registry.g.dart (the box and the TV read the same table).

import '../../features/registry.g.dart' show surahs;

final List<String> surahNamesMs = [for (final r in surahs) r[1] as String];

/// "36. Yasin"
String surahLabel(int surah) => '$surah. ${surahNamesMs[surah - 1]}';
