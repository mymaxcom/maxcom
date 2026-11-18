// Small per-phone yes/no flags of the screens (a hint the person closed).
//
// Kept in the phone's own preferences: never synced, never sent to the box,
// forgotten when the app's data is cleared. A flag that cannot be read counts
// as not set, so a hint shows again rather than vanish by mistake.

import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:shared_preferences/shared_preferences.dart';

/// Reads and writes one flag per key.
abstract class UiFlagsStore {
  Future<bool> get(String key);
  Future<void> set(String key, bool value);
}

/// The phone's preferences.
class PrefsUiFlagsStore implements UiFlagsStore {
  const PrefsUiFlagsStore();

  @override
  Future<bool> get(String key) async {
    try {
      final prefs = await SharedPreferences.getInstance();
      return prefs.getBool(key) ?? false;
    } on Object {
      return false;
    }
  }

  @override
  Future<void> set(String key, bool value) async {
    final prefs = await SharedPreferences.getInstance();
    await prefs.setBool(key, value);
  }
}

/// In memory (tests that want a store of their own).
class MemoryUiFlagsStore implements UiFlagsStore {
  final Map<String, bool> values = {};

  @override
  Future<bool> get(String key) async => values[key] ?? false;

  @override
  Future<void> set(String key, bool value) async => values[key] = value;
}

final uiFlagsStoreProvider = Provider<UiFlagsStore>((ref) => const PrefsUiFlagsStore());

/// The flag at a key; false until read.
final uiFlagProvider = FutureProvider.family<bool, String>(
  retry: (_, _) => null,
  (ref, key) => ref.watch(uiFlagsStoreProvider).get(key),
);

/// Sets the flag at [key] and lets every screen that reads it know.
Future<void> setUiFlag(WidgetRef ref, String key, bool value) async {
  await ref.read(uiFlagsStoreProvider).set(key, value);
  ref.invalidate(uiFlagProvider(key));
}
