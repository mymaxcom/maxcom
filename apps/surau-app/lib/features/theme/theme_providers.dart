// What the theme screens read: which themes the box supports (the `themes`
// block of `GET /api/health`) and the cards of the gallery drawn from the
// settings (`kioskTemplate` and `themeStyle`).

import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../app/providers.dart';
import '../../box/wire.dart';
import '../registry.g.dart';
import 'theme_style.dart';

/// The `themes` block of `GET /api/health` of whatever the gateway reaches
/// (the box on the surau Wi-Fi, the cloud away); null when the box sends
/// none (an older box) or the answer is not there yet.
final themeSupportProvider = FutureProvider<ThemeSupport?>((ref) async {
  final read = await ref.watch(healthProvider.future);
  return read?.value.themes;
});

/// Whether the box can customise themes (the contract of this app or newer).
bool supportsThemeEditing(ThemeSupport? s) => s != null && s.contract >= 1;

/// One card of the gallery.
class ThemeCardData {
  const ThemeCardData({
    required this.name,
    required this.title,
    required this.builtIn,
    required this.active,
    required this.changedScreenCount,
    this.version,
    this.contract,
    this.base,
  });

  final String name;
  final String title;
  final bool builtIn;

  /// The version of an uploaded theme; null for a built-in one.
  final int? version;

  /// The theme contract an uploaded theme was made for; null for a built-in one.
  final int? contract;

  /// The built-in theme an uploaded theme is made on; null for a built-in one.
  final String? base;
  final bool active;

  /// How many screens of the theme the surau customised.
  final int changedScreenCount;
}

/// The built-in theme an uploaded theme is made on; null for a built-in theme or an unknown name.
String? packBaseOf(Map<String, dynamic> settings, String theme) {
  final ts = settings['themeStyle'];
  final packs = ts is Map ? ts['packs'] : null;
  final p = packs is Map ? packs[theme] : null;
  final b = p is Map ? p['base'] : null;
  return b is String ? b : null;
}

/// Whether the theme shows ayat, hadis and zikir in their Arabic-led looks: Arabic Art does, and so does an uploaded theme
/// made on Arabic Art or one that ships an `arab-*` screen file (a pack opts in that way). The twin of `arabLooksOf` in
/// the kiosk, which goes by the base theme.
bool arabLooksOn(Map<String, dynamic> settings, String theme) {
  if (theme == 'arabic' || packBaseOf(settings, theme) == 'arabic') return true;
  final ts = settings['themeStyle'];
  final packs = ts is Map ? ts['packs'] : null;
  final p = packs is Map ? packs[theme] : null;
  final screens = p is Map ? p['screens'] : null;
  return screens is List && screens.any((x) => x is String && x.startsWith('arab-'));
}

/// The theme the TV wears: `kioskTemplate.templateId`, else `default`.
String activeThemeOf(Map<String, dynamic> settings) {
  final k = settings['kioskTemplate'];
  final id = k is Map ? k['templateId'] : null;
  return id is String && id.isNotEmpty ? id : 'default';
}

/// The surau's values of [theme] as the box has them.
ThemeStyleEntry storedEntryOf(Map<String, dynamic> settings, String theme) {
  final ts = settings['themeStyle'];
  final styles = ts is Map ? ts['styles'] : null;
  return styles is Map ? ThemeStyleEntry.fromJson(styles[theme]) : const ThemeStyleEntry();
}

/// The built-in themes in [builtInThemeIds] order, then the uploaded ones
/// (`themeStyle.packs`) by title.
List<ThemeCardData> themeCards(Map<String, dynamic> settings) {
  final active = activeThemeOf(settings);
  int changed(String name) => changedScreens(storedEntryOf(settings, name)).length;
  final cards = <ThemeCardData>[
    for (final id in builtInThemeIds)
      ThemeCardData(
        name: id,
        title: themeTitles[id] ?? id,
        builtIn: true,
        active: active == id,
        changedScreenCount: changed(id),
      ),
  ];
  final ts = settings['themeStyle'];
  final packs = ts is Map ? ts['packs'] : null;
  if (packs is Map) {
    final uploaded = <ThemeCardData>[];
    for (final e in packs.entries) {
      final p = e.value;
      if (e.key is! String || p is! Map) continue;
      final title = p['title'];
      final version = p['version'];
      uploaded.add(
        ThemeCardData(
          name: e.key as String,
          title: title is String ? title : e.key as String,
          builtIn: false,
          version: version is num ? version.toInt() : null,
          contract: p['contract'] is num ? (p['contract'] as num).toInt() : null,
          base: p['base'] is String ? p['base'] as String : null,
          active: active == e.key,
          changedScreenCount: changed(e.key as String),
        ),
      );
    }
    uploaded.sort((a, b) => a.title.toLowerCase().compareTo(b.title.toLowerCase()));
    cards.addAll(uploaded);
  }
  return cards;
}
