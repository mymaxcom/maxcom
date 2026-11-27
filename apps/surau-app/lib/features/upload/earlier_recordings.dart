// "Muat naik rakaman terdahulu" (2026.11.15, U1 and D2): the recordings of
// earlier lives this phone still holds and that are not in the upload queue.
//
// On Android the offer to upload a recording lived only in the sheet shown at
// the stop of the live: dismissing that sheet lost it (U1). The names each
// live wrote are kept by `SessionFiles`; this lists those sessions, and
// anything in the list can be queued at any later time.
//
// The box's own record of each live (`GET /api/live/sessions/recent`) tells
// how long the live was cut off, so ANY phone that holds the recording, not
// only the one that stopped the live, can offer to replace the gappy live
// with the full recording (D2). No secret is read or kept here.

import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../app/providers.dart';
import '../../box/wire.dart' show LiveSessionSummaryDto;
import '../../upload/upload_queue.dart';
import 'cleanup_providers.dart' show sessionFilesProvider;
import 'upload_widgets.dart' show catchUpJobsProvider, catchUpQueueProvider;

/// The gap, in seconds, from which a live counts as "cut off" for the offer
/// to replace it (the same minute the stop summary uses).
const int gapReplaceThresholdSec = 60;

class EarlierRecording {
  const EarlierRecording({required this.sessionId, required this.bytes, required this.files, this.live});

  /// The box session the recording was made in.
  final String sessionId;
  final int bytes;
  final int files;

  /// The box's record of that live, when it still has it (the last 10).
  final LiveSessionSummaryDto? live;

  String? get kuliahId => live?.kuliahId;

  /// The YouTube video of the live a replacement would hide; null when the live had none.
  String? get liveVideoId => live?.lastBroadcastId;

  /// The live was cut off for at least a minute and has a video to replace.
  bool get gappy => liveVideoId != null && (live?.gapSeconds ?? 0) >= gapReplaceThresholdSec;

  int get gapMinutes => ((live?.gapSeconds ?? 0) / 60).round();
}

/// What "replace the gappy live" means for [rec] under the surau's setting
/// [mode] (`ask`, `always`, `never`): the video id to replace, null for no
/// replacement, and [ask] true when the person decides.
({String? replace, bool ask}) replaceDecision(EarlierRecording rec, String mode) {
  // "always" acts only when the box-recorded gap passes the threshold
  if (!rec.gappy || mode == 'never') return (replace: null, ask: false);
  if (mode == 'always') return (replace: rec.liveVideoId, ask: false);
  return (replace: rec.liveVideoId, ask: true);
}

/// The recordings of earlier lives on this phone that are not queued, newest
/// live first. Empty on the web (the browser's own banner covers it), without
/// a queue, or when nothing is left on the phone.
final earlierRecordingsProvider = FutureProvider<List<EarlierRecording>>((ref) async {
  if (ref.watch(appDepsProvider).platform != 'android') return const [];
  final files = ref.watch(sessionFilesProvider);
  final queue = ref.watch(catchUpQueueProvider);
  if (files == null || queue == null) return const [];
  final queued = {for (final j in ref.watch(catchUpJobsProvider).value ?? const <UploadJob>[]) j.sessionId};
  final sessions = await files.sessions();
  if (sessions.isEmpty) return const [];

  // The box's record of the recent lives: best effort (an older box has no such route).
  final recent = <String, LiveSessionSummaryDto>{};
  final gateway = ref.watch(gatewayProvider);
  if (gateway != null) {
    try {
      for (final s in LiveSessionSummaryDto.listFrom(await gateway.getFresh('/api/live/sessions/recent', quiet: () => true))) {
        recent[s.id] = s;
      }
    } on Object {
      // no record: the recording can still be uploaded, without the replacement offer
    }
  }

  final out = <EarlierRecording>[];
  for (final id in sessions) {
    if (queued.contains(id)) continue;
    // a live that is still running is not "earlier"
    final live = recent[id];
    if (live != null && live.stoppedAt == null) continue;
    final List<UploadSegment> segs;
    try {
      segs = await queue.runner.segmentsFor(id, live?.kuliahId);
    } on Object {
      continue;
    }
    // the files are gone from the phone (deleted, or cleaned up after a verified upload)
    if (segs.isEmpty) continue;
    out.add(
      EarlierRecording(sessionId: id, bytes: segs.fold(0, (a, s) => a + s.bytes), files: segs.length, live: live),
    );
  }
  out.sort((a, b) {
    final x = a.live?.startedAt, y = b.live?.startedAt;
    if (x != null && y != null) return y.compareTo(x);
    if (x != null) return -1;
    if (y != null) return 1;
    return b.sessionId.compareTo(a.sessionId);
  });
  return out;
});
