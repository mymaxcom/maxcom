// The search behind the Konfigurasi list. Pure Dart: a query is matched, in
// order, against each feature's title (BM, EN and Arabic), group, field labels,
// choice labels (the last three in the language of the app) and keywords. A match that is not in the title says why, so
// the row can explain itself. MAXCOM system values are not searchable by
// anyone who cannot see them.

import '../app/app_lang.dart';
import '../l10n/s_lookup.dart';
import '../ops/ops_build.dart';
import '../ops/registry_ops.g.dart';
import '../ops/system_labels_ms.dart';
import '../app/router.dart' show liveSettingsFeatureKeys;
import 'labels.dart';
import 'labels_cam.dart';
import 'labels_ms.dart' show settingLabelsMs, choiceLabelsMs;
import 'registry.g.dart';
import 'shell/permissions.dart';

/// The key of the one hit that stands for the four live features.
const String liveSettingsMovedKey = 'live-moved';

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
    String q,
    AppLang lang, {
    required List<String> titles,
    required String group,
    Iterable<String> fields = const [],
    Iterable<String> choices = const [],
    Iterable<String> keywords = const [],
  }) {
    if (_firstMatch(titles, q) != null) return '';
    final s = sFor(lang);
    if (group.toLowerCase().contains(q)) return s.settingsWhyGroup(group);
    final field = _firstMatch(fields, q);
    if (field != null) return s.settingsWhyField(field);
    final choice = _firstMatch(choices, q);
    if (choice != null) return s.settingsWhyChoice(choice);
    final keyword = _firstMatch(keywords, q);
    if (keyword != null) return s.settingsWhyKeyword(keyword);
    return null;
  }

  List<SearchHit> search(String query, {required Set<String> roles, AppLang lang = AppLang.ms}) {
    final q = query.trim().toLowerCase();
    if (q.isEmpty) return const [];
    // The Lanjutan values exist only in the ops build (Plan 14 Task 25).
    final seesSystem = kOpsBuild && canSee(roles, 'system:read');
    final hits = <SearchHit>[];
    void hit(String key, String? why) {
      if (why != null) hits.add(SearchHit(key, why.isEmpty ? null : why));
    }

    // The live features are not listed here: a query that matches any of them gives the one pointer row instead.
    var liveMatched = false;
    for (final f in features) {
      if (f.group == 'lanjutan' && !seesSystem) continue;
      if (hiddenFeatures.contains(f.key)) continue;
      final fields = <String>[];
      final choices = <String>[];
      _leaves(f.defaults, '', (path, name) {
        if (name == 'suspendedAt') return;
        if (!seesSystem && fieldMetaTable[f.key]?[path]?['scope'] == 'system') return;
        if (fieldMetaTable[f.key]?[path]?['hidden'] == true) return;
        if (settingLabelsMs.containsKey(name)) fields.add(settingLabel(name, lang));
        for (final v in choiceLabelsMs[name]?.keys ?? const <String>[]) {
          choices.add(choiceLabel(name, v, lang));
        }
      });
      final desc = featureDescTable[f.key];
      final liveFeature = liveSettingsFeatureKeys.contains(f.key);
      void add(String key, String? why) {
        if (liveFeature) {
          if (why != null) liveMatched = true;
        } else {
          hit(key, why);
        }
      }
      add(
        f.key,
        _match(
          q,
          lang,
          titles: [f.labelMs, f.labelEn, f.labelAr],
          group: kOpsBuild && f.group == 'lanjutan' ? lanjutanGroupTitleMs : groupLabel(f.group, lang),
          fields: fields,
          choices: choices,
          keywords: (desc?['keywords'] as List?)?.cast<String>() ?? const [],
        ),
      );
    }

    if (canSee(roles, 'live:settings')) {
      if (!liveMatched) {
        final texts = [
          for (final l in AppLang.values) ...[
            liveSettingsMovedRow(l), liveSettingsMovedHint(l), liveSectionSettings(l), liveSettingsCameraRow(l),
            liveSettingsKioskRow(l), liveSettingsKioskHint(l), liveSettingsYoutubeRow(l), liveSettingsYoutubeHint(l),
            liveSettingsRecordingRow(l), liveSettingsRecordingHint(l),
          ],
          ...liveSettingsMovedWords,
        ];
        liveMatched = _firstMatch(texts, q) != null;
      }
      if (liveMatched) hits.add(const SearchHit(liveSettingsMovedKey, null));
    }

    if (kOpsBuild && seesSystem) {
      for (final r in opsLanjutanRows) {
        hit(
          'lj:${r['feature']}',
          _match(
            q,
            lang,
            titles: [r['labelMs'] as String, r['labelEn'] as String],
            group: lanjutanGroupTitleMs,
            fields: [for (final n in (r['fields'] as List).cast<String>()) settingLabel(n, lang)],
          ),
        );
      }
    }

    for (final x in extras) {
      hit(x.key, _match(q, lang, titles: [x.title], group: x.group, keywords: x.keywords));
    }
    return hits;
  }
}
