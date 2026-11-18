// [PP-A1] The words of the Peranti and Pengguna lists: "aktif 3 hari lalu",
// "tidak digunakan 90 hari", the name rule and the direction isolate.

import 'package:flutter_test/flutter_test.dart';
import 'package:surau_app/features/people/people_words.dart';
import 'package:surau_app/l10n/generated/s.dart';
import 'package:surau_app/l10n/generated/s_ar.dart';
import 'package:surau_app/l10n/generated/s_en.dart';
import 'package:surau_app/l10n/generated/s_ms.dart';

void main() {
  final ms = SMs();
  final en = SEn();
  final ar = SAr();

  group('[PP-A1] lastActiveWords and unusedWords', () {
    test('[PP-A1] 0 days is today, 1 is yesterday, more is "n hari lalu"', () {
      expect(lastActiveWords(ms, 0), 'aktif hari ini');
      expect(lastActiveWords(ms, 1), 'aktif semalam');
      expect(lastActiveWords(ms, 3), 'aktif 3 hari lalu');
      expect(lastActiveWords(en, 3), 'active 3 days ago');
      expect(lastActiveWords(en, 0), 'active today');
      expect(lastActiveWords(ar, 1), isNotEmpty);
      expect(lastActiveWords(ms, -2), 'aktif hari ini', reason: 'never negative');
    });

    test('[PP-A1] unused for n days', () {
      expect(unusedWords(ms, 90), 'tidak digunakan 90 hari');
      expect(unusedWords(en, 61), 'unused for 61 days');
      expect(unusedWords(ms, 0), 'tidak digunakan 0 hari');
    });
  });

  group('[PP-A1] isolate', () {
    test('[PP-A1] the name sits between FSI and PDI', () {
      expect(isolate('Ustaz Ahmad'), '\u2068Ustaz Ahmad\u2069');
      expect(isolate(''), '');
      expect(isolate('\u2068x\u2069'), '\u2068x\u2069', reason: 'not wrapped twice');
    });
  });

  group('[PP-A1] nameProblem and cleanedName', () {
    String? problem(String raw) => nameProblem(ms, raw);

    test('[PP-A1] empty, blank, 81 characters, a control character and U+202E are refused', () {
      const bad = 'Nama mesti 1 hingga 80 aksara';
      expect(problem(''), bad);
      expect(problem('   '), bad);
      expect(problem('a' * 81), bad);
      expect(problem('Encik\u0007Rahman'), bad);
      expect(problem('Encik\tRahman'), bad);
      expect(problem('Encik\u007FRahman'), bad);
      expect(problem('Encik\u202ERahman'), bad);
      expect(problem('Encik\u2066Rahman'), bad);
      expect(problem('Encik\u2069Rahman'), bad);
    });

    test('[PP-A1] a good name has no problem, 80 characters included, spaces collapsed first', () {
      expect(problem('Encik Rahman'), isNull);
      expect(problem('a' * 80), isNull);
      expect(problem('  Kak   Siti  '), isNull);
      expect(problem('أحمد بن علي'), isNull);
      expect(nameProblem(en, ''), 'The name must be 1 to 80 characters');
    });

    test('[PP-A1] cleanedName trims and collapses runs of whitespace', () {
      expect(cleanedName('  Encik   Rahman '), 'Encik Rahman');
      expect(cleanedName('Puan  Aminah'), 'Puan Aminah');
      expect(cleanedName(''), '');
    });
  });

  test('[PP-A1] S has the words used here', () {
    expect(S, isNotNull);
  });
}
