// The language of this phone's app (BM, English, Arabic). Per phone only:
// kept in SharedPreferences under `app.lang`, never synced or sent to the
// box or the cloud.

import 'dart:ui' show Locale, PlatformDispatcher;

import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'providers.dart';

enum AppLang {
  ms,
  en,
  ar;

  Locale get locale => Locale(name);

  String get code => name;

  static AppLang? fromCode(String? code) {
    for (final l in values) {
      if (l.name == code) return l;
    }
    return null;
  }
}

/// First launch: the first system language we ship; none means BM.
AppLang initialAppLang(List<Locale> system) {
  for (final l in system) {
    final lang = AppLang.fromCode(l.languageCode);
    if (lang != null) return lang;
  }
  return AppLang.ms;
}

abstract class AppLangStore {
  AppLang? read();
  Future<void> write(AppLang lang);
}

class PrefsAppLangStore implements AppLangStore {
  PrefsAppLangStore(this._prefs);
  final SharedPreferences _prefs;

  static const key = 'app.lang';

  @override
  AppLang? read() => AppLang.fromCode(_prefs.getString(key));

  @override
  Future<void> write(AppLang lang) async {
    await _prefs.setString(key, lang.code);
  }
}

class MemoryAppLangStore implements AppLangStore {
  MemoryAppLangStore([this.value]);
  AppLang? value;

  @override
  AppLang? read() => value;

  @override
  Future<void> write(AppLang lang) async {
    value = lang;
  }
}

/// The store in use: the real one from [AppDeps], or (tests) one memory
/// store per container that answers BM, so every existing test and golden
/// stays BM.
final appLangStoreProvider = Provider<AppLangStore>(
  (ref) =>
      ref.watch(appDepsProvider).appLangStore ?? MemoryAppLangStore(AppLang.ms),
);

class AppLangNotifier extends Notifier<AppLang> {
  @override
  AppLang build() {
    final store = ref.watch(appLangStoreProvider);
    return store.read() ?? initialAppLang(PlatformDispatcher.instance.locales);
  }

  Future<void> set(AppLang lang) async {
    await ref.read(appLangStoreProvider).write(lang);
    state = lang;
  }
}

final appLangProvider = NotifierProvider<AppLangNotifier, AppLang>(
  AppLangNotifier.new,
);
