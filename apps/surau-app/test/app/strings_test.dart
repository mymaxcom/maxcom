// Guards the user-facing strings (Plan 4 Global Constraints):
// BM is the template; every key exists in both files; no dash, arrow or
// approximation symbols; Malaysian wording, not Indonesian.

import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';

Map<String, String> _readArb(String path) {
  final file = File(path);
  if (!file.existsSync()) throw StateError('$path must exist');
  final json = jsonDecode(file.readAsStringSync()) as Map<String, dynamic>;
  return {
    for (final entry in json.entries)
      if (!entry.key.startsWith('@')) entry.key: entry.value as String,
  };
}

/// Characters and sequences no user-facing string may contain.
const _forbiddenSequences = <String, String>{
  '—': 'em dash',
  '–': 'en dash',
  '≈': 'approximation sign',
  '→': 'right arrow',
  '←': 'left arrow',
  '↑': 'up arrow',
  '↓': 'down arrow',
  '->': 'ASCII arrow',
  '=>': 'ASCII arrow',
};

/// Indonesian words that must not appear (Malaysian equivalents in brackets).
const _indonesianDenyList = <String>[
  'bisa', // boleh
  'unduh', // muat turun
  'unggah', // muat naik
  'butuh', // perlukan
  'mengunduh',
  'mengunggah',
  'membutuhkan',
];

void main() {
  final ms = _readArb('lib/l10n/app_ms.arb');
  final en = _readArb('lib/l10n/app_en.arb');

  test('BM template has strings', () {
    expect(ms, isNotEmpty);
  });

  test('every BM key exists in English, and the reverse', () {
    final missingInEn = ms.keys.where((k) => !en.containsKey(k)).toList();
    final missingInMs = en.keys.where((k) => !ms.containsKey(k)).toList();
    expect(missingInEn, isEmpty, reason: 'keys missing from app_en.arb');
    expect(missingInMs, isEmpty, reason: 'keys missing from app_ms.arb');
  });

  test('the template locale is ms', () {
    final json = jsonDecode(
      File('lib/l10n/app_ms.arb').readAsStringSync(),
    ) as Map<String, dynamic>;
    expect(json['@@locale'], 'ms');
  });

  for (final entry in {'ms': ms, 'en': en}.entries) {
    test('no forbidden symbols in app_${entry.key}.arb', () {
      final offenders = <String>[];
      for (final s in entry.value.entries) {
        for (final f in _forbiddenSequences.entries) {
          if (s.value.contains(f.key)) {
            offenders.add('${s.key}: ${f.value}');
          }
        }
      }
      expect(offenders, isEmpty);
    });

    test('no empty values in app_${entry.key}.arb', () {
      final empty = entry.value.entries
          .where((e) => e.value.trim().isEmpty)
          .map((e) => e.key)
          .toList();
      expect(empty, isEmpty);
    });
  }

  test('BM strings use Malaysian words, not Indonesian', () {
    final offenders = <String>[];
    for (final s in ms.entries) {
      for (final word in _indonesianDenyList) {
        final re = RegExp('\\b$word\\b', caseSensitive: false);
        if (re.hasMatch(s.value)) offenders.add('${s.key}: $word');
      }
    }
    expect(offenders, isEmpty);
  });

  test('the strings the plan names are present in BM', () {
    expect(ms['settingsTitle'], 'Tetapan');
    expect(ms['errorForbidden'], 'Tiada kebenaran untuk tindakan ini');
    expect(ms['errorBoxUnreachable'], 'Tidak dapat menghubungi MAXCOM');
    expect(ms['hadisReorderNeedsConnection'], 'Susun semula perlukan sambungan ke MAXCOM');
    expect(en['hadisReorderNeedsConnection'], isNotEmpty);
  });

  test('MyHadith appears nowhere in the app text (dropped 2026-11-09)', () {
    final re = RegExp('myhadith', caseSensitive: false);
    for (final entry in {'ms': ms, 'en': en}.entries) {
      final offenders = entry.value.entries.where((e) => re.hasMatch(e.value)).map((e) => e.key).toList();
      expect(offenders, isEmpty, reason: entry.key);
    }
  });

  // Operator rule 2026-11-04: the box is "MAXCOM" (exact spelling) or
  // the surau's own name, never "Kotak".
  for (final entry in {'ms': ms, 'en': en}.entries) {
    test('no "Kotak" in app_${entry.key}.arb', () {
      final re = RegExp(r'\bkotak\b', caseSensitive: false);
      final offenders = entry.value.entries
          .where((e) => re.hasMatch(e.value))
          .map((e) => e.key)
          .toList();
      expect(offenders, isEmpty);
    });
  }

  // Plan 14 (R33): one word for the box. Never "Peranti MAXCOM" nor "aplikasi Surau".
  for (final entry in {'ms': ms, 'en': en}.entries) {
    test('no "Peranti MAXCOM" and no "aplikasi Surau" in app_${entry.key}.arb', () {
      final re = RegExp(r'peranti maxcom|aplikasi surau', caseSensitive: false);
      final offenders = entry.value.entries.where((e) => re.hasMatch(e.value)).map((e) => e.key).toList();
      expect(offenders, isEmpty);
    });
  }

  test('MAXCOM is spelled exactly wherever it appears', () {
    final loose = RegExp(r'surau\s?tv\s?box', caseSensitive: false);
    for (final entry in {'ms': ms, 'en': en}.entries) {
      for (final s in entry.value.entries) {
        for (final m in loose.allMatches(s.value)) {
          expect(m.group(0), 'MAXCOM', reason: '${entry.key}/${s.key}');
        }
      }
    }
  });
}
