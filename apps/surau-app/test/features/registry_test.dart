// The generated registry equals core: counts, a nested default, the
// permission table, and the hash of core's sources recorded at generation
// (a core change without `node scripts/gen-app-fixtures.mjs` fails here).

import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:pointycastle/digests/sha256.dart';
import 'package:surau_app/features/labels_ms.dart';
import 'package:surau_app/features/registry.g.dart';

String _read(String relative) {
  final file = File(relative);
  if (!file.existsSync()) {
    throw StateError('$relative not found; run from apps/surau-app');
  }
  return file.readAsStringSync();
}

/// Same recipe as the generator: the three sources, CRLF as LF, in order.
String coreHashNow() {
  final d = SHA256Digest();
  for (final f in [
    'features/registry.ts',
    'features/settings.ts',
    'auth/permissions.ts',
    'features/meta.ts',
    'features/lists.ts',
  ]) {
    final text = _read('../../packages/core/src/$f').replaceAll('\r\n', '\n');
    final bytes = Uint8List.fromList(utf8.encode(text));
    d.update(bytes, 0, bytes.length);
  }
  final out = Uint8List(32);
  d.doFinal(out, 0);
  return out.map((b) => b.toRadixString(16).padLeft(2, '0')).join();
}

void main() {
  test('core sources unchanged since the registry was generated', () {
    expect(
      coreSourceHash,
      coreHashNow(),
      reason:
          'core changed: run  node scripts/gen-app-fixtures.mjs  and commit',
    );
    final cases = jsonDecode(_read('test/fixtures/settings-cases.json')) as Map;
    expect(cases['coreSourceHash'], coreSourceHash);
  });

  test('features: core has 53, 9 of them locked', () {
    expect(features.length, 53);
    final locked = features.where((f) => f.locked).map((f) => f.key).toSet();
    expect(locked, {
      'prayerBar',
      'clock',
      'prayerSequenceSafety',
      'zone',
      'surauInfo',
      'dataSources',
      'location',
      'prayerSources',
      'system',
    });
    expect(features.map((f) => f.key).toSet().length, features.length);
  });

  test('appLock: group Keselamatan, off by default, not locked', () {
    final f = features.firstWhere((x) => x.key == 'appLock');
    expect(f.group, 'keselamatan');
    expect(groupLabelsMs['keselamatan'], 'Keselamatan');
    expect(f.defaultEnabled, isFalse);
    expect(f.locked, isFalse);
    expect(f.defaults, isEmpty);
    expect(f.labelMs, 'Kunci aplikasi');
  });

  test('every feature has a group heading and BM + EN label', () {
    for (final f in features) {
      expect(groupLabelsMs.containsKey(f.group), isTrue, reason: f.key);
      expect(f.labelMs, isNotEmpty);
      expect(f.labelEn, isNotEmpty);
    }
  });

  test('nested defaults survive: Subuh iqamah on Friday is 12', () {
    final f = features.firstWhere((x) => x.key == 'iqamahCountdown');
    final minutes = f.defaults['minutes'] as Map;
    expect((minutes['jumaat'] as Map)['subuh'], 12);
    expect((minutes['ahad'] as Map).length, 5);
    expect(minutes.length, 7);
    expect(f.defaultEnabled, isTrue);
  });

  test('permissions equal core for every role', () {
    expect(permissions.keys.toSet(), {'superadmin', 'admin', 'treasurer', 'media', 'ajk'});
    expect(permissions['ajk'], [
      'settings:read',
      'content:read',
      'kiosk:read',
      'finance:read',
      'health:read',
    ]);
    expect(permissions['admin'], contains('users:manage'));
    expect(permissions['admin'], isNot(contains('system:write')));
    expect(permissions['superadmin'], containsAll(['users:manage', 'system:read', 'system:write', 'superadmin:manage']));
    expect(roleLabelsMs['superadmin'], 'Pentadbir MAXCOM');
    expect(roleLabelsEn['superadmin'], 'MAXCOM Administrator');
    expect(roleLabelsMs['treasurer'], 'Bendahari');
  });
}
