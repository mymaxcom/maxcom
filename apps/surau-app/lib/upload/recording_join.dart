// After a live ends, the recording pieces of that live become ONE video file (2026.11.14, contract C).
//
//  * Android: the pieces the live engine wrote to Movies/MAXCOM are joined on the phone with MediaMuxer, without
//    re-encoding, into `MAXCOM-<date>-<HHmm>-<slot>-all.mp4`; the joined length is checked against the sum of the
//    pieces and only then are the pieces removed (`AndroidRecordingJoiner`, the Kotlin `RecordingMerger`).
//  * Web / iPad: the pieces in the browser store go to the box (`POST /api/live/recordings/<liveId>/pieces/<n>`),
//    the box joins them (`POST .../join`, ffmpeg concat, no re-encode), the iPad saves the joined file
//    (`GET .../file`, one tap). Clicking the download link is NOT proof the browser kept the file (Safari lets the
//    person cancel), so nothing is deleted then: the person is asked "saved in Files/Downloads?" and only a Yes
//    removes the local pieces and asks the box to drop its copy (`confirmSaved`). Without a Yes the box copy expires
//    by itself after 7 days (`WebRecordingJoin`).
//    The pieces and the joined file travel as browser Blobs (`RecordingTransfer`), never as bytes in Dart memory.
//
// Nothing is ever removed unless the joined file exists. A failure keeps every piece and says so by a code.

import 'dart:async';
import 'package:flutter/services.dart';

import '../box/box_client.dart';
import '../features/live/recordings_store.dart';
import '../features/shell/box_gateway.dart';
import 'session_files.dart';

class JoinOutcome {
  const JoinOutcome.joined({
    required String this.name,
    this.bytes = 0,
    this.leftover = 0,
    this.pieces = 0,
    this.leftoverNames = const [],
    this.tracked = true,
  }) : joined = true,
       error = null;

  /// One piece or none: nothing to join (the file stays as it is).
  const JoinOutcome.nothing([this.name])
    : joined = false,
      error = null,
      bytes = 0,
      leftover = 0,
      pieces = 0,
      leftoverNames = const [],
      tracked = true;

  /// Every piece is still there.
  const JoinOutcome.failed(String this.error)
    : joined = false,
      name = null,
      bytes = 0,
      leftover = 0,
      pieces = 0,
      leftoverNames = const [],
      tracked = true;

  final bool joined;
  final String? name;
  final int bytes;

  /// Pieces that could not be removed after the join (they stay; the joined file exists).
  final int leftover;
  final int pieces;

  /// The pieces that stayed after the join, by name: they stay in the live's record (nothing is lost track of).
  final List<String> leftoverNames;

  /// False when the joined name could not be written to the record of this live (the file exists in Movies/MAXCOM).
  final bool tracked;

  /// The same joined outcome with [tracked] false: the name was not recorded.
  JoinOutcome untracked() => JoinOutcome.joined(
    name: name!,
    bytes: bytes,
    leftover: leftover,
    pieces: pieces,
    leftoverNames: leftoverNames,
    tracked: false,
  );

  /// A reason code (`not_found`, `no_space`, `join_failed`, `length_mismatch`, a box code); null when nothing failed.
  final String? error;

  bool get failed => error != null;
}

/// Android: asks the phone's own code to join the pieces named by the live engine.
class AndroidRecordingJoiner {
  AndroidRecordingJoiner({MethodChannel? channel}) : _channel = channel ?? const MethodChannel('my.maxcom/upload');

  final MethodChannel _channel;

  Future<JoinOutcome>? _running;
  String _runningKey = '';

  /// One join at a time (the phone writes one temporary file per live): the same names asked again while the join
  /// runs get the same answer; other names get `busy` from the phone, with every piece kept.
  Future<JoinOutcome> join(List<String> names) {
    final key = names.join('|');
    final running = _running;
    if (running != null && key == _runningKey) return running;
    final f = _join(names);
    if (running == null) {
      _running = f;
      _runningKey = key;
      unawaited(f.whenComplete(() {
        if (identical(_running, f)) _running = null;
      }));
    }
    return f;
  }

  Future<JoinOutcome> _join(List<String> names) async {
    final valid = [
      for (final n in names)
        if (isRecordingName(n)) n,
    ];
    if (valid.length < 2) return JoinOutcome.nothing(valid.isEmpty ? null : valid.first);
    try {
      final out = await _channel.invokeMapMethod<String, dynamic>('mergeRecordings', {'names': valid});
      if (out == null) return const JoinOutcome.failed('join_failed');
      if (out['merged'] == true && out['name'] is String && isRecordingName(out['name'] as String)) {
        return JoinOutcome.joined(
          name: out['name'] as String,
          bytes: (out['bytes'] as num? ?? 0).toInt(),
          leftover: (out['leftover'] as num? ?? 0).toInt(),
          pieces: (out['pieces'] as num? ?? 0).toInt(),
          leftoverNames: [
            if (out['leftoverNames'] is List)
              for (final n in out['leftoverNames'] as List)
                if (n is String && isRecordingName(n) && valid.contains(n)) n,
          ],
        );
      }
      final err = out['error'];
      if (err is String && RegExp(r'^[a-z_]{1,30}$').hasMatch(err)) return JoinOutcome.failed(err);
      return JoinOutcome.nothing(out['name'] is String ? out['name'] as String : null);
    } on PlatformException {
      return const JoinOutcome.failed('join_failed');
    } on MissingPluginException {
      return const JoinOutcome.failed('join_failed');
    }
  }
}

/// Hands the joined bytes to the browser as a file (one tap).
typedef SaveBytes = Future<void> Function(String fileName, Uint8List bytes, String mime);

/// A coded failure of the web join (`missing_piece`, ...).
class JoinFailure implements Exception {
  const JoinFailure(this.code);

  final String code;

  @override
  String toString() => 'JoinFailure($code)';
}

/// The browser cannot hold the joined file (out of memory): nothing is deleted anywhere.
class RecordingTooBig implements Exception {
  const RecordingTooBig();

  @override
  String toString() => 'RecordingTooBig';
}

/// Moves the recording files between the browser store and the box. On the web a piece goes up as a browser Blob and
/// the joined file comes down as a Blob (never a `Uint8List` in Dart memory); the bytes version below is for the
/// tests and for anything without a browser.
abstract class RecordingTransfer {
  /// Sends the piece [blob] (what [RecordingsStore.blobOf] gave) to the box at [path].
  Future<void> uploadPiece(String path, Object blob, String mime);

  /// Takes the joined file from the box. Throws [RecordingTooBig] when the browser cannot hold it.
  Future<Object> fetchFile(String path);

  /// Hands [file] (what [fetchFile] gave) to the browser as a download named [fileName].
  Future<void> saveFile(String fileName, Object file, String mime);
}

/// [RecordingTransfer] over bytes in memory, through the gateway.
class BytesRecordingTransfer implements RecordingTransfer {
  BytesRecordingTransfer({required this.gateway, required this.saveBytes});

  final BoxGateway gateway;
  final SaveBytes saveBytes;

  @override
  Future<void> uploadPiece(String path, Object blob, String mime) async {
    if (blob is! Uint8List || blob.isEmpty) throw const JoinFailure('missing_piece');
    await gateway.postRaw(path, blob, mime);
  }

  @override
  Future<Object> fetchFile(String path) async {
    final bytes = await gateway.getBytes(path);
    if (bytes.isEmpty) throw const JoinFailure('missing_file');
    return bytes;
  }

  @override
  Future<void> saveFile(String fileName, Object file, String mime) => saveBytes(fileName, file as Uint8List, mime);
}

/// A transfer that never reaches a box: used when the app is talking to the cloud (away from the surau). The pieces
/// are hundreds of megabytes and the cloud has no such route, so nothing is sent; the person is told to be on the
/// surau Wi-Fi (`box_away`) and every piece stays.
class AwayRecordingTransfer implements RecordingTransfer {
  const AwayRecordingTransfer();

  @override
  Future<void> uploadPiece(String path, Object blob, String mime) => Future.error(const BoxUnreachable());

  @override
  Future<Object> fetchFile(String path) => Future.error(const BoxUnreachable());

  @override
  Future<void> saveFile(String fileName, Object file, String mime) => Future.error(const BoxUnreachable());
}

/// What `saveJoined` did.
enum JoinSave {
  /// The browser was handed the file. Not yet proof it is kept: the person is asked, then [WebRecordingJoin.confirmSaved].
  handedOver,

  /// The file could not be had or handed over; nothing was deleted.
  failed,

  /// The browser could not hold it; nothing was deleted.
  tooBig,
}

/// The file name of the one joined recording on the iPad: `MAXCOM-<date>-<slot>.mp4` (`.webm` for WebM pieces).
String joinedWebFileName(List<SegmentInfo> pieces) {
  final first = pieces.first;
  final d = first.createdAt.toLocal();
  String two(int n) => n.toString().padLeft(2, '0');
  final ext = first.mime.contains('mp4') ? 'mp4' : 'webm';
  return 'MAXCOM-${d.year}-${two(d.month)}-${two(d.day)}-${safeLabel(first.label)}.$ext';
}

String _pieceMime(String mime) => mime.contains('mp4') ? 'video/mp4' : 'video/webm';

/// Web / iPad: upload the pieces of one live to the box, let it join them, save the joined file, clean up.
class WebRecordingJoin {
  WebRecordingJoin({
    required this.store,
    required this.gateway,
    required this.saveBytes,
    RecordingTransfer? transfer,
    this.busyWait = const Duration(seconds: 2),
    this.busyTries = 5,
  }) : transfer = transfer ?? BytesRecordingTransfer(gateway: gateway, saveBytes: saveBytes);

  /// A `busy` answer (the box already takes two uploads, or this live is being joined) is tried again after this wait.
  final Duration busyWait;
  final int busyTries;

  final RecordingsStore store;
  final BoxGateway gateway;
  final SaveBytes saveBytes;
  final RecordingTransfer transfer;

  static final RegExp _liveId = RegExp(r'^[A-Za-z0-9_-]{1,100}$');

  String _base(String liveId) => '/api/live/recordings/$liveId';

  static final RegExp _code = RegExp(r'^[a-z_]{1,30}$');

  /// The reason code of a failure. A box that does not answer (or a route that may only go to the box) is `box_away`:
  /// the person is told to be on the surau Wi-Fi.
  static String failureCode(Object e) {
    if (e is JoinFailure) return e.code;
    if (e is LiveOnly || e is OfflineWriteRefused || e is BoxUnreachable || e is Uncertain) return 'box_away';
    if (e is BoxError && e.code != null && _code.hasMatch(e.code!)) return e.code!;
    return 'upload_failed';
  }

  /// Uploads the pieces of [sessionId] (the browser's id) as the live [liveId] (the box's id) and asks the box to
  /// join them. A single piece is left as it is. Every piece stays in the browser store whatever happens here.
  Future<JoinOutcome> upload({required String liveId, required String sessionId}) async {
    if (!_liveId.hasMatch(liveId)) return const JoinOutcome.failed('unknown_live');
    final pieces = await store.forSession(sessionId);
    if (pieces.length < 2) return JoinOutcome.nothing(pieces.isEmpty ? null : pieces.first.fileName);
    try {
      for (var i = 0; i < pieces.length; i++) {
        final blob = await store.blobOf(pieces[i].id);
        if (blob == null) return const JoinOutcome.failed('missing_piece');
        try {
          await _withBusyRetry(() => transfer.uploadPiece('${_base(liveId)}/pieces/${i + 1}', blob, _pieceMime(pieces[i].mime)));
        } on BoxError catch (e) {
          // The box already joined this live (an earlier try got that far): nothing more to send, go to the download.
          if (e.code == 'already_joined') {
            return JoinOutcome.joined(name: joinedWebFileName(pieces), pieces: pieces.length);
          }
          rethrow;
        }
      }
      final r = await _withBusyRetry(() => gateway.post('${_base(liveId)}/join', {'count': pieces.length}));
      return JoinOutcome.joined(
        name: joinedWebFileName(pieces),
        bytes: (r['bytes'] as num? ?? 0).toInt(),
        pieces: pieces.length,
      );
    } on Object catch (e) {
      return JoinOutcome.failed(failureCode(e));
    }
  }

  /// Runs [go]; a 409 `busy` is tried again after [busyWait], up to [busyTries] times.
  Future<T> _withBusyRetry<T>(Future<T> Function() go) async {
    for (var n = 1;; n++) {
      try {
        return await go();
      } on BoxError catch (e) {
        if (e.code != 'busy' || n >= busyTries) rethrow;
        await Future<void>.delayed(busyWait);
      }
    }
  }

  /// One tap: takes the joined file from the box and hands it to the browser. NOTHING is deleted here: a click on a
  /// download link does not prove the browser kept the file. The caller asks the person and then calls [confirmSaved].
  Future<JoinSave> saveJoined({required String liveId, required String sessionId}) async {
    if (!_liveId.hasMatch(liveId)) return JoinSave.failed;
    final pieces = await store.forSession(sessionId);
    if (pieces.isEmpty) return JoinSave.failed;
    final Object file;
    try {
      file = await transfer.fetchFile('${_base(liveId)}/file');
    } on RecordingTooBig {
      return JoinSave.tooBig;
    } on Object {
      return JoinSave.failed;
    }
    try {
      await transfer.saveFile(joinedWebFileName(pieces), file, _pieceMime(pieces.first.mime));
    } on RecordingTooBig {
      return JoinSave.tooBig;
    } on Object {
      return JoinSave.failed;
    }
    return JoinSave.handedOver;
  }

  /// The person said the file is in Files/Downloads: only now the box drops its copy and the local pieces go.
  Future<void> confirmSaved({required String liveId, required String sessionId}) async {
    if (!_liveId.hasMatch(liveId)) return;
    final pieces = await store.forSession(sessionId);
    try {
      await gateway.delete(_base(liveId));
    } on Object {
      // the box removes its copy after 7 days by itself
    }
    for (final p in pieces) {
      await store.delete(p.id);
    }
  }
}
