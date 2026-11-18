// Guard: no physical left/right layout in lib/. Arabic mirrors the screen, so
// padding, alignment, borders, text alignment and positions use the
// directional forms (EdgeInsetsDirectional, AlignmentDirectional,
// BorderDirectional, TextAlign.start/end, PositionedDirectional).
//
// A line may opt out with `// dir-ok: <reason>` (a video frame, a chart that
// must not mirror). Files an area task has not cleared yet are in
// [_pending] with the task that owns them; each task empties its own rows and
// RV leaves the map empty.

import 'dart:io';

import 'package:flutter_test/flutter_test.dart';

String _norm(String path) => path.split(r'\').join('/');

/// Named arguments that are physical, per constructor.
const _physicalNamed = <String, Set<String>>{
  'EdgeInsets.only': {'left', 'right'},
  'Border': {'left', 'right'},
  'Positioned': {'left', 'right'},
  'SafeArea': {'left', 'right'},
};

/// Plain tokens that are physical wherever they appear.
final _physicalTokens = RegExp(
  r'\b(?:Alignment\.(?:centerLeft|centerRight|topLeft|topRight|bottomLeft|bottomRight)|TextAlign\.(?:left|right))\b',
);

/// Finds the physical layout in [source]; returns the 1-based line numbers.
/// A line carrying `dir-ok` is never reported.
List<int> findPhysicalDirection(String source) {
  final lines = source.split('\n');
  final hits = <int>{};
  bool ok(int line) => lines[line - 1].contains('dir-ok');
  int lineOf(int offset) => '\n'.allMatches(source.substring(0, offset)).length + 1;

  for (final m in _physicalTokens.allMatches(source)) {
    final line = lineOf(m.start);
    if (_isComment(lines[line - 1], m.start - _lineStart(source, m.start))) continue;
    if (!ok(line)) hits.add(line);
  }

  // Constructors with named arguments: read the balanced argument list.
  for (final entry in _physicalNamed.entries) {
    final ctor = RegExp('\\b${RegExp.escape(entry.key)}\\(');
    for (final m in ctor.allMatches(source)) {
      final line = lineOf(m.start);
      if (_isComment(lines[line - 1], m.start - _lineStart(source, m.start))) continue;
      final args = _args(source, m.end);
      if (args == null) continue;
      for (final a in args) {
        final name = RegExp(r'^\s*(\w+)\s*:').firstMatch(a.text)?.group(1);
        if (name != null && entry.value.contains(name)) {
          final at = lineOf(a.offset + (a.text.length - a.text.trimLeft().length));
          if (!ok(at) && !ok(line)) hits.add(at);
        }
      }
    }
  }

  // EdgeInsets.fromLTRB(a, b, c, d) with a != c.
  for (final m in RegExp(r'\bEdgeInsets\.fromLTRB\(').allMatches(source)) {
    final line = lineOf(m.start);
    if (_isComment(lines[line - 1], m.start - _lineStart(source, m.start))) continue;
    final args = _args(source, m.end);
    if (args == null || args.length < 3) continue;
    if (args[0].text.trim() != args[2].text.trim() && !ok(line)) hits.add(line);
  }
  return hits.toList()..sort();
}

int _lineStart(String s, int offset) => s.lastIndexOf('\n', offset == 0 ? 0 : offset - 1) + 1;

bool _isComment(String line, int col) {
  final i = line.indexOf('//');
  return i >= 0 && i <= col;
}

class _Arg {
  const _Arg(this.text, this.offset);
  final String text;
  final int offset;
}

/// The top-level arguments of the call whose `(` is just before [from].
List<_Arg>? _args(String s, int from) {
  var depth = 1;
  var start = from;
  final out = <_Arg>[];
  String? quote;
  for (var i = from; i < s.length; i++) {
    final c = s[i];
    if (quote != null) {
      if (c == r'\') {
        i++;
      } else if (c == quote) {
        quote = null;
      }
      continue;
    }
    if (c == "'" || c == '"') {
      quote = c;
    } else if (c == '(' || c == '[' || c == '{') {
      depth++;
    } else if (c == ')' || c == ']' || c == '}') {
      depth--;
      if (depth == 0) {
        out.add(_Arg(s.substring(start, i), start));
        return out;
      }
    } else if (c == ',' && depth == 1) {
      out.add(_Arg(s.substring(start, i), start));
      start = i + 1;
    }
  }
  return null;
}

/// File -> the task that clears it. Emptied by RA1 to RA6 and RV.
const _pending = <String, String>{};

void main() {
  group('the scanner', () {
    test('[C9] a planted Alignment.centerLeft is found, and dir-ok silences it', () {
      expect(findPhysicalDirection('final a = Alignment.centerLeft;'), [1]);
      expect(findPhysicalDirection('final a = Alignment.centerLeft; // dir-ok: video frame'), isEmpty);
      expect(findPhysicalDirection('final a = AlignmentDirectional.centerStart;'), isEmpty);
      expect(findPhysicalDirection('// Alignment.centerLeft in a comment'), isEmpty);
    });

    test('[C9] each physical form is found', () {
      for (final code in [
        'EdgeInsets.only(left: 8)',
        'EdgeInsets.only(top: 4, right: 8)',
        'EdgeInsets.fromLTRB(8, 0, 0, 0)',
        'Border(left: BorderSide())',
        'Border(right: BorderSide())',
        'TextAlign.left',
        'TextAlign.right',
        'Positioned(left: 0, child: x)',
        'Positioned(right: 0, child: x)',
        'SafeArea(left: false, child: x)',
        'Alignment.topRight',
        'Alignment.bottomLeft',
      ]) {
        expect(findPhysicalDirection('final a = $code;'), [1], reason: code);
      }
    });

    test('[C9] the directional and symmetric forms are not flagged', () {
      for (final code in [
        'EdgeInsetsDirectional.only(start: 8)',
        'EdgeInsets.only(top: 8, bottom: 2)',
        'EdgeInsets.fromLTRB(8, 0, 8, 0)',
        'EdgeInsets.fromLTRB(a + 1, 0, a + 1, 0)',
        'BorderDirectional(start: BorderSide())',
        'Border(top: BorderSide())',
        'TextAlign.start',
        'PositionedDirectional(start: 0, child: x)',
        'Positioned(top: 0, child: x)',
      ]) {
        expect(findPhysicalDirection('final a = $code;'), isEmpty, reason: code);
      }
    });

    test('[C9] a multi-line call is read to its closing bracket and reports the argument line', () {
      const src = 'final a = EdgeInsets.only(\n  top: 4,\n  left: 8,\n);';
      expect(findPhysicalDirection(src), [3]);
    });
  });

  test('[C9] [P11] [F12] [L9] [K12] [A12] no physical left/right layout in lib/', () {
    final hits = <String>[];
    final stale = <String>[];
    for (final f in Directory('lib').listSync(recursive: true)) {
      if (f is! File || !f.path.endsWith('.dart')) continue;
      final path = _norm(f.path);
      if (path.contains('/l10n/generated/')) continue;
      final found = findPhysicalDirection(f.readAsStringSync());
      if (_pending.containsKey(path)) {
        if (found.isEmpty) stale.add('$path (${_pending[path]}) is clean: remove it from _pending');
        continue;
      }
      for (final line in found) {
        hits.add('$path:$line');
      }
    }
    expect(stale, isEmpty);
    expect(hits, isEmpty, reason: 'physical left/right layout (use the directional form or // dir-ok: reason):\n${hits.join('\n')}');
  });
}
