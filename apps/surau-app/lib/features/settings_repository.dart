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
import '../l10n/generated/s.dart';
import '../l10n/s_lookup.dart';
import 'common/error_text.dart' show errorText, kErrorCodeTexts;
import 'settings_widgets/field_meta.dart' show fieldMeta;
import 'registry.g.dart';
import 'shell/box_gateway.dart';
import 'shell/read_cache.dart';

enum SettingsFailure { invalid, notFound, forbidden, other }

/// A refusal the app words itself (not the box's text): [SettingsSaveError.text]
/// gives it in the app language.
enum SettingsMsg { forbidden, notFound, tvLangNeedsUpdate, tvLangArNeedsUpdate }

/// A save the box refused. [message] is the text to show beside the form:
/// the box's `errors[0]` for a 400.
class SettingsSaveError implements Exception {
  const SettingsSaveError(this.kind, this.message, {this.status, this.msg, this.source});

  /// A refusal worded by the app, in BM as [message] and in any language via [text].
  SettingsSaveError.of(this.kind, SettingsMsg this.msg, {this.status})
    : message = _bmText(msg),
      source = null;

  final SettingsFailure kind;

  /// BM text (or the box's own first message for a 400); screens show [text].
  final String message;
  final int? status;
  final SettingsMsg? msg;

  /// The box's refusal, when it named a code the app words itself (K11).
  final BoxError? source;

  /// What to show beside the form, in the language of [s].
  String text(S s) {
    final src = source;
    if (src != null && kErrorCodeTexts.containsKey(src.code)) return errorText(s, src);
    return msg == null ? message : _textOf(s, msg!);
  }

  static String _textOf(S s, SettingsMsg m) => switch (m) {
    SettingsMsg.forbidden => s.errorForbidden,
    SettingsMsg.notFound => s.errorFeatureNotFound,
    SettingsMsg.tvLangNeedsUpdate => s.tvLangNeedsUpdate,
    SettingsMsg.tvLangArNeedsUpdate => s.tvLangArNeedsUpdate,
  };

  static String _bmText(SettingsMsg m) => _textOf(sBm, m);

  static String get forbiddenMessage => _bmText(SettingsMsg.forbidden);
  static String get notFoundMessage => _bmText(SettingsMsg.notFound);

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
const Set<String> wholeValueKeys = {'logo', 'styles', 'packs'};

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

/// A box from before the TV language "Automatik" (`auto`) or Arabic (`ar`) answers 400 and
/// names `language.lang`: say plainly that the box needs the update.
bool _olderBoxRefusesTvLang(
  String feature,
  Map<String, dynamic> patch,
  String boxMessage,
) =>
    feature == 'language' &&
    (patch['lang'] == 'auto' || patch['lang'] == 'ar') &&
    boxMessage.contains('language.lang');

class SettingsRepository {
  SettingsRepository(this.gateway, {this.onSaved});

  final BoxGateway gateway;

  /// Called after a save or reset succeeded (the provider refreshes the
  /// shared settings with it).
  final void Function()? onSaved;

  static const String path = '/api/settings';

  /// The last [save] was queued on this device, not yet heard by the box.
  bool lastSaveQueued = false;

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
      lastSaveQueued = gateway.lastPutQueued;
      gateway.cache.put(path, all, gateway.now());
      onSaved?.call();
      return all;
    } on SessionExpired {
      rethrow;
    } on BoxError catch (e) {
      throw switch (e.status) {
        400 when _olderBoxRefusesTvLang(feature, patch, e.message) =>
          SettingsSaveError.of(
            SettingsFailure.invalid,
            patch['lang'] == 'ar' ? SettingsMsg.tvLangArNeedsUpdate : SettingsMsg.tvLangNeedsUpdate,
            status: 400,
          ),
        400 => SettingsSaveError(SettingsFailure.invalid, e.message, status: 400, source: e),
        403 => SettingsSaveError.of(
          SettingsFailure.forbidden,
          SettingsMsg.forbidden,
          status: 403,
        ),
        404 => SettingsSaveError.of(
          SettingsFailure.notFound,
          SettingsMsg.notFound,
          status: 404,
        ),
        _ => SettingsSaveError(SettingsFailure.other, e.message, status: e.status, source: e),
      };
    }
  }

  /// `PUT { enabled: defaultEnabled, ...defaults }` for [feature]. A locked
  /// feature stays on (its default is on).
  ///
  /// Fields the Pentadbir MAXCOM owns (scope `system`) and hidden fields are
  /// left out unless [includeSystem] (the person holds `system:write`): the
  /// box refuses a patch that carries one for anyone else, which made every
  /// reset of Siaran YouTube and Tilawah fail (K3).
  Future<Map<String, dynamic>> resetToDefaults(String feature, {bool includeSystem = false}) {
    final f = features.where((x) => x.key == feature).firstOrNull;
    if (f == null) {
      throw SettingsSaveError.of(SettingsFailure.notFound, SettingsMsg.notFound);
    }
    return save(feature, defaultsPatch(f, includeSystem: includeSystem));
  }
}

/// `{enabled: defaultEnabled, ...defaults}` as plain JSON values.
Map<String, dynamic> defaultsPatch(FeatureDef f, {bool includeSystem = true}) => {
  'enabled': f.defaultEnabled,
  ...(_without(f.key, '', _copy(f.defaults), includeSystem) as Map<String, dynamic>),
};

/// [v] without the system-scoped and hidden fields (dot-joined [path]).
Object? _without(String feature, String path, Object? v, bool includeSystem) {
  if (includeSystem || v is! Map) return v;
  final out = <String, dynamic>{};
  for (final e in v.entries) {
    final p = path.isEmpty ? '${e.key}' : '$path.${e.key}';
    final meta = fieldMeta(feature, p);
    if (meta != null && (meta.isSystem || meta.hidden)) continue;
    out['${e.key}'] = _without(feature, p, e.value, includeSystem);
  }
  return out;
}

Object? _copy(Object? v) {
  if (v is Map) return {for (final e in v.entries) e.key as String: _copy(e.value)};
  if (v is List) return [for (final x in v) _copy(x)];
  return v;
}

/// The settings page's read. An offline-first gateway answers from the local
/// copy, which never holds the app lock (the box keeps it to itself), so the
/// lock's state is read live from the box; with the box away it is the value
/// the enrolment or the last unlock recorded, marked `_live: false` so the
/// page can say it needs the connection (K1).
Future<Read<Map<String, dynamic>>> loadSettings(
  BoxGateway gateway, {
  bool? enrolledAppLock,
}) async {
  final read = await gateway.get(SettingsRepository.path);
  final have = read.value['appLock'];
  if (have is Map && have['enabled'] is bool) return read;
  Map<String, dynamic>? live;
  try {
    final all = await gateway.getFresh(SettingsRepository.path);
    final lock = all['appLock'];
    if (lock is Map) live = lock.cast<String, dynamic>();
  } on SessionExpired {
    rethrow;
  } on Object {
    live = null;
  }
  final lock = live != null
      ? <String, dynamic>{...live}
      : <String, dynamic>{if (enrolledAppLock != null) 'enabled': enrolledAppLock, '_live': false};
  return Read({...read.value, 'appLock': lock}, at: read.at, stale: read.stale);
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
