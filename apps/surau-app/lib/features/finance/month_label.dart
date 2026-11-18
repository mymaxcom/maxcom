// A month as a person reads it in the app language: "October 2026",
// "Oktober 2026". The names come from the catalogue; the A4 report keeps its
// own BM names (report_a4.dart).

import '../../l10n/generated/s.dart';

/// `2026-10` -> `October 2026` (the app language); an unreadable value is
/// returned as it is.
String monthLabel(S s, String ym) {
  final m = int.tryParse(ym.length >= 7 ? ym.substring(5, 7) : '') ?? 0;
  final names = s.ra3MonthNames.split('|');
  if (m < 1 || m > names.length || ym.length < 4) return ym;
  return '${names[m - 1]} ${ym.substring(0, 4)}';
}
