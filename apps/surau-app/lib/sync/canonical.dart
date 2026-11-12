// Canonical JSON, op digest and op message: the Dart twin of
// packages/core/src/sync/canonical.ts. The shared vectors in
// packages/core/test/fixtures/sync-vectors.json pin both sides byte for
// byte (test/sync/canonical_test.dart reads the copy under test/fixtures).
//
// Rules (RFC 8785 subset): object keys sorted by UTF-16 code units, no
// whitespace, numbers printed the way JavaScript's String(n) does (so
// `1e+21`, `-0` as `0`, no `.0`), strings escaped like JSON.stringify.

import 'dart:convert';
import 'dart:typed_data';

import 'package:pointycastle/export.dart';

/// First line of every signed op. The wake and dirty messages and
/// `surau-unlock` never share it.
const String opMessagePrefix = 'surau-op';

const int _maxSafeInt = 9007199254740991;

String canonicalJson(Object? v) {
  final b = StringBuffer();
  _write(b, v);
  return b.toString();
}

void _write(StringBuffer b, Object? v) {
  if (v == null) {
    b.write('null');
  } else if (v is bool) {
    b.write(v ? 'true' : 'false');
  } else if (v is num) {
    b.write(_number(v));
  } else if (v is String) {
    _string(b, v);
  } else if (v is List) {
    b.write('[');
    for (var i = 0; i < v.length; i++) {
      if (i > 0) b.write(',');
      _write(b, v[i]);
    }
    b.write(']');
  } else if (v is Map) {
    final keys = <String>[];
    for (final k in v.keys) {
      if (k is! String) {
        throw ArgumentError('canonicalJson: object key is not a string');
      }
      keys.add(k);
    }
    keys.sort((a, b) => a.compareTo(b)); // UTF-16 code unit order
    b.write('{');
    var first = true;
    for (final k in keys) {
      if (!first) b.write(',');
      first = false;
      _string(b, k);
      b.write(':');
      _write(b, v[k]);
    }
    b.write('}');
  } else {
    throw ArgumentError('canonicalJson: unsupported ${v.runtimeType}');
  }
}

String _number(num n) {
  if (n is int && n.abs() <= _maxSafeInt) return n.toString();
  final d = n.toDouble();
  if (d.isNaN || d.isInfinite) {
    throw ArgumentError('canonicalJson: non-finite number');
  }
  if (d == 0) return '0'; // also -0
  var s = d.toString();
  if (s.endsWith('.0')) s = s.substring(0, s.length - 2);
  return s;
}

const String _hex = '0123456789abcdef';

void _string(StringBuffer b, String s) {
  b.write('"');
  for (var i = 0; i < s.length; i++) {
    final c = s.codeUnitAt(i);
    switch (c) {
      case 0x22:
        b.write('\\"');
      case 0x5c:
        b.write('\\\\');
      case 0x08:
        b.write('\\b');
      case 0x0c:
        b.write('\\f');
      case 0x0a:
        b.write('\\n');
      case 0x0d:
        b.write('\\r');
      case 0x09:
        b.write('\\t');
      default:
        final lone = _isLoneSurrogate(s, i);
        if (c < 0x20 || lone) {
          b.write('\\u');
          b.write(_hex[(c >> 12) & 15]);
          b.write(_hex[(c >> 8) & 15]);
          b.write(_hex[(c >> 4) & 15]);
          b.write(_hex[c & 15]);
        } else {
          b.writeCharCode(c);
        }
    }
  }
  b.write('"');
}

bool _isLoneSurrogate(String s, int i) {
  final c = s.codeUnitAt(i);
  if (c >= 0xd800 && c <= 0xdbff) {
    return !(i + 1 < s.length &&
        s.codeUnitAt(i + 1) >= 0xdc00 &&
        s.codeUnitAt(i + 1) <= 0xdfff);
  }
  if (c >= 0xdc00 && c <= 0xdfff) {
    return !(i > 0 &&
        s.codeUnitAt(i - 1) >= 0xd800 &&
        s.codeUnitAt(i - 1) <= 0xdbff);
  }
  return false;
}

/// Lowercase hex sha256 of [data].
String sha256HexOf(List<int> data) {
  final d = SHA256Digest();
  final out = d.process(Uint8List.fromList(data));
  final b = StringBuffer();
  for (final x in out) {
    b.write(_hex[x >> 4]);
    b.write(_hex[x & 15]);
  }
  return b.toString();
}

/// Hex sha256 of the canonical JSON of the op without its `sig`.
String opDigest(Map<String, dynamic> op) {
  final rest = Map<String, dynamic>.of(op)..remove('sig');
  return sha256HexOf(utf8.encode(canonicalJson(rest)));
}

/// `surau-op\n<boxId>\n<deviceId>\n<opId>\n<opDigest>` as UTF-8: the bytes
/// a device signs.
Uint8List opMessage(Map<String, dynamic> op) => Uint8List.fromList(
  utf8.encode(
    '$opMessagePrefix\n${op['boxId']}\n${op['deviceId']}\n${op['opId']}\n'
    '${opDigest(op)}',
  ),
);

/// The wake message a device signs (the contract's own prefix family).
Uint8List wakeDeviceMessage(String boxId, String deviceId, int tsMs) =>
    Uint8List.fromList(
      utf8.encode('maxcom-wake-dev\n$boxId\n$deviceId\n$tsMs'),
    );
