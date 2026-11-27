// Every setting name in the registry (nested names too) has a BM and an
// English label, so no form row renders a raw key.

import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:surau_app/app/app_lang.dart';
import 'package:surau_app/features/labels.dart';
import 'package:surau_app/features/labels_ar.dart';
import 'package:surau_app/content/kinds.dart';
import 'package:surau_app/features/labels_cam.dart' as cam;
import 'package:surau_app/features/labels_content.dart';
import 'package:surau_app/features/settings_widgets/field_meta.dart' show DisabledWhen;
import 'package:surau_app/features/labels_ms.dart';
import 'package:surau_app/features/registry.g.dart';
import 'package:surau_app/features/validate.dart';
import 'package:surau_app/ops/system_labels_ms.dart';

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

  test('groups: all ten, in order, each used by a feature', () {
    expect(groupOrder, groupLabelsMs.keys.toList());
    expect(groupLabelsMs['solat'], 'Solat');
    expect(groupLabelsMs['quran'], 'Al-Quran');
    expect(groupLabelsMs['live'], 'Siaran langsung');
    expect(groupLabelsMs['keselamatan'], 'Keselamatan');
    // The Lanjutan group belongs to the ops build (Plan 14 Task 25): never in the shared maps.
    expect(groupLabelsMs.containsKey('lanjutan'), isFalse);
    expect(groupOrder.last, 'keselamatan');
    for (final g in groupOrder) {
      expect(features.any((f) => f.group == g), isTrue, reason: g);
    }
  });

  test('kiosk template: the setting and its five English theme names', () {
    expect(settingLabelsMs['templateId'], 'Templat');
    expect(settingLabelsEn['templateId'], 'Template');
    for (final id in builtInThemeIds) {
      expect(choiceLabelMs('templateId', id), themeTitles[id], reason: id);
    }
    expect(choiceLabelMs('templateId', 'oldschool'), 'Old School');
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

  test('the Lanjutan texts live in the ops labels', () {
    expect(lanjutanGroupTitleMs, 'Lanjutan');
    expect(lanjutanRowHintMs.keys, containsAll(['liveYoutube', 'tilawah']));
  });

  group('three languages (Task 6)', () {
    final arabic = RegExp('[؀-ۿ]');
    final bad = RegExp('[–—→←≈]');

    Set<String> nestedKeys(Map<String, Map<String, String>> m) => {
          for (final e in m.entries)
            for (final k in e.value.keys) '${e.key}.$k',
        };

    test('every key of each BM map is in the English and Arabic maps, and no extra key', () {
      expect(groupLabelsEn.keys.toSet(), groupLabelsMs.keys.toSet());
      expect(groupLabelsAr.keys.toSet(), groupLabelsMs.keys.toSet());
      expect(featureHelpEn.keys.toSet(), featureHelpMs.keys.toSet());
      expect(featureHelpAr.keys.toSet(), featureHelpMs.keys.toSet());
      expect(settingLabelsEn.keys.toSet(), settingLabelsMs.keys.toSet());
      expect(settingLabelsAr.keys.toSet(), settingLabelsMs.keys.toSet());
      expect(sourceLeafLabelsEn.keys.toSet(), sourceLeafLabelsMs.keys.toSet());
      expect(sourceLeafLabelsAr.keys.toSet(), sourceLeafLabelsMs.keys.toSet());
      expect(settingHelpEn.keys.toSet(), settingHelpMs.keys.toSet());
      expect(settingHelpAr.keys.toSet(), settingHelpMs.keys.toSet());
      expect(choiceLabelsEn.keys.toSet(), choiceLabelsMs.keys.toSet());
      expect(choiceLabelsAr.keys.toSet(), choiceLabelsMs.keys.toSet());
      expect(nestedKeys(choiceLabelsEn), nestedKeys(choiceLabelsMs));
      expect(nestedKeys(choiceLabelsAr), nestedKeys(choiceLabelsMs));
      expect(choiceHelpEn.keys.toSet(), choiceHelpMs.keys.toSet());
      expect(choiceHelpAr.keys.toSet(), choiceHelpMs.keys.toSet());
      expect(nestedKeys(choiceHelpEn), nestedKeys(choiceHelpMs));
      expect(nestedKeys(choiceHelpAr), nestedKeys(choiceHelpMs));
    });

    test('no text in any language carries a dash, arrow or approximation sign', () {
      final all = <String>[
        for (final m in [groupLabelsMs, groupLabelsEn, groupLabelsAr]) ...m.values,
        for (final m in [featureHelpMs, featureHelpEn, featureHelpAr]) ...m.values,
        for (final m in [settingLabelsMs, settingLabelsEn, settingLabelsAr]) ...m.values,
        for (final m in [sourceLeafLabelsMs, sourceLeafLabelsEn, sourceLeafLabelsAr]) ...m.values,
        for (final m in [settingHelpMs, settingHelpEn, settingHelpAr]) ...m.values,
        for (final m in [choiceLabelsMs, choiceLabelsEn, choiceLabelsAr]) for (final c in m.values) ...c.values,
        for (final m in [choiceHelpMs, choiceHelpEn, choiceHelpAr]) for (final c in m.values) ...c.values,
        for (final f in features) f.labelMs,
        for (final f in features) f.labelEn,
        for (final f in features) f.labelAr,
        for (final d in featureDescTable.values) ...[d['ms'] as String, d['en'] as String, d['ar'] as String],
      ];
      for (final v in all) {
        expect(bad.hasMatch(v), isFalse, reason: v);
      }
    });

    test('Arabic texts are Arabic, except names that stay Latin', () {
      // These stay as they are in every language: the TCP/UDP names, the theme names (spec 6.10.2).
      const latinOk = {'transport.tcp', 'transport.udp', 'templateId', 'method.jakim', 'source.hadeethenc'};
      for (final e in choiceLabelsAr.entries) {
        for (final c in e.value.entries) {
          if (latinOk.contains('${e.key}.${c.key}') || latinOk.contains(e.key)) continue;
          expect(arabic.hasMatch(c.value), isTrue, reason: '${e.key}.${c.key}: ${c.value}');
        }
      }
      for (final e in [
        ...settingLabelsAr.entries,
        ...sourceLeafLabelsAr.entries,
        ...groupLabelsAr.entries,
        ...featureHelpAr.entries,
        ...settingHelpAr.entries,
      ]) {
        expect(arabic.hasMatch(e.value), isTrue, reason: '${e.key}: ${e.value}');
      }
      for (final f in features) {
        expect(arabic.hasMatch(f.labelAr), isTrue, reason: f.key);
        expect(arabic.hasMatch(featureDescTable[f.key]!['ar'] as String), isTrue, reason: f.key);
      }
    });

    test('every enum choice has an English and an Arabic label', () {
      for (final n in names) {
        final rule = ruleFor(n);
        if (rule == null || rule.type != SettingRuleType.enumOf) continue;
        for (final v in rule.vals) {
          expect(choiceLabelsEn[n]?[v], isNotNull, reason: 'en $n=$v');
          expect(choiceLabelsAr[n]?[v], isNotNull, reason: 'ar $n=$v');
        }
      }
    });

    test('lookups answer in the language asked, with the TV language setting named as the spec says', () {
      expect(settingLabel('lang', AppLang.ms), 'Bahasa skrin TV');
      expect(settingLabel('lang', AppLang.en), 'TV screen language');
      expect(settingLabel('lang', AppLang.ar), 'لغة شاشة التلفاز');
      expect(choiceLabel('lang', 'auto', AppLang.ms), 'Automatik');
      expect(choiceLabel('lang', 'auto', AppLang.en), 'Automatic');
      expect(choiceLabel('lang', 'auto', AppLang.ar), 'تلقائي');
      for (final l in AppLang.values) {
        expect(choiceLabel('lang', 'ar', l), 'العربية');
      }
      expect(choiceLabel('lang', 'ms', AppLang.ms), 'Bahasa Melayu');
      expect(choiceLabel('lang', 'en', AppLang.ms), 'English');
      expect(groupLabel('solat', AppLang.en), 'Prayer');
      expect(groupLabel('solat', AppLang.ms), 'Solat');
      expect(settingHelp('maxBitrateKbps', AppLang.en), startsWith('Match'));
      expect(settingHelp('maxBitrateKbps', AppLang.en), contains('1000 to 8000'));
      expect(settingHelp('maxBitrateKbps', AppLang.ms), startsWith('Ikut'));
      expect(settingHelp('maxBitrateKbps', AppLang.ms), contains('1000 hingga 8000'));
      expect(arabic.hasMatch(settingHelp('maxBitrateKbps', AppLang.ar)!), isTrue);
      expect(settingHelp('no-such-setting', AppLang.ar), isNull);
      expect(choiceHelp('relayFrom', 'box', AppLang.en), isNotNull);
      expect(featureHelp('finance', AppLang.ar), featureHelpAr['finance']);
    });

    test('every feature has its label and description in all three languages', () {
      final appLock = features.firstWhere((f) => f.key == 'appLock');
      expect(featureLabel(appLock, AppLang.ms), 'Kunci aplikasi');
      expect(featureLabel(appLock, AppLang.en), 'App lock');
      expect(featureLabel(appLock, AppLang.ar), 'قفل التطبيق');
      for (final f in features) {
        for (final l in AppLang.values) {
          expect(featureLabel(f, l), isNotEmpty, reason: '${f.key} ${l.name}');
          expect(featureDesc(f.key, l), isNotEmpty, reason: '${f.key} ${l.name}');
        }
        expect(featureDesc(f.key, AppLang.ms), featureDescTable[f.key]!['ms']);
      }
      expect(featureDesc('no-such-feature', AppLang.ar), '');
    });

    test('units follow the language; symbols stay', () {
      expect(unitLabel('saat', 15, AppLang.ms), 'saat');
      expect(unitLabel('saat', 15, AppLang.en), 'seconds');
      expect(unitLabel('minit', 1, AppLang.en), 'minute');
      expect(unitLabel('hari', 5, AppLang.ar), '\u0623\u064a\u0627\u0645');
      expect(unitLabel('hari', 30, AppLang.ar), '\u064a\u0648\u0645\u064b\u0627');
      expect(unitLabel('kbps', 3, AppLang.ar), 'kbps');
    });

    test('a missing Arabic key falls back to English, then to BM, then to the raw name', () {
      expect(settingLabel('zzNoSuchName', AppLang.ar), 'zzNoSuchName');
      expect(choiceLabel('zzNoSuch', 'v', AppLang.ar), 'v');
      expect(groupLabel('zzNoSuch', AppLang.en), 'zzNoSuch');
    });

    testWidgets('appLangOf follows the locale of the widget tree, BM when there is none we ship', (tester) async {
      AppLang? seen;
      for (final code in ['ms', 'en', 'ar', 'fr']) {
        await tester.pumpWidget(
          Localizations(
            locale: Locale(code),
            delegates: const [DefaultWidgetsLocalizations.delegate],
            child: Builder(builder: (context) {
              seen = appLangOf(context);
              return const SizedBox();
            }),
          ),
        );
        expect(seen, code == 'fr' ? AppLang.ms : AppLang.fromCode(code), reason: code);
      }
    });
  });

  group('role, camera, live and content-kind words follow the app language', () {
    final bad = RegExp('[–—→≈←]');
    final arabic = RegExp('[؀-ۿ]');

    test('every role has a BM, an English and an Arabic name', () {
      expect(roleLabelsAr.keys.toSet(), roleLabelsMs.keys.toSet());
      expect(roleLabelsEn.keys.toSet(), roleLabelsMs.keys.toSet());
      for (final r in roleLabelsMs.keys) {
        expect(roleLabel(r, AppLang.ms), roleLabelsMs[r]);
        expect(roleLabel(r, AppLang.en), roleLabelsEn[r]);
        expect(arabic.hasMatch(roleLabel(r, AppLang.ar)), isTrue, reason: r);
      }
      expect(roleLabel('zzNoRole', AppLang.ar), 'zzNoRole');
      expect(roleLabelsAr['treasurer'], 'أمين الصندوق');
    });

    test('the camera and live words answer in all three languages and BM stays word for word', () {
      expect(cam.cameraUseTitle(AppLang.ms), 'Tawarkan kamera luaran');
      expect(cam.cameraUseTitle(AppLang.en), 'Offer the external camera');
      expect(arabic.hasMatch(cam.cameraUseTitle(AppLang.ar)), isTrue);
      expect(cam.cameraTestRunningDetail(AppLang.ms, 'x'), 'Menghubungi x. Ini mengambil masa hingga 15 saat.');
      expect(cam.cameraTestRunningDetail(AppLang.en, 'x'), contains('x'));
      expect(cam.cameraTestRunningDetail(AppLang.ar, 'x'), contains('x'));
      expect(cam.cameraAudioHas(AppLang.ms, ''), 'Ada');
      expect(cam.cameraAudioHas(AppLang.en, 'aac'), 'Yes, aac');
      expect(cam.livePhonePullNote(AppLang.en, 'Cam', mic: false), endsWith('Keep the screen on.'));
      expect(cam.liveAudioJoin(AppLang.ms, ['a', 'b']), 'a dan b');
      expect(cam.liveAudioJoin(AppLang.en, ['a', 'b']), 'a and b');
      expect(cam.liveAudioJoin(AppLang.ar, ['a', 'b']), 'a و' 'b');
      expect(cam.liveAudioOffsetChip(AppLang.ms, 150), 'Imbangan +150 ms');
      expect(cam.liveAudioOffsetChip(AppLang.en, 150), 'Offset +150 ms');
    });

    test('every camera and live function gives a text in each language (BM, English, Arabic differ)', () {
      // One line of labels_cam.dart is `_t(l, ms, en, ar)`: a language cannot be left out. Here the
      // text of the file is read to count them, and no string in any language has a dash or arrow.
      final src = File('lib/features/labels_cam.dart').readAsStringSync();
      final fns = RegExp(r'^String \w+\(AppLang l', multiLine: true).allMatches(src).length;
      final calls = RegExp(r'_t\(\s*l,', multiLine: true).allMatches(src).length;
      expect(fns, greaterThan(200));
      // a few functions answer without `_t` (an address, a +ms value, a codec question)
      expect(calls, greaterThan(fns - 6));
      expect(bad.hasMatch(src), isFalse, reason: 'labels_cam.dart has a dash, arrow or approximation sign');
      // G7: the device is MAXCOM in every text, never "kotak"; and the live screen words nothing by itself
      final kotak = RegExp(r'kotak', caseSensitive: false);
      expect(kotak.hasMatch(src), isFalse, reason: 'labels_cam.dart says "kotak"');
      final screen = File('lib/features/live/live_screen.dart').readAsStringSync();
      expect(kotak.hasMatch(screen), isFalse, reason: 'live_screen.dart says "kotak"');
      for (final hard in const ["'Terputus'", "'Menyambung semula'", "'Diterima'", "'Gambar terakhir'"]) {
        expect(screen.contains(hard), isFalse, reason: 'live_screen.dart hardcodes $hard');
      }
    });

    test('content kind words: BM from kinds.dart, English and Arabic from the tables, same keys', () {
      expect(contentKindLabelsAr.keys.toSet(), contentKindLabelsEn.keys.toSet());
      expect(contentKindPluralsEn.keys.toSet(), contentKindLabelsEn.keys.toSet());
      expect(contentKindPluralsAr.keys.toSet(), contentKindLabelsEn.keys.toSet());
      expect(contentFieldLabelsAr.keys.toSet(), contentFieldLabelsEn.keys.toSet());
      expect(contentFieldHintsAr.keys.toSet(), contentFieldHintsEn.keys.toSet());
      expect(contentChoiceLabelsAr.keys.toSet(), contentChoiceLabelsEn.keys.toSet());
      expect(dayLabelsAr.keys.toSet(), dayLabelsEn.keys.toSet());
      expect(dayLabelsEn.keys.toSet(), dayLabelsMs.keys.toSet());
      expect(monthWordsAr.length, 12);
      expect(monthWordsEn.length, 12);
      expect(weekdayWordsAr.length, 7);
      expect(weekdayWordsEn.length, 7);
      expect(contentKindLabelsEn.keys.toSet(), {for (final k in contentKinds) k.key});
      final fieldKeys = <String>{};
      final hintKeys = <String>{};
      final choiceKeys = <String>{};
      for (final k in contentKinds) {
        for (final l in AppLang.values) {
          expect(k.label(l), isNotEmpty, reason: '${k.key} ${l.name}');
          expect(k.labelPlural(l), isNotEmpty, reason: '${k.key} ${l.name}');
        }
        expect(k.label(AppLang.ms), k.labelMs);
        expect(k.labelPlural(AppLang.ms), k.labelMsPlural);
        expect(k.label(AppLang.en), contentKindLabelsEn[k.key], reason: k.key);
        expect(arabic.hasMatch(k.label(AppLang.ar)), isTrue, reason: k.key);
        for (final f in k.fields) {
          fieldKeys.add('${k.key}.${f.key}');
          expect(k.fieldLabel(f, AppLang.ms), f.labelMs);
          expect(contentFieldLabelsEn['${k.key}.${f.key}'], isNotNull, reason: '${k.key}.${f.key}');
          expect(arabic.hasMatch(k.fieldLabel(f, AppLang.ar)), isTrue, reason: '${k.key}.${f.key}');
          expect(k.fieldHint(f, AppLang.ms), f.hintMs);
          if (f.hintMs != null) {
            hintKeys.add('${k.key}.${f.key}');
            // A switch's help explains Yes and No (poster Regangkan gambar) or what No means (video Bunyi); every other hint is an example.
            final en = k.fieldHint(f, AppLang.en)!;
            expect(f.type == FieldType.bool ? (en.startsWith('Yes:') || en.startsWith('No:')) : en.startsWith('Example:'), isTrue, reason: '${k.key}.${f.key}');
            expect(arabic.hasMatch(k.fieldHint(f, AppLang.ar)!), isTrue, reason: '${k.key}.${f.key}');
          }
          for (final c in f.choices) {
            choiceKeys.add('${k.key}.${f.key}');
            expect(k.choiceLabel(f, c, AppLang.ms), f.choiceLabelMs(c));
            expect(contentChoiceLabelsEn['${k.key}.${f.key}']?[c], isNotNull, reason: '${k.key}.${f.key}=$c');
            expect(contentChoiceLabelsAr['${k.key}.${f.key}']?[c], isNotNull, reason: '${k.key}.${f.key}=$c');
          }
        }
      }
      expect(contentFieldLabelsEn.keys.toSet(), fieldKeys);
      expect(contentFieldHintsEn.keys.toSet(), hintKeys);
      expect(contentChoiceLabelsEn.keys.toSet(), choiceKeys);
    });

    test('content words carry no dash, arrow or approximation sign', () {
      final all = <String>[
        for (final m in [
          contentKindLabelsEn, contentKindLabelsAr, contentKindPluralsEn, contentKindPluralsAr,
          contentFieldLabelsEn, contentFieldLabelsAr, contentFieldHintsEn, contentFieldHintsAr,
          dayLabelsEn, dayLabelsAr,
        ]) ...m.values,
        for (final m in [contentChoiceLabelsEn, contentChoiceLabelsAr]) for (final c in m.values) ...c.values,
        ...monthWordsEn, ...monthWordsAr, ...weekdayWordsEn, ...weekdayWordsAr,
        for (final m in roleLabelsAr.values) m,
      ];
      for (final v in all) {
        expect(bad.hasMatch(v), isFalse, reason: v);
      }
    });

    test('days, dates and times are worded in the app language; BM is unchanged', () {
      expect(daysWords(['jumaat', 'sabtu'], AppLang.ms), 'Jumaat, Sabtu');
      expect(daysWords(['jumaat', 'sabtu'], AppLang.en), 'Friday, Saturday');
      expect(daysWords(['jumaat', 'sabtu'], AppLang.ar), 'الجمعة، السبت');
      expect(daysWords(['umum'], AppLang.en), 'Every day');
      expect(daysWords(['umum'], AppLang.ms), 'Setiap hari');
      expect(dateWords('2026-11-06', AppLang.ms), 'Jumaat, 6 Nov 2026');
      expect(dateWords('2026-11-06', AppLang.en), 'Friday, 6 Nov 2026');
      expect(dateWords('2026-11-06', AppLang.ar, weekday: false), '6 نوفمبر 2026');
      expect(timeWords('19:15', AppLang.ms), '7:15 malam');
      expect(timeWords('19:15', AppLang.en), '7:15 pm');
      expect(timeWords('09:05', AppLang.en), '9:05 am');
      expect(dateTimeWords('2026-11-20T20:30', AppLang.ms), 'Jumaat, 20 Nov 2026, 8:30 malam');
      expect(dateTimeWords('2026-11-20T20:30', AppLang.en), 'Friday, 20 Nov 2026, 8:30 pm');
      expect(dateWords('not a date', AppLang.ar), 'not a date');
    });

    test('every dependency note has BM, English and Arabic, and the lookup picks by language', () {
      var seen = 0;
      for (final f in fieldMetaTable.values) {
        for (final m in f.values) {
          final raw = m['disabledWhen'];
          if (raw is! Map) continue;
          seen++;
          final d = DisabledWhen(raw.cast<String, Object?>());
          expect(d.note(AppLang.ms), d.noteMs);
          expect(d.note(AppLang.en), d.noteEn);
          expect(d.note(AppLang.ar), d.noteAr);
          expect(arabic.hasMatch(d.noteAr), isTrue);
          expect(bad.hasMatch(d.noteMs + d.noteEn + d.noteAr), isFalse);
        }
      }
      expect(seen, 11, reason: 'disabledWhen rows of the generated registry (registry.g.dart)');
    });
  });
}
