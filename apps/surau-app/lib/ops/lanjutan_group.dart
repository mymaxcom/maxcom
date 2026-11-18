// Plan 14 Task 25: the Lanjutan group of the settings list (the MAXCOM system
// pages and the deep links into ordinary pages). Ops build only.

import '../features/registry.g.dart' show FeatureDef, features, featureDescTable;
import 'registry_ops.g.dart';
import 'system_labels_ms.dart';

/// One row of the Lanjutan group.
class LanjutanRowSpec {
  const LanjutanRowSpec({required this.rowKey, required this.hitKey, required this.label, required this.hint, required this.feature, required this.deepLink});

  /// The widget key suffix (`settings-row-<rowKey>`).
  final String rowKey;

  /// The search index key.
  final String hitKey;
  final String label;
  final String hint;
  final String feature;

  /// Opened with `?lj=1` so the page scrolls to its Lanjutan card.
  final bool deepLink;
}

/// The rows, system pages first, then the deep links.
List<LanjutanRowSpec> lanjutanRowSpecs() => [
  for (final FeatureDef f in features)
    if (opsSystemFeatures.contains(f.key))
      LanjutanRowSpec(
        rowKey: f.key,
        hitKey: f.key,
        label: f.labelMs,
        hint: featureDescTable[f.key]?['ms'] as String? ?? '',
        feature: f.key,
        deepLink: false,
      ),
  for (final r in opsLanjutanRows)
    LanjutanRowSpec(
      rowKey: 'lj-${r['feature']}',
      hitKey: 'lj:${r['feature']}',
      label: r['labelMs'] as String,
      hint: lanjutanRowHintMs[r['feature']] ?? '',
      feature: r['feature'] as String,
      deepLink: true,
    ),
];
