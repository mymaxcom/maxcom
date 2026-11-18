// What a person may open, derived from the union of their roles and the
// box's feature switches: the menu entries in the order they are shown,
// and the rule for every path so the guard and the menu never disagree.
// A hidden entry leaves no gap (spec 5.4); a path the person may not open
// sends them home with `Tiada kebenaran untuk tindakan ini`.

import 'package:flutter/material.dart';

import '../../app/router.dart';
import '../../l10n/generated/s.dart';
import '../../ops/fleet/fleet_menu.dart';
import '../../ops/fleet/fleet_routes.dart';
import '../../ops/ops_build.dart';
import '../validate.dart' show featureByKey;
import 'permissions.dart';

enum MenuEntry {
  dashboard,
  content,
  settings,
  people,
  audit,
  live,
  upload,
  finance,
  jemaah,

  /// The MAXCOM Ops fleet entries (ops build only; see lib/ops/fleet/fleet_menu.dart).
  fleet,
}

class MenuItem {
  const MenuItem({
    required this.entry,
    required this.route,
    required this.icon,
    required this.selectedIcon,
    this.labelOf,
  });

  final MenuEntry entry;
  final String route;
  final IconData icon;
  final IconData selectedIcon;

  /// A label that does not come from the arb files (the ops entries).
  final String Function(S s)? labelOf;

  String label(S s) => labelOf?.call(s) ?? switch (entry) {
    MenuEntry.dashboard => s.navDashboard,
    MenuEntry.content => s.navContent,
    MenuEntry.settings => s.navSettings,
    MenuEntry.people => s.navPeople,
    MenuEntry.audit => s.navAudit,
    MenuEntry.live => s.navLive,
    MenuEntry.upload => s.navUpload,
    MenuEntry.finance => s.navFinance,
    MenuEntry.jemaah => s.navJemaah,
    MenuEntry.fleet => '',
  };

  /// True when [location] is this entry's page or one of its children; the
  /// people entry also owns the devices and pairing pages.
  bool matches(String location) {
    if (route == AppRoutes.dashboard) return location == AppRoutes.dashboard;
    if (entry == MenuEntry.people &&
        (_under(location, AppRoutes.devices) ||
            _under(location, AppRoutes.pairing))) {
      return true;
    }
    return _under(location, route);
  }
}

const List<MenuItem> _allItems = [
  MenuItem(
    entry: MenuEntry.dashboard,
    route: AppRoutes.dashboard,
    icon: Icons.home_outlined,
    selectedIcon: Icons.home_rounded,
  ),
  MenuItem(
    entry: MenuEntry.finance,
    route: AppRoutes.finance,
    icon: Icons.savings_outlined,
    selectedIcon: Icons.savings_rounded,
  ),
  MenuItem(
    entry: MenuEntry.content,
    route: AppRoutes.content,
    icon: Icons.article_outlined,
    selectedIcon: Icons.article_rounded,
  ),
  MenuItem(
    entry: MenuEntry.settings,
    route: AppRoutes.settings,
    icon: Icons.tune_outlined,
    selectedIcon: Icons.tune_rounded,
  ),
  MenuItem(
    entry: MenuEntry.people,
    route: AppRoutes.users,
    icon: Icons.people_outline_rounded,
    selectedIcon: Icons.people_rounded,
  ),
  MenuItem(
    entry: MenuEntry.audit,
    route: AppRoutes.audit,
    icon: Icons.history_rounded,
    selectedIcon: Icons.history_rounded,
  ),
  MenuItem(
    entry: MenuEntry.live,
    route: AppRoutes.live,
    icon: Icons.videocam_outlined,
    selectedIcon: Icons.videocam_rounded,
  ),
  // Under Live: the catch-up uploads of recordings YouTube did not get.
  MenuItem(
    entry: MenuEntry.upload,
    route: AppRoutes.upload,
    icon: Icons.cloud_upload_outlined,
    selectedIcon: Icons.cloud_upload_rounded,
  ),
  MenuItem(
    entry: MenuEntry.jemaah,
    route: AppRoutes.jemaah,
    icon: Icons.groups_outlined,
    selectedIcon: Icons.groups_rounded,
  ),
];

/// The menu for a person: entries their roles allow and whose feature is
/// on, in display order.
List<MenuItem> menuFor(Set<String> roles, FeatureFlags features, {bool ops = false}) => [
  if (kOpsBuild && ops) ...opsFleetMenu(roles),
  for (final item in _allItems)
    if (routeAllowed(item.route, roles, features) &&
        !(kOpsBuild && opsLocalDataClosed(cloud: ops, roles: roles) && isLocalDataPath(item.route)))
      item,
];

/// The MAXCOM system pages (Lanjutan): a settings page whose feature is of group `lanjutan`.
bool _isSystemPage(String path) {
  final key = path.startsWith('${AppRoutes.settings}/') ? path.substring(AppRoutes.settings.length + 1) : '';
  return key.isNotEmpty && featureByKey(key)?.group == 'lanjutan';
}

/// Whether [location] may be opened by someone with [roles] while
/// [features] are switched on. Unknown paths are refused.
bool routeAllowed(String location, Set<String> roles, FeatureFlags features) {
  final path = _normalise(location);
  bool has(String p) => canSee(roles, p);

  // The MAXCOM Ops screens exist only in the ops build, for `fleet:read`.
  if (isOpsPath(path)) return kOpsBuild && opsRouteAllowed(path, roles);
  if (path == AppRoutes.dashboard) return true;
  if (path == AppRoutes.thisDevice) return true;
  // Scanning a box QR (a probe, an enrolment code) is for any signed-in person.
  if (path == AppRoutes.scan) return true;
  // Everyone's own edits that did not land.
  if (path == AppRoutes.syncConflicts) return true;
  // MAXCOM system pages (Lanjutan) exist only in the ops build (Plan 14 Task 25), for `system:read`;
  // the public app refuses the route whoever asks.
  if (_isSystemPage(path)) return kOpsBuild && has('system:read');
  if (path == AppRoutes.settingsOrder) return has('settings:write');
  if (_under(path, AppRoutes.settings)) return has('settings:read');
  if (_under(path, AppRoutes.content)) return has('content:read');
  if (path == AppRoutes.preview) return has('kiosk:read');
  if (path == AppRoutes.islamic) return has('settings:read');
  if (_under(path, AppRoutes.prayerData)) return has('prayer:import');
  if (_under(path, AppRoutes.users)) {
    return has('users:manage') || has('devices:manage');
  }
  if (path == AppRoutes.devices) return has('devices:manage');
  if (path == AppRoutes.pairing) return has('devices:manage');
  if (path == AppRoutes.audit) return has('audit:read');
  if (_under(path, AppRoutes.finance)) {
    if (!features.isOn('finance')) return false;
    // Keying in, the opening balances and the audit trail are for
    // finance:write; the fund settings for the Pentadbir (settings:write);
    // the rest is read-only.
    if (path == AppRoutes.financeKutipan ||
        path == AppRoutes.financeBayaran ||
        path == AppRoutes.financeCorrection ||
        path == AppRoutes.financeAudit) {
      return has('finance:write');
    }
    if (path == AppRoutes.financeFunds) return has('settings:write');
    if (path == AppRoutes.financeSetup) return has('finance:write');
    return has('finance:read');
  }
  if (path == AppRoutes.live) {
    // The box refuses every start while the kiosk switch is off, YouTube-only included.
    return has('live:control') && features.isOn('liveOnKiosk');
  }
  if (path == AppRoutes.upload) {
    return has('live:control') && features.isOn('youtubeCatchUp');
  }
  if (path == AppRoutes.jemaah) {
    return has('settings:read') && features.isOn('jemaahPage');
  }
  return false;
}

bool _under(String path, String root) =>
    path == root || path.startsWith('$root/');

String _normalise(String location) {
  var path = location;
  final q = path.indexOf('?');
  if (q >= 0) path = path.substring(0, q);
  if (path.length > 1 && path.endsWith('/')) {
    path = path.substring(0, path.length - 1);
  }
  return path.isEmpty ? AppRoutes.dashboard : path;
}
