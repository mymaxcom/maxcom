// The surah table is ONE source: core `islamic/surahs.ts` (the box and the TV read it too), generated into
// registry.g.dart and test/fixtures/surahs.json by `node scripts/gen-app-fixtures.mjs --surahs`.

import 'dart:convert';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:surau_app/features/registry.g.dart';
import 'package:surau_app/features/surah_names.dart';
import 'package:surau_app/l10n/generated/s.dart';

void main() {
  test('all 114 rows match core: number, Malaysian name, ayat count, Arabic name', () {
    final file = File('test/fixtures/surahs.json');
    expect(file.existsSync(), isTrue, reason: 'run from apps/surau-app');
    final core = jsonDecode(file.readAsStringSync()) as List;
    expect(core, hasLength(114));
    expect(surahs, hasLength(114));
    for (var i = 0; i < 114; i++) {
      expect(surahs[i], core[i], reason: 'surah ${i + 1} differs from core: run gen-app-fixtures.mjs --surahs');
    }
    expect(surahs.fold<int>(0, (a, r) => a + (r[2] as int)), 6236);
  });

  test('the name follows the app language: Arabic in AR, the TV spelling in BM and EN', () {
    final ms = lookupS(const Locale('ms'));
    final en = lookupS(const Locale('en'));
    final ar = lookupS(const Locale('ar'));
    expect(surahName(ms, 18), 'Al-Kahfi');
    expect(surahName(en, 18), 'Al-Kahfi');
    expect(surahName(ar, 18), 'الكهف');
    expect(surahName(ms, 36), 'Yasin');
    expect(surahNumbered(ms, 18), '18. Al-Kahfi');
    expect(surahNumbered(ar, 18), contains('18. الكهف'));
  });

  test('search ignores case, hyphens, apostrophes and spaces and matches the Arabic name and the number', () {
    bool hit(int n, String q) => normaliseSearch(surahSearchText(n)).contains(normaliseSearch(q));
    for (final q in ['yasin', 'ya sin', 'Ya-Sin', 'YA-SIN', 'يس', '36']) {
      expect(hit(36, q), isTrue, reason: q);
    }
    expect(hit(36, 'kahf'), isFalse);
    expect(hit(18, 'الكهف'), isTrue);
    expect(hit(18, 'al kahfi'), isTrue);
    expect(hit(3, 'ali imran'), isTrue);
    expect(hit(3, "Ali 'Imran"), isTrue);
    expect(hit(26, 'syuara'), isTrue);
  });
}
