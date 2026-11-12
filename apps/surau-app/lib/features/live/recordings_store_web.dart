// The browser store behind the iPad publisher's recording (Plan 5 Task 9):
// IndexedDB `maxcom-recordings`, store `segments` holds the finished files
// `{ id, sessionId, index, mime, bytes, createdAt, label, saved, blob }`,
// store `parts` holds the chunks of a segment still being recorded. A
// crash leaves the parts; [pending] joins them. Blobs are kept as browser
// Blobs, never read into Dart memory.

import 'dart:async';
import 'dart:js_interop';
import 'dart:js_interop_unsafe';

import 'package:web/web.dart' as web;

import 'recordings_store.dart';

RecordingsStore openStore({
  required String dbName,
  Future<void> Function(String fileName, Object blob)? downloader,
}) => IndexedDbRecordingsStore(
  dbName: dbName,
  downloader: downloader ?? anchorDownload,
);

const String _segments = 'segments';
const String _parts = 'parts';

class IndexedDbRecordingsStore implements RecordingsStore {
  IndexedDbRecordingsStore({required this.dbName, required this.downloader});

  final String dbName;
  final Future<void> Function(String fileName, Object blob) downloader;

  Future<web.IDBDatabase>? _dbFuture;
  final Map<String, int> _nextPart = {};
  final Set<String> _active = {};

  Future<web.IDBDatabase> get _db => _dbFuture ??= _open();

  Future<web.IDBDatabase> _open() {
    final c = Completer<web.IDBDatabase>();
    final req = web.window.indexedDB.open(dbName, 1);
    req.onupgradeneeded = ((web.Event _) {
      final db = req.result as web.IDBDatabase;
      db.createObjectStore(
        _segments,
        web.IDBObjectStoreParameters(keyPath: 'id'.toJS),
      );
      db.createObjectStore(
        _parts,
        web.IDBObjectStoreParameters(keyPath: 'key'.toJS),
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
      _dbFuture = null; // try again next time
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

  static String _segId(String sessionId, int index) => '$sessionId-$index';

  static web.IDBKeyRange _partRange(String segId) =>
      web.IDBKeyRange.bound('$segId#'.toJS, '$segId#￿'.toJS);

  static String _s(JSObject o, String k) => (o[k] as JSString?)?.toDart ?? '';

  static int _i(JSObject o, String k) => (o[k] as JSNumber?)?.toDartInt ?? 0;

  static SegmentInfo _info(JSObject o) => SegmentInfo(
    id: _s(o, 'id'),
    sessionId: _s(o, 'sessionId'),
    index: _i(o, 'index'),
    mime: _s(o, 'mime'),
    bytes: _i(o, 'bytes'),
    createdAt: DateTime.fromMillisecondsSinceEpoch(_i(o, 'createdAt')),
    label: _s(o, 'label'),
    saved: (o['saved'] as JSBoolean?)?.toDart ?? false,
  );

  @override
  Future<void> appendPart({
    required String sessionId,
    required int index,
    required String mime,
    required String label,
    required Object chunk,
    required int size,
  }) async {
    final db = await _db;
    final seg = _segId(sessionId, index);
    _active.add(seg);
    final n = _nextPart[seg] ?? 0;
    _nextPart[seg] = n + 1;
    final tx = db.transaction(_parts.toJS, 'readwrite');
    final done = _done(tx);
    tx
        .objectStore(_parts)
        .put(
          _record({
            'key': '$seg#${n.toString().padLeft(6, '0')}'.toJS,
            'seg': seg.toJS,
            'sessionId': sessionId.toJS,
            'index': index.toJS,
            'mime': mime.toJS,
            'label': label.toJS,
            'size': size.toJS,
            'createdAt': DateTime.now().millisecondsSinceEpoch.toJS,
            'blob': chunk as JSAny,
          }),
        );
    await done;
  }

  Future<List<JSObject>> _partsOf(web.IDBDatabase db, String seg) async {
    final tx = db.transaction(_parts.toJS, 'readonly');
    final r = await _result(tx.objectStore(_parts).getAll(_partRange(seg)));
    return (r as JSArray<JSObject>).toDart;
  }

  /// Joins [parts] (in key order) into a finished segment and drops them.
  Future<SegmentInfo> _join(
    web.IDBDatabase db,
    String seg,
    List<JSObject> parts,
  ) async {
    final first = parts.first;
    final mime = _s(first, 'mime');
    var bytes = 0;
    final blobs = <JSAny>[];
    for (final p in parts) {
      bytes += _i(p, 'size');
      blobs.add(p['blob']!);
    }
    final blob = web.Blob(blobs.toJS, web.BlobPropertyBag(type: mime));
    final rec = _record({
      'id': seg.toJS,
      'sessionId': _s(first, 'sessionId').toJS,
      'index': _i(first, 'index').toJS,
      'mime': mime.toJS,
      'bytes': (blob.size > 0 ? blob.size.toInt() : bytes).toJS,
      'createdAt': _i(first, 'createdAt').toJS,
      'label': _s(first, 'label').toJS,
      'saved': false.toJS,
      'blob': blob,
    });
    final tx = db.transaction([_segments.toJS, _parts.toJS].toJS, 'readwrite');
    final done = _done(tx);
    tx.objectStore(_segments).put(rec);
    tx.objectStore(_parts).delete(_partRange(seg));
    await done;
    _nextPart.remove(seg);
    return _info(rec);
  }

  @override
  Future<SegmentInfo?> finishSegment(String sessionId, int index) async {
    final db = await _db;
    final seg = _segId(sessionId, index);
    final parts = await _partsOf(db, seg);
    _active.remove(seg);
    if (parts.isEmpty) return null;
    return _join(db, seg, parts);
  }

  Future<void> _recoverOrphans(web.IDBDatabase db) async {
    final tx = db.transaction(_parts.toJS, 'readonly');
    final all = (await _result(
      tx.objectStore(_parts).getAll(),
    ) as JSArray<JSObject>).toDart;
    final groups = <String, List<JSObject>>{};
    for (final p in all) {
      groups.putIfAbsent(_s(p, 'seg'), () => []).add(p);
    }
    for (final e in groups.entries) {
      if (_active.contains(e.key)) continue;
      await _join(db, e.key, e.value);
    }
  }

  Future<List<SegmentInfo>> _allSegments(web.IDBDatabase db) async {
    final tx = db.transaction(_segments.toJS, 'readonly');
    final r = await _result(tx.objectStore(_segments).getAll());
    return (r as JSArray<JSObject>).toDart.map(_info).toList();
  }

  @override
  Future<List<SegmentInfo>> pending() async {
    final db = await _db;
    await _recoverOrphans(db);
    final l = (await _allSegments(db)).where((i) => !i.saved).toList()
      ..sort((a, b) {
        final c = a.createdAt.compareTo(b.createdAt);
        return c != 0 ? c : a.index.compareTo(b.index);
      });
    return l;
  }

  @override
  Future<List<SegmentInfo>> forSession(String sessionId) async {
    final db = await _db;
    final l =
        (await _allSegments(db)).where((i) => i.sessionId == sessionId).toList()
          ..sort((a, b) => a.index.compareTo(b.index));
    return l;
  }

  Future<JSObject?> _get(web.IDBDatabase db, String id) async {
    final tx = db.transaction(_segments.toJS, 'readonly');
    final r = await _result(tx.objectStore(_segments).get(id.toJS));
    return r == null || r.isUndefinedOrNull ? null : r as JSObject;
  }

  @override
  Future<void> save(String id) async {
    final db = await _db;
    final rec = await _get(db, id);
    if (rec == null) return;
    await downloader(_info(rec).fileName, rec['blob']!);
  }

  @override
  Future<void> markSaved(String id) async {
    final db = await _db;
    final rec = await _get(db, id);
    if (rec == null) return;
    rec['saved'] = true.toJS;
    final tx = db.transaction(_segments.toJS, 'readwrite');
    final done = _done(tx);
    tx.objectStore(_segments).put(rec);
    await done;
  }

  @override
  Future<void> delete(String id) async {
    final db = await _db;
    final tx = db.transaction([_segments.toJS, _parts.toJS].toJS, 'readwrite');
    final done = _done(tx);
    tx.objectStore(_segments).delete(id.toJS);
    tx.objectStore(_parts).delete(_partRange(id));
    await done;
    _active.remove(id);
    _nextPart.remove(id);
  }
}

/// One tap, one file: an `<a download>` over an object URL.
Future<void> anchorDownload(String fileName, Object blob) async {
  final url = web.URL.createObjectURL(blob as web.Blob);
  final a = web.document.createElement('a') as web.HTMLAnchorElement
    ..href = url
    ..download = fileName
    ..style.display = 'none';
  web.document.body!.append(a);
  a.click();
  a.remove();
  Timer(const Duration(seconds: 60), () => web.URL.revokeObjectURL(url));
}
