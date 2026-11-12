// Where the iPad (browser) publisher keeps its recording while it is live
// (Plan 5 Task 9). The browser cannot write to a folder, so each recorded
// segment lives in IndexedDB until the person saves it with one tap per
// file (a Safari limit the operator accepted, spec 6.3). Nothing here
// deletes by itself: a segment goes only after [RecordingsStore.delete], which
// only the person (after confirming) or the verified clean-up of that one
// session (`WebRecordingRemover`, Plan 6 Task 13) ever calls.
//
// While a segment is being recorded its chunks are written as small
// "parts"; [RecordingsStore.finishSegment] joins them into one file. If the
// tab dies mid-segment the parts stay, and [RecordingsStore.pending] joins
// them at the next open, so a crash still leaves a playable file.
//
// This file holds the platform-neutral contract and an in-memory store (the
// stub, and tests); the IndexedDB store is `recordings_store_web.dart`.

import 'dart:async';

import 'recordings_store_stub.dart'
    if (dart.library.js_interop) 'recordings_store_web.dart'
    as impl;

/// One recorded file (a segment of a session).
class SegmentInfo {
  const SegmentInfo({
    required this.id,
    required this.sessionId,
    required this.index,
    required this.mime,
    required this.bytes,
    required this.createdAt,
    required this.label,
    this.saved = false,
  });

  final String id;
  final String sessionId;
  final int index;
  final String mime;
  final int bytes;
  final DateTime createdAt;

  /// Short label for the file name (the kuliah id or `siaran`).
  final String label;
  final bool saved;

  /// `MAXCOM-2026-11-05-<label>-<index>.mp4` (`.webm` when the browser
  /// recorded webm).
  String get fileName {
    final d = createdAt.toLocal();
    String two(int n) => n.toString().padLeft(2, '0');
    final date = '${d.year}-${two(d.month)}-${two(d.day)}';
    final ext = mime.contains('mp4') ? 'mp4' : 'webm';
    return 'MAXCOM-$date-${safeLabel(label)}-$index.$ext';
  }

  @override
  String toString() => 'SegmentInfo($id, $bytes bytes, saved: $saved)';
}

/// A label that is safe in a file name.
String safeLabel(String? raw) {
  var s = (raw ?? '').replaceAll(RegExp(r'[^A-Za-z0-9]+'), '-');
  s = s.replaceAll(RegExp(r'^-+|-+$'), '');
  if (s.isEmpty) return 'siaran';
  return s.length > 30 ? s.substring(0, 30) : s;
}

abstract class RecordingsStore {
  /// Adds one chunk of the segment being recorded. [chunk] is a browser
  /// `Blob` on the web store (any object in the in-memory one).
  Future<void> appendPart({
    required String sessionId,
    required int index,
    required String mime,
    required String label,
    required Object chunk,
    required int size,
  });

  /// Joins the parts of a segment into one file and returns it; null when
  /// the segment had no data.
  Future<SegmentInfo?> finishSegment(String sessionId, int index);

  /// Files not yet saved by the person, oldest first. Joins the parts of
  /// segments a crash left unfinished (except one being recorded now).
  Future<List<SegmentInfo>> pending();

  /// Every file of one session (saved or not), in order.
  Future<List<SegmentInfo>> forSession(String sessionId);

  /// Hands the file to the browser as a download (one tap each).
  Future<void> save(String id);

  Future<void> markSaved(String id);

  /// Removes one file. Only ever called after the person confirms, or by the
  /// clean-up once YouTube has verified that session (Plan 6 Task 13).
  Future<void> delete(String id);
}

/// A store that keeps everything in memory: the VM stub and the tests.
class MemoryRecordingsStore implements RecordingsStore {
  MemoryRecordingsStore({this.onSave});

  /// Called by [save] with the file name and the chunk list.
  final void Function(String fileName, List<Object> chunks)? onSave;

  final Map<String, _MemSeg> _segs = {};
  final Map<String, _MemParts> _parts = {};
  final Set<String> _active = {};

  static String idOf(String sessionId, int index) => '$sessionId-$index';

  @override
  Future<void> appendPart({
    required String sessionId,
    required int index,
    required String mime,
    required String label,
    required Object chunk,
    required int size,
  }) async {
    final id = idOf(sessionId, index);
    _active.add(id);
    final p = _parts.putIfAbsent(
      id,
      () => _MemParts(sessionId, index, mime, label, DateTime.now()),
    );
    p.chunks.add(chunk);
    p.bytes += size;
  }

  SegmentInfo _join(_MemParts p) {
    final id = idOf(p.sessionId, p.index);
    final s = _MemSeg(
      SegmentInfo(
        id: id,
        sessionId: p.sessionId,
        index: p.index,
        mime: p.mime,
        bytes: p.bytes,
        createdAt: p.createdAt,
        label: p.label,
      ),
      List.of(p.chunks),
    );
    _segs[id] = s;
    _parts.remove(id);
    return s.info;
  }

  @override
  Future<SegmentInfo?> finishSegment(String sessionId, int index) async {
    final id = idOf(sessionId, index);
    _active.remove(id);
    final p = _parts[id];
    return p == null ? null : _join(p);
  }

  @override
  Future<List<SegmentInfo>> pending() async {
    for (final id in _parts.keys.toList()) {
      if (!_active.contains(id)) _join(_parts[id]!);
    }
    final l = _segs.values.map((s) => s.info).where((i) => !i.saved).toList()
      ..sort(_byTime);
    return l;
  }

  @override
  Future<List<SegmentInfo>> forSession(String sessionId) async {
    final l =
        _segs.values
            .map((s) => s.info)
            .where((i) => i.sessionId == sessionId)
            .toList()
          ..sort((a, b) => a.index.compareTo(b.index));
    return l;
  }

  static int _byTime(SegmentInfo a, SegmentInfo b) {
    final c = a.createdAt.compareTo(b.createdAt);
    return c != 0 ? c : a.index.compareTo(b.index);
  }

  @override
  Future<void> save(String id) async {
    final s = _segs[id];
    if (s != null) onSave?.call(s.info.fileName, s.chunks);
  }

  @override
  Future<void> markSaved(String id) async {
    final s = _segs[id];
    if (s == null) return;
    final i = s.info;
    _segs[id] = _MemSeg(
      SegmentInfo(
        id: i.id,
        sessionId: i.sessionId,
        index: i.index,
        mime: i.mime,
        bytes: i.bytes,
        createdAt: i.createdAt,
        label: i.label,
        saved: true,
      ),
      s.chunks,
    );
  }

  @override
  Future<void> delete(String id) async {
    _segs.remove(id);
    _parts.remove(id);
    _active.remove(id);
  }
}

class _MemSeg {
  _MemSeg(this.info, this.chunks);
  final SegmentInfo info;
  final List<Object> chunks;
}

class _MemParts {
  _MemParts(this.sessionId, this.index, this.mime, this.label, this.createdAt);
  final String sessionId;
  final int index;
  final String mime;
  final String label;
  final DateTime createdAt;
  final List<Object> chunks = [];
  int bytes = 0;
}

/// The recordings store of this platform: IndexedDB in the browser, memory
/// elsewhere. [downloader] replaces the browser download (tests).
RecordingsStore openRecordingsStore({
  String dbName = 'maxcom-recordings',
  Future<void> Function(String fileName, Object blob)? downloader,
}) => impl.openStore(dbName: dbName, downloader: downloader);
