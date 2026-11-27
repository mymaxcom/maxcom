// The one place the app reads a feature's default from (2026.11.15 Siaran
// langsung revamp, B2). Every reader of a feature that may have no stored row
// yet asks here, so no hand-kept list of defaults can disagree with the
// registry again (the generated registry.g.dart carries core's
// `defaultEnabled` and the default of every field).

import 'registry.g.dart';

FeatureDef? _def(String feature) {
  for (final f in features) {
    if (f.key == feature) return f;
  }
  return null;
}

/// Core's `defaultEnabled` of [feature]; false for a feature core does not know.
bool featureDefaultOn(String feature) => _def(feature)?.defaultEnabled ?? false;

/// The default of every field of [feature] (a fresh copy, without `enabled`).
Map<String, dynamic> featureFieldDefaults(String feature) =>
    _copy(_def(feature)?.defaults ?? const <String, Object?>{}) as Map<String, dynamic>;

/// Whether [feature] is switched on in [doc], the feature's own stored row (or
/// null when nothing is stored): the stored switch when it is a bool, else the
/// registry default.
bool featureOnIn(Map<dynamic, dynamic>? doc, String feature) {
  final v = doc?['enabled'];
  return v is bool ? v : featureDefaultOn(feature);
}

/// [feature] as it is in force: the registry defaults (with `enabled`) and the
/// stored row [doc] laid over them, nested groups cell by cell. Keys of [doc]
/// the registry does not know are kept (a newer box).
Map<String, dynamic> effectiveFeature(String feature, Map<dynamic, dynamic>? doc) {
  final base = <String, dynamic>{'enabled': featureDefaultOn(feature), ...featureFieldDefaults(feature)};
  if (doc == null) return base;
  return _over(base, doc);
}

/// One field of [feature] in force: the stored value when [doc] holds the
/// key, else the registry default (null when neither knows it).
Object? featureValue(String feature, Map<dynamic, dynamic>? doc, String key) {
  if (key == 'enabled') return featureOnIn(doc, feature);
  if (doc != null && doc.containsKey(key)) return doc[key];
  return _def(feature)?.defaults[key];
}

Map<String, dynamic> _over(Map<String, dynamic> base, Map<dynamic, dynamic> top) {
  final out = <String, dynamic>{...base};
  for (final e in top.entries) {
    final k = '${e.key}';
    final b = out[k];
    final v = e.value;
    out[k] = b is Map<String, dynamic> && v is Map ? _over(b, v) : _copy(v);
  }
  return out;
}

Object? _copy(Object? v) {
  if (v is Map) return <String, dynamic>{for (final e in v.entries) '${e.key}': _copy(e.value)};
  if (v is List) return [for (final x in v) _copy(x)];
  return v;
}
