// The words of the Peranti and Pengguna lists, and the name rule.
//
// Day counts are always the server's (`PeopleActivityDto`), never computed
// from the phone's clock; these functions only turn a count into a sentence in
// the language of the [S] given.

import '../../l10n/generated/s.dart';

/// "aktif hari ini" (0), "aktif semalam" (1), "aktif {n} hari lalu" (more).
/// A negative count reads as today.
String lastActiveWords(S s, int idleDays) {
  if (idleDays <= 0) return s.peopleActiveToday;
  if (idleDays == 1) return s.peopleActiveYesterday;
  return s.peopleActiveDaysAgo(idleDays);
}

/// "tidak digunakan {n} hari".
String unusedWords(S s, int idleDays) => s.peopleUnusedDays(idleDays < 0 ? 0 : idleDays);

const String _fsi = '\u2068'; // FIRST STRONG ISOLATE
const String _pdi = '\u2069'; // POP DIRECTIONAL ISOLATE

/// [name] between FSI and PDI: a name written in Arabic inside a Malay row (or
/// the other way round) keeps its own direction and does not reorder the words
/// around it. Empty stays empty and an already isolated name is unchanged.
String isolate(String name) {
  if (name.isEmpty) return name;
  if (name.startsWith(_fsi) && name.endsWith(_pdi)) return name;
  return '$_fsi$name$_pdi';
}

final RegExp _forbidden = RegExp('[\u0000-\u001F\u007F\u202A-\u202E\u2066-\u2069]');
final RegExp _whitespaceRun = RegExp(r'\s+');

/// The name as the box stores it: runs of whitespace become one space, then
/// trimmed. Does not check anything: see [nameProblem].
String cleanedName(String raw) => raw.replaceAll(_whitespaceRun, ' ').trim();

/// The sentence for what is wrong with [raw] as a name of a person or device,
/// or null when it is fine. The app-side twin of the box's `checkName`: no
/// control character (U+0000 to U+001F, U+007F), no direction override (U+202A
/// to U+202E, U+2066 to U+2069), and 1 to 80 characters after [cleanedName].
String? nameProblem(S s, String raw) => nameIsValid(raw) ? null : s.nameInvalid;

/// Whether [raw] passes the name rule (see [nameProblem]).
bool nameIsValid(String raw) {
  if (_forbidden.hasMatch(raw)) return false;
  final clean = cleanedName(raw);
  return clean.isNotEmpty && clean.length <= 80;
}
