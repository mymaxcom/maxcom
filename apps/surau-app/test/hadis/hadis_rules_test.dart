// The hadis rules on the phone give the answers core records: the vectors
// in test/fixtures/hadis-cases.json come from packages/core (regenerate with
// `node scripts/gen-app-fixtures.mjs --hadis`), plus the literal answers the
// plan fixes.

import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:surau_app/hadis/hadis_rules.dart';

void main() {
  final file =
      jsonDecode(File('test/fixtures/hadis-cases.json').readAsStringSync())
          as Map<String, dynamic>;
  final cases = (file['cases'] as List<dynamic>).cast<Map<String, dynamic>>();

  group('parity vectors with core', () {
    test('there are at least 12', () => expect(cases.length >= 12, isTrue));

    for (final c in cases) {
      final fn = c['fn'] as String;
      final input = c['input'] as String;
      final expected = c['expect'];
      test('$fn(${input.length > 24 ? '${input.substring(0, 24)}...' : input})',
          () {
        switch (fn) {
          case 'hadisLength':
            expect(hadisLength(input), expected);
          case 'gradeOf':
            expect(gradeKeyOf(input), expected);
          case 'attributionOf':
            final a = attributionOf(input);
            if (expected == null) {
              expect(a, isNull);
            } else {
              final e = expected as Map<String, dynamic>;
              expect(a?.short, e['short']);
              expect(a?.long, e['long']);
            }
          case 'providerItemId':
            expect(providerItemId(input), expected);
          case 'hadisParts':
            expect(hadisParts(input, max: (c['max'] as num).toInt()), expected);
          default:
            fail('unknown vector function $fn');
        }
      });
    }
  });

  group('literal answers', () {
    test('length classes', () {
      expect(hadisLength('a' * 220), 'short');
      expect(hadisLength('a' * 221), 'medium');
      expect(hadisLength('a' * 520), 'medium');
      expect(hadisLength('a' * 521), 'long');
    });

    test('grades map to BM labels and the two locked ones are not savable', () {
      expect(gradeKeyOf('صحيح'), 'sahih');
      expect(gradeKeyOf(' صَحِيح '), 'sahih');
      expect(gradeKeyOf('حسن لغيره'), 'hasan_lighairihi');
      expect(gradeKeyOf('ضعيف جدا'), isNull);
      expect(gradeLabel('sahih'), 'Sahih');
      expect(gradeLabel('sahih_lighairihi'), 'Sahih li ghairihi');
      expect(gradeLabel('maudhu'), 'Palsu (maudhu)');
      expect(gradeLabel('x'), 'x');
      expect(gradeSavable('sahih'), isTrue);
      expect(gradeSavable('hasan_lighairihi'), isTrue);
      expect(gradeSavable('dhaif'), isFalse);
      expect(gradeSavable('maudhu'), isFalse);
      expect(gradeSavable(null), isFalse);
      expect(hadisGrades, hasLength(6));
    });

    test('attributions', () {
      expect(
        attributionOf('رواه البخاري ومسلم'),
        const HadisAttribution('Muttafaq alaih', 'Riwayat al-Bukhari dan Muslim'),
      );
      expect(attributionOf('رواه مسلم'), const HadisAttribution('Riwayat Muslim', null));
      expect(
        attributionOf('رواه أحمد وأبو داود والنسائي')?.short,
        'Riwayat Ahmad, Abu Daud dan al-Nasai',
      );
      expect(attributionOf('رواه فلان'), isNull);
      expect(attributionOf('رواه مسلم وفلان'), isNull);
      expect(attributionOf(''), isNull);
    });

    test('parts split at sentence ends, even before a closing quote', () {
      final body = '${'Kata ' * 60}Akhir.” ${'Lagi ' * 60}Habis.';
      final parts = hadisParts(body);
      expect(parts, hasLength(2));
      expect(parts.first.endsWith('.”'), isTrue);
      expect(parts.every((p) => p.isNotEmpty && p.length <= 400), isTrue);
      expect(hadisParts('   '), isEmpty);
      final longWords = List.filled(200, 'perkataan').join(' ');
      final cut = hadisParts(longWords, max: 100);
      expect(cut.every((p) => p.isNotEmpty && p.length <= 100), isTrue);
      expect(cut.join(' '), longWords);
    });
  });
}
