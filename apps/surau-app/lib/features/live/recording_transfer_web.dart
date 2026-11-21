// The browser side of the recording join: the pieces go up and the joined file comes down as Blobs through `fetch`,
// so a recording of an hour (a gigabyte or more) is never held as a `Uint8List` in Dart memory (2026.11.14, AQ3).
// It talks to the surau's own box only (the same base and session token the gateway uses); the cloud has no such route.

import 'dart:convert';
import 'dart:js_interop';

import 'package:web/web.dart' as web;

import '../../box/box_client.dart';
import '../../upload/recording_join.dart';
import 'recordings_store_web.dart' show anchorDownload;

RecordingTransfer? openRecordingTransfer({required Uri box, required String token}) =>
    FetchRecordingTransfer(box: box, token: token);

class FetchRecordingTransfer implements RecordingTransfer {
  FetchRecordingTransfer({required this.box, required this.token});

  final Uri box;
  final String token;

  Uri _uri(String path) {
    if (!path.startsWith('/')) throw ArgumentError.value(path, 'path', 'must start with /');
    return box.replace(path: '', query: null).resolve(path);
  }

  Future<web.Response> _fetch(String path, {String method = 'GET', web.Blob? body, String? contentType}) async {
    final headers = web.Headers();
    if (token.isNotEmpty) headers.append('authorization', 'Bearer $token');
    if (contentType != null) headers.append('content-type', contentType);
    final init = web.RequestInit(method: method, headers: headers, credentials: 'omit', cache: 'no-store');
    if (body != null) init.body = body;
    final web.Response res;
    try {
      res = await web.window.fetch(_uri(path).toString().toJS, init).toDart;
    } on Object catch (e) {
      throw BoxUnreachable(e);
    }
    if (!res.ok) throw await _failure(res);
    return res;
  }

  Future<BoxError> _failure(web.Response res) async {
    String? code;
    var message = BoxError.genericMessage;
    try {
      final body = jsonDecode((await res.text().toDart).toDart);
      if (body is Map) {
        final c = body['code'];
        if (c is String && c.isNotEmpty && c.length <= 64) code = c;
        final m = body['message'];
        if (m is String) message = m;
      }
    } on Object {
      // keep the generic message
    }
    return BoxError(res.status, message, code: code);
  }

  @override
  Future<void> uploadPiece(String path, Object blob, String mime) async {
    final b = blob as web.Blob;
    if (b.size == 0) throw const JoinFailure('missing_piece');
    await _fetch(path, method: 'POST', body: b, contentType: mime);
  }

  @override
  Future<Object> fetchFile(String path) async {
    final res = await _fetch(path);
    try {
      final blob = await res.blob().toDart;
      if (blob.size == 0) throw const JoinFailure('missing_file');
      return blob;
    } on JoinFailure {
      rethrow;
    } on Object catch (e) {
      final m = e.toString().toLowerCase();
      // the browser could not make room for the file (memory or storage): nothing is lost, say so
      if (m.contains('memory') || m.contains('quota') || m.contains('allocation') || m.contains('range')) {
        throw const RecordingTooBig();
      }
      throw BoxUnreachable(e);
    }
  }

  @override
  Future<void> saveFile(String fileName, Object file, String mime) => anchorDownload(fileName, file);
}
