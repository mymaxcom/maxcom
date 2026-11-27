// The Android side of the catch-up upload (Plan 6 Task 10): a thin client for
// the in-repo Kotlin package `my.maxcom.app.upload` (WorkManager). A job is
// queued as unique work that survives an app kill and a reboot, runs on
// Wi-Fi (or on any network once the person allows mobile data), joins the
// segments with MediaMuxer, and speaks the same resumable protocol as
// `resumable_client.dart`.
//
// What crosses the channel (2026.11.15, B1 and U7): the job and nothing else.
// The app itself asks the MAXCOM box for the Google upload address
// (`upload/begin`) and tells it when the video is up (`upload/done`); the
// worker only sends the bytes to that address. So the session token, the box
// address and the certificate of [UploadAuth] never cross this channel and
// never reach WorkManager. The upload address is not logged, shown in the
// notification or sent back in an error. Errors to Dart are reason codes only.
//
// What the worker says back (`UploadEvent`):
// - `uploaded` on the wire: YouTube has the part and gave its `videoId`. It
//   arrives here as the Dart state of that name when [UploadPartState] has
//   one, else as `uploading` with the full offset and the `videoId` set. The
//   event carries the `uploadId` to confirm with.
// - `queued` with error `needs_begin` (and `clearSession` when an address
//   died): the part has no usable upload address; get one and start again.
// - `failed` with `runner_error`, `empty_file`, `bad_upload_uri`,
//   `source_missing` or `rejected_<status>`; `queued` with `network`.

import 'dart:async';

import 'package:flutter/services.dart';

import 'session_files.dart';
import 'upload_queue.dart';

class AndroidUploadRunner implements UploadRunner {
  AndroidUploadRunner({
    MethodChannel? method,
    EventChannel? eventChannel,
    this.sessionFiles,
  }) : _method = method ?? methodChannel {
    _sub = (eventChannel ?? events_).receiveBroadcastStream().listen(
      _onEvent,
      onError: (Object _) {},
    );
    unawaited(_replayStatus());
  }

  static const methodChannel = MethodChannel('my.maxcom/upload');
  static const events_ = EventChannel('my.maxcom/upload/events');

  final MethodChannel _method;

  /// The names each live wrote (set by the queue's provider once the store is
  /// open). A session with no stored names has no segments: it is never
  /// uploaded automatically.
  SessionFiles? sessionFiles;
  StreamSubscription<dynamic>? _sub;
  final StreamController<UploadEvent> _events = StreamController.broadcast();

  @override
  bool get survivesRestart => true;

  @override
  Stream<UploadEvent> get events => _events.stream;

  /// What the worker did while the app was closed: its saved state, as
  /// events, so the queue learns of parts that finished in the background.
  Future<void> _replayStatus() async {
    try {
      final l = await _method.invokeMethod<List<dynamic>>('status');
      for (final e in l ?? const <dynamic>[]) {
        _onEvent(e);
      }
    } on PlatformException {
      // no worker state
    } on MissingPluginException {
      // channel not registered (see UploadChannel.register)
    }
  }

  @override
  Future<UploadNetwork> network() async {
    try {
      return switch (await _method.invokeMethod<String>('network')) {
        'wifi' => UploadNetwork.wifi,
        'cellular' => UploadNetwork.cellular,
        _ => UploadNetwork.none,
      };
    } on PlatformException {
      return UploadNetwork.none;
    } on MissingPluginException {
      return UploadNetwork.none;
    }
  }

  /// The files of one live, found in MediaStore (and the app's folder) by the
  /// exact names the engine reported when that live ended. No scan by prefix
  /// or date: another live's files, an older-scheme file or a renamed copy
  /// can never be picked up.
  @override
  Future<List<UploadSegment>> segmentsFor(
    String sessionId,
    String? kuliahId,
  ) async {
    final asked = await sessionFiles?.names(sessionId) ?? const <String>[];
    if (asked.isEmpty) return const [];
    final List<dynamic> raw;
    try {
      raw =
          await _method.invokeMethod<List<dynamic>>('findSegments', {
            'names': asked,
          }) ??
          const [];
    } on PlatformException {
      return const [];
    } on MissingPluginException {
      return const [];
    }
    final byName = <String, UploadSegment>{
      for (final e in raw)
        if (e is Map &&
            e['uri'] is String &&
            e['name'] is String &&
            asked.contains(e['name']) &&
            isRecordingName(e['name'] as String))
          e['name'] as String: UploadSegment(
            'android:${e['uri']}',
            (e['bytes'] as num? ?? 0).toInt(),
          ),
    };
    return [
      for (final n in asked)
        if (byName.containsKey(n)) byName[n]!,
    ];
  }

  /// Same rule as `AndroidPublisher` and `LiveLogic.sanitizePrefix`.
  static String recordingPrefix(String? kuliahId) {
    final s = (kuliahId ?? '').replaceAll(RegExp(r'[^A-Za-z0-9_-]'), '-');
    if (s.isEmpty) return 'siaran';
    return s.length > 40 ? s.substring(0, 40) : s;
  }

  /// Queues [job] for the worker. Each part to send carries the Google upload
  /// address in `uploadUri` (from the box's `upload/begin`); a part without one
  /// comes back as `queued` with `needs_begin`. [auth] is NOT sent: the worker
  /// has no business with the box, and the session token must not be stored
  /// in WorkManager.
  @override
  Future<void> start(UploadJob job, UploadAuth auth) async {
    try {
      await _method.invokeMethod<void>('enqueue', {'job': job.toJson()});
    } on PlatformException catch (e) {
      throw StateError(e.code);
    } on MissingPluginException {
      throw StateError('upload_channel_missing');
    }
  }

  @override
  Future<void> cancel(String jobId) async {
    try {
      await _method.invokeMethod<void>('cancel', {'jobId': jobId});
    } on PlatformException {
      // nothing to cancel
    } on MissingPluginException {
      // nothing to cancel
    }
  }

  @override
  Future<void> forget(String jobId) async {
    try {
      await _method.invokeMethod<void>('forget', {'jobId': jobId});
    } on PlatformException {
      // nothing kept
    } on MissingPluginException {
      // nothing kept
    }
  }

  static final RegExp _codeRe = RegExp(r'^[a-z0-9_]{1,40}$');

  /// The worker's word for "YouTube has it, the box is not told yet".
  static const uploadedWire = 'uploaded';

  /// The worker's reason for "this part needs an upload address from the box".
  static const needsBegin = 'needs_begin';

  void _onEvent(dynamic e) {
    if (e is! Map) return;
    var state = UploadPartState.values.where((s) => s.name == e['state']);
    final jobId = e['jobId'];
    final part = e['partIndex'];
    final total = (e['total'] as num?)?.toInt();
    var offset = (e['offset'] as num?)?.toInt();
    if (e['state'] == uploadedWire) {
      // YouTube has the part; the box is told by the app. Only with the video
      // id: an "uploaded" without one is not a real "uploaded" and is dropped
      // (the queue would wait for a confirmation it can never send).
      final id = e['videoId'];
      if (id is! String || id.isEmpty) return;
      // Without a Dart state of that name it reads as: sent in full, video id known.
      if (state.isEmpty) state = [UploadPartState.uploading];
      offset ??= total;
    }
    if (state.isEmpty || jobId is! String || part is! num) return;
    final err = e['error'];
    _events.add(
      UploadEvent(
        jobId: jobId,
        partIndex: part.toInt(),
        state: state.first,
        offset: offset,
        total: total,
        uploadId: e['uploadId'] as String?,
        uploadUri: e['uploadUri'] as String?,
        videoId: e['videoId'] as String?,
        // Reason codes only: anything else may hold a URL.
        error: err is String ? (_codeRe.hasMatch(err) ? err : 'error') : null,
        resetsAt: e['resetsAt'] is String
            ? DateTime.tryParse(e['resetsAt'] as String)
            : null,
        joined: e['joined'] as bool?,
        clearSession: e['clearSession'] == true,
      ),
    );
  }

  @override
  Future<void> dispose() async {
    await _sub?.cancel();
    _sub = null;
    await _events.close();
  }
}

UploadRunner createAndroidRunner() => AndroidUploadRunner();

UploadRunner createWebRunner() => throw UnsupportedError('web');
