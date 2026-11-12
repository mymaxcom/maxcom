// Browser local store (Plan 6 Task 7): IndexedDB `maxcom-local-<boxId>` with
// object stores `docs` (key [collection, id]), `meta` and `blobs`. NOT
// encrypted: a browser has no keystore, the origin sandbox and the device's
// own lock are the protection (builder's call 4). `wipe()` deletes the
// database.

import 'dart:async';
import 'dart:convert';
import 'dart:js_interop';
import 'dart:js_interop_unsafe';
import 'dart:typed_data';

import 'package:web/web.dart' as web;

import 'local_store.dart';
import 'local_store_stub.dart' as stub;

LocalStore androidLocalStore() => stub.androidLocalStore();

LocalStore webLocalStore() => IndexedDbLocalStore();

const String _docs = 'docs';
const String _meta = 'meta';
const String _blobs = 'blobs';

class IndexedDbLocalStore implements LocalStore {
  IndexedDbLocalStore({this.blobCap = defaultBlobCapBytes});

  final int blobCap;
  String? _box;
  Future<web.IDBDatabase>? _dbFuture;

  String get _name => 'maxcom-local-${_box ?? ''}';

  Future<web.IDBDatabase> get _db {
    if (_box == null) throw StateError('open() first');
    return _dbFuture ??= _open();
  }

  Future<web.IDBDatabase> _open() {
    final c = Completer<web.IDBDatabase>();
    final req = web.window.indexedDB.open(_name, 1);
    req.onupgradeneeded = ((web.Event _) {
      final db = req.result as web.IDBDatabase;
      db.createObjectStore(
        _docs,
        web.IDBObjectStoreParameters(
          keyPath: ['collection'.toJS, 'id'.toJS].toJS,
        ),
      );
      db.createObjectStore(
        _meta,
        web.IDBObjectStoreParameters(keyPath: 'key'.toJS),
      );
      db.createObjectStore(
        _blobs,
        web.IDBObjectStoreParameters(keyPath: 'id'.toJS),
      );
    }).toJS;
    req.onsuccess = ((web.Event _) {
      c.complete(req.result as web.IDBDatabase);
    }).toJS;
    req.onerror = ((web.Event _) {
      c.completeError(StateError('IndexedDB tidak dapat dibuka'));
    }).toJS;
    req.onblocked = ((web.Event _) {
      c.completeError(StateError('IndexedDB tidak dapat dibuka'));
    }).toJS;
    return c.future.catchError((Object e) {
      _dbFuture = null;
      throw e;
    });
  }

  static Future<JSAny?> _result(web.IDBRequest r) {
    final c = Completer<JSAny?>();
    r.onsuccess = ((web.Event _) => c.complete(r.result)).toJS;
    r.onerror = ((web.Event _) => c.completeError(
      StateError('IndexedDB gagal'),
    )).toJS;
    return c.future;
  }

  static Future<void> _done(web.IDBTransaction tx) {
    final c = Completer<void>();
    tx.oncomplete = ((web.Event _) => c.complete()).toJS;
    tx.onerror = ((web.Event _) => c.completeError(
      StateError('IndexedDB gagal'),
    )).toJS;
    tx.onabort = ((web.Event _) => c.completeError(
      StateError('IndexedDB tidak cukup ruang'),
    )).toJS;
    return c.future;
  }

  static JSObject _record(Map<String, JSAny?> fields) {
    final o = JSObject();
    fields.forEach((k, v) => o[k] = v);
    return o;
  }

  static web.IDBKeyRange _range(String collection) => web.IDBKeyRange.bound(
    [collection.toJS].toJS,
    [collection.toJS, '\u{ffff}'.toJS].toJS,
  );

  static String _s(JSObject o, String k) => (o[k] as JSString?)?.toDart ?? '';

  static int _i(JSObject o, String k) => (o[k] as JSNumber?)?.toDartInt ?? 0;

  /// Decodes one stored document; null when it cannot be read.
  static Map<String, dynamic>? _decode(JSObject o) {
    try {
      return jsonDecode(_s(o, 'json')) as Map<String, dynamic>;
    } catch (_) {
      return null;
    }
  }

  Future<void> _needsSnapshot() => setMeta(metaNeedsSnapshot, '1');

  @override
  Future<void> open(String boxId) async {
    if (!isValidBoxId(boxId)) throw ArgumentError('box id');
    if (_box != boxId) {
      final old = _dbFuture;
      _dbFuture = null;
      if (old != null) (await old).close();
    }
    _box = boxId;
    await _db;
  }

  @override
  Future<Map<String, dynamic>?> getDoc(String collection, String id) async {
    final db = await _db;
    final tx = db.transaction(_docs.toJS, 'readonly');
    final r = await _result(
      tx.objectStore(_docs).get([collection.toJS, id.toJS].toJS),
    );
    if (r == null || r.isUndefined) return null;
    final d = _decode(r as JSObject);
    if (d == null) await _needsSnapshot();
    return d;
  }

  @override
  Future<List<Map<String, dynamic>>> list(String collection) async {
    final db = await _db;
    final tx = db.transaction(_docs.toJS, 'readonly');
    final r = await _result(tx.objectStore(_docs).getAll(_range(collection)));
    final out = <Map<String, dynamic>>[];
    var bad = false;
    for (final o in (r as JSArray<JSObject>).toDart) {
      final d = _decode(o);
      if (d == null) {
        bad = true;
      } else {
        out.add(d);
      }
    }
    if (bad) await _needsSnapshot();
    return out;
  }

  JSObject _docRecord(String collection, String id, Map<String, dynamic> doc) =>
      _record({
        'collection': collection.toJS,
        'id': id.toJS,
        'json': jsonEncode(doc).toJS,
      });

  @override
  Future<void> putDoc(
    String collection,
    String id,
    Map<String, dynamic> doc,
  ) async {
    final db = await _db;
    final tx = db.transaction(_docs.toJS, 'readwrite');
    final done = _done(tx);
    tx.objectStore(_docs).put(_docRecord(collection, id, doc));
    await done;
  }

  @override
  Future<void> deleteDoc(String collection, String id) async {
    final db = await _db;
    final tx = db.transaction(_docs.toJS, 'readwrite');
    final done = _done(tx);
    tx.objectStore(_docs).delete([collection.toJS, id.toJS].toJS);
    await done;
  }

  @override
  Future<void> applyDocs(
    String collection, {
    Map<String, Map<String, dynamic>> puts = const {},
    Set<String> deletes = const {},
  }) async {
    final db = await _db;
    final tx = db.transaction(_docs.toJS, 'readwrite');
    final done = _done(tx);
    final store = tx.objectStore(_docs);
    for (final id in deletes) {
      store.delete([collection.toJS, id.toJS].toJS);
    }
    for (final e in puts.entries) {
      store.put(_docRecord(collection, e.key, e.value));
    }
    await done;
  }

  @override
  Future<void> putAll(
    String collection,
    Map<String, Map<String, dynamic>> docs,
  ) async {
    final db = await _db;
    final tx = db.transaction(_docs.toJS, 'readwrite');
    final done = _done(tx);
    final store = tx.objectStore(_docs);
    store.delete(_range(collection));
    for (final e in docs.entries) {
      store.put(_docRecord(collection, e.key, e.value));
    }
    await done;
  }

  @override
  Future<Map<String, String>> meta() async {
    final db = await _db;
    final tx = db.transaction(_meta.toJS, 'readonly');
    final r = await _result(tx.objectStore(_meta).getAll());
    return {
      for (final o in (r as JSArray<JSObject>).toDart)
        _s(o, 'key'): _s(o, 'value'),
    };
  }

  @override
  Future<void> setMeta(String key, String? value) async {
    final db = await _db;
    final tx = db.transaction(_meta.toJS, 'readwrite');
    final done = _done(tx);
    final store = tx.objectStore(_meta);
    if (value == null) {
      store.delete(key.toJS);
    } else {
      store.put(_record({'key': key.toJS, 'value': value.toJS}));
    }
    await done;
  }

  @override
  Future<Uint8List?> getBlob(String id) async {
    final db = await _db;
    final tx = db.transaction(_blobs.toJS, 'readonly');
    final r = await _result(tx.objectStore(_blobs).get(id.toJS));
    if (r == null || r.isUndefined) return null;
    return ((r as JSObject)['bytes'] as JSUint8Array).toDart;
  }

  @override
  Future<void> putBlob(String id, Uint8List bytes) async {
    final db = await _db;
    var tx = db.transaction(_blobs.toJS, 'readwrite');
    var done = _done(tx);
    tx
        .objectStore(_blobs)
        .put(
          _record({
            'id': id.toJS,
            'bytes': Uint8List.fromList(bytes).toJS,
            'size': bytes.length.toJS,
            'at': DateTime.now().microsecondsSinceEpoch.toJS,
          }),
        );
    await done;
    // Evict the oldest asset blobs (never queued uploads, never this one).
    tx = db.transaction(_blobs.toJS, 'readwrite');
    done = _done(tx);
    final store = tx.objectStore(_blobs);
    final all = (await _result(store.getAll()) as JSArray<JSObject>).toDart;
    var total = 0;
    for (final o in all) {
      total += _i(o, 'size');
    }
    all.sort((a, b) => _i(a, 'at').compareTo(_i(b, 'at')));
    for (final o in all) {
      if (total <= blobCap) break;
      final oid = _s(o, 'id');
      if (oid == id || oid.startsWith(uploadBlobPrefix)) continue;
      total -= _i(o, 'size');
      store.delete(oid.toJS);
    }
    await done;
  }

  @override
  Future<void> deleteBlob(String id) async {
    final db = await _db;
    final tx = db.transaction(_blobs.toJS, 'readwrite');
    final done = _done(tx);
    tx.objectStore(_blobs).delete(id.toJS);
    await done;
  }

  @override
  Future<void> wipe() async {
    if (_box == null) return;
    final old = _dbFuture;
    _dbFuture = null;
    if (old != null) (await old).close();
    final c = Completer<void>();
    final req = web.window.indexedDB.deleteDatabase(_name);
    req.onsuccess = ((web.Event _) => c.complete()).toJS;
    req.onerror = ((web.Event _) => c.completeError(
      StateError('IndexedDB gagal'),
    )).toJS;
    req.onblocked = ((web.Event _) => c.complete()).toJS;
    await c.future;
  }

  @override
  Future<int> bytes() async {
    if (_box == null) return 0;
    final db = await _db;
    final tx = db.transaction(
      [_docs.toJS, _meta.toJS, _blobs.toJS].toJS,
      'readonly',
    );
    var n = 0;
    final docs = await _result(tx.objectStore(_docs).getAll());
    for (final o in (docs as JSArray<JSObject>).toDart) {
      n += utf8.encode(_s(o, 'json')).length;
    }
    final metas = await _result(tx.objectStore(_meta).getAll());
    for (final o in (metas as JSArray<JSObject>).toDart) {
      n += _s(o, 'key').length + _s(o, 'value').length;
    }
    final blobs = await _result(tx.objectStore(_blobs).getAll());
    for (final o in (blobs as JSArray<JSObject>).toDart) {
      n += _i(o, 'size');
    }
    return n;
  }
}
