// The Dart copy of core's PERMISSIONS and of the menu features' default
// switches must equal the TypeScript source, read from the repo.

import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:surau_app/features/shell/permissions.dart';

String _read(String relative) {
  final file = File(relative);
  if (!file.existsSync()) {
    throw StateError('$relative not found; run from apps/surau-app');
  }
  return file.readAsStringSync();
}

/// `admin: [ 'a', 'b' ]` blocks inside `export const PERMISSIONS`.
Map<String, List<String>> _parsePermissions(String ts) {
  final start = ts.indexOf('export const PERMISSIONS');
  final end = ts.indexOf('};', start);
  final block = ts.substring(start, end);
  final out = <String, List<String>>{};
  for (final m in RegExp(r'(\w+):\s*\[([^\]]*)\]').allMatches(block)) {
    out[m.group(1)!] = RegExp(r"'([^']+)'")
        .allMatches(m.group(2)!)
        .map((q) => q.group(1)!)
        .toList();
  }
  return out;
}

/// `def('finance', 'kewangan', false, false` -> key: defaultEnabled.
Map<String, bool> _parseDefaults(String ts) => {
  for (final m in RegExp(
    r"def\('(\w+)',\s*'\w+',\s*(true|false),\s*(true|false)",
  ).allMatches(ts))
    m.group(1)!: m.group(3) == 'true',
};

void main() {
  final permissionsTs = _read('../../packages/core/src/auth/permissions.ts');
  final registryTs = _read('../../packages/core/src/features/registry.ts');

  test('permissions equal core PERMISSIONS role for role', () {
    final core = _parsePermissions(permissionsTs);
    expect(core.keys, containsAll(['admin', 'treasurer', 'media', 'ajk']));
    expect(permissions.keys.toSet(), core.keys.toSet());
    for (final role in core.keys) {
      expect(permissions[role], core[role], reason: role);
    }
  });

  test('menu feature defaults equal the registry', () {
    final core = _parseDefaults(registryTs);
    expect(core.length, greaterThan(40));
    for (final e in featureDefaultEnabled.entries) {
      expect(core[e.key], e.value, reason: e.key);
    }
  });

  test('can is the union over roles; unknown roles hold nothing', () {
    expect(can(['ajk'], 'content:write'), isFalse);
    expect(can(['ajk', 'media'], 'content:write'), isTrue);
    expect(can(['treasurer', 'ajk'], 'finance:write'), isTrue);
    expect(can(['imam'], 'settings:read'), isFalse);
    expect(can([], 'settings:read'), isFalse);
    expect(canSee({'admin'}, 'users:manage'), isTrue);
  });

  test('feature flags fall back to registry defaults', () {
    const none = FeatureFlags.defaults;
    expect(none.isOn('finance'), isFalse);
    expect(none.isOn('liveOnKiosk'), isTrue);
    expect(none.isOn('jemaahPage'), isFalse);
    expect(none.isOn('somethingElse'), isFalse);

    final fromBox = FeatureFlags.fromSettings({
      'finance': {'enabled': true},
      'liveOnKiosk': {'enabled': false},
      'clock': {'enabled': 'yes'},
    });
    expect(fromBox.isOn('finance'), isTrue);
    expect(fromBox.isOn('liveOnKiosk'), isFalse);
    expect(fromBox.isOn('liveYoutube'), isTrue, reason: 'default kept');
    expect(fromBox.isOn('clock'), isFalse, reason: 'bad value ignored');
  });
}
