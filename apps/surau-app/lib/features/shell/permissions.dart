// Role permissions and the feature switches the menu depends on. The
// permission table and the role labels are generated from core into
// `lib/features/registry.g.dart` (`node scripts/gen-app-fixtures.mjs`);
// this file re-exports them and keeps the helpers every screen calls.

import '../registry.g.dart';
import '../settings_defaults.dart';

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

/// Core's `LIVE_SETTINGS_FEATURES`: the features a Siaran Langsung user
/// (`live:settings`) may change without `settings:write`.
const Set<String> liveSettingsFeatures = {'liveOnKiosk', 'liveYoutube', 'recording', 'liveCamera'};

/// Core's `canWriteSettingsFeatures` for one feature: `settings:write`, or
/// `live:settings` and a live feature.
bool canWriteSettingsFeature(Set<String> roles, String feature) =>
    canSee(roles, 'settings:write') || (canSee(roles, 'live:settings') && liveSettingsFeatures.contains(feature));

/// Which features are on, read from `GET /api/settings`
/// (`{ <feature>: { enabled, ... } }`); features the box did not mention
/// fall back to the registry default
/// (`featureDefaultOn`, the generated registry: no hand-kept list, B2).
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

  /// A feature the Tetapan lists hide (planned) behaves as off whatever is stored: nobody could switch it off again.
  bool isOn(String feature) =>
      !hiddenFeatures.contains(feature) && (_enabled[feature] ?? featureDefaultOn(feature));

  /// For tests and previews: [defaults] with some features forced.
  FeatureFlags copyWith(Map<String, bool> changes) =>
      FeatureFlags({..._enabled, ...changes});
}
