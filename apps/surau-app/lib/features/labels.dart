// The one place that picks a setting name, group heading, help sentence or
// choice name in the language of the app (BM, English, Arabic). The maps are
// in labels_ms.dart (BM and English) and labels_ar.dart (Arabic); a missing
// Arabic key falls back to English, then BM, then the raw name (labels_test
// keeps that from happening).

import 'package:flutter/widgets.dart';

import '../app/app_lang.dart';
import '../l10n/generated/s.dart';
import 'labels_ar.dart';
import 'labels_content.dart';
import 'labels_ms.dart';
import 'registry.g.dart';

/// The language of a catalogue (`S`): for code that holds `s` but no context.
AppLang appLangOfS(S s) => AppLang.fromCode(s.localeName) ?? AppLang.ms;

/// The app language of the widget tree: the locale the app is showing, BM when
/// it is not one we ship. For widgets that have no `ref`.
AppLang appLangOf(BuildContext context) {
  final locale = Localizations.maybeLocaleOf(context);
  return AppLang.fromCode(locale?.languageCode) ?? AppLang.ms;
}

String? _pick(AppLang lang, String? ar, String? en, String? ms) => switch (lang) {
      AppLang.ar => ar ?? en ?? ms,
      AppLang.en => en ?? ms,
      AppLang.ms => ms,
    };

/// Label for a setting name; the name itself when no map has it.
String settingLabel(String name, AppLang lang) =>
    _pick(lang, settingLabelsAr[name], settingLabelsEn[name], settingLabelsMs[name]) ?? name;

/// Label for a leaf of a data source (`name` there is the source's name).
String sourceLeafLabel(String name, AppLang lang) =>
    _pick(lang, sourceLeafLabelsAr[name], sourceLeafLabelsEn[name], sourceLeafLabelsMs[name]) ??
    settingLabel(name, lang);

/// The sentence under a setting, or null when it has none.
String? settingHelp(String name, AppLang lang) =>
    _pick(lang, settingHelpAr[name], settingHelpEn[name], settingHelpMs[name]);

// A setting name shared by several features ('volume') keeps one generic label;
// these say what it is in one feature, keyed '<feature>.<name>' (ar, en, ms).
const Map<String, (String, String, String)> _featureSettingLabels = {
  'videos.volume': ('مستوى صوت الفيديو', 'Video volume', 'Kelantangan video'),
};
const Map<String, (String, String, String)> _featureSettingHelps = {
  'videos.volume': (
    "للفيديوهات التي يكون مفتاح 'الصوت' فيها مفعّلًا.",
    "For videos whose 'Sound' switch is on.",
    "Untuk video yang suisnya 'Bunyi' dihidupkan.",
  ),
};

String _pickFeature((String, String, String) t, AppLang lang) => switch (lang) {
      AppLang.ar => t.$1,
      AppLang.en => t.$2,
      AppLang.ms => t.$3,
    };

/// [settingLabel] for a setting of [feature]; the feature's own wording when it has one.
String featureSettingLabel(String feature, String name, AppLang lang) {
  final t = _featureSettingLabels['$feature.$name'];
  return t == null ? settingLabel(name, lang) : _pickFeature(t, lang);
}

/// [settingHelp] for a setting of [feature]; the feature's own sentence when it has one.
String? featureSettingHelp(String feature, String name, AppLang lang) {
  final t = _featureSettingHelps['$feature.$name'];
  return t == null ? settingHelp(name, lang) : _pickFeature(t, lang);
}

/// Heading of a settings group.
String groupLabel(String group, AppLang lang) =>
    _pick(lang, groupLabelsAr[group], groupLabelsEn[group], groupLabelsMs[group]) ?? group;

/// Name of one choice of an enum setting; the raw value when unknown.
String choiceLabel(String setting, String value, AppLang lang) =>
    _pick(lang, choiceLabelsAr[setting]?[value], choiceLabelsEn[setting]?[value], choiceLabelsMs[setting]?[value]) ??
    value;

/// The sentence under one choice (settings drawn as cards), or null.
String? choiceHelp(String setting, String value, AppLang lang) =>
    _pick(lang, choiceHelpAr[setting]?[value], choiceHelpEn[setting]?[value], choiceHelpMs[setting]?[value]);

/// The sentence under a feature's switch on its settings page, or null.
String? featureHelp(String featureKey, AppLang lang) =>
    _pick(lang, featureHelpAr[featureKey], featureHelpEn[featureKey], featureHelpMs[featureKey]);

/// Name of a role; the role key itself when unknown. Screens that already hold
/// the catalogue (`S`) use `roleLabel(s, role)` in common/roles.dart: the same words.
String roleLabel(String role, AppLang lang) =>
    _pick(lang, roleLabelsAr[role], roleLabelsEn[role], roleLabelsMs[role]) ?? role;

/// The name of a feature (registry labelMs, labelEn, labelAr).
String featureLabel(FeatureDef f, AppLang lang) => switch (lang) {
      AppLang.ar => f.labelAr.isNotEmpty ? f.labelAr : (f.labelEn.isNotEmpty ? f.labelEn : f.labelMs),
      AppLang.en => f.labelEn.isNotEmpty ? f.labelEn : f.labelMs,
      AppLang.ms => f.labelMs,
    };

/// The description of a feature; empty when the registry has none.
String featureDesc(String featureKey, AppLang lang) {
  final d = featureDescTable[featureKey];
  if (d == null) return '';
  String? at(String k) {
    final v = d[k];
    return v is String && v.isNotEmpty ? v : null;
  }

  return _pick(lang, at('ar'), at('en'), at('ms')) ?? '';
}

/// The unit word of a registry number (`saat`, `minit`, `hari`) in the app
/// language, in the form that goes with [n] (Arabic has a dual and a plural
/// for 3 to 10). Units that are symbols (%, kbps, MB) stay as they are.
String unitLabel(String unit, num n, AppLang lang) {
  if (lang == AppLang.ms) return unit;
  final one = n == 1;
  switch (unit) {
    case 'saat':
      if (lang == AppLang.en) return one ? 'second' : 'seconds';
      return _arUnit(n, 'ثانية', 'ثانيتان', 'ثوانٍ', 'ثانية');
    case 'minit':
      if (lang == AppLang.en) return one ? 'minute' : 'minutes';
      return _arUnit(n, 'دقيقة', 'دقيقتان', 'دقائق', 'دقيقة');
    case 'hari':
      if (lang == AppLang.en) return one ? 'day' : 'days';
      return _arUnit(n, 'يوم', 'يومان', 'أيام', 'يومًا');
    default:
      return unit;
  }
}

String _arUnit(num n, String one, String two, String few, String many) {
  if (n == 1) return one;
  if (n == 2) return two;
  if (n >= 3 && n <= 10) return few;
  return many;
}

// ---- Content kinds (the BM words are in lib/content/kinds.dart and are passed in as [ms]) ----

String _pickOr(AppLang lang, String ms, String? ar, String? en) => switch (lang) {
      AppLang.ar => ar ?? en ?? ms,
      AppLang.en => en ?? ms,
      AppLang.ms => ms,
    };

/// Name of a content kind: one item, or the list title when [plural].
String contentKindLabel(String kind, AppLang lang, {required String ms, bool plural = false}) => plural
    ? _pickOr(lang, ms, contentKindPluralsAr[kind], contentKindPluralsEn[kind])
    : _pickOr(lang, ms, contentKindLabelsAr[kind], contentKindLabelsEn[kind]);

/// Name of a field of a content kind.
String contentFieldLabel(String kind, String field, AppLang lang, {required String ms}) =>
    _pickOr(lang, ms, contentFieldLabelsAr['$kind.$field'], contentFieldLabelsEn['$kind.$field']);

/// The example under a field; null when the field has none ([ms] null).
String? contentFieldHint(String kind, String field, AppLang lang, {required String? ms}) {
  if (ms == null) return null;
  return _pickOr(lang, ms, contentFieldHintsAr['$kind.$field'], contentFieldHintsEn['$kind.$field']);
}

/// Name of one choice of an enum field of a content kind.
String contentChoiceLabel(String kind, String field, String value, AppLang lang, {required String ms}) =>
    _pickOr(lang, ms, contentChoiceLabelsAr['$kind.$field']?[value], contentChoiceLabelsEn['$kind.$field']?[value]);

/// A day name; "every day" for `umum` and `daily`.
String dayLabel(String day, AppLang lang, {required String ms}) =>
    _pickOr(lang, ms, dayLabelsAr[day], dayLabelsEn[day]);

/// Month name (1 to 12) as a short word.
String monthWord(int month, AppLang lang, {required String ms}) =>
    _pickOr(lang, ms, monthWordsAr[month - 1], monthWordsEn[month - 1]);

/// Weekday name (DateTime.weekday: 1 Monday to 7 Sunday).
String weekdayWord(int weekday, AppLang lang, {required String ms}) =>
    _pickOr(lang, ms, weekdayWordsAr[weekday - 1], weekdayWordsEn[weekday - 1]);

/// The city a world-time zone is named after, in the app language. A zone
/// outside the catalogue (an imported one) shows its own IANA name: [ms] when
/// given, else the part after the last slash with spaces for underscores.
String zoneCityName(String zone, AppLang lang, {String? ms}) {
  final map = switch (lang) {
    AppLang.ms => zoneCityNamesMs,
    AppLang.en => zoneCityNamesEn,
    AppLang.ar => zoneCityNamesAr,
  };
  return map[zone] ?? ms ?? zone.split('/').last.replaceAll('_', ' ');
}

/// The word after a 12-hour clock time: BM and Arabic say the part of the day,
/// English says am or pm.
String dayPartWord(int hour, AppLang lang) {
  switch (lang) {
    case AppLang.ms:
      return hour < 12
          ? 'pagi'
          : hour < 15
              ? 'tengah hari'
              : hour < 19
                  ? 'petang'
                  : 'malam';
    case AppLang.en:
      return hour < 12 ? 'am' : 'pm';
    case AppLang.ar:
      return hour < 12
          ? 'صباحًا'
          : hour < 15
              ? 'ظهرًا'
              : hour < 19
                  ? 'عصرًا'
                  : 'مساءً';
  }
}
