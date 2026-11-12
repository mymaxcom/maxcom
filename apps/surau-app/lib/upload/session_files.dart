// The exact recording files of each live session (Plan 6 gate 2, Q-H1/Q-M1).
//
// On Android the live engine reports the names it wrote (naming scheme 2,
// `MAXCOM-<date>-<HHmm>-<prefix>-<nn>.mp4`) when a live ends. They are stored
// here, by session id, and are the ONLY way the clean-up and the catch-up
// upload find a recording: never a scan by prefix or date. No names stored
// for a session means no footprint, no automatic upload and no deletion.
//
// Names only: no address, no path, no token.

import '../store/local_store.dart';

final RegExp _recordingName = RegExp(
  r'^MAXCOM-\d{4}-\d{2}-\d{2}-([01]\d|2[0-3])[0-5]\d-[A-Za-z0-9_-]{1,40}-\d{1,4}\.mp4$',
);

/// True only for a name the recorder writes (scheme 2). The older scheme
/// (no HHmm), a "name (1).mp4" copy, a path or any other file never passes.
bool isRecordingName(String name) => _recordingName.hasMatch(name);

class SessionFiles {
  SessionFiles(this.store);

  final LocalStore store;

  static String _id(String sessionId) {
    final s = sessionId.replaceAll(RegExp(r'[^A-Za-z0-9_-]'), '-');
    return s.isEmpty ? 'session' : (s.length > 100 ? s.substring(0, 100) : s);
  }

  /// Stores the valid, distinct [names] of [sessionId], in order. Nothing is
  /// written when none is valid (an earlier answer is never wiped).
  Future<void> save(String sessionId, List<String> names) async {
    final ok = <String>[];
    for (final n in names) {
      if (isRecordingName(n) && !ok.contains(n)) ok.add(n);
    }
    if (ok.isEmpty) return;
    await store.putDoc(Collections.sessionFiles, _id(sessionId), {
      'sessionId': sessionId,
      'names': ok,
    });
  }

  /// The stored names of [sessionId], valid ones only; empty when unknown.
  Future<List<String>> names(String sessionId) async {
    final d = await store.getDoc(Collections.sessionFiles, _id(sessionId));
    if (d == null || d['sessionId'] != sessionId) return const [];
    final out = <String>[];
    for (final n in (d['names'] as List? ?? const [])) {
      if (n is String && isRecordingName(n) && !out.contains(n)) out.add(n);
    }
    return out;
  }
}
