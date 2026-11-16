// `/settings/<feature>`: a feature the Tetapan lists hide is not reachable by its address either.

import 'package:flutter_test/flutter_test.dart';
import 'package:surau_app/app/router.dart';
import 'package:surau_app/features/registry.g.dart' show hiddenFeatures;

void main() {
  test('a hidden feature goes back to the settings list', () {
    expect(hiddenFeatures, isNotEmpty);
    for (final key in hiddenFeatures) {
      expect(settingsFeatureRedirect(key), AppRoutes.settings, reason: key);
    }
  });

  test('a feature with its own page goes there; an ordinary one opens its generic page', () {
    expect(settingsFeatureRedirect('kioskTemplate'), AppRoutes.settingsThemes);
    expect(settingsFeatureRedirect('prayerSources'), AppRoutes.settingsPrayerSources);
    expect(settingsFeatureRedirect('tilawah'), isNull);
    expect(settingsFeatureRedirect(null), isNull);
  });
}
