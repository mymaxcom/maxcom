// The platform removers of the recording clean-up (Plan 6 Task 13). Each can
// delete only what the app itself recorded, and only by the names the
// clean-up registered at the end of a live. No address ever crosses the
// channel or is stored.
//
//  * Android: only the names the live engine reported for that very session
//    (`SessionFiles`) are looked at, never a scan by prefix or date. The Kotlin
//    `RecordingGuard` accepts a name only when it is
//    `MAXCOM-<date>-<HHmm>-<label>-<nn>.mp4`, and a MediaStore row only when it sits
//    in `Movies/MAXCOM` and is owned by this app's package; the app's own
//    pending copies in `files/Movies/MAXCOM` go the same way.
//  * Web: the IndexedDB segments of that one session.

import 'package:flutter/services.dart';

import '../features/live/recordings_store.dart';
import 'recording_cleanup.dart';
import 'session_files.dart';


/// The removers for [platform] (`android`, `web`, `ios-web`); null elsewhere.
RecordingRemover? recordingRemoverFor(
  String platform,
  RecordingsStore? recordings, {
  SessionFiles? sessionFiles,
}) {
  if (platform == 'android') {
    return AndroidRecordingRemover(sessionFiles: sessionFiles);
  }
  if ((platform == 'web' || platform == 'ios-web') && recordings != null) {
    return WebRecordingRemover(recordings);
  }
  return null;
}

class WebRecordingRemover implements RecordingRemover {
  WebRecordingRemover(this.store);

  final RecordingsStore store;

  @override
  Future<RecordingFootprint?> footprint(
    String sessionId,
    String? kuliahId,
  ) async {
    final l = await store.forSession(sessionId);
    if (l.isEmpty) return null;
    return RecordingFootprint(
      names: [for (final s in l) s.id],
      sizes: [for (final s in l) s.bytes],
      bytes: l.fold(0, (a, s) => a + s.bytes),
    );
  }

  @override
  Future<RemoveResult> remove(String sessionId, RecordingFootprint fp) async {
    // only ids that belong to this session, whatever the footprint says
    final own = {for (final s in await store.forSession(sessionId)) s.id: s};
    var deleted = 0;
    var bytes = 0;
    for (final n in fp.names) {
      final seg = own[n];
      if (seg == null) continue;
      await store.delete(seg.id);
      deleted++;
      bytes += seg.bytes;
    }
    return RemoveResult(deleted: deleted, skipped: 0, bytes: bytes);
  }
}

class AndroidRecordingRemover implements RecordingRemover {
  AndroidRecordingRemover({MethodChannel? channel, this.sessionFiles})
    : _channel = channel ?? const MethodChannel('my.maxcom/upload');

  final MethodChannel _channel;

  /// The names the live engine reported for each session. A session with no
  /// stored names has no footprint: nothing of it is ever deleted.
  final SessionFiles? sessionFiles;

  @override
  Future<RecordingFootprint?> footprint(
    String sessionId,
    String? kuliahId,
  ) async {
    final asked = await sessionFiles?.names(sessionId) ?? const <String>[];
    if (asked.isEmpty) return null;
    final List<dynamic> raw;
    try {
      raw =
          await _channel.invokeMethod<List<dynamic>>('findSegments', {
            'names': asked,
          }) ??
          const [];
    } on PlatformException {
      return null;
    } on MissingPluginException {
      return null;
    }
    // Exactly the asked names, in the order they were written, whatever the
    // device answered.
    final found = <String, int>{
      for (final e in raw)
        if (e is Map &&
            e['name'] is String &&
            asked.contains(e['name']) &&
            isRecordingName(e['name'] as String))
          e['name'] as String: (e['bytes'] as num? ?? 0).toInt(),
    };
    final names = [
      for (final n in asked)
        if (found.containsKey(n)) n,
    ];
    if (names.isEmpty) return null;
    return RecordingFootprint(
      names: names,
      sizes: [for (final n in names) found[n]!],
      bytes: names.fold(0, (a, n) => a + found[n]!),
    );
  }

  @override
  Future<RemoveResult> remove(String sessionId, RecordingFootprint fp) async {
    final names = [
      for (final n in fp.names)
        if (isRecordingName(n)) n,
    ];
    if (names.isEmpty) return const RemoveResult(deleted: 0, skipped: 0, bytes: 0);
    try {
      final out = await _channel.invokeMapMethod<String, dynamic>(
        'deleteRecordings',
        {'names': names},
      );
      return RemoveResult(
        deleted: (out?['deleted'] as num? ?? 0).toInt(),
        skipped: (out?['skipped'] as num? ?? 0).toInt(),
        bytes: (out?['bytes'] as num? ?? 0).toInt(),
      );
    } on PlatformException {
      return RemoveResult(deleted: 0, skipped: names.length, bytes: 0);
    } on MissingPluginException {
      return RemoveResult(deleted: 0, skipped: names.length, bytes: 0);
    }
  }
}
