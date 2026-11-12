@TestOn('vm')
library;

import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:surau_app/sync/canonical.dart';

// Reads the shared vectors in place (read only): the same file the
// TypeScript test pins in packages/core.
Map<String, dynamic> _vectors() {
  final f = File('../../packages/core/test/fixtures/sync-vectors.json');
  return jsonDecode(f.readAsStringSync()) as Map<String, dynamic>;
}

String _hex(List<int> b) =>
    b.map((x) => x.toRadixString(16).padLeft(2, '0')).join();

void main() {
  final v = _vectors();
  final canon = (v['canonical'] as List).cast<Map<String, dynamic>>();
  final ops = (v['ops'] as List).cast<Map<String, dynamic>>();

  test('there are eleven vectors', () {
    expect(canon.length + ops.length, 11);
  });

  for (final c in canon) {
    test('canonical: ${c['name']}', () {
      final parsed = jsonDecode(c['inputJson'] as String);
      final out = canonicalJson(parsed);
      expect(out, c['canonical']);
      expect(sha256HexOf(utf8.encode(out)), c['sha256Hex']);
    });
  }

  for (final o in ops) {
    test('${o['name']}: canonical, digest, message', () {
      final op = o['op'] as Map<String, dynamic>;
      final without = Map<String, dynamic>.of(op)..remove('sig');
      expect(canonicalJson(without), o['canonicalWithoutSig']);
      expect(opDigest(op), o['digest']);
      final msg = opMessage(op);
      expect(utf8.decode(msg), o['messageText']);
      expect(_hex(msg), o['messageHex']);
    });
  }

  test('numbers print like JavaScript', () {
    expect(canonicalJson(-0.0), '0');
    expect(canonicalJson(1.0), '1');
    expect(canonicalJson(1e21), '1e+21');
    expect(canonicalJson(1e-7), '1e-7');
    expect(canonicalJson(0.1), '0.1');
    expect(canonicalJson(<String, dynamic>{'a': 2}), '{"a":2}');
  });

  test('NaN and infinity are refused', () {
    expect(() => canonicalJson(double.nan), throwsArgumentError);
    expect(() => canonicalJson(double.infinity), throwsArgumentError);
  });

  test('the wake message has its own prefix family', () {
    final m = utf8.decode(wakeDeviceMessage('b1', 'd1', 1700000000000));
    expect(m, 'maxcom-wake-dev\nb1\nd1\n1700000000000');
    expect(m.startsWith('surau-op'), isFalse);
  });
}
