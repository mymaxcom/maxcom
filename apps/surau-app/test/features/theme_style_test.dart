import 'package:flutter_test/flutter_test.dart';
import 'package:surau_app/features/theme/theme_style.dart';
import 'package:surau_app/box/wire.dart';

void main() {
  test('Guna untuk semua skrin writes the all-screens layer and clears every one-screen layer', () {
    const e = ThemeStyleEntry(semua: {'accent': '#111111', 'shade': 10}, skrin: {'kuliah': {'shade': 40, 'align': 'kanan'}, 'hadis': {'scale': 'L'}});
    final r = applyToAll(e, 'kuliah');
    expect(r.semua, {'accent': '#111111', 'shade': 40, 'align': 'kanan'});
    expect(r.skrin, isEmpty);
  });
  test('Simpan sends only this theme; Set semula of the theme sends an empty entry', () {
    expect(stylesPatch('creative', const ThemeStyleEntry(semua: {'shade': 20})), {'styles': {'creative': {'semua': {'shade': 20}, 'skrin': <String, Object?>{}}}});
    expect(stylesPatch('creative', const ThemeStyleEntry()), {'styles': {'creative': {'semua': <String, Object?>{}, 'skrin': <String, Object?>{}}}});
    expect(stylesPatch('creative', null), {'styles': {'creative': {'semua': <String, Object?>{}, 'skrin': <String, Object?>{}}}});
  });
  test('explicit values against follow the theme: all screens kanan, this screen kiri', () {
    var e = const ThemeStyleEntry(semua: {'align': 'kanan'});
    e = setValue(e, 'kuliah', 'align', 'kiri');
    expect(effectiveStyle(e, 'kuliah')['align'], 'kiri');
    expect(hasOwn(e, 'kuliah', 'align'), isTrue);
    expect(effectiveStyle(e, 'hadis')['align'], 'kanan');
    // Ikut tema on this screen: the screen's own value goes, the all-screens value shows again.
    final followed = setValue(e, 'kuliah', 'align', null);
    expect(effectiveStyle(followed, 'kuliah')['align'], 'kanan');
    expect(hasOwn(followed, 'kuliah', 'align'), isFalse);
    // Set semula on one screen removes only that screen's keys.
    final withOther = setValue(setValue(e, 'kuliah', 'shade', 20), 'hadis', 'scale', 'L');
    final reset = resetScreen(withOther, 'kuliah');
    expect(effectiveStyle(reset, 'kuliah')['align'], 'kanan');
    expect(reset.skrin.keys, ['hadis']);
    expect(reset.semua, {'align': 'kanan'});
  });
  test('a concrete value equal to a built-in default is kept as itself', () {
    final e = setValue(setValue(setValue(const ThemeStyleEntry(), 'kuliah', 'font', 'jakarta'), 'kuliah', 'scale', 'S'), 'kuliah', 'align', 'kiri');
    expect(e.toJson()['skrin'], {'kuliah': {'font': 'jakarta', 'scale': 'S', 'align': 'kiri'}});
  });
  test('the theme default layer darkness mirrors theme.json', () {
    expect(themeDefaultsOf('default').semua, {'shade': 55, 'goldOutline': 'on'});
    expect(themeDefaultsOf('creative').semua, {'shade': 35});
    expect(themeDefaultsOf('oldschool').semua, {'shade': 35, 'goldOutline': 'on'});
  });
  test('setValue edits one screen; null removes; an emptied screen disappears', () {
    var e = setValue(const ThemeStyleEntry(), 'kuliah', 'shade', 20);
    expect(e.skrin, {'kuliah': {'shade': 20}});
    e = setValue(e, 'kuliah', 'shade', null);
    expect(e.isEmpty, isTrue);
  });
  test('effective style: defaults, then all, then one screen', () {
    const e = ThemeStyleEntry(semua: {'accent': '#111111'}, skrin: {'kuliah': {'shade': 40}});
    expect(effectiveStyle(e, 'kuliah', defaults: const ThemeStyleEntry(semua: {'scale': 'M'})), {'scale': 'M', 'accent': '#111111', 'shade': 40});
  });
  test('changed markers', () {
    const e = ThemeStyleEntry(semua: {'accent': '#111111'}, skrin: {'kuliah': {'shade': 40}});
    expect(isChanged(e, 'kuliah', 'shade'), isTrue);
    expect(isChanged(e, 'hadis', 'shade'), isFalse);
    expect(isChanged(e, 'hadis', 'accent'), isTrue);
    expect(changedScreens(e), {'kuliah'});
  });
  test('value rules match the box', () {
    expect(styleValueProblem('shade', 81), isNotNull);
    expect(styleValueProblem('shade', 80), isNull);
    expect(styleValueProblem('scale', 'XS'), isNotNull);
    expect(styleValueProblem('accent', '#2fd1b0'), isNull);
    expect(styleValueProblem('arScale', 90), isNotNull);
    expect(styleValueProblem('nope', 1), isNotNull);
  });
  test('json round trip drops unknown keys, bad values and unknown screens', () {
    final e = ThemeStyleEntry.fromJson({'semua': {'shade': 20.0, 'zz': 1, 'accent': 5}, 'skrin': {'kuliah': {'scale': 'L'}, 'nope': {'scale': 'L'}}});
    expect(e.toJson(), {'semua': {'shade': 20}, 'skrin': {'kuliah': {'scale': 'L'}}});
    expect(ThemeStyleEntry.fromJson(null).isEmpty, isTrue);
  });
  test('HealthDto reads the themes block, and null on an older box', () {
    final h = HealthDto.fromJson({'ok': true, 'version': 3, 'themes': {'contract': 1, 'builtIn': ['default', 'minimal']}});
    expect(h.themes!.contract, 1);
    expect(h.themes!.builtIn, ['default', 'minimal']);
    expect(HealthDto.fromJson({'ok': true, 'version': 3}).themes, isNull);
  });
}
