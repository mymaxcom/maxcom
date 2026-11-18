// Plan 14: the ops fleet words keep the app's text rules (no dashes, arrows or approximation signs, no Indonesian
// words) and stay ASCII, so the binary scan finds them as plain bytes. Reads every `*_texts.dart` in lib/ops/fleet.

import 'dart:io';

import 'package:flutter_test/flutter_test.dart';

const _forbidden = <String>['—', '–', '≈', '→', '←', '↑', '↓', '->', '=>'];
const _indonesian = <String>['bisa', 'unduh', 'unggah', 'butuh', 'mengunduh', 'mengunggah', 'membutuhkan'];

void main() {
  final files = [
    for (final f in Directory('lib/ops/fleet').listSync())
      if (f is File && f.path.endsWith('_texts.dart')) f,
  ];

  test('there is a text file to check', () => expect(files, isNotEmpty));

  for (final f in files) {
    final name = f.uri.pathSegments.last;
    final src = f.readAsStringSync();
    test('$name is ASCII with no dash, arrow or approximation sign in a string', () {
      for (final unit in src.runes) {
        expect(unit < 128, isTrue, reason: 'non-ASCII character U+${unit.toRadixString(16)}');
      }
      for (final line in src.split('\n')) {
        if (line.trim().startsWith('//')) continue;
        for (final m in RegExp(r"'(?:[^'\\]|\\.)*'").allMatches(line)) {
          final lit = m.group(0)!;
          for (final bad in _forbidden) {
            expect(lit.contains(bad), isFalse, reason: '"$bad" in $lit');
          }
        }
      }
    });
    test('$name has no Indonesian word', () {
      final lower = src.toLowerCase();
      for (final w in _indonesian) {
        expect(RegExp('\\b$w\\b').hasMatch(lower), isFalse, reason: w);
      }
    });
  }
}
