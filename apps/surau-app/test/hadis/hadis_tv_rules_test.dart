// What the phone says the TV will do gives the answers core records: the
// vectors under `tv` in test/fixtures/hadis-cases.json are computed by
// packages/core (regenerate with `node scripts/gen-app-fixtures.mjs --hadis`).

import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:surau_app/hadis/hadis_api.dart';
import 'package:surau_app/hadis/hadis_tv_rules.dart';

void main() {
  final file =
      jsonDecode(File('test/fixtures/hadis-cases.json').readAsStringSync())
          as Map<String, dynamic>;
  final tv = file['tv'] as Map<String, dynamic>;
  List<Map<String, dynamic>> listOf(String key) =>
      (tv[key] as List<dynamic>).cast<Map<String, dynamic>>();

  group('hadisTier', () {
    final cases = listOf('tierCases');
    test('there are vectors', () => expect(cases, isNotEmpty));
    for (var i = 0; i < cases.length; i++) {
      final c = cases[i];
      test('case $i (from ${c['from']})', () {
        expect(
          hadisTier(c['textMs'] as String, c['textAr'] as String?, from: c['from'] as String),
          c['expect'],
        );
      });
    }
  });

  group('hadisPlan', () {
    final cases = listOf('planCases');
    test('some vectors go to parts and some stay single', () {
      final modes = {for (final c in cases) (c['expect'] as Map)['mode']};
      expect(modes, {'single', 'parts'});
    });
    for (var i = 0; i < cases.length; i++) {
      final c = cases[i];
      test('case $i', () {
        final item = c['item'] as Map<String, dynamic>;
        final e = c['expect'] as Map<String, dynamic>;
        final plan = hadisPlan(
          textMs: item['textMs'] as String,
          textAr: item['textAr'] as String?,
          intro: item['intro'] as String?,
          settings: c['settings'] as Map<String, dynamic>,
        );
        expect(plan.isParts, e['mode'] == 'parts');
        expect(plan.tier, e['tier']);
        if (plan.isParts) {
          expect(plan.parts, e['parts']);
        } else {
          expect(plan.showAr, e['showAr']);
        }
      });
    }
  });

  group('hadisPool', () {
    final items = [
      for (final i in listOf('poolItems')) HadisItem(i),
    ];
    final cases = listOf('poolCases');
    test('there are vectors', () => expect(cases, isNotEmpty));
    for (var i = 0; i < cases.length; i++) {
      final c = cases[i];
      test('case $i (${c['today']})', () {
        final out = hadisPool(
          items,
          c['settings'] as Map<String, dynamic>,
          c['today'] as String,
        );
        expect([for (final h in out) h.id], c['expect']);
      });
    }
  });

  group('hadisPool with more than the card cap', () {
    final items = [
      for (final i in listOf('poolBigItems')) HadisItem(i),
    ];
    final cases = listOf('poolBigCases');
    test('there are vectors, and a card window is the cap', () {
      expect(cases, isNotEmpty);
      final card = cases.firstWhere(
        (c) => (c['settings'] as Map)['changeEvery'] == 'card',
      );
      expect((card['expect'] as List), hasLength(hadisCardPoolMax));
      expect(hadisCardPoolMax, 50);
    });
    for (var i = 0; i < cases.length; i++) {
      final c = cases[i];
      test('big case $i (${c['today']})', () {
        final out = hadisPool(
          items,
          c['settings'] as Map<String, dynamic>,
          c['today'] as String,
        );
        expect([for (final h in out) h.id], c['expect']);
      });
    }
  });

  test('a part of a long hadis is tier m with four Malay lines', () {
    final plan = hadisPlan(
      textMs: 'Satu ayat yang panjang sekali. ' * 40,
      settings: const {},
    );
    expect(plan.isParts, isTrue);
    expect(plan.tier, 'm');
    expect(plan.msLines, 4);
    expect(hadisTierSizes('m').msLines, 3);
  });
}
