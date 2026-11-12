// What a person may open, derived from the union of their roles and the
// box's feature switches: the menu entries in the order they are shown,
// and the rule for every path so the guard and the menu never disagree.
// A hidden entry leaves no gap (spec 5.4); a path the person may not open
// sends them home with `Tiada kebenaran untuk tindakan ini`.

import 'package:flutter/material.dart';

import '../../app/router.dart';
import '../../l10n/generated/s.dart';
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
}

class MenuItem {
  const MenuItem({
    required this.entry,
    required this.route,
    required this.icon,
    required this.selectedIcon,
  });

  final MenuEntry entry;
  final String route;
  final IconData icon;
  final IconData selectedIcon;

  String label(S s) => switch (entry) {
    MenuEntry.dashboard => s.navDashboard,
    MenuEntry.content => s.navContent,
    MenuEntry.settings => s.navSettings,
    MenuEntry.people => s.navPeople,
    MenuEntry.audit => s.navAudit,
    MenuEntry.live => s.navLive,
    MenuEntry.upload => s.navUpload,
    MenuEntry.finance => s.navFinance,
    MenuEntry.jemaah => s.navJemaah,
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
List<MenuItem> menuFor(Set<String> roles, FeatureFlags features) => [
  for (final item in _allItems)
    if (routeAllowed(item.route, roles, features)) item,
];

const Set<String> _systemPages = {
  '/settings/cloudSync',
  '/settings/dataSources',
  '/settings/system',
};

/// Whether [location] may be opened by someone with [roles] while
/// [features] are switched on. Unknown paths are refused.
bool routeAllowed(String location, Set<String> roles, FeatureFlags features) {
  final path = _normalise(location);
  bool has(String p) => canSee(roles, p);

  if (path == AppRoutes.dashboard) return true;
  if (path == AppRoutes.thisDevice) return true;
  // Scanning a box QR (a probe, an enrolment code) is for any signed-in person.
  if (path == AppRoutes.scan) return true;
  // Everyone's own edits that did not land.
  if (path == AppRoutes.syncConflicts) return true;
  // MAXCOM system pages (Lanjutan) are for the Pentadbir MAXCOM; the group is hidden from others and so is the route.
  if (_systemPages.contains(path)) return has('system:read');
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
    return has('live:control') &&
        (features.isOn('liveOnKiosk') || features.isOn('liveYoutube'));
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
