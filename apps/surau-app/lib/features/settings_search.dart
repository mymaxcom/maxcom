// The search behind the Tetapan list. Pure Dart: a query is matched, in
// order, against each feature's title (BM and EN), group, field labels,
// choice labels and keywords. A match that is not in the title says why, so
// the row can explain itself. MAXCOM system values are not searchable by
// anyone who cannot see them.

import 'labels_ms.dart';
import 'registry.g.dart';
import 'shell/permissions.dart';

class SearchHit {
  const SearchHit(this.feature, this.why);

  /// A feature key, `lj:<feature>` for a Lanjutan deep link, or an extra's key.
  final String feature;

  /// `Medan: Kuat bunyi`; null when the title itself matched.
  final String? why;
}

/// A row of the list that is not a feature (the card order, the data pages).
class SearchExtra {
  const SearchExtra(this.key, this.title, this.group, {this.keywords = const []});

  final String key;
  final String title;
  final String group;
  final List<String> keywords;
}

class SettingsSearchIndex {
  const SettingsSearchIndex({this.extras = const []});

  final List<SearchExtra> extras;

  static void _leaves(Map<Object?, Object?> m, String prefix, void Function(String path, String name) add) {
    for (final e in m.entries) {
      final name = e.key as String;
      final path = prefix.isEmpty ? name : '$prefix.$name';
      add(path, name);
      final v = e.value;
      if (v is Map) _leaves(v, path, add);
    }
  }

  static String? _firstMatch(Iterable<String> texts, String q) {
    for (final t in texts) {
      if (t.toLowerCase().contains(q)) return t;
    }
    return null;
  }

  /// Why [q] matches, or null when it does not; '' when the title matched.
  static String? _match(
    String q, {
    required List<String> titles,
    required String group,
    Iterable<String> fields = const [],
    Iterable<String> choices = const [],
    Iterable<String> keywords = const [],
  }) {
    if (_firstMatch(titles, q) != null) return '';
    if (group.toLowerCase().contains(q)) return 'Kumpulan: $group';
    final field = _firstMatch(fields, q);
    if (field != null) return 'Medan: $field';
    final choice = _firstMatch(choices, q);
    if (choice != null) return 'Pilihan: $choice';
    final keyword = _firstMatch(keywords, q);
    if (keyword != null) return 'Kata kunci: $keyword';
    return null;
  }

  List<SearchHit> search(String query, {required Set<String> roles}) {
    final q = query.trim().toLowerCase();
    if (q.isEmpty) return const [];
    final seesSystem = canSee(roles, 'system:read');
    final hits = <SearchHit>[];
    void hit(String key, String? why) {
      if (why != null) hits.add(SearchHit(key, why.isEmpty ? null : why));
    }

    for (final f in features) {
      if (f.group == 'lanjutan' && !seesSystem) continue;
      final fields = <String>[];
      final choices = <String>[];
      _leaves(f.defaults, '', (path, name) {
        if (name == 'suspendedAt') return;
        if (!seesSystem && fieldMetaTable[f.key]?[path]?['scope'] == 'system') return;
        final label = settingLabelsMs[name];
        if (label != null) fields.add(label);
        choices.addAll(choiceLabelsMs[name]?.values ?? const []);
      });
      final desc = featureDescTable[f.key];
      hit(
        f.key,
        _match(
          q,
          titles: [f.labelMs, f.labelEn],
          group: groupLabelsMs[f.group] ?? f.group,
          fields: fields,
          choices: choices,
          keywords: (desc?['keywords'] as List?)?.cast<String>() ?? const [],
        ),
      );
    }

    if (seesSystem) {
      for (final r in lanjutanRows) {
        hit(
          'lj:${r['feature']}',
          _match(
            q,
            titles: [r['labelMs'] as String, r['labelEn'] as String],
            group: groupLabelsMs['lanjutan']!,
            fields: [for (final n in (r['fields'] as List).cast<String>()) settingLabelMs(n)],
          ),
        );
      }
    }

    for (final x in extras) {
      hit(x.key, _match(q, titles: [x.title], group: x.group, keywords: x.keywords));
    }
    return hits;
  }
}
