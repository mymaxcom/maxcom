// The hadis rules the app needs on the phone: length class, the grade and
// attribution tables, the id of a saved HadeethEnc hadis, the parts of a long
// text. The same answers as `packages/core/src/content/hadisSource.ts` and
// `hadisDisplay.ts` (the box and the TV use those); `test/hadis` runs the
// vectors core records in `test/fixtures/hadis-cases.json` against this file.

/// `source` of an own-list hadis the importer could not attribute.
const String unstatedSource = 'Tidak dinyatakan';

/// Live hadis the box keeps, both sources together.
const int maxSaved = 500;

/// The list says `Hampir penuh` from this many saved hadis.
const int nearFullAt = 450;

/// The six grades HadeethEnc uses, in the order of the settings list.
class HadisGradeRow {
  const HadisGradeRow(this.ar, this.key, this.ms, this.note, this.allowed);

  final String ar;
  final String key;
  final String ms;
  final String note;

  /// False for the two grades that can never be shown on the TV.
  final bool allowed;
}

const List<HadisGradeRow> hadisGrades = [
  HadisGradeRow('صحيح', 'sahih', 'Sahih', 'Darjat tertinggi', true),
  HadisGradeRow('حسن', 'hasan', 'Hasan', 'Diterima sebagai hujah', true),
  HadisGradeRow(
    'صحيح لغيره',
    'sahih_lighairihi',
    'Sahih li ghairihi',
    'Sahih kerana sokongan riwayat lain',
    true,
  ),
  HadisGradeRow(
    'حسن لغيره',
    'hasan_lighairihi',
    'Hasan li ghairihi',
    'Hasan kerana sokongan riwayat lain',
    true,
  ),
  HadisGradeRow('ضعيف', 'dhaif', 'Dhaif', 'Lemah; tidak dipaparkan', false),
  HadisGradeRow(
    'موضوع',
    'maudhu',
    'Palsu (maudhu)',
    'Tidak sekali-kali dipaparkan',
    false,
  ),
];

/// Tatweel and diacritics out, alef, ya and ta marbuta folded, spaces
/// collapsed.
String _foldAr(String s) => s
    .replaceAll(RegExp('[\u0640\u064B-\u065F\u0670]'), '')
    .replaceAll(RegExp('[\u0622\u0623\u0625]'), '\u0627')
    .replaceAll('\u0649', '\u064A')
    .replaceAll('\u0629', '\u0647')
    .replaceAll(RegExp(r'\s+'), ' ')
    .trim();

final Map<String, String> _gradeByAr = {
  for (final g in hadisGrades) _foldAr(g.ar): g.key,
};

/// Grade key for HadeethEnc's Arabic grade text, null when it is not one of
/// the six known texts.
String? gradeKeyOf(String ar) => _gradeByAr[_foldAr(ar)];

/// BM label of a grade key, the key itself when unknown.
String gradeLabel(String key) {
  for (final g in hadisGrades) {
    if (g.key == key) return g.ms;
  }
  return key;
}

/// True when a grade may be saved at all: known and not Dhaif or Palsu.
bool gradeSavable(String? key) {
  if (key == null) return false;
  for (final g in hadisGrades) {
    if (g.key == key) return g.allowed;
  }
  return false;
}

const List<(String, String)> _narrators = [
  ('البخاري', 'al-Bukhari'),
  ('مسلم', 'Muslim'),
  ('أبو داود', 'Abu Daud'),
  ('الترمذي', 'al-Tirmizi'),
  ('النسائي', 'al-Nasai'),
  ('ابن ماجه', 'Ibnu Majah'),
  ('أحمد', 'Ahmad'),
  ('مالك', 'Malik'),
  ('الدارمي', 'al-Darimi'),
  ('ابن حبان', 'Ibnu Hibban'),
  ('الحاكم', 'al-Hakim'),
  ('البيهقي', 'al-Baihaqi'),
  ('الطبراني', 'al-Tabarani'),
];

final Map<String, String> _narratorByAr = {
  for (final n in _narrators) _foldAr(n.$1): n.$2,
};

final Set<String> _muttafaqAr = {
  _foldAr('متفق عليه'),
  _foldAr('رواه البخاري ومسلم'),
  _foldAr('رواه البخاري و مسلم'),
};

/// The BM form of an attribution: `short` is what the TV prints, `long` the
/// full form when the short one is Muttafaq alaih.
class HadisAttribution {
  const HadisAttribution(this.short, this.long);

  final String short;
  final String? long;

  @override
  bool operator ==(Object other) =>
      other is HadisAttribution && other.short == short && other.long == long;

  @override
  int get hashCode => Object.hash(short, long);

  @override
  String toString() => 'HadisAttribution($short, $long)';
}

String _joinNames(List<String> names) => names.length == 1
    ? names.first
    : '${names.sublist(0, names.length - 1).join(', ')} dan ${names.last}';

/// `رواه البخاري ومسلم` is Muttafaq alaih; `رواه X وY وZ` becomes
/// `Riwayat X, Y dan Z`. Null when any name is not in the table.
HadisAttribution? attributionOf(String ar) {
  final s = _foldAr(ar);
  if (s.isEmpty) return null;
  if (_muttafaqAr.contains(s)) {
    return const HadisAttribution(
      'Muttafaq alaih',
      'Riwayat al-Bukhari dan Muslim',
    );
  }
  final m = RegExp(r'^رواه (.+)$').firstMatch(s);
  if (m == null) return null;
  final parts = m
      .group(1)!
      .replaceAll(RegExp('\\s*[\u060C,]\\s*'), '|')
      .replaceAll(RegExp(r'\s+و\s+'), '|')
      .replaceAll(RegExp(r'\s+و(?=\S)'), '|')
      .split('|')
      .map((x) => x.trim())
      .where((x) => x.isNotEmpty)
      .toList();
  if (parts.isEmpty) return null;
  final names = <String>[];
  for (final p in parts) {
    final n = _narratorByAr[p];
    if (n == null) return null;
    names.add(n);
  }
  if (names.length == 2 && names[0] == 'al-Bukhari' && names[1] == 'Muslim') {
    return const HadisAttribution(
      'Muttafaq alaih',
      'Riwayat al-Bukhari dan Muslim',
    );
  }
  return HadisAttribution('Riwayat ${_joinNames(names)}', null);
}

/// 'short' up to 220 characters, 'medium' up to 520, else 'long'.
String hadisLength(String textMs) {
  final n = textMs.length;
  return n <= 220 ? 'short' : (n <= 520 ? 'medium' : 'long');
}

/// The content id of a saved HadeethEnc hadis.
String providerItemId(String id) => 'hadeethenc-$id';

/// Parts of at most [max] characters, split at sentence ends; one sentence
/// over [max] is split at the last space. Never an empty part.
List<String> hadisParts(String body, {int max = 400}) {
  final text = body.trim();
  if (text.isEmpty) return const [];
  final sentences = text
      .split(RegExp('(?<=[.?!][\u201D"\u2019)]*)\\s+'))
      .where((x) => x.isNotEmpty);
  final pieces = <String>[];
  for (var s in sentences) {
    while (s.length > max) {
      var cut = s.lastIndexOf(' ', max);
      if (cut <= 0) cut = max;
      pieces.add(s.substring(0, cut).trim());
      s = s.substring(cut).trim();
    }
    if (s.isNotEmpty) pieces.add(s);
  }
  final parts = <String>[];
  var cur = '';
  for (final p in pieces) {
    if (cur.isEmpty) {
      cur = p;
    } else if (cur.length + 1 + p.length <= max) {
      cur = '$cur $p';
    } else {
      parts.add(cur);
      cur = p;
    }
  }
  if (cur.isNotEmpty) parts.add(cur);
  return parts;
}
