import 'dart:async';
import 'dart:convert';
import 'dart:typed_data';

import 'package:http/http.dart' as http;

import 'wire.dart';

export 'wire.dart';

/// An error answered by the box (HTTP status >= 400).
class BoxError implements Exception {
  const BoxError(this.status, this.message, {this.retryAfterSec, this.code});

  final int status;

  /// The box's reason code (`wrong_pin`, `bad_nonce`, ...) when its answer
  /// carries one in a string `code` field; null otherwise. Callers branch
  /// on this, never on [message], which is wording for the person.
  final String? code;

  /// First of the box's `errors`, else `Permintaan gagal`.
  final String message;
  final int? retryAfterSec;

  @override
  String toString() => 'BoxError($status, $message)';
}

/// 401 on a request that carried a session token.
class SessionExpired extends BoxError {
  const SessionExpired(String message, {super.retryAfterSec, super.code})
    : super(401, message);
}

/// The box could not be reached (socket error, DNS, TLS, timeout).
class BoxUnreachable implements Exception {
  const BoxUnreachable([this.cause]);

  final Object? cause;

  @override
  String toString() => 'BoxUnreachable($cause)';
}

/// Talks to one box. The session token travels only in the Authorization
/// header, never in a URL.
class BoxClient {
  BoxClient(
    this.box,
    this.client, {
    this.connect = const Duration(seconds: 8),
    this.read = const Duration(seconds: 10),
  });

  final Uri box;
  final http.Client client;

  /// Budget to reach the box and receive response headers is
  /// `connect + read`; the body must then arrive within `read`. (package:http
  /// cannot time a TCP connect on its own; Task 4 also sets the socket-level
  /// connection timeout of the platform client to this value.)
  final Duration connect;
  final Duration read;

  static const String _generic = 'Permintaan gagal';
  static const String _expired = 'Sesi tamat. Sila buka kunci semula';

  // ---- public API ----

  Future<EnrolResult> enrolComplete({
    required String code,
    required Map<String, String> publicJwk,
    required String deviceName,
    required String platform,
    String? pin,
  }) async {
    final out = await postJson('/api/enrol/complete', {
      'code': code,
      'publicJwk': publicJwk,
      'deviceName': deviceName,
      'platform': platform,
      'pin': ?pin,
    });
    return EnrolResult.fromJson(out);
  }

  /// A fresh nonce request changes nothing the user can lose, so a lost first
  /// connection may be retried once ([idempotent]).
  Future<Challenge> challenge(String deviceId) async => Challenge.fromJson(
    await postJson('/api/auth/challenge', {
      'deviceId': deviceId,
    }, idempotent: true),
  );

  Future<UnlockResult> unlock({
    required String deviceId,
    required String nonce,
    required String signatureB64url,
    required String pin,
  }) async => SessionDto.fromJson(
    await postJson('/api/auth/unlock', {
      'deviceId': deviceId,
      'nonce': nonce,
      'signature': signatureB64url,
      'pin': pin,
    }),
  );

  Future<Map<String, dynamic>> getJson(String path, {String? token}) async =>
      _decodeObject(await _send('GET', path, token: token, idempotent: true));

  Future<Map<String, dynamic>> putJson(
    String path,
    Object body, {
    required String token,
  }) async => _decodeObject(await _send('PUT', path, token: token, json: body));

  /// Public routes (enrol, challenge, unlock) pass no token.
  /// [idempotent] allows ONE silent retry when the box cannot be reached; it
  /// is for reads only. Enrol, unlock and every other write never retry.
  Future<Map<String, dynamic>> postJson(
    String path,
    Object body, {
    String? token,
    bool idempotent = false,
  }) async => _decodeObject(
    await _send('POST', path, token: token, json: body, idempotent: idempotent),
  );

  /// `POST path` with raw bytes as the body and their own Content-Type (a
  /// zip, for instance). The same auth, trust and error mapping as
  /// [postJson]; a write, so never retried.
  Future<Map<String, dynamic>> postRaw(
    String path,
    Uint8List bytes,
    String contentType, {
    required String token,
  }) async => _decodeObject(
    await _send('POST', path, token: token, raw: bytes, contentType: contentType),
  );

  Future<void> delete(String path, {required String token}) async {
    await _send('DELETE', path, token: token);
  }

  /// `POST /api/assets` with the raw file as body and its own Content-Type.
  Future<AssetMeta> uploadAsset(
    Uint8List bytes,
    String mime, {
    required String token,
  }) async {
    final res = await _send(
      'POST',
      '/api/assets',
      token: token,
      raw: bytes,
      contentType: mime,
    );
    return AssetMeta.fromJson(_decodeObject(res));
  }

  Future<Uint8List> getBytes(String path, {String? token}) async =>
      (await _send('GET', path, token: token, idempotent: true)).bodyBytes;

  // ---- internals ----

  Uri _uri(String path) {
    if (!path.startsWith('/')) {
      throw ArgumentError.value(path, 'path', 'must start with /');
    }
    return box.replace(path: '', query: null).resolve(path);
  }

  /// One silent retry of an idempotent read when the first connection fails
  /// (the first connect after idle often loses to a sleeping Wi-Fi link).
  /// Writes are sent exactly once.
  Future<http.Response> _send(
    String method,
    String path, {
    String? token,
    Object? json,
    Uint8List? raw,
    String? contentType,
    bool idempotent = false,
  }) async {
    try {
      return await _sendOnce(
        method,
        path,
        token: token,
        json: json,
        raw: raw,
        contentType: contentType,
      );
    } on BoxUnreachable {
      if (!idempotent) rethrow;
      return _sendOnce(
        method,
        path,
        token: token,
        json: json,
        raw: raw,
        contentType: contentType,
      );
    }
  }

  Future<http.Response> _sendOnce(
    String method,
    String path, {
    String? token,
    Object? json,
    Uint8List? raw,
    String? contentType,
  }) async {
    final req = http.Request(method, _uri(path));
    final t = token;
    // The offline session has an empty token: nothing to send, but a 401
    // still reads as an ended session (it means a base answered).
    if (t != null && t.isNotEmpty) req.headers['authorization'] = 'Bearer $t';
    if (json != null) {
      req.headers['content-type'] = 'application/json';
      req.body = jsonEncode(json);
    } else if (raw != null) {
      req.headers['content-type'] = contentType ?? 'application/octet-stream';
      req.bodyBytes = raw;
    }

    final http.Response res;
    try {
      final streamed = await client.send(req).timeout(connect + read);
      res = await http.Response.fromStream(streamed).timeout(read);
    } on BoxError {
      rethrow;
    } on Exception catch (e) {
      // SocketException, TimeoutException, ClientException, TLS failures.
      throw BoxUnreachable(e);
    }

    if (res.statusCode >= 400) throw _failure(res, token != null);
    return res;
  }

  BoxError _failure(http.Response res, bool hadToken) {
    var message = _generic;
    String? code;
    try {
      final body = jsonDecode(utf8.decode(res.bodyBytes));
      if (body is Map) {
        final c = body['code'];
        if (c is String && c.isNotEmpty && c.length <= 64) code = c;
        final m = body['message'];
        final e = body['error'];
        final errors = body['errors'];
        if (m is String) {
          message = m;
        } else if (e is String) {
          message = e;
        } else if (errors is List &&
            errors.isNotEmpty &&
            errors.first is String) {
          message = errors.first as String;
        }
      }
    } on FormatException {
      // keep the generic message
    }
    final retry = int.tryParse(res.headers['retry-after'] ?? '');
    if (res.statusCode == 401 && hadToken) {
      return SessionExpired(
        message == _generic ? _expired : message,
        retryAfterSec: retry,
        code: code,
      );
    }
    return BoxError(res.statusCode, message, retryAfterSec: retry, code: code);
  }

  Map<String, dynamic> _decodeObject(http.Response res) {
    if (res.bodyBytes.isEmpty) return <String, dynamic>{};
    try {
      final body = jsonDecode(utf8.decode(res.bodyBytes));
      if (body is Map<String, dynamic>) return body;
    } on FormatException {
      // fall through
    }
    throw BoxError(res.statusCode, _generic);
  }
}
