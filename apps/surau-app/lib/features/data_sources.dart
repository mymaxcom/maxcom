// The `dataSources` feature: where MAXCOM fetches from the internet
// (e-Solat prayer times, Quran text, recitation audio), each a `{name,
// url}` the admin may point elsewhere. The screens that start such a
// fetch name the source on their button ("Muat turun dari e-Solat JAKIM
// ke dalam MAXCOM"), read from `GET /api/settings`, falling back to
// the registry's default names when the box has not answered yet or is
// older than the feature.

import 'validate.dart' show featureByKey;

/// The feature key in core.
const String dataSourcesKey = 'dataSources';

/// The sources, in the registry's order.
const List<String> sourceKeys = [
  'esolat',
  'esolatZones',
  'nominatim',
  'quranText',
  'quranAudio',
  'hadeethenc',
];

/// Whether [key] (a top-level setting name of `dataSources`) is a source.
bool isSourceKey(String key) => sourceKeys.contains(key);

/// The registry default for one field of a source, '' when unknown.
String defaultSourceField(String source, String field) {
  final f = featureByKey(dataSourcesKey);
  final src = f?.defaults[source];
  final v = src is Map ? src[field] : null;
  return v is String ? v : '';
}

/// `dataSources.<source>.name` from the settings body, else the default.
String dataSourceName(Map<String, dynamic>? settings, String source) {
  final ds = settings?[dataSourcesKey];
  final src = ds is Map ? ds[source] : null;
  final name = src is Map ? src['name'] : null;
  if (name is String && name.trim().isNotEmpty) return name.trim();
  return defaultSourceField(source, 'name');
}
