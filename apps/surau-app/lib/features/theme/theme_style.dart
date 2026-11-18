// The theme menu model (the Dart twin of core `theme/style.ts`): one theme's
// values for all screens (`semua`) and for single screens (`skrin`), kept in
// memory by the Ubah suai editor until Simpan.
//
// Values: bgImage (64-hex asset id), bgFit (penuh, regang, sederhana, kecil),
// bgPos (kiri, tengah, kanan), shade (0..80), accent / text / harakat
// (#rrggbb), font / arFont (id), scale (S, M, L, XL), align (kiri, tengah,
// kanan), arScale (100..160), arLineHeight (16..24), tarjamah (bawah, sisi).
// 'sembunyi' was a tarjamah value (hide the translation): removed so Tetapan
// alone decides whether a translation shows. A stored one is still valid (an
// older box or app may hold it) and is dropped when the entry is read.

import '../../l10n/generated/s.dart';
import '../../l10n/s_lookup.dart';
import '../registry.g.dart';

/// One screen's menu values (key to a JSON value: String or int).
typedef StyleMap = Map<String, Object>;

/// Every key a [StyleMap] may hold, in core's order.
const List<String> styleKeys = [
  'bgImage', 'bgFit', 'bgPos', 'shade', 'accent', 'text', 'font', 'scale',
  'align', 'arFont', 'arScale', 'harakat', 'arLineHeight', 'tarjamah',
  'goldOutline',
];

/// The themes that draw a thin gold outline on their large text ("Garis emas pada tajuk", on unless switched off).
const List<String> goldOutlineThemes = ['default', 'oldschool', 'arabic'];

final RegExp _hex6 = RegExp(r'^#[0-9A-Fa-f]{6}$');
final RegExp _asset64 = RegExp(r'^[0-9a-f]{64}$');
final RegExp _fontId = RegExp(r'^[a-z0-9-]{1,32}$');

bool _oneOf(Object? v, List<String> vals) => v is String && vals.contains(v);
bool _intIn(Object? v, int min, int max) =>
    v is num && v == v.truncate() && v >= min && v <= max;

/// Null when [value] is valid for [key]; else a reason in the app language ([s], BM when none is given). The
/// same rules as core `styleValueError`.
String? styleValueProblem(String key, Object value, [S? lang]) {
  final s = lang ?? sBm;
  switch (key) {
    case 'bgImage':
      return value is String && _asset64.hasMatch(value) ? null : s.valImageBad;
    case 'bgFit':
      return _oneOf(value, const ['penuh', 'regang', 'sederhana', 'kecil']) ? null : s.valFitBad;
    case 'bgPos':
    case 'align':
      return _oneOf(value, const ['kiri', 'tengah', 'kanan']) ? null : s.valChoiceBad;
    case 'shade':
      return _intIn(value, 0, 80) ? null : s.valWholeNumber(0, 80);
    case 'accent':
    case 'text':
    case 'harakat':
      return value is String && _hex6.hasMatch(value) ? null : s.valColourLike;
    case 'font':
    case 'arFont':
      return value is String && _fontId.hasMatch(value) ? null : s.valFontBad;
    case 'scale':
      return _oneOf(value, const ['S', 'M', 'L', 'XL']) ? null : s.valSizeChoice;
    case 'arScale':
      return _intIn(value, 100, 160) ? null : s.valWholeNumber(100, 160);
    case 'arLineHeight':
      return _intIn(value, 16, 24) ? null : s.valWholeNumber(16, 24);
    case 'tarjamah':
      return _oneOf(value, const ['bawah', 'sisi', 'sembunyi']) ? null : s.valChoiceBad;
    case 'goldOutline':
      return _oneOf(value, const ['on', 'off']) ? null : s.valChoiceBad;
    default:
      return s.valValueUnknown;
  }
}

StyleMap _cleanStyle(Object? raw) {
  final out = <String, Object>{};
  if (raw is! Map) return out;
  for (final k in styleKeys) {
    Object? v = raw[k];
    if (v == null) continue;
    if (v is double && v == v.truncate()) v = v.toInt();
    if (styleValueProblem(k, v) == null) out[k] = v;
  }
  if (out['tarjamah'] == 'sembunyi') out.remove('tarjamah');
  return out;
}

/// One theme's menu values.
class ThemeStyleEntry {
  const ThemeStyleEntry({this.semua = const {}, this.skrin = const {}});

  /// Values for every screen of the theme.
  final StyleMap semua;

  /// Values for single screens (screen id to values); they win over [semua].
  final Map<String, StyleMap> skrin;

  /// The JSON the box stores (always both keys).
  Map<String, dynamic> toJson() => {
        'semua': {...semua},
        'skrin': {
          for (final e in skrin.entries) e.key: {...e.value},
        },
      };

  /// Reads what the box sent; drops what it does not know. Never throws.
  static ThemeStyleEntry fromJson(Object? j) {
    if (j is! Map) return const ThemeStyleEntry();
    final skrin = <String, StyleMap>{};
    final raw = j['skrin'];
    if (raw is Map) {
      for (final id in screenIds) {
        final s = _cleanStyle(raw[id]);
        if (s.isNotEmpty) skrin[id] = s;
      }
    }
    return ThemeStyleEntry(semua: _cleanStyle(j['semua']), skrin: skrin);
  }

  /// Nothing set: the theme's own look.
  bool get isEmpty => semua.isEmpty && skrin.values.every((m) => m.isEmpty);
}

/// The values a screen shows: [defaults] (the theme's own), then the surau's
/// all-screens values, then its one-screen values; later wins per key.
StyleMap effectiveStyle(
  ThemeStyleEntry e,
  String screenId, {
  ThemeStyleEntry defaults = const ThemeStyleEntry(),
}) =>
    {
      ...defaults.semua,
      ...?defaults.skrin[screenId],
      ...e.semua,
      ...?e.skrin[screenId],
    };

/// Sets [key] for one screen; a null [value] removes it. A screen left with
/// no value is removed.
ThemeStyleEntry setValue(ThemeStyleEntry e, String screenId, String key, Object? value) {
  final skrin = <String, StyleMap>{
    for (final s in e.skrin.entries) s.key: {...s.value},
  };
  final m = skrin[screenId] ?? <String, Object>{};
  if (value == null) {
    m.remove(key);
  } else {
    m[key] = value;
  }
  if (m.isEmpty) {
    skrin.remove(screenId);
  } else {
    skrin[screenId] = m;
  }
  return ThemeStyleEntry(semua: {...e.semua}, skrin: skrin);
}

/// "Guna untuk semua skrin": the all-screens layer takes this screen's values
/// and every one-screen layer is cleared.
ThemeStyleEntry applyToAll(ThemeStyleEntry e, String screenId) =>
    ThemeStyleEntry(semua: {...e.semua, ...?e.skrin[screenId]}, skrin: const {});

/// The surau set [key] for this screen (in all screens or in this one).
bool isChanged(ThemeStyleEntry e, String screenId, String key) =>
    e.semua.containsKey(key) || (e.skrin[screenId]?.containsKey(key) ?? false);

/// The screens with a value of their own (a gold dot in the editor).
Set<String> changedScreens(ThemeStyleEntry e) =>
    {for (final s in e.skrin.entries) if (s.value.isNotEmpty) s.key};

/// The surau set [key] on this screen itself (not inherited from all screens).
bool hasOwn(ThemeStyleEntry e, String screenId, String key) =>
    e.skrin[screenId]?.containsKey(key) ?? false;

/// "Set semula" on one screen: only this screen's own values go; the all-screens
/// values and every other screen stay.
ThemeStyleEntry resetScreen(ThemeStyleEntry e, String screenId) => ThemeStyleEntry(
      semua: {...e.semua},
      skrin: {
        for (final s in e.skrin.entries)
          if (s.key != screenId) s.key: {...s.value},
      },
    );

/// The layer darkness (percent) a theme wears over a picture when the surau set
/// none: what each built-in `theme.json` declares in `defaults.semua.shade`.
const int defaultThemeShade = 55;
const int otherThemeShade = 35;

/// Lowest layer darkness on the default look while a picture shows (the kiosk
/// clamps to the same value).
const int minDefaultShade = 25;

/// The theme's own values (the twin of the `defaults` of its `theme.json`). Arabic Art declares no layer darkness
/// (the kiosk wears 35 over a picture then) and starts from Uthmani Hafs.
ThemeStyleEntry themeDefaultsOf(String theme) => theme == 'arabic'
    ? const ThemeStyleEntry(semua: {'arFont': 'hafs', 'goldOutline': 'on'})
    : ThemeStyleEntry(semua: {
        'shade': theme == 'default' ? defaultThemeShade : otherThemeShade,
        if (goldOutlineThemes.contains(theme)) 'goldOutline': 'on',
      });

/// The harakat colour is drawn only with Amiri Quran or Amiri (a marks-only copy of those fonts draws it; the Uthmani
/// Hafs file may not be modified). Takes the values in force on the screen, the theme's own included.
bool harakatAllowed(Map<String, Object> effective) {
  final f = effective['arFont'] ?? 'hafs';
  return f == 'amiri' || f == 'amiri-quran';
}

/// The body of `PUT /api/settings/themeStyle`: only [theme]'s own entry. Every
/// theme is its own field on the box, so a save here never touches another
/// theme (two editors on different themes cannot erase each other). Set semula
/// of the whole theme sends an empty entry.
Map<String, dynamic> stylesPatch(String theme, ThemeStyleEntry? entry) => {
      'styles': {theme: (entry ?? const ThemeStyleEntry()).toJson()},
    };
