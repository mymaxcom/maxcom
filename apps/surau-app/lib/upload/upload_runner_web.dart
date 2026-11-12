// The browser upload runner (Plan 6 Task 10, spec 12b B). It runs while the
// app is open: the screen tells the person to keep MAXCOM open (a Safari
// limit the operator accepted). Each recorded segment is its own video,
// because Safari's MP4 fragments cannot be joined in the browser without a
// muxer library (builder's call 7), so `joined` is always false here.
//
// Bytes are read from the IndexedDB segment Blob in slices (`Blob.slice`),
// never the whole file in memory.

// ignore_for_file: prefer_initializing_formals

import 'dart:async';
import 'dart:js_interop';
import 'dart:js_interop_unsafe';
import 'dart:typed_data';

import 'package:http/http.dart' as http;
import 'package:web/web.dart' as web;

import '../features/live/recordings_store.dart';
import 'resumable_client.dart';
import 'upload_loop.dart';
import 'upload_queue.dart';

export 'upload_loop.dart' show SliceSource;

/// A browser `Blob` read in slices.
class BlobSliceSource implements SliceSource {
  BlobSliceSource(this.blob);

  final web.Blob blob;

  @override
  int get length => blob.size;

  @override
  Future<Uint8List> slice(int start, int end) async {
    final buf = await blob.slice(start, end).arrayBuffer().toDart;
    return buf.toDart.asUint8List();
  }
}

/// Reads the Blob of a finished segment from the recordings database
/// (`maxcom-recordings`, store `segments`, key = segment id).
Future<SliceSource> idbSegmentSource(
  String source, {
  String dbName = 'maxcom-recordings',
}) async {
  const prefix = 'web:';
  if (!source.startsWith(prefix)) throw StateError('source');
  final id = source.substring(prefix.length);
  final c = Completer<web.IDBDatabase>();
  final open = web.window.indexedDB.open(dbName);
  open.onsuccess = ((web.Event _) => c.complete(open.result as web.IDBDatabase))
      .toJS;
  open.onerror = ((web.Event _) => c.completeError(StateError('idb'))).toJS;
  final db = await c.future;
  try {
    final r = Completer<JSAny?>();
    final req = db.transaction('segments'.toJS, 'readonly')
        .objectStore('segments')
        .get(id.toJS);
    req.onsuccess = ((web.Event _) => r.complete(req.result)).toJS;
    req.onerror = ((web.Event _) => r.completeError(StateError('idb'))).toJS;
    final rec = await r.future;
    if (rec == null) throw StateError('segment');
    final blob = (rec as JSObject).getProperty<JSAny?>('blob'.toJS);
    if (blob == null) throw StateError('blob');
    return BlobSliceSource(blob as web.Blob);
  } finally {
    db.close();
  }
}

class WebUploadRunner implements UploadRunner {
  WebUploadRunner({
    RecordingsStore? recordings,
    SourceOpener? openSource,
    http.Client? httpClient,
    int chunkSize = resumableChunkBytes,
    Future<void> Function(Duration)? sleep,
  }) : _recordings = recordings,
       _openSource = openSource ?? idbSegmentSource,
       _resumable = ResumableClient(
         client: httpClient ?? http.Client(),
         chunkSize: chunkSize,
         sleep: sleep,
       );

  RecordingsStore? _recordings;
  final SourceOpener _openSource;
  final ResumableClient _resumable;
  final StreamController<UploadEvent> _events = StreamController.broadcast();
  final Map<String, bool> _stop = {};

  RecordingsStore get recordings => _recordings ??= openRecordingsStore();

  @override
  bool get survivesRestart => false;

  @override
  Stream<UploadEvent> get events => _events.stream;

  @override
  Future<UploadNetwork> network() async {
    // The browser cannot tell Wi-Fi from mobile data (Safari has no
    // Network Information API): online means run.
    return web.window.navigator.onLine
        ? UploadNetwork.unknown
        : UploadNetwork.none;
  }

  @override
  Future<List<UploadSegment>> segmentsFor(String sessionId, String? kuliahId) =>
      segmentsFromRecordings(recordings, sessionId);

  @override
  Future<void> start(UploadJob job, UploadAuth auth) async {
    if (_stop[job.id] == false) return; // already running
    _stop[job.id] = false;
    final loop = UploadLoop(
      resumable: _resumable,
      openSource: _openSource,
      emit: (e) {
        if (!_events.isClosed) _events.add(e);
      },
    );
    try {
      await loop.run(job, auth, shouldStop: () => _stop[job.id] != false);
    } finally {
      _stop.remove(job.id);
    }
  }

  @override
  Future<void> cancel(String jobId) async {
    if (_stop.containsKey(jobId)) _stop[jobId] = true;
  }

  @override
  Future<void> forget(String jobId) async {}

  @override
  Future<void> dispose() async {
    for (final k in _stop.keys.toList()) {
      _stop[k] = true;
    }
    await _events.close();
  }
}

UploadRunner createWebRunner() => WebUploadRunner();

UploadRunner createAndroidRunner() => throw UnsupportedError('android');
