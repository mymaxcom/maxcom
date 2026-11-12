// The settings data layer: read every feature's settings through the
// gateway (last answer cached for when the box is away), save a patch of
// only the changed keys, reset a feature to its defaults. The box merges a
// patch deeply, so a nested change sends just the changed cells.
//
// Errors are typed for the form: a refused patch carries the box's first
// message, a feature the box does not know says so, a write while the box
// is away is `OfflineWriteRefused` (`Cuba lagi di surau`, nothing sent),
// and a 401 is `SessionExpired` as everywhere else.

import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../app/providers.dart';
import '../box/box_client.dart';
import 'registry.g.dart';
import 'shell/box_gateway.dart';
import 'shell/read_cache.dart';

enum SettingsFailure { invalid, notFound, forbidden, other }

/// A save the box refused. [message] is the text to show beside the form:
/// the box's `errors[0]` for a 400.
class SettingsSaveError implements Exception {
  const SettingsSaveError(this.kind, this.message, {this.status});

  final SettingsFailure kind;
  final String message;
  final int? status;

  static const String forbiddenMessage = 'Tiada kebenaran untuk tindakan ini';
  static const String notFoundMessage = 'Ciri tidak dijumpai';

  @override
  String toString() => 'SettingsSaveError($kind, $message)';
}

bool _deepEqual(Object? a, Object? b) {
  if (a is Map && b is Map) {
    if (a.length != b.length) return false;
    for (final k in a.keys) {
      if (!b.containsKey(k) || !_deepEqual(a[k], b[k])) return false;
    }
    return true;
  }
  if (a is List && b is List) {
    if (a.length != b.length) return false;
    for (var i = 0; i < a.length; i++) {
      if (!_deepEqual(a[i], b[i])) return false;
    }
    return true;
  }
  return a == b;
}

/// Settings whose object value is one thing, not a group of cells: an
/// image reference (`{asset, crop, bg, ...}`) is validated and stored as
/// a whole, so a change to any part sends all of it.
const Set<String> wholeValueKeys = {'logo'};

/// The keys of [edited] whose value differs from [original], nested
/// objects reduced to their changed cells (except [wholeValueKeys]);
/// lists go whole. Empty when nothing changed.
Map<String, dynamic> diffPatch(
  Map<String, dynamic> original,
  Map<String, dynamic> edited,
) {
  final out = <String, dynamic>{};
  for (final e in edited.entries) {
    final o = original[e.key];
    final v = e.value;
    if (o is Map && v is Map && !wholeValueKeys.contains(e.key)) {
      final sub = diffPatch(o.cast<String, dynamic>(), v.cast<String, dynamic>());
      if (sub.isNotEmpty) out[e.key] = sub;
    } else if (!original.containsKey(e.key) || !_deepEqual(o, v)) {
      out[e.key] = v;
    }
  }
  return out;
}

class SettingsRepository {
  SettingsRepository(this.gateway, {this.onSaved});

  final BoxGateway gateway;

  /// Called after a save or reset succeeded (the provider refreshes the
  /// shared settings with it).
  final void Function()? onSaved;

  static const String path = '/api/settings';

  /// All features' settings: fresh, or the cached answer marked stale.
  Future<Read<Map<String, dynamic>>> load() => gateway.get(path);

  /// `PUT /api/settings/<feature>` with [patch] (changed keys only).
  /// Returns the full settings the box answered with; the read cache is
  /// updated so an offline reading shows what was saved.
  Future<Map<String, dynamic>> save(
    String feature,
    Map<String, dynamic> patch,
  ) async {
    try {
      final all = await gateway.put('$path/$feature', patch);
      gateway.cache.put(path, all, gateway.now());
      onSaved?.call();
      return all;
    } on SessionExpired {
      rethrow;
    } on BoxError catch (e) {
      throw switch (e.status) {
        400 => SettingsSaveError(SettingsFailure.invalid, e.message, status: 400),
        403 => const SettingsSaveError(
          SettingsFailure.forbidden,
          SettingsSaveError.forbiddenMessage,
          status: 403,
        ),
        404 => const SettingsSaveError(
          SettingsFailure.notFound,
          SettingsSaveError.notFoundMessage,
          status: 404,
        ),
        _ => SettingsSaveError(SettingsFailure.other, e.message, status: e.status),
      };
    }
  }

  /// `PUT { enabled: defaultEnabled, ...defaults }` for [feature]. A locked
  /// feature stays on (its default is on).
  Future<Map<String, dynamic>> resetToDefaults(String feature) {
    final f = features.where((x) => x.key == feature).firstOrNull;
    if (f == null) {
      throw const SettingsSaveError(
        SettingsFailure.notFound,
        SettingsSaveError.notFoundMessage,
      );
    }
    return save(feature, defaultsPatch(f));
  }
}

/// `{enabled: defaultEnabled, ...defaults}` as plain JSON values.
Map<String, dynamic> defaultsPatch(FeatureDef f) => {
  'enabled': f.defaultEnabled,
  ...(_copy(f.defaults) as Map<String, dynamic>),
};

Object? _copy(Object? v) {
  if (v is Map) return {for (final e in v.entries) e.key as String: _copy(e.value)};
  if (v is List) return [for (final x in v) _copy(x)];
  return v;
}

/// Null until unlocked (no gateway). Saving refreshes [settingsProvider].
final settingsRepositoryProvider = Provider<SettingsRepository?>((ref) {
  final gateway = ref.watch(gatewayProvider);
  if (gateway == null) return null;
  return SettingsRepository(
    gateway,
    onSaved: () => ref.invalidate(settingsProvider),
  );
});
