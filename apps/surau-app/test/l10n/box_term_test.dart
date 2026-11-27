// The product term for a device in the multi-box set (lib/l10n/box_term.dart) is spelled the same way in every
// language: no bare "Kotak"/"box" noun, and every "Kiosk Box" is the whole product term.

import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:surau_app/l10n/box_term.dart';

Map<String, String> _arb(String lang) {
  final json = jsonDecode(File('lib/l10n/app_$lang.arb').readAsStringSync()) as Map<String, dynamic>;
  return {for (final e in json.entries) if (!e.key.startsWith('@')) e.key: e.value as String};
}

void main() {
  final langs = {'ms': _arb('ms'), 'en': _arb('en'), 'ar': _arb('ar')};

  for (final e in langs.entries) {
    test('${e.key}: "Kiosk Box" only ever as the whole product term', () {
      final bad = <String>[];
      for (final s in e.value.entries) {
        for (final m in RegExp(r'Kiosk Box').allMatches(s.value)) {
          if (!s.value.substring(0, m.start).endsWith('MAXCOM ')) bad.add(s.key);
        }
      }
      expect(bad, isEmpty);
    });
    test('${e.key}: the product term is used by the multi-box strings', () {
      expect(e.value['tvsSectionBoxes'], contains(boxProductTerm));
      expect(e.value['linkDeviceOther'], contains(boxProductTerm));
    });
  }

  test('ms: no lower-case or Indonesian noun for the device, roles follow the term', () {
    final ms = langs['ms']!;
    expect(ms['tvsMainBox'], '$boxShortTerm $boxMainMs');
    expect(ms['tvsFollowerBox'], '$boxShortTerm $boxFollowerMs');
    expect(ms.values.where((v) => RegExp(r'\bkotak\b', caseSensitive: false).hasMatch(v)), isEmpty);
  });

  test('en and ar: role words wrap the short term', () {
    expect(langs['en']!['tvsMainBox'], '${boxMainEn[0].toUpperCase()}${boxMainEn.substring(1)} $boxShortTerm');
    expect(langs['en']!['tvsFollowerBox'], '${boxFollowerEn[0].toUpperCase()}${boxFollowerEn.substring(1)} $boxShortTerm');
    expect(langs['ar']!['tvsMainBox'], '$boxShortTerm $boxMainAr');
    expect(langs['ar']!['tvsFollowerBox'], '$boxShortTerm $boxFollowerAr');
  });
}
