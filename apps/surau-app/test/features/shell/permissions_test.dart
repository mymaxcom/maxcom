// The Dart copy of core's PERMISSIONS and of the menu features' default
// switches must equal the TypeScript source, read from the repo.

import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:surau_app/features/shell/menu.dart' show routeAllowed;
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
  test('[L4] with only liveYoutube on there is no Live tab and no Live route', () {
    final onlyYoutube = FeatureFlags.defaults.copyWith({
      'liveOnKiosk': false,
      'liveYoutube': true,
    });
    expect(routeAllowed('/live', {'live'}, onlyYoutube), isFalse);
    final kiosk = FeatureFlags.defaults.copyWith({'liveOnKiosk': true});
    expect(routeAllowed('/live', {'live'}, kiosk), isTrue);
  });

  final permissionsTs = _read('../../packages/core/src/auth/permissions.ts');
  final registryTs = _read('../../packages/core/src/features/registry.ts');

  // Cloud-only roles and permissions (Plan 14) stay out of the public app; the
  // ops build gets its own registry under lib/ops/ (Task 25).
  const cloudOnlyRoles = {'support'};
  const cloudOnlyPermissions = {
    'fleet:read',
    'fleet:manage',
    'surau:create',
    'surau:suspend',
    'audit:read_all',
  };

  test('permissions equal core PERMISSIONS role for role', () {
    final all = _parsePermissions(permissionsTs);
    expect(all.keys, containsAll(['admin', 'treasurer', 'media', 'ajk']));
    final core = {
      for (final e in all.entries)
        if (!cloudOnlyRoles.contains(e.key))
          e.key: e.value.where((p) => !cloudOnlyPermissions.contains(p)).toList(),
    };
    expect(permissions.keys.toSet(), core.keys.toSet());
    for (final role in core.keys) {
      expect(permissions[role], core[role], reason: role);
    }
  });

  test('no cloud-only role or permission reaches the public app', () {
    for (final role in cloudOnlyRoles) {
      expect(permissions.containsKey(role), isFalse, reason: role);
    }
    for (final list in permissions.values) {
      expect(list.where(cloudOnlyPermissions.contains), isEmpty);
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

  test('a feature hidden from Tetapan is off whatever the box stores', () {
    final f = FeatureFlags.fromSettings({
      'jemaahPage': {'enabled': true},
      'finance': {'enabled': true},
    });
    expect(f.isOn('jemaahPage'), isFalse);
    expect(f.copyWith({'jemaahPage': true}).isOn('jemaahPage'), isFalse);
    expect(f.isOn('finance'), isTrue);
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

  // [A14] The permission the app asks for to open a page must imply the one
  // the box asks for on the first read that page makes, or a page opens whose
  // reads fail. Read from the box's route table (apps/box-server authz.ts).
  group('[A14] app route rules imply the box permission of the first read', () {
    final authz = _read('../box-server/src/auth/authz.ts');
    final rows = <String, String>{
      for (final m in RegExp(
        r"method: '(\w+)', pattern: .*?permission: '([^']+)', sample: '([^'`]+)'",
      ).allMatches(authz))
        '${m.group(1)} ${m.group(3)}': m.group(2)!,
    };
    final router = _read('lib/app/router.dart');
    final appRoutes = <String>{
      for (final m in RegExp(r"static const String \w+ = '(/[^']*)';").allMatches(router))
        m.group(1)!,
    };

    // The first read each page makes, as a box sample path. Routes with
    // no entry here read nothing the box guards by role (see [noRead]).
    const firstRead = <String, String>{
      '/settings': '/api/settings',
      '/settings/order': '/api/settings',
      '/settings/sync': '/api/settings',
      '/settings/location': '/api/settings',
      '/settings/zone': '/api/prayer/zones',
      '/settings/prayer-sources': '/api/settings',
      '/settings/templat': '/api/themes/support',
      '/settings/templat/muat-naik': '/api/themes/support',
      '/settings/:feature': '/api/settings',
      '/content': '/api/content/announcements',
      '/content/:kind': '/api/content/announcements',
      '/content/hadis/cari': '/api/hadis/status',
      '/preview': '/api/kiosk/content',
      '/islamic': '/api/islamic/status',
      '/prayer-data': '/api/prayer/status',
      '/prayer-data/import': '/api/prayer/status',
      '/prayer-data/imports': '/api/prayer/imports',
      '/prayer-data/import-paparan-lama': '/api/prayer/status',
      '/users': '/api/users',
      '/users/new': '/api/users',
      '/devices': '/api/devices',
      '/pairing': '/api/kiosk/pair/pending',
      '/audit': '/api/audit',
      '/finance': '/api/finance/summary',
      '/finance/kutipan': '/api/finance/funds',
      '/finance/bayaran': '/api/finance/funds',
      '/finance/pembetulan': '/api/finance/entries',
      '/finance/tabung': '/api/finance/funds',
      '/finance/laporan': '/api/finance/summary',
      '/finance/audit': '/api/finance/audit',
      '/finance/setup': '/api/finance/funds',
      '/live': '/api/live/status',
      '/upload': '/api/youtube/quota',
      '/jemaah': '/api/settings',
    };
    // Pages that read nothing role-guarded, or are doors outside the shell.
    const noRead = <String>{
      '/', '/enrol', '/setup', '/recovery', '/scan', '/unlock',
      '/this-device', '/sync/conflicts',
    };

    String concrete(String route) => route
        .replaceAll(':feature', 'clock')
        .replaceAll(':kind', 'kuliah');

    test('every route of the app has a first read, or is listed as reading nothing', () {
      final missing = appRoutes.where(
        (r) => !firstRead.containsKey(r) && !noRead.contains(r) && !r.startsWith('/ops'),
      );
      expect(missing, isEmpty, reason: 'add the page to firstRead in this test');
    });

    test('each first read is a real route of the box', () {
      for (final e in firstRead.entries) {
        expect(rows.containsKey('GET ${e.value}'), isTrue, reason: '${e.key} -> ${e.value}');
      }
    });

    test('whoever the app lets into a page holds the box permission of its first read', () {
      final allOn = FeatureFlags.fromSettings({
        for (final k in featureDefaultEnabled.keys) k: {'enabled': true},
      }).copyWith({'finance': true, 'liveOnKiosk': true, 'youtubeCatchUp': true});
      final bad = <String>[];
      for (final role in permissions.keys) {
        for (final e in firstRead.entries) {
          final need = rows['GET ${e.value}'];
          if (need == null || need == 'session_or_site' || need == 'public') continue;
          if (routeAllowed(concrete(e.key), {role}, allOn) && !can([role], need)) {
            bad.add('$role opens ${e.key} but the box needs $need for ${e.value}');
          }
        }
      }
      expect(bad, isEmpty);
    });
  });
}
