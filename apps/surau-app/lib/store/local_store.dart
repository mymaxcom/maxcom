// The app's local copy of the box data (Plan 6 Task 7): small JSON documents
// grouped in collections, a few key/value "meta" entries, and blobs (asset
// bytes and queued uploads). The sync engine (Task 8) reads and writes only
// through [LocalStore], so the same code runs on Android (Keystore-sealed
// files), on the web (IndexedDB) and in tests (memory).

import 'dart:convert';
import 'dart:typed_data';

/// Collections the app keeps. `content:<kind>` is one collection per content
/// kind; [content] builds its name.
class Collections {
  const Collections._();

  static const String settings = 'settings';
  static const String users = 'users';
  static const String devices = 'devices';
  static const String surauInfo = 'surauInfo';
  static const String outbox = 'outbox';
  static const String conflicts = 'conflicts';
  static const String uploads = 'uploads';

  /// One doc per recorded session the clean-up watches (Plan 6 Task 13).
  static const String cleanup = 'cleanup';

  /// One doc per Android live: the exact file names it recorded.
  static const String sessionFiles = 'sessionFiles';

  /// The last 200 audit rows, a cache only.
  static const String audit = 'audit';

  // Plan 7 finance: one collection per feed entity, named as the entity
  // (every doc keyed by its id; a month by `YYYY-MM`). The photo collection
  // holds the meta only; the JPEG bytes are a blob.
  static const String financeEntries = 'finance:entry';
  static const String financeFunds = 'finance:fund';
  static const String financePerihal = 'finance:perihal';
  static const String financeMonths = 'finance:month';
  static const String financePhotos = 'finance:photo';

  static String content(String kind) => 'content:$kind';
}

/// Meta key (value: ISO time) of the last time the person looked at the
/// corrections ("Pembetulan" badge). Local only; never synced.
const String metaFinanceCorrectionsSeenAt = 'financeCorrectionsSeenAt';

/// Meta key set when a stored file could not be opened (tampered, or the
/// Keystore key is gone after a device reset): the next sync pulls a fresh
/// snapshot.
const String metaNeedsSnapshot = 'needsSnapshot';

/// Meta key (value: ISO time) set when the outbox file could not be read and
/// was set aside: the engine shows it as a conflict, then clears it.
const String metaOutboxUnreadable = 'outboxUnreadable';

/// Total blob bytes kept before the oldest asset blob is evicted.
const int defaultBlobCapBytes = 200 * 1024 * 1024;

/// Blobs whose id starts with this are queued uploads: never evicted.
const String uploadBlobPrefix = 'upload-';

/// A box id is used in file names and Keystore aliases: letters, digits,
/// `_` and `-` only, 1 to 64 characters.
bool isValidBoxId(String id) => RegExp(r'^[A-Za-z0-9_-]{1,64}$').hasMatch(id);

abstract class LocalStore {
  /// Opens (creating when needed) the store of one enrolled box.
  Future<void> open(String boxId);

  Future<Map<String, dynamic>?> getDoc(String collection, String id);

  Future<List<Map<String, dynamic>>> list(String collection);

  Future<void> putDoc(String collection, String id, Map<String, dynamic> doc);

  Future<void> deleteDoc(String collection, String id);

  /// Replaces the whole collection with [docs].
  Future<void> putAll(
    String collection,
    Map<String, Map<String, dynamic>> docs,
  );

  /// Puts [puts] and removes [deletes] in one write of the collection.
  Future<void> applyDocs(
    String collection, {
    Map<String, Map<String, dynamic>> puts = const {},
    Set<String> deletes = const {},
  });

  Future<Map<String, String>> meta();

  /// A null [value] removes the key.
  Future<void> setMeta(String key, String? value);

  Future<Uint8List?> getBlob(String id);

  Future<void> putBlob(String id, Uint8List bytes);

  Future<void> deleteBlob(String id);

  /// Deletes everything this store holds (and the Keystore key on Android).
  Future<void> wipe();

  /// Bytes the store occupies.
  Future<int> bytes();
}

Map<String, dynamic> copyDoc(Map<String, dynamic> doc) =>
    jsonDecode(jsonEncode(doc)) as Map<String, dynamic>;

/// In-memory store for tests and for platforms with no persistent store.
class MemoryLocalStore implements LocalStore {
  MemoryLocalStore({this.blobCap = defaultBlobCapBytes});

  final int blobCap;
  final Map<String, Map<String, Map<String, dynamic>>> _docs = {};
  final Map<String, String> _meta = {};
  final Map<String, Uint8List> _blobs = {};
  // Insertion order is the age order: oldest first.
  final List<String> _blobOrder = [];

  @override
  Future<void> open(String boxId) async {
    if (!isValidBoxId(boxId)) throw ArgumentError('box id');
  }

  @override
  Future<Map<String, dynamic>?> getDoc(String collection, String id) async {
    final d = _docs[collection]?[id];
    return d == null ? null : copyDoc(d);
  }

  @override
  Future<List<Map<String, dynamic>>> list(String collection) async => [
    for (final d in (_docs[collection] ?? const {}).values) copyDoc(d),
  ];

  @override
  Future<void> putDoc(
    String collection,
    String id,
    Map<String, dynamic> doc,
  ) async {
    (_docs[collection] ??= {})[id] = copyDoc(doc);
  }

  @override
  Future<void> deleteDoc(String collection, String id) async {
    _docs[collection]?.remove(id);
  }

  @override
  Future<void> putAll(
    String collection,
    Map<String, Map<String, dynamic>> docs,
  ) async {
    _docs[collection] = {for (final e in docs.entries) e.key: copyDoc(e.value)};
  }

  @override
  Future<void> applyDocs(
    String collection, {
    Map<String, Map<String, dynamic>> puts = const {},
    Set<String> deletes = const {},
  }) async {
    final c = _docs[collection] ??= {};
    for (final id in deletes) {
      c.remove(id);
    }
    for (final e in puts.entries) {
      c[e.key] = copyDoc(e.value);
    }
  }

  @override
  Future<Map<String, String>> meta() async => Map.of(_meta);

  @override
  Future<void> setMeta(String key, String? value) async {
    if (value == null) {
      _meta.remove(key);
    } else {
      _meta[key] = value;
    }
  }

  @override
  Future<Uint8List?> getBlob(String id) async {
    final b = _blobs[id];
    return b == null ? null : Uint8List.fromList(b);
  }

  @override
  Future<void> putBlob(String id, Uint8List bytes) async {
    _blobs[id] = Uint8List.fromList(bytes);
    _blobOrder
      ..remove(id)
      ..add(id);
    var total = _blobs.values.fold<int>(0, (a, b) => a + b.length);
    for (final old in List<String>.of(_blobOrder)) {
      if (total <= blobCap) break;
      if (old == id || old.startsWith(uploadBlobPrefix)) continue;
      total -= _blobs.remove(old)!.length;
      _blobOrder.remove(old);
    }
  }

  @override
  Future<void> deleteBlob(String id) async {
    _blobs.remove(id);
    _blobOrder.remove(id);
  }

  @override
  Future<void> wipe() async {
    _docs.clear();
    _meta.clear();
    _blobs.clear();
    _blobOrder.clear();
  }

  @override
  Future<int> bytes() async {
    var n = 0;
    for (final c in _docs.values) {
      for (final d in c.values) {
        n += utf8.encode(jsonEncode(d)).length;
      }
    }
    for (final e in _meta.entries) {
      n += e.key.length + e.value.length;
    }
    for (final b in _blobs.values) {
      n += b.length;
    }
    return n;
  }
}
