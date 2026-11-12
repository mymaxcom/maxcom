// The 114 surah names in BM (Latin script, Malaysian transliteration),
// index 0 = surah 1, copied from the box's
// `apps/box-server/src/islamic/quranStore.ts` SURAH_NAMES (Latin column
// only: the app shows no Arabic, which the web build could not download a
// fallback font for under the box's CSP).

const List<String> surahNamesMs = [
  'Al-Fatihah', 'Al-Baqarah', "Ali 'Imran", "An-Nisa'", "Al-Ma'idah", "Al-An'am",
  "Al-A'raf", 'Al-Anfal', 'At-Taubah', 'Yunus', 'Hud', 'Yusuf',
  "Ar-Ra'd", 'Ibrahim', 'Al-Hijr', 'An-Nahl', "Al-Isra'", 'Al-Kahfi',
  'Maryam', 'Taha', "Al-Anbiya'", 'Al-Hajj', "Al-Mu'minun", 'An-Nur',
  'Al-Furqan', "Asy-Syu'ara'", 'An-Naml', 'Al-Qasas', "Al-'Ankabut", 'Ar-Rum',
  'Luqman', 'As-Sajdah', 'Al-Ahzab', "Saba'", 'Fatir', 'Yasin',
  'As-Saffat', 'Sad', 'Az-Zumar', 'Ghafir', 'Fussilat', 'Asy-Syura',
  'Az-Zukhruf', 'Ad-Dukhan', 'Al-Jasiyah', 'Al-Ahqaf', 'Muhammad', 'Al-Fath',
  'Al-Hujurat', 'Qaf', 'Az-Zariyat', 'At-Tur', 'An-Najm', 'Al-Qamar',
  'Ar-Rahman', "Al-Waqi'ah", 'Al-Hadid', 'Al-Mujadalah', 'Al-Hasyr', 'Al-Mumtahanah',
  'As-Saff', "Al-Jumu'ah", 'Al-Munafiqun', 'At-Taghabun', 'At-Talaq', 'At-Tahrim',
  'Al-Mulk', 'Al-Qalam', 'Al-Haqqah', "Al-Ma'arij", 'Nuh', 'Al-Jinn',
  'Al-Muzzammil', 'Al-Muddaththir', 'Al-Qiyamah', 'Al-Insan', 'Al-Mursalat', "An-Naba'",
  "An-Nazi'at", "'Abasa", 'At-Takwir', 'Al-Infitar', 'Al-Mutaffifin', 'Al-Insyiqaq',
  'Al-Buruj', 'At-Tariq', "Al-A'la", 'Al-Ghasyiyah', 'Al-Fajr', 'Al-Balad',
  'Asy-Syams', 'Al-Lail', 'Ad-Duha', 'Asy-Syarh', 'At-Tin', "Al-'Alaq",
  'Al-Qadr', 'Al-Bayyinah', 'Az-Zalzalah', "Al-'Adiyat", "Al-Qari'ah", 'At-Takathur',
  "Al-'Asr", 'Al-Humazah', 'Al-Fil', 'Quraisy', "Al-Ma'un", 'Al-Kauthar',
  'Al-Kafirun', 'An-Nasr', 'Al-Masad', 'Al-Ikhlas', 'Al-Falaq', 'An-Nas',
];

/// "36. Yasin"
String surahLabel(int surah) => '$surah. ${surahNamesMs[surah - 1]}';
