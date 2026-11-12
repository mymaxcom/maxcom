// Role permissions and the feature switches the menu depends on. The
// permission table and the role labels are generated from core into
// `lib/features/registry.g.dart` (`node scripts/gen-app-fixtures.mjs`);
// this file re-exports them and keeps the helpers every screen calls.

import '../registry.g.dart';

export '../registry.g.dart' show permissions, roleLabelsMs;

/// Core's `can`: true when any of [roles] holds [permission]. A person with
/// several roles gets the union (operator rule 2026-11-04). Unknown roles
/// hold nothing.
bool can(Iterable<String> roles, String permission) {
  for (final role in roles) {
    final held = permissions[role];
    if (held != null && held.contains(permission)) return true;
  }
  return false;
}

/// The plan's name for [can], used by the menu and the route guards.
bool canSee(Set<String> roles, String permission) => can(roles, permission);

/// `defaultEnabled` from the registry for the features that hide a menu
/// entry when off (spec 5.4). Used until the box's settings have loaded.
const Map<String, bool> featureDefaultEnabled = {
  'finance': false,
  'liveOnKiosk': true,
  'liveYoutube': true,
  'jemaahPage': false,
};

/// Which features are on, read from `GET /api/settings`
/// (`{ <feature>: { enabled, ... } }`); features the box did not mention
/// fall back to the registry default.
class FeatureFlags {
  const FeatureFlags([this._enabled = const {}]);

  /// Everything at its registry default (no settings loaded yet).
  static const FeatureFlags defaults = FeatureFlags();

  factory FeatureFlags.fromSettings(Map<String, dynamic> settings) {
    final out = <String, bool>{};
    for (final entry in settings.entries) {
      final v = entry.value;
      if (v is Map && v['enabled'] is bool) out[entry.key] = v['enabled'] as bool;
    }
    return FeatureFlags(out);
  }

  final Map<String, bool> _enabled;

  bool isOn(String feature) =>
      _enabled[feature] ?? featureDefaultEnabled[feature] ?? false;

  /// For tests and previews: [defaults] with some features forced.
  FeatureFlags copyWith(Map<String, bool> changes) =>
      FeatureFlags({..._enabled, ...changes});
}
