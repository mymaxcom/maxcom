// Guard: no Malay (BM) user-facing text typed into Dart code. Every message
// comes from the ARB catalogues (S) so it follows the app language. Scans
// the string literals of lib/**/*.dart for common BM words and fails with
// the list of file:line.
//
// A literal that must stay BM on purpose carries a trailing `// lang-ok:`
// comment with the reason (text the box sends and the app matches exactly,
// or a diagnostic the user never reads).

import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';

const _words = <String>[
  'Tidak', 'tidak', 'sila', 'Sila', 'Simpan', 'gagal', 'Gagal', 'mesti',
  'Mesti', 'belum', 'sudah', 'untuk', 'dengan', 'boleh',
  // Release 2026.11.12 (RA0): the words of the month, weekday, prayer and
  // unit lists that the area tasks must move to the catalogues.
  'Januari', 'Februari', 'Mac', 'Mei', 'Julai', 'Ogos', 'Oktober', 'Disember',
  'Isnin', 'Selasa', 'Rabu', 'Khamis', 'Jumaat', 'Sabtu', 'Ahad',
  'Subuh', 'Syuruk', 'Zohor', 'Asar', 'Maghrib', 'Isyak',
  'hingga', 'Kumpulan', 'Medan', 'Pilihan', 'Kamera', 'Siaran', 'Kod', 'Nama',
];

String _norm(String path) => path.split(r'\').join('/');

/// Folders and files that may hold BM: catalogues, label maps, generated
/// registries, documents (finance A4 report) and the trilingual screens.
bool _allowed(String path) {
  final p = _norm(path);
  if (p.contains('/l10n/') || p.startsWith('lib/l10n/')) return true;
  if (p.startsWith('lib/ops/')) return true;
  final name = p.split('/').last;
  if (name.startsWith('labels_') || name == 'labels.dart') return true;
  if (name == 'registry.g.dart' || name == 'registry_ops.g.dart') return true;
  if (p == 'lib/features/finance/report_a4.dart') return true;
  if (p == 'lib/features/common/trilingual_strings.dart') return true;
  // The live notice: the operator's three binding sentences (BM, English, Arabic).
  if (p == 'lib/features/live/live_notice.dart') return true;
  return false;
}

/// Files owned by another task of the language plan: flagged, not mine to
/// change. Each entry names the owner; remove it when that task lands.
const _siblingOwned = <String, String>{};

/// File -> the task that clears the words added in RA0. Each of RA1 to RA6
/// empties its own rows; RV leaves the map empty.
const _pending = <String, String>{};

final _literal = RegExp(
  r'''\x27(?:[^\x27\\]|\\.)*\x27|"(?:[^"\\]|\\.)*"''',
);

/// `line: text` for each line of [source] with a BM word in a string literal.
List<String> findBmLiterals(String source) {
  final out = <String>[];
  final lines = source.split('\n');
  for (var i = 0; i < lines.length; i++) {
    final line = lines[i];
    if (line.trimLeft().startsWith('//')) continue;
    if (line.contains('lang-ok')) continue;
    for (final m in _literal.allMatches(line)) {
      final text = m.group(0)!;
      if (_words.any((w) => RegExp('\\b$w\\b').hasMatch(text))) {
        out.add('${i + 1}: ${text.length > 70 ? text.substring(0, 70) : text}');
        break;
      }
    }
  }
  return out;
}

void main() {
  test('no BM words in string literals outside the catalogues', () {
    final hits = <String>[];
    final stale = <String>[];
    for (final f in Directory('lib').listSync(recursive: true)) {
      if (f is! File || !f.path.endsWith('.dart')) continue;
      final path = _norm(f.path);
      if (_allowed(path) || _siblingOwned.containsKey(path)) continue;
      final found = findBmLiterals(utf8.decode(f.readAsBytesSync(), allowMalformed: true));
      if (_pending.containsKey(path)) {
        if (found.isEmpty) stale.add('$path (${_pending[path]}) is clean: remove it from _pending');
        continue;
      }
      for (final h in found) {
        hits.add('$path:$h');
      }
    }
    expect(stale, isEmpty);
    expect(hits, isEmpty, reason: 'BM literals outside the catalogues:\n${hits.join('\n')}');
  });

  test('[LG7] the widened list finds month, weekday and prayer words and honours lang-ok', () {
    expect(findBmLiterals("final a = 'Januari';"), hasLength(1));
    expect(findBmLiterals("final a = 'Isnin';"), hasLength(1));
    expect(findBmLiterals("final a = 'Waktu Subuh';"), hasLength(1));
    expect(findBmLiterals('final a = "dari 1 hingga 5";'), hasLength(1));
    expect(findBmLiterals("final a = 'Kumpulan';"), hasLength(1));
    expect(findBmLiterals("final a = 'Siaran';"), hasLength(1));
    expect(findBmLiterals("final a = 'Januari'; // lang-ok: key"), isEmpty);
    expect(findBmLiterals("// 'Januari' in a comment"), isEmpty);
    expect(findBmLiterals("final a = 'January';"), isEmpty);
  });
}
