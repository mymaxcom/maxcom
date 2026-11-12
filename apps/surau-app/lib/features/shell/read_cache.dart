// The last good answer to every GET, kept under its path with the time it
// arrived, so the app can show it when the box is away (builder's call 7:
// reads from cache with a banner, no offline write queue). Lives in a
// provider for the app's lifetime and, in the app, in shared_preferences
// so a restart away from the surau still shows the last data.

import 'dart:convert';

import 'package:shared_preferences/shared_preferences.dart';

class CachedBody {
  const CachedBody(this.body, this.at);

  final Map<String, dynamic> body;
  final DateTime at;
}

/// A value from the box, or from the cache when the box could not be
/// reached ([stale] is then true and [at] is when it was last fresh).
class Read<T> {
  const Read(this.value, {required this.at, required this.stale});

  final T value;
  final DateTime at;
  final bool stale;

  Read<R> map<R>(R Function(T) f) => Read(f(value), at: at, stale: stale);
}

/// Where cached bodies live between launches. Entries are kept per box id,
/// so data from one box can never be shown for another. [MemoryReadCacheStore]
/// keeps them for one run.
abstract class ReadCacheStore {
  /// The entries kept for [boxId]; entries of any other box are dropped.
  Future<Map<String, CachedBody>> load(String boxId);

  /// Writes one entry. Calls are applied in order, and a [clear] called
  /// after a [put] always lands after it.
  Future<void> put(String boxId, String path, CachedBody body);

  /// Forgets everything, for every box.
  Future<void> clear();
}

class MemoryReadCacheStore implements ReadCacheStore {
  final Map<String, Map<String, CachedBody>> _all = {};

  @override
  Future<Map<String, CachedBody>> load(String boxId) async {
    _all.removeWhere((k, _) => k != boxId);
    return Map.of(_all[boxId] ?? const {});
  }

  @override
  Future<void> put(String boxId, String path, CachedBody body) async =>
      (_all[boxId] ??= {})[path] = body;

  @override
  Future<void> clear() async => _all.clear();
}

/// `surau.cache.<boxId><path>` -> `{"at": <ms since epoch>, "body": {...}}`
/// (a path starts with `/`). Bodies hold no secrets (never a token); a
/// corrupt entry is skipped. Every write goes through one chain, so a late
/// save can never land after a [clear], and only the changed key is written.
class PrefsReadCacheStore implements ReadCacheStore {
  PrefsReadCacheStore(this._prefs);

  final SharedPreferences _prefs;

  static const String prefix = 'surau.cache.';

  Future<void> _tail = Future<void>.value();

  Future<T> _enqueue<T>(Future<T> Function() op) {
    final done = _tail.then((_) => op());
    _tail = done.then<void>((_) {}, onError: (Object _) {});
    return done;
  }

  @override
  Future<Map<String, CachedBody>> load(String boxId) => _enqueue(() async {
    final out = <String, CachedBody>{};
    final mine = '$prefix$boxId/';
    for (final k in _prefs.getKeys().toList()) {
      if (!k.startsWith(prefix)) continue;
      if (!k.startsWith(mine)) {
        await _prefs.remove(k); // another box's data, or the old key layout
        continue;
      }
      final raw = _prefs.getString(k);
      if (raw == null) continue;
      try {
        final j = jsonDecode(raw);
        if (j is Map<String, dynamic> &&
            j['at'] is int &&
            j['body'] is Map<String, dynamic>) {
          out[k.substring(mine.length - 1)] = CachedBody(
            j['body'] as Map<String, dynamic>,
            DateTime.fromMillisecondsSinceEpoch(j['at'] as int, isUtc: true),
          );
        }
      } on Object {
        // skip a corrupt entry
      }
    }
    return out;
  });

  @override
  Future<void> put(String boxId, String path, CachedBody body) => _enqueue(
    () => _prefs.setString(
      '$prefix$boxId$path',
      jsonEncode({
        'at': body.at.toUtc().millisecondsSinceEpoch,
        'body': body.body,
      }),
    ),
  );

  @override
  Future<void> clear() => _enqueue(() async {
    for (final k in _prefs.getKeys().toList()) {
      if (k.startsWith(prefix)) await _prefs.remove(k);
    }
  });
}

class ReadCache {
  ReadCache({this.store, this.boxId = '', Map<String, CachedBody>? initial})
    : _bodies = Map.of(initial ?? const {});

  final ReadCacheStore? store;

  /// The box these answers belong to; the store keeps them under it.
  String boxId;
  final Map<String, CachedBody> _bodies;

  /// Bumped by [clear]; a load that started before it must not seed.
  int _epoch = 0;

  CachedBody? get(String path) => _bodies[path];

  /// Entries from a previous run; a body fetched in this run wins.
  void seed(Map<String, CachedBody> loaded) {
    for (final e in loaded.entries) {
      _bodies.putIfAbsent(e.key, () => e.value);
    }
  }

  /// Loads this box's kept entries from [store] and seeds them, unless the
  /// cache was cleared meanwhile.
  Future<void> restore() async {
    final s = store;
    if (s == null) return;
    final epoch = _epoch;
    final loaded = await s.load(boxId);
    if (epoch == _epoch) seed(loaded);
  }

  /// Switches to another box: what was cached for the old one leaves
  /// memory (the store drops it on the next load) and the new box's own
  /// kept entries are read.
  void useBox(String id) {
    if (id == boxId) return;
    _epoch++;
    _bodies.clear();
    boxId = id;
    restore();
  }

  bool get isEmpty => _bodies.isEmpty;

  /// Paths cached so far, for tests and the device page.
  Iterable<String> get paths => _bodies.keys;

  void put(String path, Map<String, dynamic> body, DateTime at) {
    final entry = CachedBody(body, at);
    _bodies[path] = entry;
    store?.put(boxId, path, entry);
  }

  /// Lupakan peranti, Daftar semula: nothing of the old box stays.
  void clear() {
    _epoch++;
    _bodies.clear();
    store?.clear();
  }
}
