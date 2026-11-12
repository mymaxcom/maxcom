// The Dart upload loop of the browser runner (Plan 6 Task 10): for each part,
// begin a session on the cloud, PUT the bytes straight to YouTube in slices,
// resume after any interruption, tell the cloud when YouTube has the video.
// It lives apart from the browser code so it runs in plain unit tests.
//
// Everything it reports goes out as [UploadEvent]s; it never prints the
// upload URI or a token.

import 'dart:async';
import 'dart:typed_data';

import 'resumable_client.dart';
import 'upload_queue.dart';

/// A file read in slices; the browser one wraps a `Blob`.
abstract class SliceSource {
  int get length;

  /// Bytes `[start, end)`.
  Future<Uint8List> slice(int start, int end);
}

class _AsByteSource implements ByteSource {
  _AsByteSource(this.inner);
  final SliceSource inner;

  @override
  int get length => inner.length;

  @override
  Future<Uint8List> read(int start, int end) => inner.slice(start, end);
}

/// Opens the file a part's `source` names.
typedef SourceOpener = Future<SliceSource> Function(String source);

class UploadLoop {
  UploadLoop({
    required this.resumable,
    required this.openSource,
    required this.emit,
    this.maxSessions = 5,
  });

  final ResumableClient resumable;
  final SourceOpener openSource;
  final void Function(UploadEvent) emit;

  /// New sessions tried for one part when YouTube keeps losing them.
  final int maxSessions;

  /// Runs every unfinished part of [job] in order. Returns when the job is
  /// finished, stopped ([shouldStop]) or a part ended in `failed`/`quota`.
  Future<void> run(
    UploadJob job,
    UploadAuth auth, {
    required bool Function() shouldStop,
  }) async {
    final count = job.parts.length;
    for (final part in job.parts) {
      if (shouldStop()) return;
      if (part.isDone || part.state == UploadPartState.paused) continue;
      final ok = await _part(job, part, count, auth, shouldStop);
      if (!ok) return;
    }
  }

  void _ev(
    UploadJob job,
    UploadPart part,
    UploadPartState state, {
    int? offset,
    String? uploadId,
    String? uploadUri,
    String? videoId,
    String? error,
    DateTime? resetsAt,
    bool clearSession = false,
  }) => emit(
    UploadEvent(
      jobId: job.id,
      partIndex: part.index,
      state: state,
      offset: offset,
      total: part.bytes,
      uploadId: uploadId,
      uploadUri: uploadUri,
      videoId: videoId,
      error: error,
      resetsAt: resetsAt,
      clearSession: clearSession,
    ),
  );

  /// True when the part is done and the next one may start.
  Future<bool> _part(
    UploadJob job,
    UploadPart part,
    int count,
    UploadAuth auth,
    bool Function() shouldStop,
  ) async {
    var uploadId = part.uploadId;
    var uploadUri = part.uploadUri;
    var offset = part.offset;
    var videoId = part.videoId;
    var resumedSession = uploadUri != null;

    for (var session = 0; session < maxSessions; session++) {
      if (shouldStop()) return false;

      if (videoId == null) {
        if (uploadUri == null || uploadId == null) {
          _ev(job, part, UploadPartState.beginning);
          try {
            final b = await auth.api.begin(
              UploadBeginRequest(
                kuliahId: job.kuliahId,
                bytes: part.bytes,
                part: count > 1 ? UploadPartRef(part.index, count) : null,
                // The live is hidden only after the last part is up.
                replaceLiveVideoId: part.index == count
                    ? job.replaceLiveVideoId
                    : null,
              ),
            );
            uploadId = b.uploadId;
            uploadUri = b.uploadUri;
            offset = 0;
            resumedSession = false;
            if (!isYoutubeUploadUri(uploadUri)) {
              // the address is dropped, never kept or sent to
              _ev(
                job,
                part,
                UploadPartState.failed,
                error: 'bad_upload_uri',
                clearSession: true,
              );
              return false;
            }
          } on UploadQuotaException catch (q) {
            _ev(job, part, UploadPartState.quota, resetsAt: q.resetsAt);
            return false;
          } on UploadNeedsUnlock {
            _ev(job, part, UploadPartState.failed, error: 'needs_unlock');
            return false;
          } on UploadApiException catch (e) {
            _ev(job, part, UploadPartState.failed, error: e.code);
            return false;
          } on Object {
            _ev(job, part, UploadPartState.failed, error: 'begin_failed');
            return false;
          }
        }
        if (!isYoutubeUploadUri(uploadUri)) {
          // a stored address from before: never probed, never sent to
          _ev(
            job,
            part,
            UploadPartState.failed,
            error: 'bad_upload_uri',
            clearSession: true,
          );
          return false;
        }
        _ev(
          job,
          part,
          UploadPartState.uploading,
          offset: offset,
          uploadId: uploadId,
          uploadUri: uploadUri,
        );

        final SliceSource file;
        try {
          file = await openSource(part.source);
        } on Object {
          _ev(job, part, UploadPartState.failed, error: 'source_missing');
          return false;
        }
        final uri = Uri.parse(uploadUri);
        final bytes = _AsByteSource(file);

        if (resumedSession) {
          // A session from before: ask where YouTube is, do not guess.
          UploadOutcome p;
          try {
            p = await resumable.probe(uri, file.length);
          } on Object {
            p = UploadOffset(offset);
          }
          if (p is UploadSessionLost) {
            _ev(job, part, UploadPartState.queued, clearSession: true);
            uploadId = null;
            uploadUri = null;
            offset = 0;
            continue;
          }
          if (p is UploadComplete) {
            videoId = p.videoId;
          } else if (p is UploadOffset) {
            offset = p.offset;
          }
          resumedSession = false;
        }

        if (videoId == null) {
          final out = await resumable.upload(
            uri,
            bytes,
            offset: offset,
            shouldStop: shouldStop,
            onProgress: (o) =>
                _ev(job, part, UploadPartState.uploading, offset: o),
          );
          switch (out) {
            case UploadComplete(videoId: final vid):
              _ev(
                job,
                part,
                UploadPartState.uploading,
                offset: part.bytes,
                videoId: vid,
              );
              return _finish(job, part, auth, uploadId, vid);
            case UploadSessionLost():
              _ev(job, part, UploadPartState.queued, clearSession: true);
              uploadId = null;
              uploadUri = null;
              offset = 0;
              continue;
            case UploadQuotaHit():
              DateTime? resets;
              try {
                resets = (await auth.api.quota()).resetsAt;
              } on Object {
                resets = null;
              }
              _ev(job, part, UploadPartState.quota, resetsAt: resets);
              return false;
            case UploadStopped(offset: final at):
              _ev(job, part, UploadPartState.queued, offset: at);
              return false;
            case UploadRejected(:final status):
              _ev(job, part, UploadPartState.failed, error: 'rejected_$status');
              return false;
            case UploadOffset():
              continue;
          }
        }
      }
      // YouTube already has the video (probe said so, or a run before did).
      return _finish(job, part, auth, uploadId, videoId);
    }
    _ev(job, part, UploadPartState.failed, error: 'session_lost');
    return false;
  }

  Future<bool> _finish(
    UploadJob job,
    UploadPart part,
    UploadAuth auth,
    String? uploadId,
    String videoId,
  ) async {
    if (uploadId == null) {
      _ev(job, part, UploadPartState.failed, error: 'done_failed', videoId: videoId);
      return false;
    }
    try {
      await auth.api.done(uploadId, videoId);
    } on UploadNeedsUnlock {
      _ev(
        job,
        part,
        UploadPartState.failed,
        error: 'needs_unlock',
        videoId: videoId,
      );
      return false;
    } on Object {
      // The video is on YouTube: keep its id so a retry only calls done.
      _ev(
        job,
        part,
        UploadPartState.failed,
        error: 'done_failed',
        videoId: videoId,
      );
      return false;
    }
    _ev(job, part, UploadPartState.done, offset: part.bytes, videoId: videoId);
    return true;
  }
}
