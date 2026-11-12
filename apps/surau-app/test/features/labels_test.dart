// Every setting name in the registry (nested names too) has a BM and an
// English label, so no form row renders a raw key.

import 'package:flutter_test/flutter_test.dart';
import 'package:surau_app/features/labels_ms.dart';
import 'package:surau_app/features/registry.g.dart';
import 'package:surau_app/features/validate.dart';

void _names(Map<dynamic, dynamic> m, Set<String> out) {
  for (final e in m.entries) {
    out.add(e.key as String);
    final v = e.value;
    if (v is Map<dynamic, dynamic>) _names(v, out);
  }
}

void main() {
  final names = <String>{};
  for (final f in features) {
    _names(f.defaults, names);
  }

  test('there are setting names to label', () {
    expect(names.length, greaterThan(50));
  });

  test('every setting name has a Bahasa Malaysia label', () {
    for (final n in names) {
      expect(settingLabelsMs[n], isNotNull, reason: 'no BM label for $n');
      expect(settingLabelsMs[n], isNotEmpty);
      expect(settingLabelMs(n), settingLabelsMs[n]);
    }
  });

  test('every setting name has an English label', () {
    for (final n in names) {
      expect(settingLabelsEn[n], isNotNull, reason: 'no EN label for $n');
    }
  });

  test('no label is left over for a name that does not exist', () {
    expect(settingLabelsMs.keys.toSet().difference(names), isEmpty);
    expect(settingLabelsEn.keys.toSet(), settingLabelsMs.keys.toSet());
  });

  test('labels carry no dashes, arrows or approximation signs', () {
    final bad = RegExp('[–—→≈←]');
    for (final v in [
      ...settingLabelsMs.values,
      ...settingLabelsEn.values,
      ...groupLabelsMs.values,
      for (final m in choiceLabelsMs.values) ...m.values,
    ]) {
      expect(bad.hasMatch(v), isFalse, reason: v);
    }
  });

  test('groups: all eleven, in order, each used by a feature', () {
    expect(groupOrder, groupLabelsMs.keys.toList());
    expect(groupLabelsMs['solat'], 'Solat');
    expect(groupLabelsMs['quran'], 'Al-Quran');
    expect(groupLabelsMs['live'], 'Siaran langsung');
    expect(groupLabelsMs['keselamatan'], 'Keselamatan');
    expect(groupLabelsMs['lanjutan'], 'Lanjutan');
    expect(groupOrder.last, 'lanjutan');
    for (final g in groupOrder) {
      expect(features.any((f) => f.group == g), isTrue, reason: g);
    }
  });

  test('kiosk template: the setting and its five choices read in BM', () {
    expect(settingLabelsMs['templateId'], 'Templat');
    expect(settingLabelsEn['templateId'], 'Template');
    expect(ruleFor('templateId')!.vals,
        ['default', 'colourful', 'creative', 'oldschool', 'minimal']);
    expect(choiceLabelMs('templateId', 'default'), 'Satu Warna (Lalai)');
    expect(choiceLabelMs('templateId', 'colourful'), 'Berwarna-warni');
    expect(choiceLabelMs('templateId', 'creative'), 'Kreatif');
    expect(choiceLabelMs('templateId', 'oldschool'), 'Klasik Lama');
    expect(choiceLabelMs('templateId', 'minimal'), 'Minimalis Cerah');
  });

  test('every enum choice has a BM label', () {
    for (final n in names) {
      final rule = ruleFor(n);
      if (rule == null || rule.type != SettingRuleType.enumOf) continue;
      for (final v in rule.vals) {
        expect(choiceLabelsMs[n]?[v], isNotNull, reason: '$n=$v');
      }
    }
  });
}
