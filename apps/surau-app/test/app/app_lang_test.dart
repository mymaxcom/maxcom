import 'dart:ui';

import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:surau_app/app/app_lang.dart';

void main() {
  test('first launch follows the phone language', () {
    expect(initialAppLang([const Locale('en', 'GB')]), AppLang.en);
    expect(initialAppLang([const Locale('ar', 'JO')]), AppLang.ar);
    expect(initialAppLang([const Locale('ms', 'MY')]), AppLang.ms);
    expect(
      initialAppLang([const Locale('fr'), const Locale('en')]),
      AppLang.en,
    );
    expect(initialAppLang([const Locale('fr')]), AppLang.ms);
    expect(initialAppLang([]), AppLang.ms);
  });

  test('locale and code', () {
    expect(AppLang.ar.locale, const Locale('ar'));
    expect(AppLang.en.code, 'en');
  });

  test('prefs store round trip and ignores junk', () async {
    SharedPreferences.setMockInitialValues({'app.lang': 'xx'});
    final prefs = await SharedPreferences.getInstance();
    final store = PrefsAppLangStore(prefs);
    expect(store.read(), isNull);
    await store.write(AppLang.ar);
    expect(prefs.getString('app.lang'), 'ar');
    expect(PrefsAppLangStore(prefs).read(), AppLang.ar);
  });

  test('stored choice wins over the phone language', () {
    final store = MemoryAppLangStore(AppLang.en);
    final c = ProviderContainer(
      overrides: [appLangStoreProvider.overrideWithValue(store)],
    );
    addTearDown(c.dispose);
    expect(c.read(appLangProvider), AppLang.en);
  });

  test('set persists and a new container reads it back', () async {
    final store = MemoryAppLangStore(AppLang.ms);
    final a = ProviderContainer(
      overrides: [appLangStoreProvider.overrideWithValue(store)],
    );
    addTearDown(a.dispose);
    await a.read(appLangProvider.notifier).set(AppLang.ar);
    expect(a.read(appLangProvider), AppLang.ar);
    final b = ProviderContainer(
      overrides: [appLangStoreProvider.overrideWithValue(store)],
    );
    addTearDown(b.dispose);
    expect(b.read(appLangProvider), AppLang.ar);
  });
}
