// Android local store (Plan 6 Task 7): one sealed file per collection under
// `<root>/maxcom/<boxId>/<collection>.bin`, blobs under `blobs/<id>.bin`.
// Every file is `LocalSeal.seal(bytes)` from `LocalSeal.kt`: AES-256-GCM with
// a Keystore key `maxcom-local-<boxId>`, file = IV || ciphertext || tag.
// Writes go to `<file>.tmp` and are then renamed, so a crash never leaves a
// half file under the real name. A file that cannot be opened (tampered, or
// the key is gone after a device reset) reads as empty and sets
// `meta.needsSnapshot = '1'` so the next sync pulls a fresh snapshot. The one
// exception is the outbox (queued edits): its unreadable file is renamed
// `outbox.bin.unreadable-<ms>` and `meta.outboxUnreadable` tells the engine.
//
// Each sealed file starts (inside the GCM-authenticated plain text) with a
// context header `MXB1 | len | "<boxId>|<name>"`, so a file copied to another
// name or box fails to open, which is what AES-GCM associated data would give.
// A file sealed before the header existed still opens and gets one on its
// next write.

import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:flutter/services.dart';

import '../box/device_key_android.dart' show keystoreChannelName;
import 'local_store.dart';

/// Seals and opens bytes with the per-box key. Kotlin in the app, a fake in
/// tests.
abstract class LocalSealer {
  Future<Uint8List> seal(String boxId, Uint8List plain);

  /// Throws when the bytes were changed or the key is gone.
  Future<Uint8List> open(String boxId, Uint8List sealed);

  /// Deletes the Keystore key of [boxId].
  Future<void> reset(String boxId);
}

/// [LocalSealer] over `KeystoreChannel.kt` (`localSeal`, `localOpen`,
/// `localKeyReset`, and `localDir` for the folder to keep files in).
class ChannelLocalSealer implements LocalSealer {
  ChannelLocalSealer({MethodChannel? channel})
    : _ch = channel ?? const MethodChannel(keystoreChannelName);

  final MethodChannel _ch;

  @override
  Future<Uint8List> seal(String boxId, Uint8List plain) async {
    final r = await _ch.invokeMethod<Uint8List>('localSeal', {
      'box': boxId,
      'bytes': plain,
    });
    if (r == null) throw StateError('Simpanan peranti tidak tersedia');
    return r;
  }

  @override
  Future<Uint8List> open(String boxId, Uint8List sealed) async {
    final r = await _ch.invokeMethod<Uint8List>('localOpen', {
      'box': boxId,
      'bytes': sealed,
    });
    if (r == null) throw StateError('Simpanan peranti tidak tersedia');
    return r;
  }

  @override
  Future<void> reset(String boxId) async {
    await _ch.invokeMethod<void>('localKeyReset', {'box': boxId});
  }

  /// The app's private files folder (never backed up).
  Future<Directory> rootDir() async {
    final p = await _ch.invokeMethod<String>('localDir');
    if (p == null || p.isEmpty) throw StateError('Folder simpanan tiada');
    return Directory(p);
  }
}

final List<int> _ctxMagic = utf8.encode('MXB1');

class LocalStoreAndroid implements LocalStore {
  LocalStoreAndroid({
    required this.root,
    required this.sealer,
    this.blobCap = defaultBlobCapBytes,
  });

  /// Folder that gets a `maxcom/<boxId>` child.
  final Directory root;
  final LocalSealer sealer;
  final int blobCap;

  String? _box;
  Future<void> _tail = Future<void>.value();
  final Map<String, Map<String, Map<String, dynamic>>> _cache = {};
  Map<String, String>? _meta;

  String get _boxId {
    final b = _box;
    if (b == null) throw StateError('open() first');
    return b;
  }

  Directory get _dir => Directory('${root.path}/maxcom/$_boxId');

  /// Runs [body] after every earlier operation (files are rewritten whole).
  Future<T> _locked<T>(Future<T> Function() body) {
    final c = Completer<T>();
    _tail = _tail.then((_) async {
      try {
        c.complete(await body());
      } catch (e, s) {
        c.completeError(e, s);
      }
    });
    return c.future;
  }

  /// A file-name-safe form of [name]: letters, digits, `-` and `_` stay,
  /// anything else becomes `~xx` (hex).
  static String safeName(String name) {
    final b = StringBuffer();
    for (final u in utf8.encode(name)) {
      final c = String.fromCharCode(u);
      if (RegExp(r'[A-Za-z0-9_-]').hasMatch(c)) {
        b.write(c);
      } else {
        b.write('~${u.toRadixString(16).padLeft(2, '0')}');
      }
    }
    return b.toString();
  }

  File _file(String collection) =>
      File('${_dir.path}/${safeName(collection)}.bin');
  File get _metaFile => File('${_dir.path}/_meta.bin');
  File _blobFile(String id) => File('${_dir.path}/blobs/${safeName(id)}.bin');

  Uint8List _wrap(String name, Uint8List plain) {
    final ctx = utf8.encode('$_boxId|$name');
    final out = BytesBuilder(copy: false)
      ..add(_ctxMagic)
      ..add([(ctx.length >> 8) & 0xff, ctx.length & 0xff])
      ..add(ctx)
      ..add(plain);
    return out.toBytes();
  }

  /// Strips the header and checks it names [name] in this box; bytes with no
  /// header are an older file and pass through.
  Uint8List _unwrap(String name, Uint8List b) {
    if (b.length < 6 || !_hasMagic(b)) return b;
    final n = (b[4] << 8) | b[5];
    if (b.length < 6 + n) throw StateError('context');
    final got = utf8.decode(b.sublist(6, 6 + n), allowMalformed: true);
    if (got != '$_boxId|$name') throw StateError('context');
    return Uint8List.sublistView(b, 6 + n);
  }

  static bool _hasMagic(Uint8List b) {
    for (var i = 0; i < _ctxMagic.length; i++) {
      if (b[i] != _ctxMagic[i]) return false;
    }
    return true;
  }

  Future<void> _writeSealed(File f, String name, Uint8List plain) async {
    final sealed = await sealer.seal(_boxId, _wrap(name, plain));
    await f.parent.create(recursive: true);
    final tmp = File('${f.path}.tmp');
    await tmp.writeAsBytes(sealed, flush: true);
    await tmp.rename(f.path);
  }

  /// The plain bytes of [f]; null when absent. Throws when unreadable.
  Future<Uint8List?> _readSealed(File f, String name) async {
    if (!await f.exists()) return null;
    return _unwrap(name, await sealer.open(_boxId, await f.readAsBytes()));
  }

  Future<void> _markNeedsSnapshot() async {
    final m = _meta ??= {};
    m[metaNeedsSnapshot] = '1';
    await _saveMeta();
  }

  Future<void> _saveMeta() => _writeSealed(
    _metaFile,
    'meta',
    Uint8List.fromList(utf8.encode(jsonEncode(_meta))),
  );

  Future<Map<String, String>> _loadMeta() async {
    final cached = _meta;
    if (cached != null) return cached;
    try {
      final b = await _readSealed(_metaFile, 'meta');
      if (b == null) return _meta = {};
      final j = jsonDecode(utf8.decode(b)) as Map<String, dynamic>;
      return _meta = {for (final e in j.entries) e.key: e.value as String};
    } catch (_) {
      _meta = {};
      await _markNeedsSnapshot();
      return _meta!;
    }
  }

  Future<Map<String, Map<String, dynamic>>> _load(String collection) async {
    final cached = _cache[collection];
    if (cached != null) return cached;
    await _loadMeta();
    try {
      final b = await _readSealed(_file(collection), 'c:$collection');
      if (b == null) return _cache[collection] = {};
      final j = jsonDecode(utf8.decode(b)) as Map<String, dynamic>;
      return _cache[collection] = {
        for (final e in j.entries) e.key: e.value as Map<String, dynamic>,
      };
    } catch (_) {
      _cache[collection] = {};
      if (collection == Collections.outbox) await _setAsideOutbox();
      await _markNeedsSnapshot();
      return _cache[collection]!;
    }
  }

  /// Keeps an unreadable outbox file (never silently replaced) and tells the
  /// engine that queued edits could not be read.
  Future<void> _setAsideOutbox() async {
    final f = _file(Collections.outbox);
    final now = DateTime.now().toUtc();
    try {
      if (await f.exists()) {
        await f.rename('${f.path}.unreadable-${now.millisecondsSinceEpoch}');
      }
    } catch (_) {
      // Could not move it: it stays, and the next write replaces it.
    }
    (_meta ??= {})[metaOutboxUnreadable] = now.toIso8601String();
  }

  Future<void> _save(String collection) => _writeSealed(
    _file(collection),
    'c:$collection',
    Uint8List.fromList(utf8.encode(jsonEncode(_cache[collection]))),
  );

  @override
  Future<void> open(String boxId) => _locked(() async {
    if (!isValidBoxId(boxId)) throw ArgumentError('box id');
    if (_box != boxId) {
      _cache.clear();
      _meta = null;
    }
    _box = boxId;
    await _dir.create(recursive: true);
  });

  @override
  Future<Map<String, dynamic>?> getDoc(String collection, String id) =>
      _locked(() async {
        final d = (await _load(collection))[id];
        return d == null ? null : copyDoc(d);
      });

  @override
  Future<List<Map<String, dynamic>>> list(String collection) => _locked(
    () async => [for (final d in (await _load(collection)).values) copyDoc(d)],
  );

  @override
  Future<void> putDoc(String collection, String id, Map<String, dynamic> doc) =>
      _locked(() async {
        (await _load(collection))[id] = copyDoc(doc);
        await _save(collection);
      });

  @override
  Future<void> deleteDoc(String collection, String id) => _locked(() async {
    final c = await _load(collection);
    if (c.remove(id) != null) await _save(collection);
  });

  @override
  Future<void> applyDocs(
    String collection, {
    Map<String, Map<String, dynamic>> puts = const {},
    Set<String> deletes = const {},
  }) => _locked(() async {
    final c = await _load(collection);
    var dirty = false;
    for (final id in deletes) {
      if (c.remove(id) != null) dirty = true;
    }
    for (final e in puts.entries) {
      c[e.key] = copyDoc(e.value);
      dirty = true;
    }
    if (dirty) await _save(collection);
  });

  @override
  Future<void> putAll(
    String collection,
    Map<String, Map<String, dynamic>> docs,
  ) => _locked(() async {
    await _loadMeta();
    _cache[collection] = {
      for (final e in docs.entries) e.key: copyDoc(e.value),
    };
    await _save(collection);
  });

  @override
  Future<Map<String, String>> meta() =>
      _locked(() async => Map.of(await _loadMeta()));

  @override
  Future<void> setMeta(String key, String? value) => _locked(() async {
    final m = await _loadMeta();
    if (value == null) {
      m.remove(key);
    } else {
      m[key] = value;
    }
    await _saveMeta();
  });

  @override
  Future<Uint8List?> getBlob(String id) => _locked(() async {
    await _loadMeta();
    try {
      return await _readSealed(_blobFile(id), 'b:$id');
    } catch (_) {
      await _markNeedsSnapshot();
      return null;
    }
  });

  @override
  Future<void> putBlob(String id, Uint8List bytes) => _locked(() async {
    await _writeSealed(_blobFile(id), 'b:$id', bytes);
    await _evict(keep: _blobFile(id).path);
  });

  /// Deletes the oldest asset blobs (never queued uploads, never [keep])
  /// until the blobs fit in [blobCap].
  Future<void> _evict({required String keep}) async {
    final dir = Directory('${_dir.path}/blobs');
    if (!await dir.exists()) return;
    final files = <File, FileStat>{};
    var total = 0;
    await for (final e in dir.list()) {
      if (e is! File || e.path.endsWith('.tmp')) continue;
      final st = await e.stat();
      files[e] = st;
      total += st.size;
    }
    if (total <= blobCap) return;
    final order = files.keys.toList()
      ..sort((a, b) {
        final c = files[a]!.modified.compareTo(files[b]!.modified);
        return c != 0 ? c : a.path.compareTo(b.path);
      });
    for (final f in order) {
      if (total <= blobCap) break;
      final name = f.uri.pathSegments.last;
      if (f.path == keep || name.startsWith(uploadBlobPrefix)) continue;
      total -= files[f]!.size;
      await f.delete();
    }
  }

  @override
  Future<void> deleteBlob(String id) => _locked(() async {
    final f = _blobFile(id);
    if (await f.exists()) await f.delete();
  });

  @override
  Future<void> wipe() => _locked(() async {
    final box = _box;
    if (box == null) return;
    _cache.clear();
    _meta = null;
    if (await _dir.exists()) await _dir.delete(recursive: true);
    await sealer.reset(box);
  });

  @override
  Future<int> bytes() => _locked(() async {
    if (_box == null || !await _dir.exists()) return 0;
    var n = 0;
    await for (final e in _dir.list(recursive: true)) {
      if (e is File) n += await e.length();
    }
    return n;
  });
}

/// Called from `deps.dart`.
LocalStore androidLocalStore() {
  final sealer = ChannelLocalSealer();
  return _LazyRootStore(sealer);
}

/// Finds the files folder through the channel on first use.
class _LazyRootStore implements LocalStore {
  _LazyRootStore(this._sealer);

  final ChannelLocalSealer _sealer;
  LocalStoreAndroid? _inner;

  Future<LocalStoreAndroid> _get() async => _inner ??= LocalStoreAndroid(
    root: await _sealer.rootDir(),
    sealer: _sealer,
  );

  @override
  Future<void> open(String boxId) async => (await _get()).open(boxId);
  @override
  Future<Map<String, dynamic>?> getDoc(String c, String id) async =>
      (await _get()).getDoc(c, id);
  @override
  Future<List<Map<String, dynamic>>> list(String c) async =>
      (await _get()).list(c);
  @override
  Future<void> putDoc(String c, String id, Map<String, dynamic> doc) async =>
      (await _get()).putDoc(c, id, doc);
  @override
  Future<void> deleteDoc(String c, String id) async =>
      (await _get()).deleteDoc(c, id);
  @override
  Future<void> putAll(String c, Map<String, Map<String, dynamic>> d) async =>
      (await _get()).putAll(c, d);
  @override
  Future<void> applyDocs(
    String c, {
    Map<String, Map<String, dynamic>> puts = const {},
    Set<String> deletes = const {},
  }) async => (await _get()).applyDocs(c, puts: puts, deletes: deletes);
  @override
  Future<Map<String, String>> meta() async => (await _get()).meta();
  @override
  Future<void> setMeta(String k, String? v) async =>
      (await _get()).setMeta(k, v);
  @override
  Future<Uint8List?> getBlob(String id) async => (await _get()).getBlob(id);
  @override
  Future<void> putBlob(String id, Uint8List b) async =>
      (await _get()).putBlob(id, b);
  @override
  Future<void> deleteBlob(String id) async => (await _get()).deleteBlob(id);
  @override
  Future<void> wipe() async => (await _get()).wipe();
  @override
  Future<int> bytes() async => (await _get()).bytes();
}
